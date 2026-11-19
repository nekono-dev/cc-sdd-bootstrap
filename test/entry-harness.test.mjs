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
  const result = spawnSync(path.join(repo.fakeBin, 'npx'), ['--yes', 'cc-sdd@8.2.0', '--manifest', manifest, '--lang', 'fr'], {
    cwd: repo.root, encoding: 'utf8', env: { ...process.env, FAKE_NPX_MODE: 'ok', FAKE_NPX_LOG: log },
  });
  assert.equal(result.status, 0);
  assert.equal(repo.read('.claude/skills/kiro-fake/SKILL.md'), 'skill 8.2.0 fr');
  assert.equal(repo.read('.kiro/settings/cc-sdd-guide.md'), 'guide 8.2.0 fr');
  assert.equal(repo.read('.kiro/settings/templates/specs/tasks.md'), 'templates 8.2.0 fr');
  assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8').trim()).args, ['--yes', 'cc-sdd@8.2.0', '--manifest', manifest, '--lang', 'fr']);
  assert.match(result.stdout, /fake npx progress/);
  assert.match(result.stderr, /fake npx progress/);
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
  assert.match(fail.stderr, /fake npx failure/);
  const hang = spawnSync(path.join(repo.fakeBin, 'npx'), [], { cwd: repo.root, encoding: 'utf8', timeout: 300, env: { ...env, FAKE_NPX_MODE: 'hang' } });
  assert.ok(hang.signal === 'SIGTERM' || hang.error?.code === 'ETIMEDOUT');
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
