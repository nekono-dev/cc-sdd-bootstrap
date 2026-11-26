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
  for (const name of ["feasibility-gate.mjs", "feasibility-gate-rules.mjs", "kiro-gate-rules.mjs", "stop-notice-rules.mjs"]) {
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

/**
 * 止められたことを確かめ、理由を返す。
 * 止める判定は `decision: "block"` ではなく、停止の案内を載せた追加の文脈で届く（応答の文章を必ず作らせるため）。
 * 返す文字列は、停止の案内の全文（止めた入力・止めたこと・理由を含む）。
 */
function assertBlocked(result, prompt) {
  assert.equal(result.status, 0);
  const value = JSON.parse(result.stdout);
  assert.equal("decision" in value, false, "decision を含んではならない");
  assert.equal(value.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const text = value.hookSpecificOutput.additionalContext;
  assert.match(text, /【入力の停止】/);
  assert.match(text, /--- 停止の案内 ---/);
  assert.match(text, /止めたこと: この入力を止めました。/);
  if (prompt !== undefined) assert.ok(text.includes(`止めた入力: ${prompt}`), "止めた入力が案内に入る");
  return text;
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
  assertContext(submit(f, "/kiro-spec-tasks foo -y"));
});

test("Codex は $kiro-impl で動き、タスク計画が未通過なら止め、通過なら通す", (t) => {
  const f = fixture(t);
  spec(f, "foo", recordText({ design: "通過", tasks: "未通過" }));
  const reason = assertBlocked(submit(f, "$kiro-impl foo 1.1", { tool: "codex" }));
  assert.match(reason, /タスク計画/);
  assert.match(reason, /判定が通過ではありません/);

  spec(f, "foo", recordText({ tasks: "通過" }));
  assertContext(submit(f, "$kiro-impl foo 1.1", { tool: "codex" }));
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
  assertContext(submit(f, "/kiro-spec-tasks nothere"));
  assertContext(submit(f, "/kiro-spec-tasks"));
  spec(f, "foo");
  assertContext(submit(f, "/kiro-spec-requirements foo"));
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
  assertContext(run(f.entry, { cwd: outside, input: { session_id: "s1", prompt: "/kiro-spec-tasks foo", cwd: outside } }));
});

test("spec のディレクトリが .kiro/specs の外を指すシンボリックリンクなら、特定できない扱いで通す", (t) => {
  const f = fixture(t);
  const outside = path.join(f.base, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, RECORD), recordText({ design: "未通過" }));
  symlinkSync(outside, path.join(f.root, ".kiro/specs/evil"));
  assertContext(submit(f, "/kiro-spec-tasks evil"));
});

test("../ を含む名前は分類で除かれ、止めずに通す", (t) => {
  const f = fixture(t);
  spec(f, "foo");
  assertContext(submit(f, "/kiro-spec-tasks ../foo"));
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
  assertContext(submit(f, "/kiro-spec-tasks nothere"));
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
  assertContext(submit(f, "/kiro-spec-tasks foo"));
});

test(".kiro が外のディレクトリへのシンボリックリンクなら、外の spec を読まず通す（特定できない扱い）", (t) => {
  const f = fixture(t);
  const outsideKiro = path.join(f.base, "outside-kiro");
  mkdirSync(path.join(outsideKiro, "specs", "foo"), { recursive: true });
  writeFileSync(path.join(outsideKiro, "specs", "foo", RECORD), recordText({ design: "未通過" }));
  rmSync(path.join(f.root, ".kiro"), { recursive: true });
  symlinkSync(outsideKiro, path.join(f.root, ".kiro"));
  assertContext(submit(f, "/kiro-spec-tasks foo"));
});

test("同じ根の中のリンク（spec ディレクトリが別の spec へのリンク）は、実体が .kiro/specs の下なので判定どおりに止める", (t) => {
  const f = fixture(t);
  spec(f, "foo", recordText({ design: "未通過" }));
  symlinkSync(path.join(f.root, ".kiro/specs/foo"), path.join(f.root, ".kiro/specs/alias"));
  const reason = assertBlocked(submit(f, "/kiro-spec-tasks alias"));
  assert.match(reason, /判定が通過ではありません/);
});

/**
 * 本体の git リポジトリに初回の commit を作り、worktree を count 個（detach）作る。
 * 返す paths は作った順。git worktree list の順とは一致しない場合があるので、必要なら worktreeOrder を使う。
 */
function withWorktrees(t, count) {
  const f = fixture(t);
  git(f.root, ["add", "-A"]);
  git(f.root, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  const paths = [];
  for (let i = 0; i < count; i++) {
    const wt = path.join(f.base, `wt${i}`);
    git(f.root, ["worktree", "add", "-q", "--detach", wt]);
    paths.push(wt);
  }
  return { f, paths };
}

/** git worktree list の順（本体が先頭）。試験が上限の位置を決めるために使う */
function worktreeOrder(root) {
  return git(root, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/** worktree の spec のディレクトリに記録を書く（記録が無ければ spec のディレクトリだけ作る） */
function worktreeSpec(wt, name, record) {
  const dir = path.join(wt, ".kiro/specs", name);
  mkdirSync(dir, { recursive: true });
  if (record !== undefined) writeFileSync(path.join(dir, RECORD), record);
}

test("本体に spec が無く worktree にだけあるとき、cwd が本体なら worktree の記録で止め、通過なら通す", (t) => {
  const { f, paths: [wt] } = withWorktrees(t, 1);
  worktreeSpec(wt, "foo");
  const reason = assertBlocked(submit(f, "/kiro-spec-tasks foo", { cwd: f.root }));
  assert.match(reason, /記録がありません/);

  worktreeSpec(wt, "foo", recordText({ design: "通過" }));
  assertContext(submit(f, "/kiro-spec-tasks foo", { cwd: f.root }));
});

test("cwd が worktree の中のときも、その worktree の spec で同じように止め、通す", (t) => {
  const { f, paths: [wt] } = withWorktrees(t, 1);
  worktreeSpec(wt, "foo");
  const reason = assertBlocked(submit(f, "/kiro-spec-tasks foo", { cwd: wt }));
  assert.match(reason, /記録がありません/);

  worktreeSpec(wt, "foo", recordText({ design: "通過" }));
  assertContext(submit(f, "/kiro-spec-tasks foo", { cwd: wt }));
});

test("本体と worktree に同名の spec があるとき、並びの先（入力の作業場所の根）の spec を使う", (t) => {
  const { f, paths: [wt] } = withWorktrees(t, 1);
  spec(f, "foo", recordText({ design: "未通過" }));
  worktreeSpec(wt, "foo", recordText({ design: "通過" }));
  assertBlocked(submit(f, "/kiro-spec-tasks foo", { cwd: f.root }));
  assertContext(submit(f, "/kiro-spec-tasks foo", { cwd: wt }));
});

test("git の外の cwd では、スクリプトの位置の根だけで探し、見つかれば止め、無ければ通す（例外にしない）", (t) => {
  const f = fixture(t, { inGit: false });
  spec(f, "foo", recordText({ design: "未通過" }));
  const outside = mkdtempSync(path.join(os.tmpdir(), "feasibility-gate-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const found = run(f.entry, { cwd: outside, input: { session_id: "s1", prompt: "/kiro-spec-tasks foo", cwd: outside } });
  assertBlocked(found);
  assert.equal(found.stderr, "");
  const missing = run(f.entry, { cwd: outside, input: { session_id: "s1", prompt: "/kiro-spec-tasks bar", cwd: outside } });
  assertContext(missing);
  assert.equal(missing.stderr, "");
});

test("削除済みの worktree（実体が無い）は候補から外れ、他の候補で探す", (t) => {
  const { f, paths: [gone, alive] } = withWorktrees(t, 2);
  worktreeSpec(gone, "foo", recordText({ design: "通過" }));
  rmSync(gone, { recursive: true, force: true });
  worktreeSpec(alive, "foo", recordText({ design: "未通過" }));
  const result = submit(f, "/kiro-spec-tasks foo", { cwd: f.root });
  const reason = assertBlocked(result);
  assert.match(reason, /判定が通過ではありません/);
  assert.equal(result.stderr, "");
});

test("候補は先頭 20 個まで。上限より後ろの worktree にだけある spec は特定できず通し、上限内なら止める", (t) => {
  const { f } = withWorktrees(t, 22);
  const order = worktreeOrder(f.root);
  assert.equal(order.length, 23);
  // 先頭は本体（候補 0）。候補 20 以降（order の 20・21・22 の位置）は上限を超える
  worktreeSpec(order[22], "foo", recordText({ design: "未通過" }));
  assertContext(submit(f, "/kiro-spec-tasks foo", { cwd: f.root }));

  worktreeSpec(order[1], "foo", recordText({ design: "未通過" }));
  const reason = assertBlocked(submit(f, "/kiro-spec-tasks foo", { cwd: f.root }));
  assert.match(reason, /判定が通過ではありません/);
});

/**
 * 本体の commit の後に、指定の名前（空白・タブ・日本語・改行などを含みうる）の worktree を 1 つ作る。
 * 名前は base の直下に置く。git へは引数の配列で渡す（シェルを通さない）。
 */
function worktreeNamed(t, name) {
  const { f } = withWorktrees(t, 0);
  const wt = path.join(f.base, name);
  git(f.root, ["worktree", "add", "-q", "--detach", wt]);
  return { f, wt };
}

/** 特殊なパスの worktree に未通過の spec だけがあるとき止まり、通過の記録があれば通ることを確かめる */
function checkWorktreeNamed(t, name) {
  const { f, wt } = worktreeNamed(t, name);
  worktreeSpec(wt, "foo", recordText({ design: "未通過" }));
  const reason = assertBlocked(submit(f, "/kiro-spec-tasks foo", { cwd: f.root }));
  assert.match(reason, /判定が通過ではありません/);
  assert.equal(submit(f, "/kiro-spec-tasks foo", { cwd: f.root }).stderr, "");

  worktreeSpec(wt, "foo", recordText({ design: "通過" }));
  assertContext(submit(f, "/kiro-spec-tasks foo", { cwd: f.root }));
}

test("タブを含むパスの worktree にだけある未通過の spec で止まり、通過なら通す", (t) => {
  checkWorktreeNamed(t, "wt-tab\tname");
});

test("空白を含むパスの worktree にだけある未通過の spec で止まり、通過なら通す", (t) => {
  checkWorktreeNamed(t, "wt space name");
});

test("日本語を含むパスの worktree にだけある未通過の spec で止まり、通過なら通す", (t) => {
  checkWorktreeNamed(t, "wt-日本語");
});

test("改行を含むパスの worktree にだけある未通過の spec で止まり、通過なら通す", (t) => {
  checkWorktreeNamed(t, "wt-line\nname");
});

/** 追加の指示が出たことを確かめ、その文言を返す。出力は hookSpecificOutput の 1 つだけ（Claude Code・Codex 共通の形） */
function assertContext(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value), ["hookSpecificOutput"]);
  assert.equal(value.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(typeof value.hookSpecificOutput.additionalContext, "string");
  return value.hookSpecificOutput.additionalContext;
}

test("要件と設計の入力では追加の指示が出る（Claude Code と Codex は同じ形）", (t) => {
  const f = fixture(t);
  spec(f, "foo");
  const claude = assertContext(submit(f, "/kiro-spec-requirements foo"));
  assert.match(claude, /実機検証の要否/);
  assert.match(claude, /\.kiro\/specs\/foo\/feasibility\.md/);
  const codex = assertContext(submit(f, "$kiro-spec-design foo", { tool: "codex" }));
  assert.match(codex, /設計の確認/);
});

test("kiro-spec-tasks は設計が通過なら追加の指示、記録が無ければ止め、止めるときは追加の指示を出さない", (t) => {
  const f = fixture(t);
  spec(f, "foo");
  const reason = assertBlocked(submit(f, "/kiro-spec-tasks foo"));
  assert.match(reason, /記録がありません/);
  // 止めるときは、停止の案内だけを出す（段階ごとの追加の指示【実現性の確認】は出さない）
  assert.ok(!JSON.parse(submit(f, "/kiro-spec-tasks foo").stdout).hookSpecificOutput.additionalContext.includes("【実現性の確認】"));
  spec(f, "foo", recordText({ design: "通過" }));
  assert.match(assertContext(submit(f, "/kiro-spec-tasks foo")), /タスク計画の確認/);
});

test("kiro-impl はタスク計画が通過なら追加の指示を出す（Codex の $ でも同じ形）", (t) => {
  const f = fixture(t);
  spec(f, "foo", recordText({ tasks: "通過" }));
  assert.match(assertContext(submit(f, "$kiro-impl foo 1.1", { tool: "codex" })), /書き換え/);
});

test("spec 名なしの /kiro-spec-tasks は追加の指示を出し、spec 名は `<spec 名>` のまま書く", (t) => {
  const f = fixture(t);
  assert.match(assertContext(submit(f, "/kiro-spec-tasks")), /<spec 名>/);
});

test("追加の指示の入力でもリポジトリの中に何も作られない", (t) => {
  const f = fixture(t);
  spec(f, "foo", recordText({ design: "通過" }));
  const before = git(f.root, ["status", "--porcelain", "--untracked-files=all"]);
  assertContext(submit(f, "/kiro-spec-requirements foo"));
  assertContext(submit(f, "/kiro-spec-tasks foo"));
  assert.equal(git(f.root, ["status", "--porcelain", "--untracked-files=all"]), before);
});

test("kiro-spec-quick・kiro-spec-batch は記録が無ければ止め、設計が通過なら出力しない（Claude Code と Codex）", (t) => {
  const f = fixture(t);
  spec(f, "foo");
  assert.match(assertBlocked(submit(f, "/kiro-spec-quick foo --auto")), /個別の段階のコマンド/);
  assert.match(assertBlocked(submit(f, "$kiro-spec-batch foo", { tool: "codex" })), /記録がありません/);
  spec(f, "foo", recordText({ design: "通過" }));
  assertPassed(submit(f, "/kiro-spec-quick foo --auto"));
  assertPassed(submit(f, "/kiro-spec-batch foo"));
});

test("名前なしの /kiro-spec-batch・説明文が先頭の /kiro-spec-quick・spec のディレクトリが無い /kiro-spec-quick は、止めず案内を出す（5.12）", (t) => {
  const f = fixture(t);
  assert.match(assertContext(submit(f, "/kiro-spec-batch")), /名前なしの一括作成は入力を止められない/);
  assert.match(assertContext(submit(f, "/kiro-spec-quick 新しい機能を作る")), /設計とタスクを続けて作る/);
  assert.match(assertContext(submit(f, "/kiro-spec-quick newfeature")), /個別の段階のコマンド/);
});

test("複数の spec 名と -y を含む入力でも、先頭の spec の記録が無ければ停止の案内の出力になる（3.6）", (t) => {
  const f = fixture(t);
  spec(f, "alpha");
  spec(f, "beta");
  const prompt = "/kiro-spec-tasks alpha beta -y";
  const text = assertBlocked(submit(f, prompt), prompt);
  assert.match(text, /spec `alpha`/);
  assert.match(text, /記録がありません/);
});

test("記録が無い導入前の spec の停止の案内に、記録を作る手順と不要判定の手順が含まれる（3.7）", (t) => {
  const f = fixture(t);
  spec(f, "legacy");
  const text = assertBlocked(submit(f, "/kiro-spec-quick legacy"), "/kiro-spec-quick legacy");
  assert.match(text, /## 設計の確認/);
  assert.match(text, /実機検証が不要なら/);
  assert.match(text, /- 判定: 不要/);
});

test("停止の案内の出力は decision を含まず、止める指示と止めた入力を含む（1.1・1.6）", (t) => {
  const f = fixture(t);
  spec(f, "foo");
  const result = submit(f, "/kiro-spec-tasks foo -y");
  const value = JSON.parse(result.stdout);
  assert.equal(Object.hasOwn(value, "decision"), false);
  assert.match(value.hookSpecificOutput.additionalContext, /ほかの作業はしないでください/);
  assert.match(value.hookSpecificOutput.additionalContext, /止めた入力: \/kiro-spec-tasks foo -y/);
});
