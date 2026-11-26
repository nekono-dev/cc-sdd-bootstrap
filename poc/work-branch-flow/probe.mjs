#!/usr/bin/env node
// PoC 用のフック。入力を .poc/log.jsonl に記録し、モードに応じて試作の判定を返す。
//   log            記録だけ
//   gate           試作の関門: 編集のツールの対象ファイルが基底ブランチ（または detached HEAD）の作業ツリーにあれば拒否
//   gate-all       上に加えて Bash も（git の切り替え・読み取り専用以外は）拒否
//   gate-all+brw   上に加えて brw のコマンドも許可
//   context:<文>   UserPromptSubmit で追加の文脈を返す
//   agent-require:<印>   子の起動の依頼文に印が無ければ拒否し、入れるよう理由で伝える
//   agent-update:<印>    子の起動の依頼文の末尾に印を足す（updatedInput）
//   deny:<文>      PreToolUse で必ず拒否し、理由に文を入れる（複数のフックの理由が届くかの確認用）
//   block:<文>     UserPromptSubmit で入力を止める（decision: block）
//   stop-once      Stop で 1 回だけ止める（stop_hook_active が真なら通す）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2] ?? 'log';
const raw = fs.readFileSync(0, 'utf8');
let input = {};
try { input = JSON.parse(raw); } catch { /* 空 */ }

const BASE = ['main', 'master', 'develop'];
const logRoot = path.resolve(import.meta.dirname, '..'); // .poc の親（セッションを始めたリポジトリ）

function branchAt(target) {
  let dir = path.resolve(target);
  while (dir && !fs.existsSync(dir)) dir = path.dirname(dir);
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  const r = spawnSync('git', ['-C', dir, 'branch', '--show-current'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null; // null は git の外
}

function editTarget() {
  const ti = input.tool_input ?? {};
  if (ti.file_path) return path.resolve(input.cwd ?? '.', ti.file_path);
  if (ti.notebook_path) return path.resolve(input.cwd ?? '.', ti.notebook_path);
  // Codex の apply_patch: パッチ本文の「*** Add File: パス」から取る
  const text = JSON.stringify(ti).replaceAll('\\n', '\n');
  const m = text.match(/\*\*\* (?:Add|Update|Delete) File: ([^\n"\\]+)/);
  return m ? path.resolve(input.cwd ?? '.', m[1].trim()) : null;
}

const EDIT = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch)$/;
// Bash の許可: git の切り替え系・読み取り専用のコマンド（リダイレクト・連結なし）。gate-all+brw は brw も許可（brw を知らない設計では持てない許可）
const BASH_GIT = /^\s*git\s+(switch|checkout|branch|worktree|status|log|diff|show|fetch|rev-parse|remote|ls-remote)\b/;
const BASH_READ = /^\s*(ls|pwd|cat|head|tail|grep|rg|find)\b[^>;&|]*$/;
const BASH_BRW = /^\s*brw\s/;
const bashOk = (command) => BASH_GIT.test(command) || BASH_READ.test(command) || (mode === 'gate-all+brw' && BASH_BRW.test(command));

let output = null;
const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

if (input.hook_event_name === 'PreToolUse' && (mode === 'gate' || mode.startsWith('gate-all'))) {
  const name = input.tool_name ?? '';
  let where = null;
  if (EDIT.test(name)) where = editTarget();
  else if (mode.startsWith('gate-all') && /^(Bash|shell|local_shell|exec_command)$/.test(name)) {
    const command = String(input.tool_input?.command ?? input.tool_input?.cmd ?? '');
    where = bashOk(command) ? null : (input.tool_input?.workdir ?? input.cwd);
  }
  if (where) {
    const branch = branchAt(where);
    if (branch !== null && (branch === '' || BASE.includes(branch))) {
      output = deny(`現在のブランチは ${branch || '(detached HEAD)'} です。基底ブランチの上では作業しません。先に作業用ブランチへ切り替えてください（既存の作業ブランチがあればそこへ、無ければ新規作成。git switch -c <名前>）。どれか分からなければ利用者に尋ねてください。`);
    }
  }
}

if (input.hook_event_name === 'PreToolUse' && mode.startsWith('deny:')) output = deny(mode.slice('deny:'.length));
if (input.hook_event_name === 'UserPromptSubmit' && mode.startsWith('block:')) output = { decision: 'block', reason: mode.slice('block:'.length) };

if (input.hook_event_name === 'UserPromptSubmit' && mode.startsWith('context:')) {
  output = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: mode.slice('context:'.length) } };
}

if (input.hook_event_name === 'PreToolUse' && mode.startsWith('agent-require:') && /^(Agent|Task|spawn_agent|collaborationspawn_agent)$/.test(input.tool_name ?? '')) {
  const mark = mode.slice('agent-require:'.length);
  const prompt = String(input.tool_input?.prompt ?? input.tool_input?.message ?? JSON.stringify(input.tool_input ?? {}));
  if (!prompt.includes(mark)) output = deny(`子の依頼文に「${mark}」を含めて、もう一度起動してください。`);
}

if (input.hook_event_name === 'PreToolUse' && mode.startsWith('agent-update:') && /^(Agent|Task|spawn_agent|collaborationspawn_agent)$/.test(input.tool_name ?? '')) {
  const mark = mode.slice('agent-update:'.length);
  const ti = { ...(input.tool_input ?? {}) };
  const key = ['prompt', 'message'].find((k) => typeof ti[k] === 'string');
  if (key) ti[key] = `${ti[key]}\n\n${mark}`;
  output = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: ti } };
}

if (input.hook_event_name === 'Stop' && mode === 'stop-once' && !input.stop_hook_active) {
  output = { decision: 'block', reason: 'PR がまだありません。作業ブランチの PR を作ってから終えてください。' };
}

fs.mkdirSync(path.join(logRoot, '.poc'), { recursive: true });
fs.appendFileSync(path.join(logRoot, '.poc/log.jsonl'), `${JSON.stringify({ mode, input, output })}\n`);
if (output) process.stdout.write(JSON.stringify(output));
