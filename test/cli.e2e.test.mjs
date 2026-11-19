// CLI の端から端までの振る舞いを、一時 Git リポジトリで確かめる。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { catalog, CONFIG_PATH, DEPLOY_DIR, LEDGER_PATH } from "../lib/catalog.mjs";

const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tempRoots = new Set();
after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sdd-e2e-"));
  tempRoots.add(root);
  const git = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  return root;
}

function run(root, args) {
  const result = spawnSync(process.execPath, [path.join(packageRoot, "bin/cc-sdd-bootstrap.mjs"), ...args], {
    cwd: root,
    input: "",
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, `子プロセスがシグナルで終了しました: ${result.signal}`);
  result.outputText = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return result;
}

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath));
}

function managedPaths() {
  return [CONFIG_PATH, LEDGER_PATH, ...catalog.files.map((file) => file.path), ".claude/settings.json", ".gitignore", "CLAUDE.md"];
}

function snapshot(root, paths = managedPaths()) {
  return new Map(paths.map((item) => [item, fs.existsSync(path.join(root, item)) ? read(root, item) : null]));
}

function snapshotTree(root) {
  const files = new Map();
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.set(path.relative(root, full), fs.readFileSync(full));
    }
  };
  walk(root);
  return files;
}

function assertTreeSnapshot(root, before) {
  const after = snapshotTree(root);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [item, contents] of before) assert.deepEqual(after.get(item), contents, item);
}

function assertSnapshot(root, before) {
  for (const [item, contents] of before) {
    const full = path.join(root, item);
    assert.equal(fs.existsSync(full), contents !== null, item);
    if (contents !== null) assert.deepEqual(read(root, item), contents, item);
  }
}

test("引数なしの非対話 init は既定値と一式を作り、直後の update は変更しない", () => {
  const root = makeRepo();
  const initialized = run(root, ["init"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.match(initialized.outputText, /既定値を使った項目/);
  const config = JSON.parse(read(root, CONFIG_PATH));
  assert.deepEqual(config, { format: 1, ccSdd: { version: "3.1.0", lang: "ja" }, codex: { enabled: false }, models: {} });
  for (const [key, value] of Object.entries({ "ccSdd.version": "3.1.0", "ccSdd.lang": "ja", "codex.enabled": false, models: {} })) {
    assert.match(initialized.outputText, new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*${JSON.stringify(value)}`));
  }
  assert.ok(fs.existsSync(path.join(root, CONFIG_PATH)));
  assert.ok(fs.existsSync(path.join(root, LEDGER_PATH)));
  for (const file of catalog.files) assert.ok(fs.existsSync(path.join(root, file.path)), file.path);
  assert.equal(fs.statSync(path.join(root, catalog.files.find((file) => file.executable).path)).mode & 0o777, 0o755);
  for (const item of [".claude/settings.json", ".gitignore", "CLAUDE.md"]) assert.ok(fs.existsSync(path.join(root, item)), item);
  const settings = JSON.parse(read(root, ".claude/settings.json"));
  for (const hook of catalog.hooks) {
    assert.ok(settings.hooks[hook.event].some((group) => group.hooks?.some((entry) => entry.command === hook.command)), hook.event);
  }
  const gitignore = read(root, ".gitignore").toString();
  assert.match(gitignore, /# >>> cc-sdd-bootstrap/);
  assert.match(gitignore, /# <<< cc-sdd-bootstrap/);
  for (const line of catalog.gitignore) assert.ok(gitignore.includes(line), line);
  const claude = read(root, "CLAUDE.md").toString();
  assert.match(claude, /<!-- cc-sdd-bootstrap:begin/);
  assert.match(claude, /<!-- cc-sdd-bootstrap:end/);
  assert.ok(claude.includes("@.kiro/settings/cc-sdd-guide.md"));
  for (const file of catalog.files) {
    assert.deepEqual(read(root, file.path), fs.readFileSync(path.join(packageRoot, file.path)), file.path);
  }

  const before = snapshot(root);
  const updated = run(root, ["update"]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.outputText, /変更はありません/);
  assertSnapshot(root, before);
});

test("update は導入スクリプトの実行権限を戻す", () => {
  const root = makeRepo();
  assert.equal(run(root, ["init"]).status, 0);
  const script = path.join(root, catalog.files.find((file) => file.executable).path);
  fs.chmodSync(script, 0o644);
  const update = run(root, ["update"]);
  assert.equal(update.status, 0, update.outputText);
  assert.equal(fs.statSync(script).mode & 0o777, 0o755);
  assert.match(update.outputText, /更新[\s\S]*実行権限を戻した/);
  const again = run(root, ["update"]);
  assert.equal(again.status, 0, again.outputText);
  assert.match(again.outputText, /変更はありません/);
});

test("既存の settings・gitignore・CLAUDE.md は init 後の uninstall で元に戻る", () => {
  const root = makeRepo();
  const originals = {
    ".claude/settings.json": '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo user"}]}]},"permissions":{"allow":["Read"]}}\n',
    ".gitignore": "# 利用者の設定\nnode_modules/\n",
    "CLAUDE.md": "# プロジェクトの指示\n\n利用者の文章です。\n",
  };
  for (const [item, contents] of Object.entries(originals)) {
    fs.mkdirSync(path.dirname(path.join(root, item)), { recursive: true });
    fs.writeFileSync(path.join(root, item), contents);
  }
  const initialized = run(root, ["init"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  const removed = run(root, ["uninstall"]);
  assert.equal(removed.status, 0, removed.stderr);
  // .claude/settings.json は書くときに 2 文字の字下げへ整形される（設計の SettingsHooks）。要件 6.2・9.2 は中身の保持なので、JSON として比べる
  assert.deepStrictEqual(JSON.parse(read(root, ".claude/settings.json").toString("utf8")), JSON.parse(originals[".claude/settings.json"]));
  for (const item of [".gitignore", "CLAUDE.md"]) assert.deepEqual(read(root, item), Buffer.from(originals[item]), item);
  for (const item of [CONFIG_PATH, LEDGER_PATH, ...catalog.files.map((file) => file.path)]) assert.equal(fs.existsSync(path.join(root, item)), false, item);
  assert.equal(fs.existsSync(path.join(root, DEPLOY_DIR)), false);
  assert.equal(fs.existsSync(path.join(root, ".agent-hooks")), false);
});

test("書き換えた共通部分は update と uninstall を中止し、--force で上書き・削除する", () => {
  const root = makeRepo();
  assert.equal(run(root, ["init"]).status, 0);
  const common = catalog.files.find((file) => file.kind === "common").path;
  fs.writeFileSync(path.join(root, common), "利用者の変更\n");
  const before = snapshot(root);
  const blockedUpdate = run(root, ["update"]);
  assert.equal(blockedUpdate.status, 1);
  assert.match(blockedUpdate.outputText, new RegExp(common.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(blockedUpdate.outputText, /--force/);
  assertSnapshot(root, before);
  const forcedUpdate = run(root, ["update", "--force"]);
  assert.equal(forcedUpdate.status, 0, forcedUpdate.stderr);
  assert.deepEqual(read(root, common), fs.readFileSync(path.join(packageRoot, common)));

  fs.writeFileSync(path.join(root, common), "再度の利用者の変更\n");
  const beforeUninstall = snapshot(root);
  const blockedUninstall = run(root, ["uninstall"]);
  assert.equal(blockedUninstall.status, 1);
  assert.match(blockedUninstall.outputText, /--force/);
  assert.match(blockedUninstall.outputText, new RegExp(common.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assertSnapshot(root, beforeUninstall);
  const forcedUninstall = run(root, ["uninstall", "--force"]);
  assert.equal(forcedUninstall.status, 0, forcedUninstall.stderr);
  assert.equal(fs.existsSync(path.join(root, common)), false);
});

test("uninstall は管理領域へのシンボリックリンクを拒み、リンク先の利用者ファイルを残す", () => {
  const root = makeRepo();
  assert.equal(run(root, ["init"]).status, 0);
  const deployedDir = path.join(root, DEPLOY_DIR);
  fs.rmSync(deployedDir, { recursive: true, force: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ccsdd-user-files-"));
  put(outside, ".kiro/specs/user.md", "利用者の仕様書\n");
  fs.symlinkSync(outside, deployedDir, "dir");

  const removed = run(root, ["uninstall", "--force"]);
  assert.equal(removed.status, 1, removed.outputText);
  assert.equal(fs.readFileSync(path.join(outside, ".kiro/specs/user.md"), "utf8"), "利用者の仕様書\n");
});

function put(root, relativePath, content) {
  const full = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

test("導入状態・git 前提・未知の指定に対応する終了コードと無変更を保つ", () => {
  const root = makeRepo();
  for (const args of [["update"], ["uninstall"]]) {
    const before = snapshotTree(root);
    const result = run(root, args);
    assert.equal(result.status, 1);
    assertTreeSnapshot(root, before);
  }
  const initialized = run(root, ["init"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  const before = snapshot(root);
  const repeated = run(root, ["init"]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.outputText, /update/);
  assertSnapshot(root, before);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sdd-outside-"));
  tempRoots.add(outside);
  const outsideBefore = snapshotTree(outside);
  const noGit = run(outside, ["init"]);
  assert.equal(noGit.status, 1);
  assert.match(noGit.outputText, /git|リポジトリ/);
  assertTreeSnapshot(outside, outsideBefore);
  const unknown = run(root, ["init", "--unknown-option"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.outputText, /--unknown-option/);
  assertSnapshot(root, before);
});

test("途中の書き込み失敗は済んだもの・失敗したもの・未処理を表示する", () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, ".claude"), "通常ファイルなので設定ファイルを書けない\n");
  const result = run(root, ["init"]);
  assert.equal(result.status, 1);
  const output = result.outputText;
  assert.match(output, /済んだもの/);
  assert.match(output, /失敗したもの/);
  assert.match(output, /\.claude\/settings\.json/);
  assert.match(output, /未処理のもの/);
  assert.match(output, /済んだもの:[\s\S]*失敗したもの:[\s\S]*未処理のもの:/);
  assert.match(output, /EEXIST|ENOTDIR|ディレクトリ|directory/i);
  assert.match(output, /権限|種類|ファイル.*ディレクトリ/);
  assert.match(output, /update.*もう一度|もう一度.*update/);
  const completed = [CONFIG_PATH, LEDGER_PATH, ...catalog.files.map((file) => file.path)];
  for (const item of completed) {
    assert.ok(fs.existsSync(path.join(root, item)), item);
    assert.match(output, new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const item of [".gitignore", "CLAUDE.md"]) {
    assert.equal(fs.existsSync(path.join(root, item)), false, item);
    assert.match(output, new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal(fs.statSync(path.join(root, ".claude")).isFile(), true);
});
