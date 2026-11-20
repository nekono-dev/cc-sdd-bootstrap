// CLI の端から端までの振る舞いを、一時 Git リポジトリで確かめる。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { resolveGitignoreLines } from "../lib/plan.mjs";
import { catalog, CONFIG_PATH, DEPLOY_DIR, LEDGER_PATH } from "../lib/catalog.mjs";
import { serializeLedger, sha256 } from "../lib/ledger.mjs";

const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tempRoots = new Set();
let fixturePackageRoot;
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

function makeFixturePackage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sdd-fixture-package-"));
  tempRoots.add(root);
  for (const entry of ["package.json", "bin", "lib", ".agent-hooks/cc-sdd-bootstrap"]) {
    fs.cpSync(path.join(packageRoot, entry), path.join(root, entry), { recursive: true });
  }
  const fixtureFiles = path.join(root, ".agent-hooks/cc-sdd-bootstrap");
  fs.mkdirSync(fixtureFiles, { recursive: true });
  fs.writeFileSync(path.join(fixtureFiles, "fixture-claude.txt"), "Claude fixture payload\n");
  fs.writeFileSync(path.join(fixtureFiles, "fixture-codex.txt"), "Codex fixture payload\n");
  fs.appendFileSync(path.join(root, "lib/catalog.mjs"), `\n\n// E2E client fixtures.\ncatalog.files.push(\n  { path: \`.agent-hooks/cc-sdd-bootstrap/fixture-claude.txt\`, kind: "common", executable: false, client: "claude" },\n  { path: \`.agent-hooks/cc-sdd-bootstrap/fixture-codex.txt\`, kind: "common", executable: false, client: "codex" },\n);\ncatalog.codexHooks.push({ event: "SessionStart", command: codexHookCommand("install-cc-sdd.mjs", "session-start") });\ncatalog.gitignore.push({ line: ".agents/skills/kiro-*/", client: "codex" });\ncatalog.agentsSections.push({ id: "e2e-codex-fixture", body: "## Codex fixture section" });\n`);
  return root;
}

function run(root, args, selectedPackageRoot = packageRoot) {
  const result = spawnSync(process.execPath, [path.join(selectedPackageRoot, "bin/cc-sdd-bootstrap.mjs"), ...args], {
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

function runFixture(root, args) {
  fixturePackageRoot ??= makeFixturePackage();
  return run(root, args, fixturePackageRoot);
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
  assert.deepEqual(config, { format: 1, ccSdd: { version: "3.1.0", lang: "ja", keepTemplates: false }, clients: "both", codex: { enabled: false }, models: {}, subagents: { claudeModels: {}, codexModels: {}, localModels: {}, efforts: {} } });
  for (const [key, value] of Object.entries({ "ccSdd.version": "3.1.0", "ccSdd.lang": "ja", "ccSdd.keepTemplates": false, clients: "both", "codex.enabled": false, models: {}, "subagents.claudeModels": {}, "subagents.codexModels": {}, "subagents.localModels": {}, "subagents.efforts": {} })) {
    assert.match(initialized.outputText, new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*${JSON.stringify(value)}`));
  }
  assert.ok(fs.existsSync(path.join(root, CONFIG_PATH)));
  assert.ok(fs.existsSync(path.join(root, LEDGER_PATH)));
  for (const file of catalog.files) assert.ok(fs.existsSync(path.join(root, file.path)), file.path);
  for (const file of catalog.files) assert.equal((fs.statSync(path.join(root, file.path)).mode & 0o111) !== 0, file.executable, file.path);
  for (const item of [".claude/settings.json", ".gitignore", "CLAUDE.md"]) assert.ok(fs.existsSync(path.join(root, item)), item);
  const settings = JSON.parse(read(root, ".claude/settings.json"));
  for (const hook of catalog.hooks) {
    assert.ok(settings.hooks[hook.event].some((group) => group.hooks?.some((entry) => entry.command === hook.command)), hook.event);
  }
  const gitignore = read(root, ".gitignore").toString();
  assert.match(gitignore, /# >>> cc-sdd-bootstrap/);
  assert.match(gitignore, /# <<< cc-sdd-bootstrap/);
  const defaultLines = resolveGitignoreLines(catalog.gitignore, { format: 1, ccSdd: { keepTemplates: false } });
  for (const line of defaultLines) assert.ok(gitignore.split("\n").includes(line), line);
  assert.ok(!gitignore.split("\n").includes(".kiro/settings/*"));
  assert.ok(!gitignore.split("\n").includes("!.kiro/settings/templates/"));
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

test("update は旧設定と未知の役割を保ち、4つの役割マップを部分上書きできる", () => {
  const root = makeRepo();
  const initialized = run(root, ["init"]);
  assert.equal(initialized.status, 0, initialized.outputText);
  const configPath = path.join(root, CONFIG_PATH);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.models = { manufacture: "legacy-model", futureRole: "legacy-future-model" };
  config.subagents = {
    claudeModels: { manufacture: "claude-haiku", futureRole: "claude-future" },
    codexModels: { review: "gpt-6.1-sol", futureRole: "codex-future" },
    localModels: { design: "local-design-id", futureRole: "local-future" },
    efforts: { manufacture: "high", futureRole: "medium" },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const updated = run(root, [
    "update",
    "--claude-models", "manufacture=claude-sonnet",
    "--codex-models", "review=gpt-6.1-luna",
    "--local-models", "design=local-updated-id",
    "--effort", "manufacture=medium",
  ]);
  assert.equal(updated.status, 0, updated.outputText);
  assert.match(updated.outputText, /update が完了しました/);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.models, config.models);
  assert.deepEqual(saved.subagents, {
    claudeModels: { manufacture: "claude-sonnet", futureRole: "claude-future" },
    codexModels: { review: "gpt-6.1-luna", futureRole: "codex-future" },
    localModels: { design: "local-updated-id", futureRole: "local-future" },
    efforts: { manufacture: "medium", futureRole: "medium" },
  });

  // update は保存済み設定を読み込んでスキーマ検証してから計画を適用する。
  const validated = run(root, ["update"]);
  assert.equal(validated.status, 0, validated.outputText);
  assert.match(validated.outputText, /変更はありません/);
  const rerun = run(root, ["update"]);
  assert.equal(rerun.status, 0, rerun.outputText);
  assert.match(rerun.outputText, /変更はありません/);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), saved);
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

test("壊れた JSON があっても uninstall は警告して取り除きを続ける", () => {
  const root = makeRepo();
  assert.equal(run(root, ["init"]).status, 0);
  fs.writeFileSync(path.join(root, CONFIG_PATH), "{");
  const removed = run(root, ["uninstall"]);
  assert.equal(removed.status, 0, removed.outputText);
  assert.match(removed.stderr, /\.cc-sdd-bootstrap\.json/);
  assert.match(removed.stderr, /JSON として読めません/);
  for (const file of [CONFIG_PATH, LEDGER_PATH, ...catalog.files.map((item) => item.path)]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
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

test("初期の配置物を含む導入先の update は古い入口を新しいフックに置き換える", () => {
  const root = makeRepo();
  assert.equal(run(root, ["init"]).status, 0);
  const oldPath = `${DEPLOY_DIR}/install-cc-sdd.sh`;
  const oldContents = Buffer.from("#!/usr/bin/env bash\necho old\n");
  put(root, oldPath, oldContents);
  const ledger = JSON.parse(read(root, LEDGER_PATH).toString("utf8"));
  ledger.files[oldPath] = { kind: "common", sha256: sha256(oldContents) };
  fs.writeFileSync(path.join(root, LEDGER_PATH), serializeLedger(ledger));
  const settingsPath = path.join(root, ".claude/settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const oldCommand = `"$CLAUDE_PROJECT_DIR/${oldPath}" --claude`;
  const group = settings.hooks.SessionStart.find((item) => item.hooks?.some((hook) => hook.command.includes(".agent-hooks/cc-sdd-bootstrap/")));
  group.hooks.find((hook) => hook.command.includes(".agent-hooks/cc-sdd-bootstrap/")).command = oldCommand;
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  const updated = run(root, ["update"]);
  assert.equal(updated.status, 0, updated.outputText);
  assert.equal(fs.existsSync(path.join(root, oldPath)), false);
  const result = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const owned = (result.hooks.SessionStart ?? []).flatMap((item) => item.hooks ?? []).filter((hook) => hook.command.includes(".agent-hooks/cc-sdd-bootstrap/"));
  assert.equal(owned.length, 1);
  assert.equal(owned[0].command, catalog.hooks.find((hook) => hook.event === "SessionStart").command);
  for (const [event, groups] of Object.entries(result.hooks)) {
    const count = groups.flatMap((item) => item.hooks ?? []).filter((hook) => hook.command.includes(".agent-hooks/cc-sdd-bootstrap/")).length;
    assert.equal(count, 1, event);
  }
});

test("記録後に書き換えた古い導入スクリプトがある update は --force を案内する", () => {
  const root = makeRepo();
  assert.equal(run(root, ["init"]).status, 0);
  const oldPath = `${DEPLOY_DIR}/install-cc-sdd.sh`;
  const oldContents = Buffer.from("#!/usr/bin/env bash\necho old\n");
  put(root, oldPath, oldContents);
  const ledger = JSON.parse(read(root, LEDGER_PATH).toString("utf8"));
  ledger.files[oldPath] = { kind: "common", sha256: sha256(oldContents) };
  fs.writeFileSync(path.join(root, LEDGER_PATH), serializeLedger(ledger));
  const settingsPath = path.join(root, ".claude/settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const group = settings.hooks.SessionStart.find((item) => item.hooks?.some((hook) => hook.command.includes(".agent-hooks/cc-sdd-bootstrap/")));
  group.hooks.find((hook) => hook.command.includes(".agent-hooks/cc-sdd-bootstrap/")).command = `"$CLAUDE_PROJECT_DIR/${oldPath}" --claude`;
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  put(root, oldPath, "#!/usr/bin/env bash\necho user change\n");

  const updated = run(root, ["update"]);
  assert.notEqual(updated.status, 0, updated.outputText);
  assert.equal(fs.existsSync(path.join(root, oldPath)), true);
  assert.match(updated.outputText, /--force/);
});

test("keepTemplates を変更した update は gitignore の管理区画を書き直す", () => {
  const root = makeRepo();
  assert.equal(run(root, ["init"]).status, 0);
  const configPath = path.join(root, CONFIG_PATH);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const gitignoreLines = () => fs.readFileSync(path.join(root, ".gitignore"), "utf8").split("\n");
  assert.ok(gitignoreLines().includes(".kiro/settings/"));
  assert.ok(!gitignoreLines().includes(".kiro/settings/*"));
  assert.ok(!gitignoreLines().includes("!.kiro/settings/templates/"));
  assert.ok(gitignoreLines().includes("/.cache/"));

  config.ccSdd.keepTemplates = true;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  assert.equal(run(root, ["update"]).status, 0);
  assert.ok(gitignoreLines().includes(".kiro/settings/*"));
  assert.ok(gitignoreLines().includes("!.kiro/settings/templates/"));
  assert.ok(!gitignoreLines().includes(".kiro/settings/"));
  assert.ok(gitignoreLines().includes("/.cache/"));

  config.ccSdd.keepTemplates = false;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  assert.equal(run(root, ["update"]).status, 0);
  assert.ok(gitignoreLines().includes(".kiro/settings/"));
  assert.ok(!gitignoreLines().includes(".kiro/settings/*"));
  assert.ok(!gitignoreLines().includes("!.kiro/settings/templates/"));
  assert.ok(gitignoreLines().includes("/.cache/"));
});

test("uninstall は除外解除後に .cache の未追跡候補を知らせる", () => {
  const root = makeRepo();
  assert.equal(run(root, ["init"]).status, 0);
  put(root, ".cache/cc-sdd-install.failed", "失敗\n");
  put(root, ".cache/cc-sdd-install.state.json", "{}\n");
  const removed = run(root, ["uninstall"]);
  assert.equal(removed.status, 0, removed.outputText);
  assert.match(removed.outputText, /\.cache(?![\w/.-])/);
  assert.match(removed.outputText, /\.gitignore の除外が外れた/);
  const gitignorePath = path.join(root, ".gitignore");
  assert.ok(!fs.existsSync(gitignorePath) || !/# >>> cc-sdd-bootstrap/.test(fs.readFileSync(gitignorePath, "utf8")));
});

test("雛形を保持する init は MIT ライセンスのお知らせを出して設定に保存する", () => {
  const defaultRoot = makeRepo();
  const defaultInit = run(defaultRoot, ["init"]);
  assert.equal(defaultInit.status, 0, defaultInit.outputText);
  assert.doesNotMatch(defaultInit.outputText, /MIT/);

  const root = makeRepo();
  const initialized = run(root, ["init", "--keep-templates", "yes"]);
  assert.equal(initialized.status, 0, initialized.outputText);
  assert.match(initialized.outputText, /お知らせ:[\s\S]*MIT ライセンス/);
  assert.equal(JSON.parse(read(root, CONFIG_PATH).toString("utf8")).ccSdd.keepTemplates, true);
});

test("クライアント選択・旧設定移行・切替は両クライアントの実カタログ項目を反映する", () => {
  for (const [clients, claude, codex] of [["claude", true, false], ["codex", false, true], ["both", true, true]]) {
    const root = makeRepo();
    const initialized = runFixture(root, ["init", "--clients", clients]);
    assert.equal(initialized.status, 0, initialized.outputText);
    assert.equal(JSON.parse(read(root, CONFIG_PATH).toString("utf8")).clients, clients);
    assert.equal(JSON.parse(read(root, LEDGER_PATH).toString("utf8")).clients, clients);
    assert.equal(fs.existsSync(path.join(root, ".agent-hooks/cc-sdd-bootstrap/fixture-claude.txt")), claude, clients);
    assert.equal(fs.existsSync(path.join(root, ".agent-hooks/cc-sdd-bootstrap/fixture-codex.txt")), codex, clients);
    assert.equal(fs.existsSync(path.join(root, "CLAUDE.md")), claude, clients);
    assert.equal(fs.existsSync(path.join(root, "AGENTS.md")), codex, clients);
    const claudeSettings = fs.existsSync(path.join(root, ".claude/settings.json"))
      ? JSON.parse(read(root, ".claude/settings.json").toString("utf8")) : {};
    const codexHooks = fs.existsSync(path.join(root, ".codex/hooks.json"))
      ? JSON.parse(read(root, ".codex/hooks.json").toString("utf8")) : {};
    assert.equal(Boolean(claudeSettings.hooks?.SessionStart?.some((group) => group.hooks?.some((hook) => hook.command.includes("cc-sdd-bootstrap/")))), claude, `${clients} Claude hook`);
    assert.equal(Boolean(codexHooks.hooks?.SessionStart?.some((group) => group.hooks?.some((hook) => hook.command.endsWith("# cc-sdd-bootstrap:managed")))), codex, `${clients} Codex hook`);
    const updated = runFixture(root, ["update"]);
    assert.equal(updated.status, 0, updated.outputText);
    assert.equal(JSON.parse(read(root, CONFIG_PATH).toString("utf8")).clients, clients, `${clients} saved selection`);
  }

  const root = makeRepo();
  assert.equal(runFixture(root, ["init", "--clients", "claude"]).status, 0);
  const configPath = path.join(root, CONFIG_PATH);
  const oldConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  delete oldConfig.clients;
  fs.writeFileSync(configPath, `${JSON.stringify(oldConfig, null, 2)}\n`);
  const ledgerPath = path.join(root, LEDGER_PATH);
  const oldLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  delete oldLedger.clients;
  fs.writeFileSync(ledgerPath, `${JSON.stringify(oldLedger, null, 2)}\n`);
  const migrated = runFixture(root, ["update"]);
  assert.equal(migrated.status, 0, migrated.outputText);
  assert.equal(JSON.parse(read(root, CONFIG_PATH).toString("utf8")).clients, "both");
  assert.equal(JSON.parse(read(root, LEDGER_PATH).toString("utf8")).clients, "both");
  for (const item of [".agent-hooks/cc-sdd-bootstrap/fixture-claude.txt", ".agent-hooks/cc-sdd-bootstrap/fixture-codex.txt", "CLAUDE.md", "AGENTS.md", ".claude/settings.json", ".codex/hooks.json"]) {
    assert.ok(fs.existsSync(path.join(root, item)), item);
  }
  const migratedClaudeHooks = JSON.parse(read(root, ".claude/settings.json").toString("utf8"));
  const migratedCodexHooks = JSON.parse(read(root, ".codex/hooks.json").toString("utf8"));
  assert.ok(migratedClaudeHooks.hooks.SessionStart.some((group) => group.hooks.some((hook) => hook.command.includes("cc-sdd-bootstrap/"))));
  assert.ok(migratedCodexHooks.hooks.SessionStart.some((group) => group.hooks.some((hook) => hook.command.endsWith("# cc-sdd-bootstrap:managed"))));
  const before = snapshotTree(root);
  const repeated = runFixture(root, ["update"]);
  assert.equal(repeated.status, 0, repeated.outputText);
  assert.match(repeated.outputText, /変更はありません/);
  assertTreeSnapshot(root, before);

  for (const [from, to] of [["claude", "codex"], ["codex", "claude"]]) {
    const switchedRoot = makeRepo();
    assert.equal(runFixture(switchedRoot, ["init", "--clients", from]).status, 0);
    const switched = runFixture(switchedRoot, ["update", "--clients", to]);
    assert.equal(switched.status, 0, switched.outputText);
    assert.equal(JSON.parse(read(switchedRoot, CONFIG_PATH).toString("utf8")).clients, to);
    assert.equal(fs.existsSync(path.join(switchedRoot, ".agent-hooks/cc-sdd-bootstrap/fixture-claude.txt")), to === "claude");
    assert.equal(fs.existsSync(path.join(switchedRoot, ".agent-hooks/cc-sdd-bootstrap/fixture-codex.txt")), to === "codex");
    assert.equal(fs.existsSync(path.join(switchedRoot, "CLAUDE.md")), to === "claude");
    assert.equal(fs.existsSync(path.join(switchedRoot, "AGENTS.md")), to === "codex");
    const switchedClaudeHooks = fs.existsSync(path.join(switchedRoot, ".claude/settings.json")) ? JSON.parse(read(switchedRoot, ".claude/settings.json").toString("utf8")) : {};
    const switchedCodexHooks = fs.existsSync(path.join(switchedRoot, ".codex/hooks.json")) ? JSON.parse(read(switchedRoot, ".codex/hooks.json").toString("utf8")) : {};
    assert.equal(Boolean(switchedClaudeHooks.hooks?.SessionStart?.some((group) => group.hooks?.some((hook) => hook.command.includes("cc-sdd-bootstrap/")))), to === "claude");
    assert.equal(Boolean(switchedCodexHooks.hooks?.SessionStart?.some((group) => group.hooks?.some((hook) => hook.command.endsWith("# cc-sdd-bootstrap:managed")))), to === "codex");
  }
});

test("update と uninstall は独立した利用者スキル・JSON・TOML・override を保持する", () => {
  const root = makeRepo();
  const custom = {
    ".claude/skills/custom/SKILL.md": "# custom skill\n",
    ".agents/skills/custom/SKILL.md": "# custom codex skill\n",
    ".claude/settings.json": '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo claude user"}]}]},"permissions":{"allow":["Read"]}}\n',
    ".codex/config.toml": 'model = "user-model"\n\n[features]\ncustom = true\n',
    ".codex/hooks.json": '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo user"}]}],"SessionStart":[{"hooks":[{"type":"command","command":"echo user start"}]}]},"user":true}\n',
    "AGENTS.override.md": "# User override\n",
    ".gitignore": "user-build/\n",
    "CLAUDE.md": "# Project notes\nKeep this Claude text.\n",
    "AGENTS.md": "# Project notes\nKeep this Codex text.\n",
  };
  for (const [item, contents] of Object.entries(custom)) put(root, item, contents);
  const initialized = runFixture(root, ["init", "--clients", "both"]);
  assert.equal(initialized.status, 0, initialized.outputText);
  const beforeUpdate = Object.fromEntries(Object.keys(custom).map((item) => [item, read(root, item)]));
  const updated = runFixture(root, ["update"]);
  assert.equal(updated.status, 0, updated.outputText);
  assert.match(updated.outputText, /AGENTS\.override\.md[^\n]*AGENTS\.md[^\n]*管理区画[^\n]*参照/);
  assert.match(updated.outputText, /プロジェクトを信頼[^\n]*\/hooks[^\n]*承認/);
  for (const [item, bytes] of Object.entries(beforeUpdate)) assert.deepEqual(read(root, item), bytes, item);
  assert.match(read(root, ".gitignore").toString("utf8"), /\.agents\/skills\/kiro-\*\//);
  const ignoreCheck = spawnSync("git", ["check-ignore", "-q", ".agents/skills/custom/SKILL.md"], { cwd: root });
  assert.equal(ignoreCheck.status, 1, "the independent Codex skill must not match the Kiro-only ignore pattern");
  const beforeUninstall = Object.fromEntries(Object.keys(custom).map((item) => [item, read(root, item)]));
  const removed = runFixture(root, ["uninstall"]);
  assert.equal(removed.status, 0, removed.outputText);
  for (const item of [".claude/skills/custom/SKILL.md", ".agents/skills/custom/SKILL.md", ".codex/config.toml", "AGENTS.override.md"]) {
    assert.deepEqual(read(root, item), beforeUninstall[item], item);
  }
  for (const item of [".claude/settings.json", ".codex/hooks.json"]) {
    assert.deepEqual(JSON.parse(read(root, item)), JSON.parse(custom[item]), item);
  }
  assert.equal(read(root, "CLAUDE.md").toString("utf8"), custom["CLAUDE.md"]);
  assert.equal(read(root, "AGENTS.md").toString("utf8"), custom["AGENTS.md"]);
  assert.deepEqual(read(root, ".gitignore"), Buffer.from(custom[".gitignore"]));
});

test("選択した Codex JSON の破損と壊れた AGENTS 目印は update を無変更で中止する", () => {
  for (const [file, content, diagnostic] of [
    [".codex/hooks.json", "{", ".codex/hooks.json"],
    ["AGENTS.md", "# user\n<!-- cc-sdd-bootstrap:end -->\n", "AGENTS.md"],
  ]) {
    const root = makeRepo();
    assert.equal(runFixture(root, ["init", "--clients", "codex"]).status, 0);
    assert.equal(fs.existsSync(path.join(root, "CLAUDE.md")), false);
    put(root, file, content);
    const before = snapshotTree(root);
    const failed = runFixture(root, ["update", "--clients", "both"]);
    assert.equal(failed.status, 1, failed.outputText);
    assert.match(failed.outputText, new RegExp(diagnostic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assertTreeSnapshot(root, before);
    assert.equal(fs.existsSync(path.join(root, "CLAUDE.md")), false, "pending Claude additions must not be partially applied");
  }
});
