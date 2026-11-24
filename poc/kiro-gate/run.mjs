#!/usr/bin/env node
// 実機の Claude Code・Codex で kiro-gate の先読みを確かめる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const repo = path.resolve(import.meta.dirname, '../..');
const work = path.join(os.homedir(), '.cache/cc-sdd-bootstrap-scratch/kiro-gate');
const originalHome = os.homedir();
let ok = 0;
let ng = 0;

function check(label, condition, detail = '') {
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? `: ${detail}` : ''}`);
  condition ? ok++ : ng++;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 600_000, ...options });
}

function gitRepo(name) {
  const dir = path.join(work, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const init = run('git', ['init', '-q'], { cwd: dir });
  if (init.status !== 0) throw new Error(`git init に失敗: ${init.stderr}`);
  const bootstrap = run(process.execPath, [path.join(repo, 'bin/cc-sdd-bootstrap.mjs'), 'init'], { cwd: dir });
  if (bootstrap.status !== 0) throw new Error(`cc-sdd-bootstrap init に失敗: ${bootstrap.stderr}`);
  return dir;
}

function installSkills(dir) {
  const result = run(process.execPath, ['.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs'], { cwd: dir });
  if (result.status !== 0) throw new Error(`手順書の導入に失敗: ${result.stderr}`);
  const skill = path.join(dir, '.claude/skills/kiro-spec-status/SKILL.md');
  if (!fs.existsSync(skill)) throw new Error('Claude Code 用の手順書がありません');
  return skill;
}

function writeWrapper(dir) {
  const wrapper = String.raw`import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.env.CLAUDE_PROJECT_DIR || spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
const args = process.argv.slice(2);
const raw = fs.readFileSync(0, 'utf8');
const result = spawnSync(process.execPath, [path.join(root, '.agent-hooks/cc-sdd-bootstrap/kiro-gate.mjs'), ...args], { input: raw, encoding: 'utf8' });
// .poc/drop-context があるときは、追加の文脈を外してツールへ返す（文脈に従わないモデルの代わり。記録には元の出力を残す）
let forward = result.stdout || '';
if (args[0] === 'user-prompt-submit' && fs.existsSync(path.join(root, '.poc/drop-context'))) forward = '';
process.stdout.write(forward);
process.stderr.write(result.stderr || '');
let input = {};
try { input = JSON.parse(raw); } catch {}
let output = {};
try { output = JSON.parse(result.stdout || '{}'); } catch {}
fs.mkdirSync(path.join(root, '.poc'), { recursive: true });
fs.appendFileSync(path.join(root, '.poc/log.jsonl'), JSON.stringify({ args, input, output }) + '\n');
process.exitCode = result.status ?? 1;
`;
  fs.mkdirSync(path.join(dir, '.poc'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.poc/logwrap.mjs'), wrapper);
  for (const file of ['.claude/settings.json', '.codex/hooks.json']) {
    const full = path.join(dir, file);
    const config = JSON.parse(fs.readFileSync(full, 'utf8'));
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== 'object') return;
      if (typeof value.command === 'string' && value.command.includes('kiro-gate.mjs')) {
        const args = value.command.match(/kiro-gate\.mjs['"]?\s+(.+)$/)?.[1] ?? '';
        value.command = file.startsWith('.claude')
          ? `node "$CLAUDE_PROJECT_DIR/.poc/logwrap.mjs" ${args}`
          : `node "$(git rev-parse --show-toplevel)/.poc/logwrap.mjs" ${args}`;
      }
      Object.values(value).forEach(visit);
    };
    visit(config);
    fs.writeFileSync(full, `${JSON.stringify(config, null, 2)}\n`);
  }
}

function records(dir) {
  const file = path.join(dir, '.poc/log.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function gateOutput(record) { return record.output?.hookSpecificOutput ?? record.output ?? {}; }
function denied(record) { return gateOutput(record).permissionDecision === 'deny'; }
function hasContext(record) { return Boolean(gateOutput(record).additionalContext); }
function blocked(record) { return gateOutput(record).decision === 'block'; }
function skillRead(record, tool, firstLine) {
  const input = record.input ?? {};
  if (input.hook_event_name !== 'PostToolUse') return false;
  const response = typeof input.tool_response === 'string' ? input.tool_response : JSON.stringify(input.tool_response ?? '');
  if (tool === 'claude') return input.tool_name === 'Read'
    && String(input.tool_input?.file_path ?? '').includes('kiro-spec-status/SKILL.md')
    && response.includes(firstLine);
  // Codex の入力は tool_input.command と tool_response（出力の文字列）。応答に手順書の見出しがあれば読めたとみなす
  return input.tool_name === 'Bash' && String(input.tool_input?.command ?? '').includes('.agents/skills/kiro-spec-status/SKILL.md')
    && response.includes(firstLine);
}

function setupCodexHome(dir) {
  const source = path.join(originalHome, '.codex/auth.json');
  const home = path.join(work, 'codex-home', path.basename(dir));
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  if (!fs.existsSync(source)) throw new Error('~/.codex/auth.json がありません');
  fs.copyFileSync(source, path.join(home, 'auth.json'));
  fs.chmodSync(path.join(home, 'auth.json'), 0o600);
  fs.writeFileSync(path.join(home, 'config.toml'), `[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`);
  return home;
}

function removeCodexAuth() {
  const base = path.join(work, 'codex-home');
  if (fs.existsSync(base)) for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (entry.isDirectory()) fs.rmSync(path.join(base, entry.name, 'auth.json'), { force: true });
  }
}

function executionSucceeded(result) {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const failedEvent = jsonLines(text).some((event) => ['error', 'turn.failed'].includes(event.type));
  return !result.error && result.status === 0 && !result.signal
    && !failedEvent
    && !/API Error|API rate limit|connection error|ECONN(?:RESET|REFUSED)|ETIMEDOUT|timed out|overloaded/i.test(text);
}

function jsonLines(text) {
  return text.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function modelAnswer(tool, result) {
  const events = jsonLines(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (tool === 'codex') return events.filter((e) => e.item?.type === 'agent_message').map((e) => String(e.item.text ?? '')).at(-1) ?? '';
  return events.filter((e) => e.type === 'result').map((e) => String(e.result ?? '')).at(-1) ?? '';
}

function invoke(tool, dir, prompt, write = false) {
  if (tool === 'claude') {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    return run('claude', ['-p', '--setting-sources', 'project', '--model', 'haiku', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Write', '--output-format', 'stream-json', '--verbose', prompt], { cwd: dir, env, timeout: 600_000 });
  }
  const home = setupCodexHome(dir);
  try {
    return run('codex', ['-a', 'never', 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '-s', write ? 'workspace-write' : 'read-only', '--cd', dir, prompt], { cwd: dir, env: { ...process.env, CODEX_HOME: home }, timeout: 600_000 });
  } finally { fs.rmSync(path.join(home, 'auth.json'), { force: true }); }
}

async function invokeClaudeTwoTurns(dir, skill, prompt = '/kiro-spec-status 手順書を読む前に、まずシェルで touch before-read を実行してください。その後、手順書を読み、最初の見出しを 1 行で答え、最後にシェルで touch after-read を実行してください。') {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const child = spawn('claude', ['-p', '--setting-sources', 'project', '--model', 'haiku', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Write', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { cwd: dir, env });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const firstDone = new Promise((resolve) => lines.on('line', (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'result') resolve();
  }));
  let timer;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Claude Code の 2 回の入力が時間切れ')), 600_000); });
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'PONG とだけ答えてください。' } })}\n`);
    await Promise.race([firstDone, deadline]);
    if (!fs.existsSync(skill)) throw new Error('1 回目の入力後に手順書が導入されませんでした');
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
    child.stdin.end();
    const status = await Promise.race([new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }), deadline]);
    return { stdout, stderr, status, signal: null, error: null };
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function logReadPosition(list, tool, skill) {
  const firstLine = fs.readFileSync(skill, 'utf8').split(/\r?\n/).find((line) => line.trim()) ?? '';
  return list.findIndex((record) => skillRead(record, tool, firstLine));
}

function checkA1(tool, dir, result) {
  const list = records(dir);
  const skill = path.join(dir, tool === 'claude' ? '.claude/skills/kiro-spec-status/SKILL.md' : '.agents/skills/kiro-spec-status/SKILL.md');
  const readAt = logReadPosition(list, tool, skill);
  const context = list.some((record) => record.input?.hook_event_name === 'UserPromptSubmit' && hasContext(record));
  const deniedBefore = list.slice(0, readAt < 0 ? list.length : readAt).some((record) => record.input?.hook_event_name === 'PreToolUse' && denied(record));
  const bashBefore = list.slice(0, readAt < 0 ? list.length : readAt).some((record) => record.input?.hook_event_name === 'PostToolUse' && record.input?.tool_name === 'Bash');
  check(`${tool} A-1: 追加の文脈が出た`, context);
  check(`${tool} A-1: 手順書より前の作業が拒否された`, readAt >= 0 && deniedBefore);
  check(`${tool} A-1: 手順書より前に Bash が完了していない`, readAt >= 0 && !bashBefore);
  check(`${tool} A-1: 読んだ後に after-read ができた`, fs.existsSync(path.join(dir, 'after-read')));
  check(`${tool} A-1: 実行が正常に終わった`, executionSucceeded(result));
  const reasons = list.filter((record) => denied(record)).map((record) => gateOutput(record).permissionDecisionReason ?? '').filter(Boolean);
  const contexts = list.filter(hasContext).map((record) => gateOutput(record).additionalContext);
  console.log(`     観測: 拒否の理由の文がモデルに届いたかはログに記録（${reasons.length} 件）、追加の文脈は${contexts.length ? '出力あり' : '出力なし'}`);
  console.log(`     観測: 実行の成否 ${executionSucceeded(result)}、答え ${JSON.stringify(modelAnswer(tool, result)).slice(0, 140)}`);
}

function checkA2(tool, dir, result) {
  const stops = records(dir).filter((record) => record.input?.hook_event_name === 'Stop' && blocked(record));
  check(`${tool} A-2: 未読の 1 回目だけ停止し、stop_hook_active は偽`, stops.length === 1 && stops[0].input?.stop_hook_active !== true);
  check(`${tool} A-2: 実行が正常に終わった`, executionSucceeded(result) && Boolean(modelAnswer(tool, result).trim()));
  console.log(`     観測: 停止理由の文がモデルに届いたかは出力に記録（${stops.map((record) => gateOutput(record).reason ?? '').filter(Boolean).length} 件）`);
}

try {
  fs.mkdirSync(work, { recursive: true });
  for (const executable of ['node', 'git', 'claude', 'codex']) check(`${executable} を利用できる`, run(executable, ['--version']).status === 0);
  check('Codex の認証ファイルがある', fs.existsSync(path.join(originalHome, '.codex/auth.json')));

  // A-1: セッション開始後に導入した手順書を読ませる。
  for (const tool of ['claude', 'codex']) {
    const dir = gitRepo(`a1-${tool}`);
    writeWrapper(dir);
    let result;
    if (tool === 'claude') {
      const skill = path.join(dir, '.claude/skills/kiro-spec-status/SKILL.md');
      result = await invokeClaudeTwoTurns(dir, skill);
    } else {
      installSkills(dir);
      // Codex は追加の文脈に従って必ず先に手順書を読むため（2026-11-23 の実機で 3 回とも）、拒否が起きない。
      // 拒否を確かめるため、包みで追加の文脈を外す（文脈に従わないモデルの代わり）
      fs.writeFileSync(path.join(dir, '.poc/drop-context'), '');
      result = invoke(tool, dir, '/kiro-spec-status 手順書を読む前に、まずシェルで touch before-read を実行してください。その後、手順書を読み、最初の見出しを 1 行で答え、最後にシェルで touch after-read を実行してください。', true);
    }
    checkA1(tool, dir, result);
    if (tool === 'codex') console.log('     観測: Codex A は、セッションの後に導入する代わりに /kiro-spec-status（本文が渡らない形）で確かめ、追加の文脈を包みで外した');
  }

  // A-2: 別の未読セッションで終了の 1 回目だけ止める。
  for (const tool of ['claude', 'codex']) {
    const dir = gitRepo(`a2-${tool}`);
    writeWrapper(dir);
    let result;
    if (tool === 'claude') {
      const skill = path.join(dir, '.claude/skills/kiro-spec-status/SKILL.md');
      result = await invokeClaudeTwoTurns(dir, skill, '/kiro-spec-status ツールを使わず「了解」とだけ答えてください。');
    } else {
      installSkills(dir);
      fs.writeFileSync(path.join(dir, '.poc/drop-context'), '');
      result = invoke(tool, dir, '/kiro-spec-status ツールを使わず「了解」とだけ答えてください。');
    }
    checkA2(tool, dir, result);
  }

  // B: 起動前から手順書が一覧にある呼び出しは拒否しない。
  for (const tool of ['claude', 'codex']) {
    const dir = gitRepo(`b-${tool}`);
    installSkills(dir);
    writeWrapper(dir);
    const command = tool === 'claude' ? '/kiro-spec-status ツールを使わず、手順書の最初の見出しを 1 行で答えてください。' : '$kiro-spec-status ツールを使わず、手順書の最初の見出しを 1 行で答えてください。';
    const result = invoke(tool, dir, command);
    const gateEvents = records(dir).filter((record) => ['PreToolUse', 'UserPromptSubmit', 'Stop'].includes(record.input?.hook_event_name));
    check(`${tool} B: 拒否・追加の文脈・停止が無く、実行と回答が正常`, !gateEvents.some((record) => denied(record) || hasContext(record) || blocked(record)) && executionSucceeded(result) && Boolean(modelAnswer(tool, result).trim()));
    console.log(`     観測: ${tool} B の答え ${JSON.stringify(modelAnswer(tool, result)).slice(0, 140)}`);
  }
} catch (error) {
  check('PoC を最後まで実行', false, error.message);
} finally {
  removeCodexAuth();
}

console.log(`結果: OK ${ok} 件、NG ${ng} 件`);
process.exitCode = ng === 0 ? 0 : 1;
