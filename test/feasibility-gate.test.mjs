// 実現性の確認のフックの入口（feasibility-gate.mjs）の試験。標準入力・一時の git リポジトリで確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployDir = path.join(repo, ".agent-hooks/cc-sdd-bootstrap");
const RECORD = "feasibility.md";
const ONE_MIB = 1024 * 1024;

/**
 * 一時の作業場所を作る。root は git リポジトリ（inGit が真のとき）で、入口と判定の 2 つの配置物を置く。
 * base は root の外（git の外）。
 */
function fixture(t, { inGit = true } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "feasibility-gate-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "repo");
  const hooks = path.join(root, ".agent-hooks/cc-sdd-bootstrap");
  mkdirSync(hooks, { recursive: true });
  for (const name of ["feasibility-gate.mjs", "feasibility-gate-rules.mjs", "kiro-gate-rules.mjs"]) {
    copyFileSync(path.join(deployDir, name), path.join(hooks, name));
  }
  mkdirSync(path.join(root, ".kiro/specs"), { recursive: true });
  if (inGit) git(root, ["init", "-q"]);
  return { base, root, entry: path.join(hooks, "feasibility-gate.mjs") };
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** spec のディレクトリを作る（記録は任意） */
function spec(f, name, record) {
  const dir = path.join(f.root, ".kiro/specs", name);
  mkdirSync(dir, { recursive: true });
  if (record !== undefined) writeFileSync(path.join(dir, RECORD), record);
  return dir;
}

/** 3 節の記録。判定の語は引数で変える */
function recordText({ need = "必要", design = "通過", tasks = "通過" } = {}) {
  return [
    "# 実現性の記録",
    "",
    "## 実機検証の要否",
    `- 判定: ${need}`,
    "",
    "## 設計の確認",
    `- 判定: ${design}`,
    "",
    "## タスク計画の確認",
    `- 判定: ${tasks}`,
    "",
  ].join("\n");
}

/** 入口を user-prompt-submit で動かす。input が文字列ならそのまま標準入力に渡す */
function run(entry, { tool = "claude", cwd, input }) {
  const stdin = typeof input === "string" ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [entry, "user-prompt-submit", "--tool", tool], { cwd, encoding: "utf8", input: stdin });
}

/** 利用者の入力を送る */
function submit(f, prompt, { tool = "claude", cwd = f.root } = {}) {
  return run(f.entry, { tool, cwd, input: { session_id: "s1", prompt, cwd } });
}

/** 止められたことを確かめ、理由を返す */
function assertBlocked(result) {
  assert.equal(result.status, 0);
  const value = JSON.parse(result.stdout);
  assert.equal(value.decision, "block");
  return value.reason;
}

/** 通されたことを確かめる（出力なし・終了 0） */
function assertPassed(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
}

test("記録が無いと /kiro-spec-tasks を止め、理由に spec 名・手順・記録の場所を入れる（Claude Code）", (t) => {
  const f = fixture(t);
  spec(f, "foo");
  const reason = assertBlocked(submit(f, "/kiro-spec-tasks foo -y"));
  assert.match(reason, /spec `foo`/);
  assert.match(reason, /記録がありません/);
  assert.match(reason, /\/kiro-spec-design/);
  assert.match(reason, /\.kiro\/specs\/foo\/feasibility\.md/);
});

test("記録の設計が通過なら /kiro-spec-tasks を通す（出力なし）", (t) => {
  const f = fixture(t);
  spec(f, "foo", recordText({ design: "通過", tasks: "未通過" }));
  assertPassed(submit(f, "/kiro-spec-tasks foo -y"));
});

test("Codex は $kiro-impl で動き、タスク計画が未通過なら止め、通過なら通す", (t) => {
  const f = fixture(t);
  spec(f, "foo", recordText({ design: "通過", tasks: "未通過" }));
  const reason = assertBlocked(submit(f, "$kiro-impl foo 1.1", { tool: "codex" }));
  assert.match(reason, /タスク計画/);
  assert.match(reason, /判定が通過ではありません/);

  spec(f, "foo", recordText({ tasks: "通過" }));
  assertPassed(submit(f, "$kiro-impl foo 1.1", { tool: "codex" }));
});

test("kiro-impl は設計だけ通過していても、タスク計画が通らなければ止める", (t) => {
  const f = fixture(t);
  spec(f, "foo", recordText({ design: "通過", tasks: "未通過" }));
  assertBlocked(submit(f, "/kiro-impl foo"));
});

test("記録が読めない形は止まる: ディレクトリが feasibility.md・巨大・判定の語が想定外（標準エラーには書かない）", (t) => {
  const f = fixture(t);
  const dir = spec(f, "dirrec");
  mkdirSync(path.join(dir, RECORD));
  const dirResult = submit(f, "/kiro-spec-tasks dirrec");
  assertBlocked(dirResult);
  assert.equal(dirResult.stderr, "");

  spec(f, "huge", recordText() + " ".repeat(ONE_MIB + 1));
  const hugeResult = submit(f, "/kiro-spec-tasks huge");
  assertBlocked(hugeResult);
  assert.equal(hugeResult.stderr, "");

  spec(f, "odd", recordText({ design: "OK" }));
  assertBlocked(submit(f, "/kiro-spec-tasks odd"));
});

test("spec のディレクトリが無い（名前だけ）・spec 名が無い・対象外のコマンド・通常の文章は通す", (t) => {
  const f = fixture(t);
  assertPassed(submit(f, "/kiro-spec-tasks nothere"));
  assertPassed(submit(f, "/kiro-spec-tasks"));
  spec(f, "foo");
  assertPassed(submit(f, "/kiro-spec-requirements foo"));
  assertPassed(submit(f, "/kiro-discovery"));
  assertPassed(submit(f, "通常の依頼です。/kiro-impl foo は文中なので対象外"));
});

test("cwd が git の外でも、スクリプトの位置の根に spec があれば止める", (t) => {
  const f = fixture(t, { inGit: false });
  spec(f, "foo");
  const outside = mkdtempSync(path.join(os.tmpdir(), "feasibility-gate-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assertBlocked(run(f.entry, { cwd: outside, input: { session_id: "s1", prompt: "/kiro-spec-tasks foo", cwd: outside } }));
});

test("cwd が git の外で、スクリプトの位置の根にも spec が無ければ通す", (t) => {
  const f = fixture(t, { inGit: false });
  const outside = mkdtempSync(path.join(os.tmpdir(), "feasibility-gate-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assertPassed(run(f.entry, { cwd: outside, input: { session_id: "s1", prompt: "/kiro-spec-tasks foo", cwd: outside } }));
});

test("spec のディレクトリが .kiro/specs の外を指すシンボリックリンクなら、特定できない扱いで通す", (t) => {
  const f = fixture(t);
  const outside = path.join(f.base, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, RECORD), recordText({ design: "未通過" }));
  symlinkSync(outside, path.join(f.root, ".kiro/specs/evil"));
  assertPassed(submit(f, "/kiro-spec-tasks evil"));
});

test("../ を含む名前は分類で除かれ、止めずに通す", (t) => {
  const f = fixture(t);
  spec(f, "foo");
  assertPassed(submit(f, "/kiro-spec-tasks ../foo"));
});

test("入力の JSON が不正なら、標準エラーに日本語で理由を書き、出力せず終了コード 0 で通す", (t) => {
  const f = fixture(t);
  const result = run(f.entry, { cwd: f.root, input: "{ 不正" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /入力の JSON を読み取れません/);
});

test("prompt が文字列でなければ、何も出さず通す", (t) => {
  const f = fixture(t);
  const result = run(f.entry, { cwd: f.root, input: { session_id: "s1", prompt: 123, cwd: f.root } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("引数（ツールの指定）が不正なら、標準エラーに書き、出力せず終了コード 0 で通す", (t) => {
  const f = fixture(t);
  const result = run(f.entry, { tool: "unknown", cwd: f.root, input: { session_id: "s1", prompt: "/kiro-spec-tasks foo", cwd: f.root } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /作業ツールを判定できません/);
});

test("入口は作業場所の状態を作らない（git の作業ツリーが変わらない）", (t) => {
  const f = fixture(t);
  spec(f, "foo");
  const before = git(f.root, ["status", "--porcelain", "--untracked-files=all"]);
  assertBlocked(submit(f, "/kiro-spec-tasks foo"));
  assertPassed(submit(f, "/kiro-spec-tasks nothere"));
  assert.equal(git(f.root, ["status", "--porcelain", "--untracked-files=all"]), before);
});

test("feasibility.md が .kiro/specs の外へのシンボリックリンクなら、外の記録を読まず記録なしとして止める", (t) => {
  const f = fixture(t);
  const dir = spec(f, "foo");
  const outsideRecord = path.join(f.base, "outside-record.md");
  writeFileSync(outsideRecord, recordText({ design: "通過" }));
  symlinkSync(outsideRecord, path.join(dir, RECORD));
  const reason = assertBlocked(submit(f, "/kiro-spec-tasks foo"));
  assert.match(reason, /記録がありません/);
});

test(".kiro/specs が外のディレクトリへのシンボリックリンクなら、外の記録を読まず通す（特定できない扱い）", (t) => {
  const f = fixture(t);
  const outsideSpecs = path.join(f.base, "outside-specs");
  mkdirSync(path.join(outsideSpecs, "foo"), { recursive: true });
  writeFileSync(path.join(outsideSpecs, "foo", RECORD), recordText({ design: "未通過" }));
  rmSync(path.join(f.root, ".kiro/specs"), { recursive: true });
  symlinkSync(outsideSpecs, path.join(f.root, ".kiro/specs"));
  assertPassed(submit(f, "/kiro-spec-tasks foo"));
});

test(".kiro が外のディレクトリへのシンボリックリンクなら、外の spec を読まず通す（特定できない扱い）", (t) => {
  const f = fixture(t);
  const outsideKiro = path.join(f.base, "outside-kiro");
  mkdirSync(path.join(outsideKiro, "specs", "foo"), { recursive: true });
  writeFileSync(path.join(outsideKiro, "specs", "foo", RECORD), recordText({ design: "未通過" }));
  rmSync(path.join(f.root, ".kiro"), { recursive: true });
  symlinkSync(outsideKiro, path.join(f.root, ".kiro"));
  assertPassed(submit(f, "/kiro-spec-tasks foo"));
});

test("同じ根の中のリンク（spec ディレクトリが別の spec へのリンク）は、実体が .kiro/specs の下なので判定どおりに止める", (t) => {
  const f = fixture(t);
  spec(f, "foo", recordText({ design: "未通過" }));
  symlinkSync(path.join(f.root, ".kiro/specs/foo"), path.join(f.root, ".kiro/specs/alias"));
  const reason = assertBlocked(submit(f, "/kiro-spec-tasks alias"));
  assert.match(reason, /判定が通過ではありません/);
});
