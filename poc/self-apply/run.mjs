#!/usr/bin/env node
// 自己適用済みのこのリポジトリで Claude Code と Codex を確認する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const originalHome = os.homedir();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sdd-bootstrap-self-apply-'));
let ok = 0;
let ng = 0;
const date = new Date().toISOString().slice(0, 10);

function check(label, passed, detail = '') {
  const status = Boolean(passed);
  console.log(`${status ? 'OK' : 'NG'} ${label}${detail ? `: ${detail}` : ''}`);
  status ? ok++ : ng++;
}
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 600_000, ...options });
}
function lines(text) {
  return text.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function output(result) { return `${result.stdout ?? ''}\n${result.stderr ?? ''}`; }
function sessionId(events) {
  for (const event of events) {
    if (typeof event.session_id === 'string' && event.session_id) return event.session_id;
    if (typeof event.sessionId === 'string' && event.sessionId) return event.sessionId;
    if (typeof event.thread_id === 'string' && event.thread_id) return event.thread_id;
  }
  return '';
}
function gateState(sid) {
  if (!sid) return null;
  const key = createHash('sha256').update(`${repo}\0${sid}`).digest('hex');
  const file = path.join(os.tmpdir(), 'cc-sdd-bootstrap-kiro-gate', `${key}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function answer(tool, events) {
  if (tool === 'claude') return events.filter((event) => event.type === 'result').map((event) => String(event.result ?? '')).at(-1) ?? '';
  return events.filter((event) => event.item?.type === 'agent_message').map((event) => String(event.item.text ?? '')).at(-1) ?? '';
}
function skillInvocationObserved(tool, events) {
  if (tool === 'claude') {
    // -p で先頭に /kiro-spec-status を書くと、手順書の本文がそのまま依頼として展開され、出力には現れない（Skill や Read の呼び出しも出ない）。
    // そのため、init の skills に載っていることと、手順書の Step 1（spec.json を読む）から作業を始めたことを合わせて証拠とする。
    const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
    const firstRead = events.filter((event) => event.type === 'assistant')
      .flatMap((event) => event.message?.content ?? [])
      .find((item) => item.type === 'tool_use' && item.name === 'Read');
    if (Array.isArray(init?.skills) && init.skills.includes('kiro-spec-status')
      && /\.kiro\/specs\/kiro-gate\/spec\.json$/.test(String(firstRead?.input?.file_path ?? ''))) return true;
    return events.some((event) => event.type === 'assistant'
      && (event.message?.content ?? []).some((item) => item.type === 'tool_use'
        && (item.name === 'Skill' && /kiro-spec-status/.test(JSON.stringify(item.input ?? {}))
          || item.name === 'Read' && /\.claude\/skills\/kiro-spec-status\/SKILL\.md/.test(String(item.input?.file_path ?? '')))));
  }
  return events.some((event) => event.item?.type === 'command_execution'
    && /\.agents\/skills\/kiro-spec-status\/SKILL\.md/.test(String(event.item.command ?? '')));
}
// kiro-gate の拒否の文言（kiro-gate-rules.mjs の messageDeny）。設計書などを読んだだけで一致しないよう、手順書のパスまで含めて照合する。
const denyPattern = /先に手順書 \S+\/skills\/kiro-[a-z0-9-]+\/SKILL\.md を読んでから/;
function gateDenied(tool, events) {
  if (tool === 'claude') return events.some((event) => event.type === 'user'
    && (event.message?.content ?? []).some((item) => item.type === 'tool_result'
      && denyPattern.test(typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? ''))));
  return events.some((event) => denyPattern.test(JSON.stringify(event.item ?? {}))
    && event.item?.type !== 'agent_message');
}
function succeeded(result, events) {
  const text = output(result);
  return !result.error && result.status === 0 && !result.signal
    && !events.some((event) => ['error', 'turn.failed'].includes(event.type))
    && !/API Error|API rate limit|connection error|ECONN(?:RESET|REFUSED)|ETIMEDOUT|timed out|overloaded/i.test(text);
}
function codexHome() {
  const source = path.join(originalHome, '.codex/auth.json');
  if (!fs.existsSync(source)) throw new Error('~/.codex/auth.json がありません');
  const home = path.join(temp, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  fs.copyFileSync(source, path.join(home, 'auth.json'));
  fs.chmodSync(path.join(home, 'auth.json'), 0o600);
  fs.writeFileSync(path.join(home, 'config.toml'), `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`);
  return home;
}

try {
  console.log(`実行日: ${date}`);
  for (const executable of ['node', 'claude', 'codex']) {
    const version = run(executable, ['--version']);
    check(`${executable} を利用できる`, version.status === 0, (version.stdout || version.stderr || '').trim().split(/\r?\n/)[0] ?? '');
  }
  const claudeHelp = run('claude', ['-p', '--help']);
  const codexHelp = run('codex', ['exec', '--help']);
  check('Claude Code が Read のみに制限する --tools オプションを持つ', claudeHelp.status === 0 && /--tools\b/.test(output(claudeHelp)));
  check('Codex exec が読み取り専用・検証用 hook trust 回避・JSON 出力を持つ', codexHelp.status === 0
    && /--sandbox\b|\s-s\b/.test(output(codexHelp)) && /--dangerously-bypass-hook-trust/.test(output(codexHelp)) && /--json\b/.test(output(codexHelp)));

  const guidancePrompt = 'この会話で読み込まれた指示の文面だけを根拠に、プロジェクト独自の決まりを読むディレクトリのパスだけを1行で答えてください。ファイルを開かないでください。';
  const claudeSkillPrompt = '/kiro-spec-status kiro-gate';
  const claudeEnv = { ...process.env };
  delete claudeEnv.CLAUDECODE;
  delete claudeEnv.CLAUDE_CODE_ENTRYPOINT;
  const claudeArgs = ['-p', '--setting-sources', 'project', '--model', 'haiku', '--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep', '--output-format', 'stream-json', '--verbose'];
  const claudeGuidance = run('claude', [...claudeArgs, guidancePrompt], { cwd: repo, env: claudeEnv });
  const claudeGuidanceEvents = lines(output(claudeGuidance));
  const claudeGuidanceText = answer('claude', claudeGuidanceEvents);
  check('Claude Code: 案内の入力で SessionStart の listed に kiro-spec-status がある', Array.isArray(gateState(sessionId(claudeGuidanceEvents))?.listed) && gateState(sessionId(claudeGuidanceEvents)).listed.includes('kiro-spec-status'));
  check('Claude Code: 案内の文面だけから steering のパスを答えた', succeeded(claudeGuidance, claudeGuidanceEvents) && /\.kiro\/steering\//.test(claudeGuidanceText), `回答 ${JSON.stringify(claudeGuidanceText.slice(0, 240))}`);
  const claude = run('claude', [...claudeArgs, claudeSkillPrompt], { cwd: repo, env: claudeEnv });
  const claudeEvents = lines(output(claude));
  const claudeText = answer('claude', claudeEvents);
  const claudeState = gateState(sessionId(claudeEvents));
  check('Claude Code: スキル入力の SessionStart listed に kiro-spec-status がある', Array.isArray(claudeState?.listed) && claudeState.listed.includes('kiro-spec-status'));
  check('Claude Code: 2 回目にスキル起動または SKILL.md 読み取りがある', succeeded(claude, claudeEvents) && skillInvocationObserved('claude', claudeEvents));
  check('Claude Code: 2 回目に kiro-gate の拒否がない', !gateDenied('claude', claudeEvents));
  check('Claude Code: /kiro-spec-status が動き、kiro-gate の進捗を報告', succeeded(claude, claudeEvents) && /kiro-gate/.test(claudeText) && /(完了|タスク|進捗)/.test(claudeText), `終了コード ${claude.status}、回答 ${JSON.stringify(claudeText.slice(-400))}`);

  const codexFirst = 'この会話で読み込まれた指示の文面だけを根拠に、プロジェクト独自の決まりを読むディレクトリのパスだけを1行で答えてください。ファイルを開かないでください.';
  const home = codexHome();
  let codexGuidance;
  let codex;
  try {
    const args = ['-a', 'never', 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '-s', 'read-only', '--model', 'gpt-6-luna', '-c', 'model_reasoning_effort="low"', '--cd', repo];
    codexGuidance = run('codex', [...args, codexFirst], {
      cwd: repo, env: { ...process.env, CODEX_HOME: home },
    });
    codex = run('codex', [...args, '$kiro-spec-status kiro-gate'], {
      cwd: repo, env: { ...process.env, CODEX_HOME: home },
    });
  } finally {
    fs.rmSync(path.join(home, 'auth.json'), { force: true });
  }
  const codexGuidanceEvents = lines(output(codexGuidance));
  const codexGuidanceText = answer('codex', codexGuidanceEvents);
  const codexGuidanceState = gateState(sessionId(codexGuidanceEvents));
  check('Codex: 案内の入力で SessionStart の listed に kiro-spec-status がある', Array.isArray(codexGuidanceState?.listed) && codexGuidanceState.listed.includes('kiro-spec-status'));
  check('Codex: 案内の文面だけから steering のパスを答えた', succeeded(codexGuidance, codexGuidanceEvents) && /\.kiro\/steering\//.test(codexGuidanceText), `回答 ${JSON.stringify(codexGuidanceText.slice(0, 240))}`);
  const codexEvents = lines(output(codex));
  const codexText = answer('codex', codexEvents);
  const codexSid = sessionId(codexEvents);
  const codexState = gateState(codexSid);
  check('Codex: SessionStart のフックが状態を作り、kiro-spec-status を一覧に記録', Array.isArray(codexState?.listed) && codexState.listed.includes('kiro-spec-status'), `session_id ${codexSid ? '取得' : 'なし'}、listed=${JSON.stringify(codexState?.listed ?? null)}`);
  check('Codex: 2 回目にスキル起動または手順書読み取りがある', succeeded(codex, codexEvents) && skillInvocationObserved('codex', codexEvents));
  check('Codex: 2 回目に kiro-gate の拒否がない', !gateDenied('codex', codexEvents));
  check('Codex: $kiro-spec-status が動き、kiro-gate の進捗を報告', succeeded(codex, codexEvents) && /kiro-gate/.test(codexText) && /(完了|タスク|進捗)/.test(codexText), `終了コード ${codex.status}、回答 ${JSON.stringify(codexText.slice(-400))}`);
  console.log(`観測 Codex: 状態ファイル listed=${JSON.stringify(codexState?.listed ?? null)}。状態ファイルは読み取りのみ`);
} catch (error) {
  check('実機確認を最後まで実行', false, error.message);
} finally {
  // 一時 CODEX_HOME の認証複写を含む専用ディレクトリだけを片付ける。
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`結果: OK ${ok} 件、NG ${ng} 件`);
process.exitCode = ng === 0 ? 0 : 1;
