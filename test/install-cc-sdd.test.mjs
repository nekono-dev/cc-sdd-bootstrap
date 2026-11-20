import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeRepo, runEntry } from './helpers/entry-harness.mjs';
import { FAILURE_RECORD, STATE_PATH, RETRY_COMMAND, parseState } from '../.agent-hooks/cc-sdd-bootstrap/install-rules.mjs';
import { installFailures } from '../.agent-hooks/cc-sdd-bootstrap/install-gate.mjs';

const gate = (repo) => spawnSync(process.execPath, [path.join(repo.root, '.agent-hooks/cc-sdd-bootstrap/install-gate.mjs'), 'user-prompt-submit'], { encoding: 'utf8' });

test('初回導入は指紋を記録し、途中経過を標準出力に出さない', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  repo.write('CLAUDE.md', '手書き');
  const result = runEntry(repo, ['session-start']);
  assert.equal(result.status, 0);
  assert.equal(result.npxCalls.length, 1);
  assert.ok(result.npxCalls[0].args.includes('cc-sdd@3.1.0'));
  assert.ok(result.npxCalls[0].args.includes('--manifest'));
  const state = parseState(repo.read(STATE_PATH));
  assert.ok(state);
  assert.deepEqual(Object.keys(state.files).sort(), ['.claude/skills/kiro-fake/SKILL.md', '.kiro/settings/cc-sdd-guide.md', '.kiro/settings/templates/specs/tasks.md']);
  assert.equal(repo.exists(FAILURE_RECORD), false);
  assert.match(result.stdout, /3\.1\.0/);
  assert.match(result.stdout, /SKILL\.md/);
  assert.doesNotMatch(result.stdout, /fake npx progress/);
  assert.match(result.stderr, /fake npx progress/);
  assert.equal(repo.read('CLAUDE.md'), '手書き');
  assert.deepEqual(fs.readdirSync(path.join(repo.root, '.cache')).sort(), [path.basename(STATE_PATH)]);
});

test('2 回目は省略し、欠けたファイルや状態の欠落では入れ直す', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  runEntry(repo, ['session-start']);
  const skipped = runEntry(repo, ['session-start']);
  assert.deepEqual(skipped.npxCalls, []);
  assert.match(skipped.stdout, /入れ直しを省きました/);
  fs.rmSync(path.join(repo.root, '.claude/skills/kiro-fake/SKILL.md'));
  assert.equal(runEntry(repo, ['session-start']).npxCalls.length, 1);
  fs.rmSync(path.join(repo.root, STATE_PATH));
  assert.equal(runEntry(repo, ['session-start']).npxCalls.length, 1);
});

test('再導入は古い kiro スキルだけを消し、他の利用者ファイルを残す', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  repo.write('.claude/skills/kiro-old/SKILL.md', 'old');
  repo.write('.claude/skills/my-own/SKILL.md', 'own');
  repo.write('.kiro/specs/x/spec.json', '{}');
  repo.write('CLAUDE.md', 'handwritten');
  const result = runEntry(repo, ['session-start']);
  assert.equal(result.status, 0);
  assert.equal(repo.exists('.claude/skills/kiro-old'), false);
  assert.equal(repo.read('.claude/skills/my-own/SKILL.md'), 'own');
  assert.equal(repo.read('.kiro/specs/x/spec.json'), '{}');
  assert.equal(repo.read('CLAUDE.md'), 'handwritten');
});

test('npx の失敗はフックで 0、手動で 1 とし再試行方法を記録する', (t) => {
  for (const [args, status] of [[['session-start'], 0], [[], 1]]) {
    const repo = makeRepo(); t.after(repo.cleanup);
    const result = runEntry(repo, args, { mode: 'fail' });
    assert.equal(result.status, status);
    assert.match(repo.read(FAILURE_RECORD), /7/);
    assert.match(repo.read(FAILURE_RECORD), new RegExp(RETRY_COMMAND.replaceAll('.', '\\.')));
    assert.match(result.stdout, /導入に失敗しました/);
    assert.equal(repo.exists(STATE_PATH), false);
  }
});

test('設定不備では npx を呼ばず、時間切れでは一時 manifest を消す', (t) => {
  for (const config of [null, '{broken', { format: 99, ccSdd: { version: '3.1.0', lang: 'ja' } }]) {
    const repo = makeRepo({ config }); t.after(repo.cleanup);
    const result = runEntry(repo, ['session-start']);
    assert.equal(result.npxCalls.length, 0);
    assert.match(repo.read(FAILURE_RECORD), /\.cc-sdd-bootstrap\.json/);
  }
  const repo = makeRepo(); t.after(repo.cleanup);
  const result = runEntry(repo, ['session-start'], { mode: 'hang', env: { CC_SDD_BOOTSTRAP_NPX_TIMEOUT_MS: '500' } });
  assert.equal(result.status, 0);
  assert.match(repo.read(FAILURE_RECORD), /時間内に取得・導入が終わりませんでした/);
  assert.equal(fs.readdirSync(path.join(repo.root, '.cache')).some((name) => name.includes('manifest')), false);
});

test('設定ファイルの場所がディレクトリなら案内付きで失敗を記録する', (t) => {
  const repo = makeRepo({ config: null }); t.after(repo.cleanup);
  fs.mkdirSync(path.join(repo.root, '.cc-sdd-bootstrap.json'));
  const result = runEntry(repo, ['session-start']);
  assert.equal(result.npxCalls.length, 0);
  assert.match(repo.read(FAILURE_RECORD), /\.cc-sdd-bootstrap\.json/);
  assert.match(repo.read(FAILURE_RECORD), /update/);
});

test('導入後の指紋収集に失敗したら状態を保存せず失敗を残す', (t) => {
  if (process.getuid?.() === 0) return t.skip('root では chmod による読み取り拒否を再現できない');
  const repo = makeRepo();
  t.after(() => {
    try { fs.chmodSync(path.join(repo.root, '.claude/skills/kiro-fake'), 0o755); } catch {}
    repo.cleanup();
  });
  const result = runEntry(repo, ['session-start'], { mode: 'lock' });
  assert.equal(result.status, 0);
  assert.equal(repo.exists(STATE_PATH), false);
  assert.equal(repo.exists(FAILURE_RECORD), true);
});

test('不正な引数は使い方と終了コード 2 を返す', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  const result = runEntry(repo, ['foo']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /使い方: node \.agent-hooks\/cc-sdd-bootstrap\/install-cc-sdd\.mjs \[session-start\]/);
  assert.deepEqual(result.npxCalls, []);
});

test('導入先の .claude が外部へのリンクならリンク先を変更せず失敗する', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  const outside = fs.mkdtempSync(path.join(path.dirname(repo.root), 'cc-sdd-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'keep'), 'safe');
  fs.symlinkSync(outside, path.join(repo.root, '.claude'));
  const result = runEntry(repo, ['session-start']);
  assert.equal(result.npxCalls.length, 0);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'safe');
  assert.match(repo.read(FAILURE_RECORD), /\.claude/);
});

test('設定の版・言語の変更や、記録したファイルの書き換えで入れ直す', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  runEntry(repo, ['session-start']);

  repo.write('.cc-sdd-bootstrap.json', JSON.stringify({ format: 1, ccSdd: { version: '3.2.0', lang: 'ja' } }));
  const r1 = runEntry(repo, ['session-start']);
  assert.equal(r1.npxCalls.length, 1);
  assert.ok(r1.npxCalls[0].args.includes('cc-sdd@3.2.0'));

  repo.write('.cc-sdd-bootstrap.json', JSON.stringify({ format: 1, ccSdd: { version: '3.2.0', lang: 'en' } }));
  const r2 = runEntry(repo, ['session-start']);
  assert.equal(r2.npxCalls.length, 1);
  assert.ok(r2.npxCalls[0].args.includes('en'));

  repo.write('.kiro/settings/cc-sdd-guide.md', 'new content');
  const r3 = runEntry(repo, ['session-start']);
  assert.equal(r3.npxCalls.length, 1);

  const r4 = runEntry(repo, ['session-start']);
  assert.equal(r4.npxCalls.length, 0);
});

test('失敗のあと手の再試行が成功すると記録が消え、停止の処理が通す', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  runEntry(repo, ['session-start'], { mode: 'fail' });
  assert.ok(repo.exists(FAILURE_RECORD));
  assert.equal(JSON.parse(gate(repo).stdout).decision, 'block');

  const r = runEntry(repo, []);
  assert.equal(r.status, 0);
  assert.equal(repo.exists(FAILURE_RECORD), false);
  assert.equal(gate(repo).stdout.trim(), '');
});

test('再試行のコマンドの一致', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  assert.equal(installFailures[0].retry, RETRY_COMMAND);

  const r = runEntry(repo, ['session-start'], { mode: 'fail' });
  assert.ok(repo.read(FAILURE_RECORD).includes(RETRY_COMMAND));
  assert.ok(r.stdout.includes(RETRY_COMMAND));
  assert.ok(JSON.parse(gate(repo).stdout).reason.includes(RETRY_COMMAND));
});

const cfg = (keep, version = '3.1.0') => JSON.stringify({ format: 1, ccSdd: { version, lang: 'ja', keepTemplates: keep } });
const T = '.kiro/settings/templates/specs/tasks.md';

test('保持を選ぶと、書き換えた雛形は入れ直しの理由にならず残る', (t) => {
  const repo = makeRepo({ config: cfg(true) });
  t.after(() => repo.cleanup());
  const r1 = runEntry(repo, ['session-start']);
  assert.equal(r1.npxCalls.length, 1);
  assert.equal(repo.read(T), 'templates 3.1.0 ja');
  assert.ok(!parseState(repo.read(STATE_PATH)).files[T]);

  repo.write(T, '手元の書き換え');
  const r2 = runEntry(repo, ['session-start']);
  assert.equal(r2.npxCalls.length, 0);
  assert.equal(repo.read(T), '手元の書き換え');
});

test('保持を選んで版を上げても、書き換えた雛形は上書きされない', (t) => {
  const repo = makeRepo({ config: cfg(true) });
  t.after(() => repo.cleanup());
  runEntry(repo, ['session-start']);
  repo.write(T, '手元の書き換え');

  repo.write('.cc-sdd-bootstrap.json', cfg(true, '3.2.0'));
  const r = runEntry(repo, ['session-start']);
  assert.equal(r.npxCalls.length, 1);
  assert.equal(repo.read(T), '手元の書き換え');
  assert.equal(repo.read('.kiro/settings/cc-sdd-guide.md'), 'guide 3.2.0 ja');
});

test('保持を選んでいて雛形を消すと、次の開始で置かれる', (t) => {
  const repo = makeRepo({ config: cfg(true) });
  t.after(() => repo.cleanup());
  runEntry(repo, ['session-start']);

  fs.rmSync(path.join(repo.root, '.kiro/settings/templates'), { recursive: true, force: true });
  const r = runEntry(repo, ['session-start']);
  assert.equal(r.npxCalls.length, 1);
  assert.equal(repo.read(T), 'templates 3.1.0 ja');
});

test('保持の選択を変えると入れ直し、保持しない側では雛形が戻り、保持する側では残る', (t) => {
  const repo = makeRepo({ config: cfg(true) });
  t.after(() => repo.cleanup());
  runEntry(repo, ['session-start']);
  repo.write(T, '手元の書き換え');

  repo.write('.cc-sdd-bootstrap.json', cfg(false));
  const r1 = runEntry(repo, ['session-start']);
  assert.equal(r1.npxCalls.length, 1);
  assert.equal(repo.read(T), 'templates 3.1.0 ja');
  assert.ok(parseState(repo.read(STATE_PATH)).files[T]);

  repo.write(T, '再び書き換え');
  repo.write('.cc-sdd-bootstrap.json', cfg(true));
  const r2 = runEntry(repo, ['session-start']);
  assert.equal(r2.npxCalls.length, 1);
  assert.equal(repo.read(T), '再び書き換え');
  assert.ok(!parseState(repo.read(STATE_PATH)).files[T]);
});

test('保持しない場合は、書き換えた雛形が入れ直しの理由になり戻される', (t) => {
  const repo = makeRepo({ config: cfg(false) });
  t.after(() => repo.cleanup());
  runEntry(repo, ['session-start']);
  repo.write(T, '手元の書き換え');

  const r = runEntry(repo, ['session-start']);
  assert.equal(r.npxCalls.length, 1);
  assert.equal(repo.read(T), 'templates 3.1.0 ja');
});
