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
