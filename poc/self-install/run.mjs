#!/usr/bin/env node
// 実機の Claude Code・Codex で session-install の導入と停止を確かめる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const work = path.join(os.homedir(), '.cache/cc-sdd-bootstrap-scratch/self-install');
const originalHome = os.homedir();
let ok = 0;
let ng = 0;
const results = [];

function check(label, condition, detail = '') {
  const passed = Boolean(condition);
  console.log(`${passed ? 'OK' : 'NG'} ${label}${detail ? `: ${detail}` : ''}`);
  results.push({ label, passed, detail });
  passed ? ok++ : ng++;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 600_000, ...options });
}

function gitRepo(name, configure = false) {
  const dir = path.join(work, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const init = run('git', ['init', '-q'], { cwd: dir });
  if (init.status !== 0) throw new Error(`git init に失敗: ${init.stderr}`);
  const bootstrap = run(process.execPath, [path.join(repo, 'bin/cc-sdd-bootstrap.mjs'), 'init'], { cwd: dir });
  if (bootstrap.status !== 0) throw new Error(`cc-sdd-bootstrap init に失敗: ${bootstrap.stderr}`);
  if (configure) {
    const file = path.join(dir, '.cc-sdd-bootstrap.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.ccSdd ??= {};
    data.ccSdd.version = '0.0.0-poc';
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  }
  return dir;
}

function hasSkill(dir, tool) {
  const p = tool === 'claude'
    ? '.claude/skills/kiro-spec-status/SKILL.md'
    : '.agents/skills/kiro-spec-status/SKILL.md';
  return fs.existsSync(path.join(dir, p));
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
  if (!fs.existsSync(base)) return;
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (entry.isDirectory()) fs.rmSync(path.join(base, entry.name, 'auth.json'), { force: true });
  }
}

function invoke(tool, dir, prompt) {
  if (tool === 'claude') {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    return run('claude', ['-p', '--setting-sources', 'project', '--output-format', 'stream-json', '--verbose', prompt], { cwd: dir, env });
  }
  const home = setupCodexHome(dir);
  try {
    return run('codex', ['-a', 'never', 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '-s', 'read-only', '--cd', dir, prompt], {
      cwd: dir,
      env: { ...process.env, CODEX_HOME: home },
    });
  } finally {
    fs.rmSync(path.join(home, 'auth.json'), { force: true });
  }
}

function output(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function jsonLines(result) {
  return output(result).split('\n').flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function codexCommands(result) {
  return jsonLines(result).filter((e) => e.item?.type === 'command_execution').map((e) => e.item);
}

function modelAnswer(tool, result) {
  if (tool === 'codex') {
    return jsonLines(result).filter((e) => e.item?.type === 'agent_message')
      .map((e) => String(e.item.text ?? '')).at(-1) ?? '';
  }
  return jsonLines(result).filter((e) => e.type === 'result')
    .map((e) => String(e.result ?? '')).at(-1) ?? '';
}

function observedSkillRead(tool, result) {
  const skillPath = 'kiro-spec-status/SKILL.md';
  if (tool === 'codex') {
    return codexCommands(result).some((item) => {
      const command = String(item.command ?? '');
      // 読み取りのコマンドの種類（cat・sed・rg など）は回によって変わるので問わない。成功と、出力に手順書の見出しが含まれることで判定する
      return command.includes(skillPath) && item.exit_code === 0
        && /Specification Status|kiro-spec-status Skill|Show specification status/.test(String(item.aggregated_output ?? ''));
    });
  }
  const events = jsonLines(result);
  const reads = events.flatMap((e) => e.type === 'assistant' ? (e.message?.content ?? []) : [])
    .filter((item) => item.type === 'tool_use' && item.name === 'Read'
      && String(item.input?.file_path ?? '').includes(skillPath));
  return reads.some((read) => events.some((e) => e.type === 'user'
    && (e.message?.content ?? []).some((item) => item.type === 'tool_result'
      && item.tool_use_id === read.id && item.is_error !== true
      && /kiro-spec-status Skill|Show specification status/.test(typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? '')))));
}

function executionSucceeded(result) {
  const text = output(result);
  const failedEvent = jsonLines(result).some((event) => ['error', 'turn.failed'].includes(event.type));
  return !result.error && result.status === 0 && !result.signal
    && !failedEvent
    && !/API Error|API rate limit|connection error|ECONN(?:RESET|REFUSED)|ETIMEDOUT|timed out|overloaded/i.test(text);
}

function hasModelAnswer(tool, result) {
  return Boolean(modelAnswer(tool, result).trim());
}

function stopped(tool, result) {
  const text = output(result);
  if (!executionSucceeded(result)) return false;
  // Claude Code は入力を止めたときも、止めた理由を結果（result）として返す。止めた理由が出て、モデルがツールを使っていないことで判定する
  if (tool === 'claude') return /UserPromptSubmit operation blocked by hook|導入が完了していない/.test(text)
    && !jsonLines(result).some((e) => e.type === 'assistant' && (e.message?.content ?? []).some((c) => c.type === 'tool_use'));
  return !hasModelAnswer(tool, result);
}

function hasOneTrailingSection(file) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const begin = '<!-- cc-sdd-bootstrap:begin（この区画は cc-sdd の導入のたびに書き足される。編集しない） -->';
  const end = '<!-- cc-sdd-bootstrap:end -->';
  const begins = text.split(begin);
  const ends = text.split(end);
  const beginAt = text.indexOf(begin);
  const endAt = text.indexOf(end);
  return begins.length === 2 && ends.length === 2
    && beginAt < endAt && text.slice(endAt + end.length).trim() === '';
}

try {
  fs.mkdirSync(work, { recursive: true });
  for (const executable of ['node', 'git', 'claude', 'codex']) {
    check(`${executable} を利用できる`, executable === 'node' || executable === 'git'
      ? run(executable, ['--version']).status === 0
      : run(executable, ['--version']).status === 0);
  }
  check('Codex の認証ファイルがある', fs.existsSync(path.join(originalHome, '.codex/auth.json')));

  // a. 起動前に導入し、初回セッションのスキル一覧と利用を確認する。
  const pre = gitRepo('preinstall');
  const installed = run(process.execPath, ['.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs'], { cwd: pre });
  check('a: 起動前の導入が成功', installed.status === 0, `終了コード ${installed.status}`);
  for (const tool of ['claude', 'codex']) {
    const document = path.join(pre, tool === 'claude' ? 'CLAUDE.md' : 'AGENTS.md');
    check(`a: ${tool} のスキルと標準文書が配置された`, hasSkill(pre, tool) && fs.existsSync(document));
    check(`a: ${tool} の標準文書末尾に運用の区画が 1 つある`, hasOneTrailingSection(document));
  }
  const claudeInit = invoke('claude', pre, 'PONG とだけ答えてください。');
  check('a: Claude Code の system init に kiro-spec-status が載る', executionSucceeded(claudeInit)
    && /"slash_commands"[^\n]*"kiro-spec-status"/.test(claudeInit.stdout));
  const codexSkill = invoke('codex', pre, '$kiro-spec-status の手順書の最初の見出しを、ツールを使わず 1 行で答えてください。');
  console.log(`     観測: a の Codex の答え ${JSON.stringify(modelAnswer('codex', codexSkill)).slice(0, 160)}、実行したコマンド ${codexCommands(codexSkill).length} 件、実行の成否 ${executionSucceeded(codexSkill)}`);
  check('a: Codex がツールを使わず手順書の最初の見出しを答える', executionSucceeded(codexSkill)
    && codexCommands(codexSkill).length === 0
    // Codex 向けの手順書は Claude Code 向けと見出しが違う（# Specification Status）
    && /Specification Status|kiro-spec-status Skill|Show specification status/.test(modelAnswer('codex', codexSkill)));

  // b. init のみの別リポジトリで、通常入力から両ツールの導入を始める。
  for (const tool of ['claude', 'codex']) {
    const dir = gitRepo(`first-input-${tool}`);
    const response = invoke(tool, dir, 'kiro-spec-status の手順書を読み、その最初の見出しを 1 行で答えてください。');
    check(`b: ${tool} の最初の入力で導入物と状態記録ができる`, hasSkill(dir, tool)
      && fs.existsSync(path.join(dir, '.cache/cc-sdd-install.state.json')));
    for (const docTool of ['claude', 'codex']) {
      const document = path.join(dir, docTool === 'claude' ? 'CLAUDE.md' : 'AGENTS.md');
      check(`b: ${tool} の導入で ${path.basename(document)} の末尾に運用の区画が 1 つある`,
        hasOneTrailingSection(document));
    }
    check(`b: ${tool} が入力フックから成功した読み取りで手順書を直接読む`, executionSucceeded(response)
      && observedSkillRead(tool, response));
    if (tool === 'codex') console.log(`     観測: Codex が実行したコマンド ${JSON.stringify(codexCommands(response).map((item) => ({ command: item.command, exit_code: item.exit_code }))).slice(0, 300)}`);
  }

  // c. 別リポジトリの存在しない版で、両ツールの入力が停止する。
  for (const tool of ['claude', 'codex']) {
    const dir = gitRepo(`bad-version-${tool}`, true);
    const response = invoke(tool, dir, 'この作業を始めてください。');
    check(`c: ${tool} の失敗記録が残る`, fs.existsSync(path.join(dir, '.cache/cc-sdd-install.failed')));
    if (tool === 'claude') {
      check(`c: ${tool} の入力が停止し、理由と再試行方法が見える`, stopped(tool, response)
        && /install-cc-sdd\.mjs/.test(output(response)));
    } else {
      // codex exec --json はフックが止めた理由を出力に出さない（2026-11-23、Codex 0.167.0 で確認）。
      // 止まったこと（モデルの応答が無い）を確かめ、理由の文が出力に出るかは観測として残す
      // 実行が正常に終わり（異常終了・時間切れ・通信障害は NG）、モデルの応答が無いことで判定する
      check(`c: ${tool} の入力が停止する（モデルの応答が無い）`, stopped(tool, response));
      console.log(`     観測: Codex の出力に止めた理由の文が${/install-cc-sdd\.mjs/.test(output(response)) ? '出る' : '出ない（exec の出力には現れない）'}`);
    }
  }
} catch (error) {
  check('PoC を最後まで実行', false, error.message);
} finally {
  removeCodexAuth();
}

console.log(`結果: OK ${ok} 件、NG ${ng} 件`);
process.exitCode = ng === 0 ? 0 : 1;
