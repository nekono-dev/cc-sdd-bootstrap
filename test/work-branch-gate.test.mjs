import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployDir = path.join(repo, ".agent-hooks/cc-sdd-bootstrap");
const SESSION = "session-one";

/** 一時の git リポジトリに配置物を置く。config は省くと設定ファイルを作らない */
function fixture(t, { config } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "work-branch-gate-test-"));
  const root = path.join(base, "repo");
  const tmp = path.join(base, "state");
  mkdirSync(root, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const hooks = path.join(root, ".agent-hooks/cc-sdd-bootstrap");
  mkdirSync(hooks, { recursive: true });
  // kiro-gate-rules.mjs は対象の入力の検出（detectCommand）に使うため、一緒に置く
  for (const name of ["work-branch-gate.mjs", "work-branch-gate-rules.mjs", "config-schema.mjs", "kiro-gate-rules.mjs"]) {
    copyFileSync(path.join(deployDir, name), path.join(hooks, name));
  }
  t.after(() => rmSync(base, { recursive: true, force: true }));
  if (config !== undefined) writeFileSync(path.join(root, ".cc-sdd-bootstrap.json"), config);
  git(root, ["init", "-q"]);
  git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return { root, tmp, base, entry: path.join(hooks, "work-branch-gate.mjs") };
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function hook(f, event, tool, input, cwd = f.root) {
  return spawnSync(process.execPath, [f.entry, event, "--tool", tool], {
    cwd, encoding: "utf8", input: JSON.stringify(input), env: { ...process.env, TMPDIR: f.tmp },
  });
}

function prompt(f, text, { tool = "claude", cwd, session = SESSION } = {}) {
  return hook(f, "user-prompt-submit", tool, { session_id: session, prompt: text, cwd: cwd ?? f.root }, cwd ?? f.root);
}

function pre(f, toolName, toolInput, { tool = "claude", cwd, session = SESSION } = {}) {
  return hook(f, "pre-tool-use", tool, { session_id: session, tool_name: toolName, tool_input: toolInput, cwd: cwd ?? f.root }, cwd ?? f.root);
}

function denial(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).hookSpecificOutput;
}

function stateFile(f, session = SESSION) {
  const key = crypto.createHash("sha256").update(`${f.root}\0${session}`).digest("hex");
  return path.join(f.tmp, "cc-sdd-bootstrap-work-branch", `${key}.json`);
}

test("基底ブランチで対象の入力を受けると、作業用ブランチへの切り替えを追加の文脈で案内する", (t) => {
  const f = fixture(t);
  const result = prompt(f, "/kiro-discovery 新機能");
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "UserPromptSubmit");
  assert.match(output.additionalContext, /main/);
  assert.match(output.additionalContext, /作業用ブランチ/);
});

test("基底ブランチでは作業を 2 回まで拒否し、3 回目は通す", (t) => {
  const f = fixture(t);
  prompt(f, "/kiro-spec-init 説明");
  for (let i = 0; i < 2; i += 1) {
    const output = denial(pre(f, "Write", { file_path: path.join(f.root, "a.md") }));
    assert.equal(output.hookEventName, "PreToolUse");
    assert.equal(output.permissionDecision, "deny");
    assert.match(output.permissionDecisionReason, /main/);
  }
  assert.equal(pre(f, "Write", { file_path: path.join(f.root, "a.md") }).stdout, "");
});

test("読み取りは基底ブランチでも拒否されない", (t) => {
  const f = fixture(t);
  prompt(f, "/kiro-impl foo");
  assert.equal(pre(f, "Read", { file_path: path.join(f.root, "a.md") }).stdout, "");
  assert.equal(pre(f, "Bash", { command: "git status" }).stdout, "");
});

test("作業ブランチへ切り替えると、以後の作業は拒否されない", (t) => {
  const f = fixture(t);
  prompt(f, "/kiro-discovery 新機能");
  assert.equal(pre(f, "Bash", { command: "git switch -c feature/x" }).stdout, "");
  git(f.root, ["switch", "-q", "-c", "feature/x"]);
  assert.equal(pre(f, "Write", { file_path: path.join(f.root, "a.md") }).stdout, "");
});

test("ブランチの切り替えを試みた後は、切り替えが働かなくても作業を拒否しない", (t) => {
  const f = fixture(t);
  prompt(f, "/kiro-impl foo");
  assert.equal(pre(f, "Bash", { command: "git switch -c feature/x" }).stdout, "");
  assert.equal(pre(f, "Write", { file_path: path.join(f.root, "a.md") }).stdout, "");
  assert.equal(pre(f, "Bash", { command: "echo a > b" }).stdout, "");
});

test("一覧表示だけの git branch は切り替えの試行にせず、以後の作業は拒否する", (t) => {
  const f = fixture(t);
  prompt(f, "/kiro-impl foo");
  assert.equal(pre(f, "Bash", { command: "git branch -a" }).stdout, "");
  assert.equal(denial(pre(f, "Write", { file_path: path.join(f.root, "a.md") })).permissionDecision, "deny");
});

test("workflow がオブジェクトでなければ（文字列・null・配列・数値）既定値で動かさず通す", (t) => {
  for (const config of ['{"workflow":"x"}', '{"workflow":null}', '{"workflow":[]}', '{"workflow":5}']) {
    const f = fixture(t, { config });
    const result = prompt(f, "/kiro-discovery 新機能");
    assert.equal(result.status, 0, `${config}: ${result.stderr}`);
    assert.equal(result.stdout, "", config);
    assert.match(result.stderr, /設定/, config);
  }
});

test("つないだ複合コマンドの切り替えは試行として通り、読み取りだけの複合コマンドは拒否の回数を使わない", (t) => {
  const f = fixture(t);
  prompt(f, "/kiro-impl foo");
  assert.equal(pre(f, "Bash", { command: "git branch --list 'dev/demo' && git status --short && git rev-parse --abbrev-ref HEAD" }).stdout, "");
  assert.equal(denial(pre(f, "Write", { file_path: path.join(f.root, "a.md") })).permissionDecision, "deny");
  assert.equal(pre(f, "Bash", { command: "(git show-ref --verify --quiet refs/heads/dev/demo && git switch dev/demo || git switch -c dev/demo) && git rev-parse --abbrev-ref HEAD" }).stdout, "");
  assert.equal(pre(f, "Write", { file_path: path.join(f.root, "a.md") }).stdout, "");
});

test("作業ブランチでは対象の入力でも作業でも何も出さない", (t) => {
  const f = fixture(t);
  git(f.root, ["switch", "-q", "-c", "feature/x"]);
  assert.equal(prompt(f, "/kiro-discovery 新機能").stdout, "");
  assert.equal(pre(f, "Write", { file_path: path.join(f.root, "a.md") }).stdout, "");
});

test("branchGate が false なら何も出さず、状態も作らない", (t) => {
  const f = fixture(t, { config: JSON.stringify({ workflow: { branchGate: false } }) });
  const first = prompt(f, "/kiro-discovery 新機能");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, "");
  assert.equal(pre(f, "Write", { file_path: path.join(f.root, "a.md") }).stdout, "");
  assert.equal(existsSync(path.join(f.tmp, "cc-sdd-bootstrap-work-branch")), false);
});

test("設定ファイルが壊れていれば通す（出力なし・終了 0・理由を標準エラーに 1 行）", (t) => {
  const f = fixture(t, { config: "{" });
  const result = prompt(f, "/kiro-discovery 新機能");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /設定/);
  assert.equal(result.stderr.trim().split("\n").length, 1);
});

test("設定の値が不正なら通す", (t) => {
  const f = fixture(t, { config: JSON.stringify({ workflow: { branchGate: "yes" } }) });
  const result = prompt(f, "/kiro-discovery 新機能");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /設定/);
});

test("設定の項目が欠けていれば既定値（有効・main,master,develop）で動く", (t) => {
  const f = fixture(t, { config: JSON.stringify({ ccSdd: { lang: "ja" } }) });
  assert.match(denialOrGuidance(prompt(f, "/kiro-discovery 新機能")), /main/);
});

test("基底ブランチの一覧を設定で変えられる", (t) => {
  const f = fixture(t, { config: JSON.stringify({ workflow: { baseBranches: "trunk" } }) });
  assert.equal(prompt(f, "/kiro-discovery 新機能").stdout, "", "main は基底の一覧に無い");
  git(f.root, ["switch", "-q", "-c", "trunk"]);
  assert.match(denialOrGuidance(prompt(f, "/kiro-discovery 新機能")), /trunk/);
});

test("設定ファイルが無ければ既定値（有効）で動く", (t) => {
  const f = fixture(t);
  assert.match(denialOrGuidance(prompt(f, "/kiro-discovery 新機能")), /main/);
});

test("git の外や現在のブランチを判定できない場合は通す", (t) => {
  const f = fixture(t);
  const outside = path.join(f.base, "outside");
  mkdirSync(outside);
  assert.equal(prompt(f, "/kiro-discovery 新機能").status, 0);
  assert.equal(pre(f, "Write", { file_path: path.join(outside, "a.md") }, { cwd: outside }).stdout, "");
  assert.equal(prompt(f, "/kiro-impl foo", { cwd: outside }).stdout, "");
});

test("detached HEAD は基底として案内する", (t) => {
  const f = fixture(t);
  git(f.root, ["checkout", "-q", "--detach"]);
  assert.match(denialOrGuidance(prompt(f, "/kiro-discovery 新機能")), /（ブランチなし）/);
});

test("状態は OS の一時ディレクトリの下にだけ作られ、リポジトリの中には何も作られない", (t) => {
  const f = fixture(t);
  prompt(f, "/kiro-discovery 新機能");
  pre(f, "Write", { file_path: path.join(f.root, "a.md") });
  const file = stateFile(f);
  assert.ok(existsSync(file), `状態ファイルがありません: ${file}`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const state = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(state).sort(), ["location", "turn", "validated"]);
  assert.equal(state.turn.denials, 1);
  assert.equal(git(f.root, ["status", "--porcelain", "-uall"]), "");
});

test("壊れた状態ファイルは出力せず、理由を標準エラーに出す", (t) => {
  const f = fixture(t);
  const file = stateFile(f);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ turn: {} }));
  const result = pre(f, "Write", { file_path: path.join(f.root, "a.md") });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /状態/);
});

test("入力の JSON が壊れていれば出力せず終了 0 で、理由を標準エラーに 1 行で出す", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [f.entry, "user-prompt-submit", "--tool", "claude"], {
    cwd: f.root, encoding: "utf8", input: "{", env: { ...process.env, TMPDIR: f.tmp },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /入力/);
  assert.equal(result.stderr.trim().split("\n").length, 1);
});

test("ツール名が無い PreToolUse の入力は出力せず理由を標準エラーに出す", (t) => {
  const f = fixture(t);
  prompt(f, "/kiro-discovery 新機能");
  const result = hook(f, "pre-tool-use", "claude", { session_id: SESSION, tool_name: "", tool_input: {} });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /ツール/);
});

test("Codex の道具名（shell の配列・apply_patch）も同じ規則で拒否し、読み取りは通す", (t) => {
  const f = fixture(t);
  prompt(f, "$kiro-impl foo", { tool: "codex" });
  assert.equal(denial(pre(f, "shell", { command: ["bash", "-lc", "echo a > b"] }, { tool: "codex" })).permissionDecision, "deny");
  assert.equal(denial(pre(f, "apply_patch", { command: "*** Begin Patch\n*** Add File: a.md\n*** End Patch" }, { tool: "codex" })).permissionDecision, "deny");
  assert.equal(pre(f, "shell", { command: ["bash", "-lc", "git status"] }, { tool: "codex" }).stdout, "");
  assert.equal(pre(f, "shell", { command: ["bash", "-lc", "echo a > b"] }, { tool: "codex" }).stdout, "");
});

test("Codex の対象の入力も、基底ブランチで追加の文脈を出す", (t) => {
  const f = fixture(t);
  const output = JSON.parse(prompt(f, "$kiro-discovery 新機能", { tool: "codex" }).stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "UserPromptSubmit");
  assert.match(output.additionalContext, /作業用ブランチ/);
});

test("不明な引数（イベントや作業ツール）は出力せず終了 0 で通す", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [f.entry, "stop", "--tool", "claude"], {
    cwd: f.root, encoding: "utf8", input: JSON.stringify({ session_id: SESSION }), env: { ...process.env, TMPDIR: f.tmp },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /フック/);
});

function denialOrGuidance(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stdout, "", "案内が出ていません");
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  return output.additionalContext ?? output.permissionDecisionReason;
}
