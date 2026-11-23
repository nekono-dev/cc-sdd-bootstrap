import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, buildUsage, runCli } from "../lib/cli.mjs";
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
