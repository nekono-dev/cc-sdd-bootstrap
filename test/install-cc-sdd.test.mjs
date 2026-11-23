import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makeRepo, runEntry } from './helpers/entry-harness.mjs';
import { FAILURE_RECORD, LOCK_PATH, STATE_PATH, SECTION_BEGIN_MARKER, RETRY_COMMAND, decideInstall } from '../.agent-hooks/cc-sdd-bootstrap/install-rules.mjs';
import { AGENT_SECTION_MARKERS } from '../lib/catalog.mjs';
import { readInstallFacts } from '../.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs';

function prepareComplete(repo) {
  const files = [
    '.claude/skills/kiro-x/SKILL.md', '.agents/skills/kiro-x/SKILL.md',
    '.kiro/settings/templates/specs/tasks.md', 'CLAUDE.md', 'AGENTS.md',
  ];
  for (const file of files) repo.write(file, 'present');
  repo.write(STATE_PATH, JSON.stringify({ format: 2, version: '3.1.0', lang: 'ja', files }));
  return files;
}

test('古い印と新しい印を経過時間で区別し、どちらも導入しない', (t) => {
  for (const [age, stale] of [[1000, false], [700000, true]]) {
    const repo = makeRepo(); t.after(repo.cleanup);
    prepareComplete(repo);
    repo.write(LOCK_PATH, '導入中');
    const lockPath = path.join(repo.root, LOCK_PATH);
    const mtime = new Date(Date.now() - age);
    fs.utimesSync(lockPath, mtime, mtime);
    const result = runEntry(repo);
    assert.equal(result.status, 1);
    assert.deepEqual(result.npxCalls, []);
    assert.match(result.stdout, stale ? /rm \.cache\/cc-sdd-install\.lock/ : /別のセッションで導入中/);
    const facts = readInstallFacts(repo.root);
    assert.ok(facts.lock.ageMs >= age - 1000 && facts.lock.ageMs <= age + 1000);
    assert.equal(facts.lock.ageMs > 660000, stale);
    assert.equal((awaitDecision(facts)).stale, stale);
  }
});

test('既存の失敗記録は内容を読み、記録だけを理由に入れ直す', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  repo.putSections();
  prepareComplete(repo);
  for (const doc of ['CLAUDE.md', 'AGENTS.md']) repo.write(doc, SECTION_BEGIN_MARKER);
  repo.write(FAILURE_RECORD, '既存の失敗理由');
  const facts = readInstallFacts(repo.root);
  assert.deepEqual(facts.failure, { present: true, text: '既存の失敗理由' });
  assert.deepEqual(facts.sectionPresent, { claude: true, codex: true });
  assert.equal(awaitDecision(facts).reason, 'failed');
  const result = runEntry(repo);
  assert.equal(result.npxCalls.length, 2);
  assert.equal(repo.read(FAILURE_RECORD), null);
});

function awaitDecision(facts) {
  // 判断関数は純粋な規則として既存モジュールから読む。
  return decideInstall(facts);
}

function runSessionStart(repo, tool, input = '{"session_id":"test"}') {
  const logPath = path.join(repo.fakeBin, `npx-calls-session-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const result = spawnSync(process.execPath, [repo.entry, 'session-start', '--tool', tool], {
    cwd: repo.root, encoding: 'utf8', input,
    env: { ...process.env, PATH: `${repo.fakeBin}${path.delimiter}${process.env.PATH ?? ''}`, FAKE_NPX_LOG: logPath },
  });
  try { result.npxLog = fs.readFileSync(logPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; result.npxLog = ''; }
  fs.rmSync(logPath, { force: true });
  return result;
}

function runPromptHook(repo, tool, prompt = '最初の依頼', { mode = 'ok', env = {}, input = null } = {}) {
  const logPath = path.join(repo.fakeBin, `npx-calls-prompt-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const result = spawnSync(process.execPath, [repo.entry, 'user-prompt-submit', '--tool', tool], {
    cwd: repo.root, encoding: 'utf8', input: input ?? JSON.stringify({ prompt }),
    env: { ...process.env, ...env, PATH: `${repo.fakeBin}${path.delimiter}${process.env.PATH ?? ''}`, FAKE_NPX_MODE: mode, FAKE_NPX_LOG: logPath },
  });
  try { result.npxCalls = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; result.npxCalls = []; }
  fs.rmSync(logPath, { force: true });
  return result;
}

test('最初の入力で導入し、追加文脈で手順書を直接読む道筋を伝える', (t) => {
  for (const [tool, dir] of [['claude', '.claude/skills'], ['codex', '.agents/skills']]) {
    const repo = makeRepo(); t.after(repo.cleanup); repo.putSections();
    const prompt = '/kiro-x 続けて';
    const result = runPromptHook(repo, tool, prompt);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(output.hookSpecificOutput.additionalContext, /導入しました/);
    assert.match(output.hookSpecificOutput.additionalContext, new RegExp(`${dir}/kiro-x/SKILL\\.md`));
    assert.equal(result.npxCalls.length, 2);
  }
});

test('揃った状態の最初の入力は何も出さず通す', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup); repo.putSections();
  const installed = runEntry(repo);
  assert.equal(installed.status, 0);
  const result = runPromptHook(repo, 'claude');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.npxCalls.length, 0);
});

test('導入失敗は入力を止め、再試行成功後は通す', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup); repo.putSections();
  const failed = runPromptHook(repo, 'claude', '依頼', { mode: 'fail' });
  assert.equal(failed.status, 0);
  const blocked = JSON.parse(failed.stdout);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /fake npx failure|終了コード/);
  assert.ok(blocked.reason.includes(RETRY_COMMAND));
  assert.ok(repo.read(FAILURE_RECORD));
  const recovered = runPromptHook(repo, 'claude');
  assert.equal(recovered.status, 0);
  assert.equal(JSON.parse(recovered.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(repo.read(FAILURE_RECORD), null);
});

test('壊れた設定と判定例外は理由と再試行方法を示して止める', (t) => {
  for (const input of ['{"prompt":"x"}', 'not json']) {
    const repo = makeRepo({ config: '{broken' }); t.after(repo.cleanup);
    const result = runPromptHook(repo, 'codex', '', { input });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /JSON|判定できなかった/);
    assert.ok(output.reason.includes(RETRY_COMMAND));
    assert.equal(result.npxCalls.length, 0);
  }
});

test('導入中の新しい印と古い印はいずれも止め、古い印の解除方法を示す', (t) => {
  for (const stale of [false, true]) {
    const repo = makeRepo(); t.after(repo.cleanup);
    repo.write(LOCK_PATH, '導入中');
    if (stale) {
      const lockPath = path.join(repo.root, LOCK_PATH);
      const mtime = new Date(Date.now() - 700000); fs.utimesSync(lockPath, mtime, mtime);
    }
    const result = runPromptHook(repo, 'codex');
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, stale ? /rm \.cache\/cc-sdd-install\.lock/ : /別のセッションで導入中/);
    assert.equal(result.npxCalls.length, 0);
  }
});

test('ほぼ同時の入力では一つだけ導入し、もう一方を止める', async (t) => {
  const repo = makeRepo(); t.after(repo.cleanup); repo.putSections();
  const logPath = path.join(repo.fakeBin, `npx-calls-race-${process.pid}-${Date.now()}.jsonl`);
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [repo.entry, 'user-prompt-submit', '--tool', 'claude'], {
      cwd: repo.root, env: { ...process.env, PATH: `${repo.fakeBin}${path.delimiter}${process.env.PATH ?? ''}`, FAKE_NPX_LOG: logPath, FAKE_NPX_DELAY_MS: '150' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', (chunk) => stderr += chunk);
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify({ prompt: '並行入力' }));
  });
  const results = await Promise.all([run(), run()]);
  assert.ok(results.every(({ status }) => status === 0));
  assert.equal(results.filter(({ stdout }) => JSON.parse(stdout).decision === 'block').length, 1);
  const calls = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
  assert.equal(calls.length, 2);
  fs.rmSync(logPath, { force: true });
});

test('SessionStart は両ツールで状態を知らせ、導入を始めない', (t) => {
  for (const tool of ['claude', 'codex']) {
    for (const scenario of [
      { name: '揃っている', setup(repo) { prepareComplete(repo); repo.write('CLAUDE.md', SECTION_BEGIN_MARKER); repo.write('AGENTS.md', SECTION_BEGIN_MARKER); }, expected: [/揃っている/, /3\.1\.0/, /ja/] },
      { name: '未導入', setup() {}, expected: /最初の入力.*導入/ },
      { name: '導入中', setup(repo) { repo.write(LOCK_PATH, '導入中'); }, expected: /導入中|未完了/ },
      { name: '失敗の記録', setup(repo) { repo.write(FAILURE_RECORD, '前回失敗'); }, expected: /未完了|入力.*止|最初の入力.*導入/ },
      { name: '設定がない', setup(repo) { fs.rmSync(path.join(repo.root, '.cc-sdd-bootstrap.json')); }, expected: /設定.*ありません|設定ファイル.*ありません|\.cc-sdd-bootstrap\.json.*ありません/ },
      { name: 'JSON でない設定', setup(repo) { repo.write('.cc-sdd-bootstrap.json', '{broken'); }, expected: /JSON/ },
      { name: '項目が不正な設定', setup(repo) { repo.write('.cc-sdd-bootstrap.json', JSON.stringify({ format: 1, ccSdd: { version: '3.1.0', lang: 42 } })); }, expected: /lang/ },
    ]) {
      const repo = makeRepo(); t.after(repo.cleanup);
      scenario.setup(repo);
      const result = runSessionStart(repo, tool, JSON.stringify({ unused: '入力される' }));
      assert.equal(result.status, 0, `${tool}: ${scenario.name}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
      if (Array.isArray(scenario.expected)) {
        for (const expected of scenario.expected) assert.match(output.hookSpecificOutput.additionalContext, expected, `${tool}: ${scenario.name}`);
      } else assert.match(output.hookSpecificOutput.additionalContext, scenario.expected, `${tool}: ${scenario.name}`);
      assert.equal(result.npxLog, '', `${tool}: ${scenario.name} で npx が呼ばれました`);
    }
  }
});

test('SessionStart の設定読み取り例外では何も出さず終了 0', (t) => {
  for (const tool of ['claude', 'codex']) {
    const repo = makeRepo({ config: null }); t.after(repo.cleanup);
    fs.mkdirSync(path.join(repo.root, '.cc-sdd-bootstrap.json'));
    const result = runSessionStart(repo, tool);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.npxLog, '');
  }
});

test('session-start の未知のツールは使い方と終了コード 2 を返す', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  const result = runSessionStart(repo, 'other');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /claude.*codex/);
});

test('user-prompt-submit の未知のツールは使い方と終了コード 2 を返す', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  const result = runPromptHook(repo, 'other');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /claude.*codex/);
  assert.equal(result.npxCalls.length, 0);
});

test('引数なしで導入し結果と版・言語を表示し、再実行は省く', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  repo.putSections();
  const installed = runEntry(repo);
  assert.equal(installed.status, 0);
  assert.match(installed.stdout, /導入しました/);
  assert.match(installed.stdout, /3\.1\.0.*ja/);
  const skipped = runEntry(repo);
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /省きました/);
  assert.match(skipped.stdout, /3\.1\.0.*ja/);
  assert.deepEqual(skipped.npxCalls, []);
});

test('--help は利用手順を表示し、旧引数は使い方と終了コード 2 を返す', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  const help = runEntry(repo, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /準備スクリプト/);
  assert.match(help.stdout, /<リポジトリ>/);
  assert.deepEqual(help.npxCalls, []);
  const old = runEntry(repo, ['session-start']);
  assert.equal(old.status, 2);
  assert.match(old.stderr, /準備スクリプト/);
  assert.deepEqual(old.npxCalls, []);
});

test('両文書の区画の有無を読み取り、片方でも無ければ入れ直す', (t) => {
  for (const absent of [null, 'CLAUDE.md', 'AGENTS.md']) {
    const repo = makeRepo(); t.after(repo.cleanup);
    prepareComplete(repo);
    for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
      repo.write(doc, doc === absent ? '標準文書のみ' : `先頭\n${SECTION_BEGIN_MARKER}\n本文`);
    }
    const facts = readInstallFacts(repo.root);
    assert.deepEqual(facts.sectionPresent, {
      claude: absent !== 'CLAUDE.md',
      codex: absent !== 'AGENTS.md',
    });
    assert.equal(awaitDecision(facts).action, absent === null ? 'skip' : 'install');
    const result = runEntry(repo);
    assert.equal(result.npxCalls.length, absent === null ? 0 : 2);
  }
});

test('状態に記録された Codex 側の欠けた道筋を検出し、入れ直しを始める', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  const files = prepareComplete(repo);
  repo.write('CLAUDE.md', SECTION_BEGIN_MARKER);
  repo.write('AGENTS.md', SECTION_BEGIN_MARKER);
  fs.rmSync(path.join(repo.root, files[1]));
  const facts = readInstallFacts(repo.root);
  assert.deepEqual(facts.missingFiles, [files[1]]);
  assert.equal(awaitDecision(facts).reason, 'files-missing');
  const result = runEntry(repo);
  assert.equal(result.npxCalls.length, 2);
  assert.ok(result.npxCalls.some(({ args }) => args.includes('--claude-skills')));
});

test('導入で両ツールを順に揃え、標準文書の末尾に運用区画を一つずつ足す', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  repo.write('CLAUDE.md', '以前の Claude の記述');
  repo.write('AGENTS.md', '以前の Codex の記述');
  repo.write('.claude/skills/custom/SKILL.md', '独自スキル');
  repo.write('.agents/skills/custom/SKILL.md', '独自スキル');
  repo.write('.kiro/specs/custom/spec.md', '独自仕様');
  repo.putSections();
  const result = runEntry(repo);
  assert.equal(result.status, 0);
  assert.equal(result.npxCalls.length, 2);
  assert.ok(result.npxCalls[0].args.includes('--claude-skills'));
  assert.ok(result.npxCalls[1].args.includes('--codex-skills'));
  assert.match(result.npxCalls[0].lock, /^\d{4}-\d\d-\d\dT.*\nnode \.agent-hooks\/cc-sdd-bootstrap\/install-cc-sdd\.mjs\n$/);
  assert.doesNotMatch(result.stdout, /fake npx progress/);
  assert.ok(repo.read('CLAUDE.md').startsWith('guide 3.1.0 ja\n'));
  assert.ok(repo.read('AGENTS.md').startsWith('guide 3.1.0 ja\n'));
  assert.doesNotMatch(repo.read('CLAUDE.md'), /以前の Claude の記述/);
  assert.doesNotMatch(repo.read('AGENTS.md'), /以前の Codex の記述/);
  assert.equal(repo.read('.claude/skills/custom/SKILL.md'), '独自スキル');
  assert.equal(repo.read('.agents/skills/custom/SKILL.md'), '独自スキル');
  assert.equal(repo.read('.kiro/specs/custom/spec.md'), '独自仕様');
  assert.equal(repo.read('CLAUDE.md').split(SECTION_BEGIN_MARKER).length - 1, 1);
  assert.equal(repo.read('AGENTS.md').split(SECTION_BEGIN_MARKER).length - 1, 1);
  assert.equal(repo.read(LOCK_PATH), null);
  assert.equal(repo.read(FAILURE_RECORD), null);
  const state = JSON.parse(repo.read(STATE_PATH));
  assert.ok(state.files.includes('.claude/skills/kiro-fake/SKILL.md'));
  assert.ok(state.files.includes('.agents/skills/kiro-fake/SKILL.md'));
  assert.ok(state.files.includes('.kiro/settings/templates/specs/tasks.md'));
  assert.ok(state.files.includes('CLAUDE.md'));
  assert.ok(state.files.includes('AGENTS.md'));
});

test('入れ直しのたびに標準文書へ区画を一つだけ足す', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  repo.putSections();
  assert.equal(runEntry(repo).status, 0);
  repo.write(FAILURE_RECORD, '入れ直しを要求');
  repo.write('CLAUDE.md', '途中で書き換えた Claude 文書');
  repo.write('AGENTS.md', '途中で書き換えた Codex 文書');
  const retry = runEntry(repo);
  assert.equal(retry.status, 0);
  assert.equal(retry.npxCalls.length, 2);
  for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
    assert.doesNotMatch(repo.read(doc), /途中で書き換えた/);
    assert.equal(repo.read(doc).split(SECTION_BEGIN_MARKER).length - 1, 1);
  }
});

test('各 npx は期限内でも二回の合計が導入全体の期限を超えると失敗する', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  repo.putSections();
  const result = runEntry(repo, [], {
    env: { CC_SDD_BOOTSTRAP_NPX_TIMEOUT_MS: '220', FAKE_NPX_DELAY_MS: '140' },
    timeoutMs: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.npxCalls.length, 2);
  assert.ok(repo.read(FAILURE_RECORD)?.includes('期限'));
  assert.equal(repo.read(LOCK_PATH), null);
});

test('失敗・期限切れ・区画ファイル不足では失敗記録を残して印を消す', (t) => {
  for (const scenario of [
    { mode: 'fail', env: {}, omitSections: false },
    { mode: 'hang', env: { CC_SDD_BOOTSTRAP_NPX_TIMEOUT_MS: '50' }, omitSections: false },
    { mode: 'ok', env: {}, omitSections: true },
    { mode: 'ok', env: {}, omitSections: false, emptySection: true },
  ]) {
    const repo = makeRepo({ sections: !scenario.omitSections }); t.after(repo.cleanup);
    if (!scenario.omitSections) repo.putSections();
    if (scenario.emptySection) repo.write('.agent-hooks/cc-sdd-bootstrap/agent-section-claude.md', '  \n');
    const result = runEntry(repo, [], { mode: scenario.mode, env: scenario.env });
    assert.equal(result.status, 1);
    assert.ok(repo.read(FAILURE_RECORD));
    assert.match(result.stdout, /理由:|期限|読み取れません|運用の区画/);
    assert.match(result.stdout, /再試行/);
    assert.equal(repo.read(LOCK_PATH), null);
  }
});

test('導入中の印を排他的に作り、既存の印があれば npx を実行しない', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  repo.putSections();
  repo.write(LOCK_PATH, '別の導入');
  const result = runEntry(repo);
  assert.equal(result.status, 1);
  assert.deepEqual(result.npxCalls, []);
});

test('消す対象までのシンボリックリンク経路は失敗にする', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  repo.putSections();
  fs.mkdirSync(path.join(repo.root, '.claude'));
  fs.symlinkSync(path.join(repo.root, '.claude-target'), path.join(repo.root, '.claude/skills'));
  fs.mkdirSync(path.join(repo.root, '.claude-target'));
  const result = runEntry(repo);
  assert.equal(result.status, 1);
  assert.deepEqual(result.npxCalls, []);
  assert.ok(repo.read(FAILURE_RECORD));
});

test('設定パスがディレクトリなら読み取り理由と修正案内を記録して導入しない', (t) => {
  const repo = makeRepo({ config: null }); t.after(repo.cleanup);
  fs.mkdirSync(path.join(repo.root, '.cc-sdd-bootstrap.json'));
  const result = runEntry(repo);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.deepEqual(result.npxCalls, []);
  assert.ok(repo.read(FAILURE_RECORD), `失敗記録がありません: ${JSON.stringify(result)}`);
  assert.match(`${output}${repo.read(FAILURE_RECORD)}`, /\.cc-sdd-bootstrap\.json.*EISDIR/);
  assert.ok(`${output}${repo.read(FAILURE_RECORD)}`.includes('.cc-sdd-bootstrap.json を直すか'));
  assert.ok(`${output}${repo.read(FAILURE_RECORD)}`.includes('cc-sdd-bootstrap update'));
  assert.doesNotMatch(output, /ありません| init /);
  assert.match(repo.read(FAILURE_RECORD), /\.cc-sdd-bootstrap\.json.*EISDIR/);
  assert.ok(repo.read(FAILURE_RECORD).includes('.cc-sdd-bootstrap.json を直すか'));
  assert.ok(repo.read(FAILURE_RECORD).includes('cc-sdd-bootstrap update'));
});

test('設定の読み取り例外は元の理由と修正案内を保つ', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  const original = fs.readFileSync;
  fs.readFileSync = function (file, ...args) {
    if (path.resolve(String(file)) === path.join(repo.root, '.cc-sdd-bootstrap.json')) {
      const error = new Error('注入した読み取り拒否');
      error.code = 'EACCES';
      throw error;
    }
    return original.call(this, file, ...args);
  };
  try {
    assert.throws(() => readInstallFacts(repo.root), (error) => {
      assert.ok(error.message.includes('.cc-sdd-bootstrap.json'));
      assert.ok(error.message.includes('注入した読み取り拒否'));
      assert.ok(error.message.includes('.cc-sdd-bootstrap.json を直すか'));
      assert.ok(error.message.includes('cc-sdd-bootstrap update'));
      return true;
    });
  } finally {
    fs.readFileSync = original;
  }
});

test('運用区画の開始目印はカタログと一致する', () => {
  assert.equal(SECTION_BEGIN_MARKER, AGENT_SECTION_MARKERS.begin);
});

test('旧形式の状態は未記録として入れ直す', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  repo.write(STATE_PATH, JSON.stringify({ format: 1, version: '3.1.0', lang: 'ja', fingerprints: {} }));
  const result = runEntry(repo);
  assert.equal(result.npxCalls.length, 2);
});

test('新しい導入中の印では導入せず失敗する', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  repo.write(LOCK_PATH, '導入中');
  const result = runEntry(repo);
  assert.equal(result.status, 1);
  assert.deepEqual(result.npxCalls, []);
});

test('不正な設定の判断は導入せず、失敗の記録を読み取る', (t) => {
  const repo = makeRepo({ config: '{broken' }); t.after(repo.cleanup);
  const result = runEntry(repo);
  assert.equal(result.status, 1);
  assert.deepEqual(result.npxCalls, []);
  assert.match(repo.read(FAILURE_RECORD), /JSON/);
});

test('存在しない導入記録の道筋は入れ直しを起こす', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  repo.write(STATE_PATH, JSON.stringify({ format: 2, version: '3.1.0', lang: 'ja', files: ['.agents/skills/kiro-x/SKILL.md'] }));
  const result = runEntry(repo);
  assert.equal(result.npxCalls.length, 2);
});

test('両ツールの偽 npx 出力先と標準文書の区画なしを試験土台で扱える', (t) => {
  const repo = makeRepo(); t.after(repo.cleanup);
  repo.write('.agents/skills/kiro-x/SKILL.md', 'skill');
  repo.write('CLAUDE.md', '区画なし');
  repo.write('AGENTS.md', '区画なし');
  assert.equal(fs.existsSync(path.join(repo.root, '.agents/skills/kiro-x/SKILL.md')), true);
  assert.equal(repo.read('CLAUDE.md'), '区画なし');
  assert.equal(repo.read('AGENTS.md'), '区画なし');
  repo.putSections();
  assert.ok(fs.existsSync(path.join(repo.root, '.agent-hooks/cc-sdd-bootstrap/agent-section-claude.md')));
  assert.ok(fs.existsSync(path.join(repo.root, '.agent-hooks/cc-sdd-bootstrap/agent-section-codex.md')));
});
