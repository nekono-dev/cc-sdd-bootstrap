// 導入の記録（install-record.json）と、セッション開始の入口（freshness.mjs）を、導入コマンドの実行を通して確かめる統合の試験（3.1）。
// 失敗（記録の書き込み不可）・冪等（再実行で変更なし）・記録なしの案内・取り外し（記録を残す）・全て一致の無出力を、一時の導入先で確かめる。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCli } from "../lib/cli.mjs";
import { CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH, DEPLOY_DIR } from "../lib/catalog.mjs";
import { RECORD_PATH } from "../.agent-hooks/cc-sdd-bootstrap/freshness-rules.mjs";

// 配布物の写し（このリポジトリの実ファイル）。checkout からの実行を想定し、配布元の版は取り出せない（source.commit が null）
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRESHNESS_ENTRY = `${DEPLOY_DIR}/freshness.mjs`;

/**
 * 一時の導入先（git の最上位）と、CODEX_HOME・HOME を分けた分離環境を作る。
 * 利用者の実際の ~/.codex や HOME には触れない。後始末は t.after で行う。
 */
function temporaryRepo(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "freshness-integration-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "repo");
  fs.mkdirSync(root);
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const codexHome = path.join(base, "codex");
  const home = path.join(base, "home");
  fs.mkdirSync(codexHome);
  fs.mkdirSync(home);
  const env = { ...process.env, CODEX_HOME: codexHome, HOME: home };
  return { root, env, base };
}

/** 導入コマンド（runCli）を実行し、終了コードと標準出力・標準エラーを返す */
async function runOperation(repo, argv) {
  let stdout = "";
  let stderr = "";
  const status = await runCli(argv, {
    cwd: repo.root,
    packageRoot,
    env: repo.env,
    home: repo.env.HOME,
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  return { status, stdout, stderr };
}

/** 導入先の入口（freshness.mjs）を子プロセスで起動する。標準入力は空 */
function runFreshness(repo, args = ["session-start", "--tool", "claude"]) {
  return spawnSync(process.execPath, [path.join(repo.root, FRESHNESS_ENTRY), ...args], {
    cwd: repo.root,
    encoding: "utf8",
    input: "",
    timeout: 30000,
    env: repo.env,
  });
}

const recordFile = (repo) => path.join(repo.root, RECORD_PATH);
const readText = (file) => fs.readFileSync(file, "utf8");

test("init のあと update を通すと記録ができ、再度 update は変更なしになり記録の内容も変わらない", async (t) => {
  const repo = temporaryRepo(t);
  const initialized = await runOperation(repo, ["init"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  const updated = await runOperation(repo, ["update"]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.ok(fs.existsSync(recordFile(repo)), "install-record.json がありません");
  const first = readText(recordFile(repo));

  const repeated = await runOperation(repo, ["update"]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /変更はありません/);
  assert.equal(readText(recordFile(repo)), first, "再実行で記録の内容が変わりました");
});

test("記録の書き込みに失敗すると、導入コマンドは非 0 で終わり、完了を表示しない", async (t) => {
  const repo = temporaryRepo(t);
  // 記録の場所にディレクトリを置き、ファイルとして書けない状態を作る（root 実行でも再現できる）
  fs.mkdirSync(recordFile(repo), { recursive: true });

  const failed = await runOperation(repo, ["init"]);
  assert.notEqual(failed.status, 0);
  assert.doesNotMatch(`${failed.stdout}${failed.stderr}`, /処理が完了しました/);
  assert.doesNotMatch(`${failed.stdout}${failed.stderr}`, /変更はありません/);
  assert.match(failed.stderr, /失敗: .*install-record\.json/);
  assert.ok(fs.statSync(recordFile(repo)).isDirectory(), "記録の場所が書き換わっています");
});

test("記録の無い導入先では、入口が記録なしと更新コマンドを案内し、終了コード 0 で止めない", async (t) => {
  const repo = temporaryRepo(t);
  assert.equal((await runOperation(repo, ["init"])).status, 0);
  fs.rmSync(recordFile(repo));

  const result = runFreshness(repo);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.match(output.systemMessage, /導入の記録が無い/);
  assert.match(output.systemMessage, /更新コマンド: .*update/);
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(!("decision" in output), "入力を止める decision が含まれています");
  assert.ok(!result.stdout.includes('"decision"'));
});

test("uninstall は記録を残し、フックの登録だけを外す", async (t) => {
  const repo = temporaryRepo(t);
  assert.equal((await runOperation(repo, ["init"])).status, 0);
  assert.ok(fs.existsSync(recordFile(repo)));
  assert.match(readText(path.join(repo.root, CLAUDE_SETTINGS_PATH)), /freshness\.mjs/, "導入直後は登録があるはず");
  assert.match(readText(path.join(repo.root, CODEX_HOOKS_PATH)), /freshness\.mjs/, "導入直後は登録があるはず");

  // 利用者の設定を足して、取り外しの後も設定ファイルが残る状態にする（空になったファイルは消えるため）
  const claude = JSON.parse(readText(path.join(repo.root, CLAUDE_SETTINGS_PATH)));
  claude.userSetting = "保持する値";
  fs.writeFileSync(path.join(repo.root, CLAUDE_SETTINGS_PATH), `${JSON.stringify(claude, null, 2)}\n`);
  const codex = JSON.parse(readText(path.join(repo.root, CODEX_HOOKS_PATH)));
  codex.userSetting = "保持する値";
  fs.writeFileSync(path.join(repo.root, CODEX_HOOKS_PATH), `${JSON.stringify(codex, null, 2)}\n`);

  const removed = await runOperation(repo, ["uninstall"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.ok(fs.existsSync(recordFile(repo)), "uninstall で記録が消えました");
  for (const file of [CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH]) {
    const text = readText(path.join(repo.root, file));
    assert.ok(!text.includes("freshness.mjs"), `${file} に登録が残っています`);
    assert.equal(JSON.parse(text).userSetting, "保持する値", `${file} の利用者の設定が消えました`);
  }
});

test("全て一致の導入先では、入口は何も出さず終了コード 0 で通す（記録の source.commit は null）", async (t) => {
  const repo = temporaryRepo(t);
  assert.equal((await runOperation(repo, ["init"])).status, 0);
  assert.equal((await runOperation(repo, ["update"])).status, 0);
  const record = JSON.parse(readText(recordFile(repo)));
  // checkout からの実行を想定する前提。配布元の版が取り出せず、最新との比較は通信されない
  assert.equal(record.source.commit, null);

  const result = runFreshness(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
