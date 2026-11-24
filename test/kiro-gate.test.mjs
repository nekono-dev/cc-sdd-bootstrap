import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(repo, ".agent-hooks/cc-sdd-bootstrap/kiro-gate.mjs");

function fixture(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), "kiro-gate-test-"));
  const root = path.join(base, "repo");
  const tmp = path.join(base, "state");
  mkdirSync(tmp, { recursive: true });
  const hooks = path.join(root, ".agent-hooks/cc-sdd-bootstrap");
  mkdirSync(hooks, { recursive: true });
  copyFileSync(entry, path.join(hooks, "kiro-gate.mjs"));
  copyFileSync(path.join(path.dirname(entry), "kiro-gate-rules.mjs"), path.join(hooks, "kiro-gate-rules.mjs"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { root, tmp, entry: path.join(hooks, "kiro-gate.mjs") };
}

function hook(f, event, tool, input, cwd = f.root) {
  return spawnSync(process.execPath, [f.entry, event, "--tool", tool], {
    cwd, encoding: "utf8", input: JSON.stringify(input), env: { ...process.env, TMPDIR: f.tmp },
  });
}

function skill(root, tool, name, body = `# ${name}\n手順\n`) {
  const relative = tool === "claude" ? ".claude/skills" : ".agents/skills";
  const file = path.join(root, relative, name, "SKILL.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

function stateFile(f, root, session) {
  const key = crypto.createHash("sha256").update(`${root}\0${session}`).digest("hex");
  return path.join(f.tmp, "cc-sdd-bootstrap-kiro-gate", `${key}.json`);
}

test("状態を一時領域に分け、作業場所を変えても根とセッションを取り違えない", (t) => {
  const f = fixture(t);
  skill(f.root, "claude", "kiro-x");
  const start = hook(f, "session-start", "claude", { session_id: "one", cwd: "/wrong" }, f.tmp);
  assert.equal(start.status, 0, start.stderr);
  assert.equal(start.stderr, "");
  const statePath = stateFile(f, f.root, "one");
  assert.ok(existsSync(statePath), `状態ファイルがありません: ${readdirSync(f.tmp).join(",")}`);
  assert.deepEqual(JSON.parse(readFileSync(statePath)), { listed: ["kiro-x"], turn: null });
  assert.equal(hook(f, "user-prompt-submit", "claude", { session_id: "one", prompt: "/kiro-x", cwd: "/wrong" }, os.tmpdir()).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(statePath)).turn, { skill: "kiro-x", skillPath: ".claude/skills/kiro-x/SKILL.md", read: true, stopBlocked: false });
  assert.equal(readdirSync(f.tmp).some((name) => name === "cc-sdd-bootstrap-kiro-gate"), true);
  assert.equal(readdirSync(f.root).some((name) => name.includes("kiro-gate")), false);
  assert.equal(existsSync(stateFile(f, f.root, "other")), false);
});

test("セッション開始時の一覧外スキルには追加の文脈を出し、自然文でも一覧を残す", (t) => {
  const f = fixture(t);
  skill(f.root, "codex", "kiro-old");
  hook(f, "session-start", "codex", { session_id: "s" });
  skill(f.root, "codex", "kiro-new");
  const output = hook(f, "user-prompt-submit", "codex", { session_id: "s", prompt: "$kiro-new" });
  assert.equal(output.status, 0);
  assert.match(JSON.parse(output.stdout).hookSpecificOutput.additionalContext, /\.agents\/skills\/kiro-new\/SKILL\.md/);
  hook(f, "user-prompt-submit", "codex", { session_id: "s", prompt: "通常の依頼" });
  const state = JSON.parse(readFileSync(stateFile(f, f.root, "s")));
  assert.deepEqual(state, { listed: ["kiro-old"], turn: null });
  const missing = hook(f, "user-prompt-submit", "codex", { session_id: "s", prompt: "$kiro-absent" });
  assert.equal(missing.stdout, "");
  assert.deepEqual(JSON.parse(readFileSync(stateFile(f, f.root, "s"))).listed, ["kiro-old"]);
});

test("一覧にある本文付き呼び出しは文脈を出さず読み取り済みにする", (t) => {
  const f = fixture(t);
  skill(f.root, "claude", "kiro-x");
  hook(f, "session-start", "claude", { session_id: "s" });
  const result = hook(f, "user-prompt-submit", "claude", { session_id: "s", prompt: "/kiro-x" });
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(readFileSync(stateFile(f, f.root, "s"))).turn.read, true);
});

test("壊れた JSON は出力せず日本語の理由を標準エラーに出す", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [f.entry, "user-prompt-submit", "--tool", "claude"], {
    cwd: f.root, encoding: "utf8", input: "{", env: { ...process.env, TMPDIR: f.tmp },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /入力|JSON/);
});

test("判定できない PreToolUse 入力は出力せず日本語の理由を出す", (t) => {
  const f = fixture(t);
  hook(f, "session-start", "claude", { session_id: "invalid-call" });
  skill(f.root, "claude", "kiro-new");
  hook(f, "user-prompt-submit", "claude", { session_id: "invalid-call", prompt: "/kiro-new" });
  for (const call of [
    { tool_name: "", tool_input: {} },
    { tool_name: "Bash", tool_input: null },
  ]) {
    const result = hook(f, "pre-tool-use", "claude", { session_id: "invalid-call", ...call });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /日本語|判定|ツール/);
  }
});

test("不正な turn 状態の終了は止めずに出力なしで理由を出す", (t) => {
  const f = fixture(t);
  hook(f, "session-start", "claude", { session_id: "invalid-state" });
  const statePath = stateFile(f, f.root, "invalid-state");
  writeFileSync(statePath, JSON.stringify({ listed: [], turn: {} }));
  const result = hook(f, "stop", "claude", { session_id: "invalid-state", stop_hook_active: false });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /状態/);
});

test("状態の保存に失敗したときも日本語の理由を出して通す", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root では読み取り専用の権限を再現できません");
    return;
  }
  const f = fixture(t);
  hook(f, "session-start", "claude", { session_id: "save-error" });
  const stateDirectory = path.dirname(stateFile(f, f.root, "save-error"));
  chmodSync(stateDirectory, 0o555);
  let result;
  try {
    result = hook(f, "session-start", "claude", { session_id: "save-error" });
  } finally {
    // 後片付け（一時ディレクトリの削除）より前に権限を戻す
    chmodSync(stateDirectory, 0o755);
  }
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /状態の保存に失敗しました/);
});

test("自然文の保存に失敗しても前の依頼の強制を解除する", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root では読み取り専用の権限を再現できません");
    return;
  }
  const f = fixture(t);
  hook(f, "session-start", "claude", { session_id: "clear-on-error" });
  // 一覧外（未読で始まる）にするため、手順書はセッション開始の後に作る
  skill(f.root, "claude", "kiro-x");
  const prompt = hook(f, "user-prompt-submit", "claude", { session_id: "clear-on-error", prompt: "/kiro-x" });
  assert.notEqual(prompt.stdout, "");
  const stateDirectory = path.dirname(stateFile(f, f.root, "clear-on-error"));
  chmodSync(stateDirectory, 0o555);
  let result;
  try {
    result = hook(f, "user-prompt-submit", "claude", { session_id: "clear-on-error", prompt: "通常の依頼" });
  } finally {
    // 後片付けの前に状態ディレクトリの権限を戻す
    chmodSync(stateDirectory, 0o755);
  }
  assert.equal(result.status, 0);
  assert.match(result.stderr, /状態の保存に失敗しました/);
  const allowed = hook(f, "pre-tool-use", "claude", { session_id: "clear-on-error", tool_name: "Bash", tool_input: { command: "echo hello" } });
  assert.equal(allowed.stdout, "");
});

test("新しい依頼の保存に失敗しても古い依頼の強制を残さない", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root では読み取り専用の権限を再現できません");
    return;
  }
  const f = fixture(t);
  hook(f, "session-start", "claude", { session_id: "replace-on-error" });
  // 一覧外（未読で始まる）にするため、手順書はセッション開始の後に作る
  skill(f.root, "claude", "kiro-x");
  skill(f.root, "claude", "kiro-y");
  const prompt = hook(f, "user-prompt-submit", "claude", { session_id: "replace-on-error", prompt: "/kiro-x" });
  assert.notEqual(prompt.stdout, "");
  const stateDirectory = path.dirname(stateFile(f, f.root, "replace-on-error"));
  chmodSync(stateDirectory, 0o555);
  let result;
  try {
    result = hook(f, "user-prompt-submit", "claude", { session_id: "replace-on-error", prompt: "/kiro-y" });
  } finally {
    // 後片付けの前に状態ディレクトリの権限を戻す
    chmodSync(stateDirectory, 0o755);
  }
  assert.equal(result.status, 0);
  assert.match(result.stderr, /状態の保存に失敗しました/);
  const denied = hook(f, "pre-tool-use", "claude", { session_id: "replace-on-error", tool_name: "Bash", tool_input: { command: "echo hello" } });
  assert.notEqual(denied.stdout, "");
  assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /kiro-y/);
  assert.doesNotMatch(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /kiro-x/);
});

test("同じ一時領域でも別セッションと別の根の状態を混ぜない", (t) => {
  const first = fixture(t);
  const second = fixture(t);
  second.tmp = first.tmp;
  skill(first.root, "claude", "kiro-first");
  skill(second.root, "claude", "kiro-second");
  hook(first, "session-start", "claude", { session_id: "shared" });
  hook(second, "session-start", "claude", { session_id: "shared" });

  const firstTurn = hook(first, "user-prompt-submit", "claude", { session_id: "shared", prompt: "/kiro-first" });
  assert.equal(firstTurn.stdout, "");
  assert.equal(JSON.parse(readFileSync(stateFile(first, first.root, "shared"))).turn.read, true);
  hook(second, "user-prompt-submit", "claude", { session_id: "shared", prompt: "/kiro-second" });
  const firstState = stateFile(first, first.root, "shared");
  const secondState = stateFile(first, second.root, "shared");
  assert.equal(JSON.parse(readFileSync(firstState)).turn.skill, "kiro-first");
  assert.equal(JSON.parse(readFileSync(firstState)).turn.read, true);
  assert.equal(JSON.parse(readFileSync(secondState)).turn.skill, "kiro-second");

  const otherSession = hook(first, "user-prompt-submit", "claude", { session_id: "other", prompt: "/kiro-first" });
  assert.notEqual(otherSession.stdout, "");
  const otherSessionState = JSON.parse(readFileSync(stateFile(first, first.root, "other")));
  assert.deepEqual(otherSessionState, { listed: [], turn: { skill: "kiro-first", skillPath: ".claude/skills/kiro-first/SKILL.md", read: false, stopBlocked: false } });
  assert.equal(JSON.parse(readFileSync(firstState)).turn.skill, "kiro-first");
  assert.equal(JSON.parse(readFileSync(secondState)).turn.skill, "kiro-second");
});

test("Claude Code は手順書を読むまで拒否し、読んだ後は通す", (t) => {
  const f = fixture(t);
  hook(f, "session-start", "claude", { session_id: "flow" });
  const file = skill(f.root, "claude", "kiro-new", "\n\n# 最初の見出し\n手順\n");
  const prompt = hook(f, "user-prompt-submit", "claude", { session_id: "flow", prompt: "/kiro-new" });
  assert.notEqual(prompt.stdout, "");
  const denied = hook(f, "pre-tool-use", "claude", { session_id: "flow", tool_name: "Bash", tool_input: { command: "echo hello" } });
  assert.deepEqual(JSON.parse(denied.stdout), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "先に手順書 .claude/skills/kiro-new/SKILL.md を読んでから、作業を進めてください。" } });
  const read = hook(f, "post-tool-use", "claude", { session_id: "flow", tool_name: "Read", tool_input: { file_path: file }, tool_response: "# 最初の見出し\n手順\n" });
  assert.equal(read.stdout, "");
  const allowed = hook(f, "pre-tool-use", "claude", { session_id: "flow", tool_name: "Bash", tool_input: { command: "echo hello" } });
  assert.equal(allowed.stdout, "");
  assert.equal(JSON.parse(readFileSync(stateFile(f, f.root, "flow"))).turn.read, true);
});

test("Codex は手順書の cat の成功後に Bash を通す", (t) => {
  const f = fixture(t);
  const file = skill(f.root, "codex", "kiro-new", "\n# Codex の手順\n");
  hook(f, "session-start", "codex", { session_id: "codex-flow" });
  hook(f, "user-prompt-submit", "codex", { session_id: "codex-flow", prompt: "/kiro-new" });
  const read = hook(f, "post-tool-use", "codex", { session_id: "codex-flow", cwd: f.root, tool_name: "Bash", tool_input: { command: `cat ${file}` }, tool_response: "# Codex の手順\n" });
  assert.equal(read.stdout, "");
  const allowed = hook(f, "pre-tool-use", "codex", { session_id: "codex-flow", cwd: f.root, tool_name: "Bash", tool_input: { command: "echo hello" } });
  assert.equal(allowed.stdout, "");
  assert.equal(JSON.parse(readFileSync(stateFile(f, f.root, "codex-flow"))).turn.read, true);
});

test("未読の終了は一度止め、二度目は通して turn だけ消す", (t) => {
  const f = fixture(t);
  skill(f.root, "claude", "kiro-old");
  hook(f, "session-start", "claude", { session_id: "stop-flow" });
  assert.deepEqual(JSON.parse(readFileSync(stateFile(f, f.root, "stop-flow"))), { listed: ["kiro-old"], turn: null });
  skill(f.root, "claude", "kiro-new");
  hook(f, "user-prompt-submit", "claude", { session_id: "stop-flow", prompt: "/kiro-new" });
  assert.equal(JSON.parse(readFileSync(stateFile(f, f.root, "stop-flow"))).turn.read, false);
  const first = hook(f, "stop", "claude", { session_id: "stop-flow", stop_hook_active: false });
  assert.deepEqual(JSON.parse(first.stdout), { decision: "block", reason: "手順書 .claude/skills/kiro-new/SKILL.md を先に読んでから、作業を続けてください。" });
  assert.equal(JSON.parse(readFileSync(stateFile(f, f.root, "stop-flow"))).turn.stopBlocked, true);
  const second = hook(f, "stop", "claude", { session_id: "stop-flow", stop_hook_active: false });
  assert.equal(second.stdout, "");
  assert.deepEqual(JSON.parse(readFileSync(stateFile(f, f.root, "stop-flow"))), { listed: ["kiro-old"], turn: null });
});

test("未読でも stop_hook_active が真なら通して turn を消す", (t) => {
  const f = fixture(t);
  hook(f, "session-start", "claude", { session_id: "active-stop" });
  skill(f.root, "claude", "kiro-new");
  hook(f, "user-prompt-submit", "claude", { session_id: "active-stop", prompt: "/kiro-new" });
  assert.equal(JSON.parse(readFileSync(stateFile(f, f.root, "active-stop"))).turn.read, false);
  const result = hook(f, "stop", "claude", { session_id: "active-stop", stop_hook_active: true });
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(readFileSync(stateFile(f, f.root, "active-stop"))), { listed: [], turn: null });
});
