// セッション開始の入口（freshness.mjs）の試験。
// 一時のリポジトリに入口と純粋部品を置き、偽の git（ls-remote だけ偽）で起動して、標準出力と終了コードを確かめる。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, runEntry } from "./helpers/entry-harness.mjs";
import { DISTRIBUTION_REPO, RECORD_PATH, buildRecord } from "../.agent-hooks/cc-sdd-bootstrap/freshness-rules.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const HEAD_LINE = (sha) => `${sha}\tHEAD\n`;

/**
 * 一時のリポジトリを作り、配置物（files）と記録（source と recordFiles）を置く。
 * recordFiles を省くと files の内容で記録を作る。record: false で記録を作らない。
 */
function fixture(t, { files = { "CLAUDE.md": "doc" }, source = { commit: SHA_A, ref: null }, recordFiles, record = true } = {}) {
  const repo = makeRepo({ entryName: "freshness.mjs", payload: ["freshness.mjs", "freshness-rules.mjs"], fakeGit: true, config: null });
  t.after(repo.cleanup);
  for (const [rel, text] of Object.entries(files)) repo.write(rel, text);
  if (record) repo.write(RECORD_PATH, buildRecord({ source, files: recordFiles ?? files }));
  return repo;
}

/** 入口を session-start で起動する。偽の git は既定で「最新は SHA_A」を返す */
function start(repo, { tool = "claude", env = {} } = {}) {
  return runEntry(repo, ["session-start", "--tool", tool], {
    env: { FAKE_GIT_MODE: "ok", FAKE_GIT_STDOUT: HEAD_LINE(SHA_A), ...env },
  });
}

/** 標準出力が 1 行の JSON であることを確かめて返す。出力が無ければ null */
function parseOutput(stdout) {
  if (stdout === "") return null;
  assert.equal(stdout.endsWith("\n"), true, "出力は改行で終わる");
  assert.equal(stdout.split("\n").length, 2, "出力は 1 行だけ");
  return JSON.parse(stdout);
}

test("(1) 全ファイル一致かつ最新が同じなら、何も出さず終了コード 0", (t) => {
  const repo = fixture(t);
  const result = start(repo);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.gitCalls.length, 1, "版があるので最新を 1 回問い合わせる");
});

test("(2) 記録のファイルが欠けていると、そのパスを案内する", (t) => {
  const repo = fixture(t, { files: { "CLAUDE.md": "doc" }, recordFiles: { "CLAUDE.md": "doc", "AGENTS.md": "guide" } });
  const result = start(repo);
  assert.equal(result.status, 0);
  const out = parseOutput(result.stdout);
  assert.ok(out, "案内が出る");
  // ファイル名の詳細は additionalContext（エージェント向け）に入る。systemMessage は要約の 1 文
  assert.match(out.systemMessage, /欠けがある/);
  assert.match(out.hookSpecificOutput.additionalContext, /欠けているファイル: .*AGENTS\.md/);
});

test("(3) 記録と内容が違うファイルがあると、そのパスを案内する", (t) => {
  const repo = fixture(t, { files: { "CLAUDE.md": "changed" }, recordFiles: { "CLAUDE.md": "doc" } });
  const result = start(repo);
  assert.equal(result.status, 0);
  const out = parseOutput(result.stdout);
  assert.ok(out, "案内が出る");
  assert.match(out.systemMessage, /記録と内容が違うファイルがある/);
  assert.match(out.hookSpecificOutput.additionalContext, /内容が記録と違うファイル: CLAUDE\.md/);
});

test("(4) 記録のコミットと最新が違うと、古いとして案内する", (t) => {
  const repo = fixture(t);
  const result = start(repo, { env: { FAKE_GIT_STDOUT: HEAD_LINE(SHA_B) } });
  assert.equal(result.status, 0);
  const out = parseOutput(result.stdout);
  assert.ok(out, "案内が出る");
  assert.match(out.systemMessage, /新しい版がある/);
  assert.match(out.systemMessage, /npx -y github:nekono-dev\/cc-sdd-bootstrap update/);
});

test("(5) 記録が無い（ENOENT）と、記録なしの案内を出す", (t) => {
  const repo = fixture(t, { record: false });
  const result = start(repo);
  assert.equal(result.status, 0);
  const out = parseOutput(result.stdout);
  assert.ok(out, "案内が出る");
  assert.match(out.systemMessage, /導入の記録が無い/);
  assert.equal(result.gitCalls.length, 0, "記録が無ければ最新を問い合わせない");
});

test("(6) 記録が壊れている（不正な JSON）と、壊れている案内を出す", (t) => {
  const repo = fixture(t);
  repo.write(RECORD_PATH, "{ 壊れた JSON");
  const result = start(repo);
  assert.equal(result.status, 0);
  const out = parseOutput(result.stdout);
  assert.ok(out, "案内が出る");
  assert.match(out.systemMessage, /壊れている/);
});

test("(6) 記録が読めない（ディレクトリにして読み取りに失敗させる）と、壊れている案内を出す", (t) => {
  const repo = fixture(t);
  fs.rmSync(path.join(repo.root, RECORD_PATH));
  fs.mkdirSync(path.join(repo.root, RECORD_PATH));
  const result = start(repo);
  assert.equal(result.status, 0);
  const out = parseOutput(result.stdout);
  assert.ok(out, "案内が出る");
  assert.match(out.systemMessage, /壊れている/);
});

test("(7) 偽 git が失敗しても、照合の結果（欠け）は案内し、終了コード 0", (t) => {
  const repo = fixture(t, { files: {}, recordFiles: { "CLAUDE.md": "doc" } });
  const result = start(repo, { env: { FAKE_GIT_MODE: "fail" } });
  assert.equal(result.status, 0);
  const out = parseOutput(result.stdout);
  assert.ok(out, "照合の案内が出る");
  assert.match(out.hookSpecificOutput.additionalContext, /CLAUDE\.md/);
});

test("(7) 偽 git が失敗しても、照合が一致なら何も出さない", (t) => {
  const repo = fixture(t);
  const result = start(repo, { env: { FAKE_GIT_MODE: "fail" } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("(7) 偽 git が止まっても（hang）、3 秒前後で打ち切られ、照合の結果を案内する", (t) => {
  const repo = fixture(t, { files: {}, recordFiles: { "CLAUDE.md": "doc" } });
  const started = Date.now();
  const result = start(repo, { env: { FAKE_GIT_MODE: "hang" } });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0);
  assert.ok(elapsed >= 2500 && elapsed < 6000, `3 秒の上限で打ち切られること（経過 ${elapsed} ms）`);
  const out = parseOutput(result.stdout);
  assert.ok(out, "照合の案内が出る");
  assert.match(out.hookSpecificOutput.additionalContext, /CLAUDE\.md/);
  assert.equal(result.gitCalls.length, 1);
});

test("(7) 偽 git が不正な出力を返すと、最新との比較だけを省き、照合は続く", (t) => {
  const repo = fixture(t, { files: { "CLAUDE.md": "changed" }, recordFiles: { "CLAUDE.md": "doc" } });
  const result = start(repo, { env: { FAKE_GIT_STDOUT: "不正な出力\n" } });
  assert.equal(result.status, 0);
  const out = parseOutput(result.stdout);
  assert.ok(out, "照合の案内が出る");
  assert.match(out.hookSpecificOutput.additionalContext, /CLAUDE\.md/);
  assert.doesNotMatch(out.systemMessage, /新しい版/);
});

test("(8) 固定のコミット指定（ref が 40 桁）では git を呼ばない", (t) => {
  const repo = fixture(t, { source: { commit: SHA_A, ref: SHA_A } });
  const result = start(repo, { env: { FAKE_GIT_STDOUT: HEAD_LINE(SHA_B) } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.deepEqual(result.gitCalls, []);
});

test("(8) コミットが null の記録では git を呼ばない", (t) => {
  const repo = fixture(t, { source: { commit: null, ref: null } });
  const result = start(repo, { env: { FAKE_GIT_STDOUT: HEAD_LINE(SHA_B) } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.deepEqual(result.gitCalls, []);
});

test("(9) 想定外の失敗（freshness-rules.mjs が壊れている）でも、出力せず終了コード 0", (t) => {
  const repo = fixture(t, { files: { "CLAUDE.md": "changed" }, recordFiles: { "CLAUDE.md": "doc" } });
  repo.write(".agent-hooks/cc-sdd-bootstrap/freshness-rules.mjs", 'throw new Error("壊れている");\n');
  const result = start(repo);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("(9) 記録されたパスがディレクトリでも、終了コード 0 で、出力は 1 行の JSON か空", (t) => {
  const repo = fixture(t, { files: {}, recordFiles: { "CLAUDE.md": "doc" } });
  fs.mkdirSync(path.join(repo.root, "CLAUDE.md"));
  const result = start(repo);
  assert.equal(result.status, 0);
  if (result.stdout !== "") parseOutput(result.stdout);
});

test("(9) 対応外の引数（なし・foo・session-start だけ）は出力せず終了コード 0", (t) => {
  const repo = fixture(t, { files: { "CLAUDE.md": "changed" }, recordFiles: { "CLAUDE.md": "doc" } });
  for (const args of [[], ["foo"], ["session-start"], ["session-start", "--tool", "other"], ["session-start", "--tool", "claude", "--unsupported"], ["--tool", "claude", "session-start"]]) {
    const result = runEntry(repo, args, { env: { FAKE_GIT_STDOUT: HEAD_LINE(SHA_A) } });
    assert.equal(result.status, 0, `引数 ${JSON.stringify(args)}`);
    assert.equal(result.stdout, "", `引数 ${JSON.stringify(args)}`);
    assert.equal(result.stderr, "", `引数 ${JSON.stringify(args)}`);
  }
});

test("(10) --tool claude と --tool codex で出力が同じ", (t) => {
  const repo = fixture(t, { files: { "CLAUDE.md": "changed" }, recordFiles: { "CLAUDE.md": "doc" } });
  const claude = start(repo, { tool: "claude" });
  const codex = start(repo, { tool: "codex" });
  assert.equal(claude.status, 0);
  assert.equal(codex.status, 0);
  assert.ok(claude.stdout !== "");
  assert.equal(codex.stdout, claude.stdout);
});

test("(11) 出力の JSON は systemMessage と hookSpecificOutput（SessionStart・additionalContext）を持ち、decision を含まない", (t) => {
  const repo = fixture(t, { files: { "CLAUDE.md": "changed" }, recordFiles: { "CLAUDE.md": "doc" } });
  const result = start(repo);
  const out = parseOutput(result.stdout);
  assert.ok(out);
  assert.equal(typeof out.systemMessage, "string");
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  const context = out.hookSpecificOutput.additionalContext;
  assert.equal(typeof context, "string");
  assert.ok(context.includes(out.systemMessage), "利用者向けの文面を文脈に含む");
  assert.match(context, /回答より前に/);
  assert.match(context, /npx -y github:nekono-dev\/cc-sdd-bootstrap update/);
  assert.equal("decision" in out, false);
  assert.equal("decision" in out.hookSpecificOutput, false);
});

test("(12) git の呼び出しは ls-remote と配布元を含み、認証の入力を求めない設定（GIT_TERMINAL_PROMPT=0）で行う", (t) => {
  const repo = fixture(t);
  const result = start(repo);
  assert.equal(result.gitCalls.length, 1);
  const [call] = result.gitCalls;
  assert.ok(call.args.includes("ls-remote"));
  assert.ok(call.args.includes(DISTRIBUTION_REPO));
  assert.equal(call.gitTerminalPrompt, "0");
});
