import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeRepo, runEntry } from './helpers/entry-harness.mjs';

const manifestText = JSON.stringify({ artifacts: [
  { id: 'skills' }, { id: 'doc_main' }, { id: 'settings_templates' },
] });

test('makeRepo は配置物だけの利用先を作り、cleanup で消す', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  assert.ok(fs.existsSync(path.join(repo.root, '.cc-sdd-bootstrap.json')));
  assert.ok(fs.existsSync(path.join(repo.root, '.agent-hooks/cc-sdd-bootstrap/install-rules.mjs')));
  for (const rel of ['lib', 'bin', 'package.json', 'node_modules']) assert.equal(repo.exists(rel), false);
  assert.deepEqual(JSON.parse(repo.read('.cc-sdd-bootstrap.json')), { format: 1, ccSdd: { version: '3.1.0', lang: 'ja' } });
  repo.cleanup();
  assert.equal(fs.existsSync(repo.root), false);
});

test('makeRepo は設定を省略できる', (t) => {
  const repo = makeRepo({ config: null });
  t.after(repo.cleanup);
  assert.equal(repo.read('.cc-sdd-bootstrap.json'), null);
});

test('偽 npx は manifest の成果物を書き、呼び出しと進捗を記録する', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const manifest = path.join(repo.root, 'manifest.json');
  fs.writeFileSync(manifest, manifestText);
  const log = path.join(repo.root, 'calls.jsonl');
  const result = spawnSync(path.join(repo.fakeBin, 'npx'), ['--yes', 'cc-sdd@8.2.0', '--manifest', manifest, '--claude-skills', '--lang', 'fr'], {
    cwd: repo.root, encoding: 'utf8', env: { ...process.env, FAKE_NPX_MODE: 'ok', FAKE_NPX_LOG: log },
  });
  assert.equal(result.status, 0);
  assert.equal(repo.read('.claude/skills/kiro-fake/SKILL.md'), 'skill 8.2.0 fr');
  assert.equal(repo.read('CLAUDE.md'), 'guide 8.2.0 fr');
  assert.equal(repo.read('.kiro/settings/templates/specs/tasks.md'), 'templates 8.2.0 fr');
  assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8').trim()).args, ['--yes', 'cc-sdd@8.2.0', '--manifest', manifest, '--claude-skills', '--lang', 'fr']);
});

test('偽 npx は --codex-skills で AGENTS.md と Codex スキルへ出力する', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const manifest = path.join(repo.root, 'manifest.json');
  fs.writeFileSync(manifest, manifestText);
  const result = spawnSync(path.join(repo.fakeBin, 'npx'), ['--manifest', manifest, '--codex-skills'], {
    cwd: repo.root, encoding: 'utf8', env: { ...process.env, FAKE_NPX_MODE: 'ok' },
  });
  assert.equal(result.status, 0);
  assert.equal(repo.read('.agents/skills/kiro-fake/SKILL.md'), 'skill unknown unknown');
  assert.equal(repo.read('AGENTS.md'), 'guide unknown unknown');
});

test('偽 npx は manifest に無い雛形を作らず、fail と hang を制御できる', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const manifest = path.join(repo.root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ artifacts: [{ id: 'skills' }] }));
  const log = path.join(repo.root, 'calls.jsonl');
  const env = { ...process.env, FAKE_NPX_LOG: log };
  const ok = spawnSync(path.join(repo.fakeBin, 'npx'), ['--manifest', manifest], { cwd: repo.root, encoding: 'utf8', env: { ...env, FAKE_NPX_MODE: 'ok' } });
  assert.equal(ok.status, 0);
  assert.equal(repo.exists('.kiro/settings/templates/specs/tasks.md'), false);
  const fail = spawnSync(path.join(repo.fakeBin, 'npx'), [], { cwd: repo.root, encoding: 'utf8', env: { ...env, FAKE_NPX_MODE: 'fail' } });
  assert.equal(fail.status, 7);
  const hang = spawnSync(path.join(repo.fakeBin, 'npx'), [], { cwd: repo.root, encoding: 'utf8', timeout: 300, env: { ...env, FAKE_NPX_MODE: 'hang' } });
  assert.ok(hang.signal === 'SIGTERM' || hang.error?.code === 'ETIMEDOUT');
});

test('偽 npx の lock mode は成果物を書いて kiro-fake を読めなくする', (t) => {
  if (process.getuid?.() === 0) return t.skip('root では chmod による読み取り拒否を再現できない');
  const repo = makeRepo();
  t.after(() => {
    try { fs.chmodSync(path.join(repo.root, '.claude/skills/kiro-fake'), 0o755); } catch {}
    repo.cleanup();
  });
  const manifest = path.join(repo.root, 'manifest.json');
  fs.writeFileSync(manifest, manifestText);
  const result = spawnSync(path.join(repo.fakeBin, 'npx'), ['--manifest', manifest], {
    cwd: repo.root, encoding: 'utf8', env: { ...process.env, FAKE_NPX_MODE: 'lock' },
  });
  assert.equal(result.status, 0);
  const skillDir = path.join(repo.root, '.claude/skills/kiro-fake');
  assert.equal(fs.statSync(skillDir).mode & 0o777, 0);
  fs.chmodSync(skillDir, 0o755);
  assert.equal(repo.read('.claude/skills/kiro-fake/SKILL.md'), 'skill unknown unknown');
});

test('runEntry は入口未配置でも結果を返し、npx を呼ばない', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  if (fs.existsSync(repo.entry)) return t.skip('入口が配置済み');
  const result = runEntry(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot find module/);
  assert.deepEqual(result.npxCalls, []);
});

/** 試験専用の仮の入口。標準入力を読み、偽の git の ls-remote を呼んで結果を JSON で返す */
const dummyEntry = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const r = spawnSync('git', ['ls-remote', 'https://example.invalid/x', 'HEAD'], {
  encoding: 'utf8',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
});
process.stdout.write(JSON.stringify({ input, status: r.status, stdout: r.stdout, stderr: r.stderr }) + '\\n');
process.exitCode = r.status ?? 1;
`;
const DUMMY_NAME = 'dummy-entry.mjs';
const DUMMY_REL = `.agent-hooks/cc-sdd-bootstrap/${DUMMY_NAME}`;

test('既定の makeRepo は install-cc-sdd.mjs を入口にし、偽 git を置かない', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  assert.equal(repo.entry, path.join(repo.root, '.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs'));
  assert.equal(path.basename(repo.entry), 'install-cc-sdd.mjs');
  assert.equal(repo.exists('.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs'), true);
  assert.equal(fs.existsSync(path.join(repo.fakeBin, 'git')), false);
});

test('entryName と payload を指定すると、仮の入口を一時のリポジトリで起動できる', (t) => {
  const repo = makeRepo({ entryName: DUMMY_NAME, payload: [], fakeGit: true });
  t.after(repo.cleanup);
  repo.write(DUMMY_REL, dummyEntry);
  assert.equal(repo.entry, path.join(repo.root, DUMMY_REL));
  const result = runEntry(repo, [], { input: 'hello\n', env: { FAKE_GIT_STDOUT: 'abc123\tHEAD\n' } });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).input, 'hello\n');
});

test('payload を空の配列にすると既定の配置物は写らず、指定した名前だけを写す', (t) => {
  const empty = makeRepo({ entryName: DUMMY_NAME, payload: [] });
  t.after(empty.cleanup);
  for (const name of ['install-cc-sdd.mjs', 'install-rules.mjs', 'codex-trust.mjs']) {
    assert.equal(empty.exists(`.agent-hooks/cc-sdd-bootstrap/${name}`), false, name);
  }
  const some = makeRepo({ entryName: DUMMY_NAME, payload: ['install-rules.mjs', 'no-such-file.mjs'] });
  t.after(some.cleanup);
  assert.equal(some.exists('.agent-hooks/cc-sdd-bootstrap/install-rules.mjs'), true);
  assert.equal(some.exists('.agent-hooks/cc-sdd-bootstrap/no-such-file.mjs'), false);
  assert.equal(some.exists('.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs'), false);
});

test('偽 git の ok は FAKE_GIT_STDOUT を返し、引数と GIT_TERMINAL_PROMPT を記録する', (t) => {
  const repo = makeRepo({ entryName: DUMMY_NAME, payload: [], fakeGit: true });
  t.after(repo.cleanup);
  repo.write(DUMMY_REL, dummyEntry);
  const result = runEntry(repo, [], { env: { FAKE_GIT_STDOUT: 'abc123\tHEAD\n' } });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 0);
  assert.equal(parsed.stdout, 'abc123\tHEAD\n');
  assert.deepEqual(result.gitCalls, [{ args: ['ls-remote', 'https://example.invalid/x', 'HEAD'], gitTerminalPrompt: '0' }]);
});

test('偽 git の fail は終了コード 128 と fatal の標準エラーを返す', (t) => {
  const repo = makeRepo({ entryName: DUMMY_NAME, payload: [], fakeGit: true });
  t.after(repo.cleanup);
  repo.write(DUMMY_REL, dummyEntry);
  const result = runEntry(repo, [], { env: { FAKE_GIT_MODE: 'fail' } });
  assert.equal(result.status, 128);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 128);
  assert.match(parsed.stderr, /fatal/);
  assert.equal(result.gitCalls.length, 1);
});

test('偽 git の hang は入口側の timeoutMs で打ち切れる', (t) => {
  const repo = makeRepo({ entryName: DUMMY_NAME, payload: [], fakeGit: true });
  t.after(repo.cleanup);
  repo.write(DUMMY_REL, dummyEntry);
  const started = Date.now();
  const result = runEntry(repo, [], { env: { FAKE_GIT_MODE: 'hang' }, timeoutMs: 1000 });
  assert.ok(Date.now() - started < 15000, '60 秒待たずに打ち切れること');
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.status, null);
});

test('runEntry の input は標準入力に渡り、偽 git を使わない場合 gitCalls は空になる', (t) => {
  const repo = makeRepo({ entryName: DUMMY_NAME, payload: [] });
  t.after(repo.cleanup);
  repo.write(DUMMY_REL, 'let s = "";\nfor await (const c of process.stdin) s += c;\nprocess.stdout.write(JSON.stringify({ input: s }) + "\\n");\n');
  const result = runEntry(repo, [], { input: 'x' });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).input, 'x');
  assert.deepEqual(result.gitCalls, []);
});

test('偽 git は ls-remote 以外を本物の git へ素通しする', (t) => {
  const repo = makeRepo({ entryName: DUMMY_NAME, payload: [], fakeGit: true });
  t.after(repo.cleanup);
  const passthrough = `import { spawnSync } from 'node:child_process';
const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout }));`;
  repo.write(DUMMY_REL, passthrough);
  const result = runEntry(repo, []);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 0);
  assert.match(parsed.stdout, /^git version /);
  assert.deepEqual(result.gitCalls, []);
});
