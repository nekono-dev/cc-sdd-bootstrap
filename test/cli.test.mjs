import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, buildUsage, runCli, formatSuccess, formatAbort, formatApplyFailure } from "../lib/cli.mjs";
import { configFields } from "../lib/config-schema.mjs";

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-modern-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}
function io(cwd) {
  let stdout = "";
  let stderr = "";
  return { value: { cwd, packageRoot: path.resolve("."), stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } }, output: () => ({ stdout, stderr }) };
}

test("受け付ける操作は init・update・uninstall と help だけ", () => {
  for (const operation of ["init", "update", "uninstall"]) assert.deepEqual(parseArgs([operation]), { kind: "run", operation });
  for (const args of [["--help"], ["-h"], ["help"]]) assert.deepEqual(parseArgs(args), { kind: "help" });
  for (const args of [["bogus"], ["init", "--force"], ["init", "--lang", "en"], ["init", "extra"]]) {
    assert.equal(parseArgs(args).kind, "usage-error");
  }
});

test("使い方は操作と設定ファイルの直接編集方法を示す", () => {
  const usage = buildUsage(configFields);
  for (const word of ["init", "update", "uninstall", ".cc-sdd-bootstrap.json", "直接編集"]) assert.ok(usage.includes(word), word);
  assert.ok(!usage.includes("--force"));
});

test("未知の指定は何も変えず、問題と使い方を表示して終了コード 1", async (t) => {
  const root = temporary(t);
  const streams = io(root);
  assert.equal(await runCli(["init", "--force"], streams.value), 1);
  assert.match(streams.output().stderr, /--force/);
  assert.match(streams.output().stderr, /使い方/);
  assert.deepEqual(fs.readdirSync(root), [".git"]);
});

test("git の最上位でない場所では何も変えず失敗", async (t) => {
  const root = temporary(t);
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  const streams = io(nested);
  assert.equal(await runCli(["init"], streams.value), 1);
  assert.match(streams.output().stderr, /最上位/);
  assert.deepEqual(fs.readdirSync(nested), []);
});

test("壊れた設定を読まずに uninstall し、登録と運用区画を外す", async (t) => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, ".cc-sdd-bootstrap.json"), "{");
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude/settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node /repo/.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs" }, { type: "command", command: "node user-hook.mjs" }] }] }, userSetting: true }));
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex/hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node /repo/.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs" }, { type: "command", command: "node user-hook.mjs" }] }] }, userSetting: true }));
  fs.mkdirSync(path.join(root, ".agent-hooks/cc-sdd-bootstrap"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent-hooks/cc-sdd-bootstrap/user.mjs"), "利用者の配置物");
  fs.writeFileSync(path.join(root, ".gitignore"), "# 利用者の除外設定\nsecret/\n");
  const marker = "<!-- cc-sdd-bootstrap:begin（この区画は cc-sdd の導入のたびに書き足される。編集しない） -->\n\n案内\n\n<!-- cc-sdd-bootstrap:end -->\n";
  fs.writeFileSync(path.join(root, "AGENTS.md"), "利用者の文書\n\n" + marker);
  fs.writeFileSync(path.join(root, "CLAUDE.md"), `標準文書\n\n${marker}`);
  const streams = io(root);
  assert.equal(await runCli(["uninstall"], streams.value), 0);
  assert.equal(fs.readFileSync(path.join(root, ".cc-sdd-bootstrap.json"), "utf8"), "{");
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "標準文書\n");
  assert.equal(fs.readFileSync(path.join(root, ".cc-sdd-bootstrap.json"), "utf8"), "{");
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "利用者の文書\n");
  for (const file of [".claude/settings.json", ".codex/hooks.json"]) {
    const saved = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    assert.equal(saved.userSetting, true);
    assert.equal(saved.hooks.SessionStart[0].hooks.length, 1);
    assert.equal(saved.hooks.SessionStart[0].hooks[0].command, "node user-hook.mjs");
  }
  assert.equal(fs.readFileSync(path.join(root, ".agent-hooks/cc-sdd-bootstrap/user.mjs"), "utf8"), "利用者の配置物");
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), "# 利用者の除外設定\nsecret/\n");
  assert.match(streams.output().stdout, /成功|取り外し/);
});

test("help 併記時も未知の操作・指定を拒否して問題と使い方を表示", async (t) => {
  for (const args of [["bogus", "--help"], ["init", "--force", "--help"]]) {
    const root = temporary(t);
    const streams = io(root);
    assert.equal(await runCli(args, streams.value), 1, args.join(" "));
    assert.match(streams.output().stderr, /使い方/);
    assert.match(streams.output().stderr, args[0] === "bogus" ? /bogus/ : /--force/);
    assert.deepEqual(fs.readdirSync(root), [".git"]);
  }
});

test("help は終了コード 0 で案内を出し、対象を変更しない", async (t) => {
  const root = temporary(t);
  const streams = io(root);
  assert.equal(await runCli(["--help"], streams.value), 0);
  assert.match(streams.output().stdout, /init/);
  assert.match(streams.output().stdout, /\.cc-sdd-bootstrap\.json/);
  assert.match(streams.output().stdout, /直接編集/);
  assert.deepEqual(fs.readdirSync(root), [".git"]);
});

test("導入成功は変更一覧と通知を日本語で表示する", () => {
  const output = formatSuccess("init", {
    changes: [
      { kind: "write", path: ".cc-sdd-bootstrap.json", created: true },
      { kind: "write", path: ".agent-hooks/cc-sdd-bootstrap/a.mjs", created: false },
      { kind: "delete", path: ".agent-hooks/cc-sdd-bootstrap/old.mjs" },
    ],
    notices: [
      { code: "CONFIG_CREATED", defaults: ["ccSdd.version", "ccSdd.lang"] },
      { code: "CODEX_TRUST" },
      { code: "EXISTING_AGENT_DOCS", files: ["CLAUDE.md", "AGENTS.md"] },
      { code: "GENERATED_NOTICE", id: "agents", messages: ["設定から役割のファイルを作りました"] },
    ],
  });
  for (const text of ["作成: .cc-sdd-bootstrap.json", "更新: .agent-hooks/cc-sdd-bootstrap/a.mjs", "削除: .agent-hooks/cc-sdd-bootstrap/old.mjs", "ccSdd.version=3.1.0", "ccSdd.lang=ja", "直接編集", ".agent-hooks/cc-sdd-bootstrap/", "git", "信頼", "AGENTS.md", "CLAUDE.md", ".kiro/steering/", "追跡", "コミット", "session-install", "設定から役割のファイルを作りました", "対話", "codex exec", "worktree", "本体の checkout", "node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs"]) assert.ok(output.includes(text), text);
  assert.match(output, /未承認.*AGENTS\.md/);
});

test("update の成功にも Codex の承認・worktree 案内を表示する", () => {
  const output = formatSuccess("update", { changes: [{ kind: "write", path: ".codex/hooks.json", created: false }], notices: [] });
  for (const text of ["対話", "codex exec", "worktree", "本体の checkout", "node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs", "AGENTS.md"]) assert.ok(output.includes(text), text);
});

test("取り外しを再実行しても残る対象を runCli で表示する", async (t) => {
  const root = temporary(t);
  const streams = io(root);
  assert.equal(await runCli(["init"], streams.value), 0);
  assert.equal(await runCli(["uninstall"], streams.value), 0);
  const second = io(root);
  assert.equal(await runCli(["uninstall"], second.value), 0);
  for (const text of ["取り外す登録・区画はありません", ".cc-sdd-bootstrap.json", ".agent-hooks/cc-sdd-bootstrap/", ".gitignore"]) assert.ok(second.output().stdout.includes(text), text);
});

test("変更なしと取り外し成功が状態と残る対象を表示する", () => {
  const unchanged = formatSuccess("update", { changes: [], notices: [] });
  assert.match(unchanged, /変更はありません/);
  for (const text of ["codex exec", "worktree", "node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs"]) assert.ok(!unchanged.includes(text), text);
  const removed = formatSuccess("uninstall", { changes: [{ kind: "delete", path: ".claude/settings.json" }], notices: [], removed: [".claude/settings.json", "CLAUDE.md"] });
  for (const text of ["外した", ".claude/settings.json", "CLAUDE.md", ".cc-sdd-bootstrap.json", ".agent-hooks/cc-sdd-bootstrap/", ".gitignore"]) assert.ok(removed.includes(text), text);
  for (const text of ["codex exec", "worktree", "node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs"]) assert.ok(!removed.includes(text), text);
});

test("中止理由ごとにファイル・問題・直し方を表示する", () => {
  for (const abort of [
    { code: "CONFIG_EXISTS" }, { code: "CONFIG_MISSING" },
    { code: "CONFIG_INVALID", file: ".cc-sdd-bootstrap.json", messages: ["language: 値が不正です"] },
    { code: "HOOKS_INVALID", file: ".codex/hooks.json", messages: ["JSON を読めません"] },
    { code: "BLOCK_INVALID", file: "AGENTS.md", messages: ["終了の目印がありません"] },
  ]) {
    const output = formatAbort(abort);
    assert.ok(output.length > 0);
    if (abort.file) for (const text of [abort.file, abort.messages[0], "直してください"]) assert.ok(output.includes(text), `${abort.code}: ${text}`);
  }
});

test("途中失敗は失敗・済み・未処理・再実行する操作を表示する", () => {
  const output = formatApplyFailure("init", {
    done: [{ path: ".cc-sdd-bootstrap.json" }],
    failed: { change: { path: ".codex/hooks.json" }, message: "書き込みに失敗しました: 権限がありません" },
    pending: [{ path: ".gitignore" }],
  });
  for (const text of [".codex/hooks.json", "権限がありません", ".cc-sdd-bootstrap.json", ".gitignore", "update"]) assert.ok(output.includes(text), text);
});
