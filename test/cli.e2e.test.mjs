import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(packageRoot, "bin/cc-sdd-bootstrap.mjs");

/** 対象ごとの分離（CODEX_HOME・HOME を一時ディレクトリにした環境）。利用者の ~/.codex に触れないため */
const isolations = new Map();

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-e2e-new-"));
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cli-e2e-codex-"));
  const codexHome = path.join(base, "codex");
  const home = path.join(base, "home");
  fs.mkdirSync(codexHome);
  fs.mkdirSync(home);
  isolations.set(root, { codexHome, home, env: { ...process.env, CODEX_HOME: codexHome, HOME: home } });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });
  return root;
}

/** cwd を含む対象の分離環境を求める。対応が無ければ例外（分離なしでの実行を防ぐ） */
function isolationOf(cwd) {
  let dir = cwd;
  while (!isolations.has(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`分離の環境がありません: ${cwd}`);
    dir = parent;
  }
  return isolations.get(dir);
}

function run(root, args) {
  return spawnSync(process.execPath, [entry, ...args], { cwd: root, encoding: "utf8", env: isolationOf(root).env });
}

function runOrSkip(t, root, args) {
  const result = run(root, args);
  if (result.error) {
    t.skip(`子プロセスを起動できません: ${result.error.code}`);
    return null;
  }
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("一時の git リポジトリで init・利用者設定を保つ update・uninstall を通して実行できる", (t) => {
  const root = temporary(t);
  const initialized = runOrSkip(t, root, ["init"]);
  if (!initialized) return;
  assert.equal(initialized.status, 0, initialized.stderr);

  const config = path.join(root, ".cc-sdd-bootstrap.json");
  const claudeSettings = path.join(root, ".claude/settings.json");
  const codexHooks = path.join(root, ".codex/hooks.json");
  const ignore = path.join(root, ".gitignore");
  const deploy = path.join(root, ".agent-hooks/cc-sdd-bootstrap");
  for (const file of [config, claudeSettings, codexHooks, ignore,
    path.join(deploy, "install-cc-sdd.mjs"), path.join(deploy, "install-rules.mjs"),
    path.join(deploy, "config-schema.mjs"), path.join(deploy, "subagent-roles.mjs"),
    path.join(deploy, "agent-section-claude.md"), path.join(deploy, "agent-section-codex.md")]) {
    assert.ok(fs.existsSync(file), `${path.relative(root, file)} がありません`);
  }

  const claude = readJson(claudeSettings);
  claude.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: "利用者の同じ組のフック" }] });
  claude.hooks.UserPromptSubmit.push({ matcher: "利用者の組", hooks: [{ type: "command", command: "利用者の別の組" }] });
  claude.userSetting = "保持する値";
  fs.writeFileSync(claudeSettings, `${JSON.stringify(claude, null, 2)}\n`);

  const codex = readJson(codexHooks);
  // Codex 向けの登録が 0 件のとき、init は hooks の鍵の無い設定を作る（利用者が足す前提で形を用意する）
  codex.hooks ??= {};
  codex.hooks.SessionStart ??= [];
  codex.hooks.SessionStart.push({ hooks: [{ type: "command", command: "利用者の同じ組のフック" }] });
  codex.hooks.SessionStart.push({ matcher: "利用者の組", hooks: [{ type: "command", command: "利用者の別の組" }] });
  codex.userSetting = "保持する値";
  fs.writeFileSync(codexHooks, `${JSON.stringify(codex, null, 2)}\n`);

  const userIgnoreLine = "# 利用者の除外設定";
  fs.appendFileSync(ignore, `${userIgnoreLine}\n`);
  const updated = runOrSkip(t, root, ["update"]);
  if (!updated) return;
  assert.equal(updated.status, 0, updated.stderr);
  for (const [file, event] of [[claudeSettings, "UserPromptSubmit"], [codexHooks, "SessionStart"]]) {
    const hooks = readJson(file);
    assert.equal(hooks.userSetting, "保持する値");
    assert.ok(hooks.hooks[event].some((group) => group.hooks?.some((hook) => hook.command === "利用者の同じ組のフック")));
    assert.ok(hooks.hooks[event].some((group) => group.matcher === "利用者の組"));
  }
  assert.match(fs.readFileSync(ignore, "utf8"), /^# 利用者の除外設定$/m);
  const repeated = runOrSkip(t, root, ["update"]);
  if (!repeated) return;
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /変更はありません/);

  const configText = fs.readFileSync(config, "utf8");
  const broken = { ...readJson(config), subagents: { maxModel: { claude: "fable" } } };
  fs.writeFileSync(config, `${JSON.stringify(broken, null, 2)}\n`);
  const failed = runOrSkip(t, root, ["update"]);
  if (!failed) return;
  assert.notEqual(failed.status, 0);
  assert.match(`${failed.stdout}${failed.stderr}`, /subagents\.maxModel\.claude/);
  fs.writeFileSync(config, configText);

  const claudeDoc = "# 標準の Claude 文書\n\n標準部分を残す。\n";
  const agentsDoc = "# 標準の Codex 文書\n\n標準部分を残す。\n";
  const claudeSection = fs.readFileSync(path.join(deploy, "agent-section-claude.md"), "utf8");
  const codexSection = fs.readFileSync(path.join(deploy, "agent-section-codex.md"), "utf8");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), `${claudeDoc}\n${claudeSection}`);
  fs.writeFileSync(path.join(root, "AGENTS.md"), `${agentsDoc}\n${codexSection}`);

  const removed = runOrSkip(t, root, ["uninstall"]);
  if (!removed) return;
  assert.equal(removed.status, 0, removed.stderr);
  for (const [file, event] of [[claudeSettings, "UserPromptSubmit"], [codexHooks, "SessionStart"]]) {
    const hooks = readJson(file);
    assert.equal(hooks.userSetting, "保持する値");
    assert.ok(hooks.hooks[event].some((group) => group.hooks?.some((hook) => hook.command === "利用者の同じ組のフック")));
    assert.ok(hooks.hooks[event].some((group) => group.matcher === "利用者の組"));
    assert.ok(!JSON.stringify(hooks).includes(".agent-hooks/cc-sdd-bootstrap/"));
  }
  for (const [file, standard, markers] of [
    [path.join(root, "CLAUDE.md"), claudeDoc, "cc-sdd-bootstrap:"],
    [path.join(root, "AGENTS.md"), agentsDoc, "cc-sdd-bootstrap:"],
  ]) {
    const content = fs.readFileSync(file, "utf8");
    assert.ok(content.includes(standard));
    assert.ok(!content.includes(markers));
  }
  assert.ok(fs.existsSync(config));
  assert.ok(fs.existsSync(path.join(deploy, "install-cc-sdd.mjs")));
  assert.ok(fs.existsSync(ignore));
  assert.match(fs.readFileSync(ignore, "utf8"), /^# 利用者の除外設定$/m);
});

test("git の最上位でない場所では何も変更しない", (t) => {
  const root = temporary(t);
  const nested = path.join(root, "subdir");
  fs.mkdirSync(nested);
  const before = fs.readdirSync(root).sort();
  const result = runOrSkip(t, nested, ["init"]);
  if (!result) return;
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git リポジトリの最上位/);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  assert.deepEqual(fs.readdirSync(nested), []);
});

test("シンボリックリンクを通る変更先では何も変更しない", (t) => {
  const root = temporary(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cli-e2e-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, ".claude"), "dir");
  const before = fs.readdirSync(root).sort();
  const result = runOrSkip(t, root, ["init"]);
  if (!result) return;
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.claude\/settings\.json/);
  assert.match(result.stderr, /シンボリックリンク/);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("未対応の指定は変更せず、問題と使い方を表示して失敗する", (t) => {
  const root = temporary(t);
  const result = runOrSkip(t, root, ["init", "--force"]);
  if (!result) return;
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--force/);
  assert.match(result.stderr, /使い方/);
  assert.deepEqual(fs.readdirSync(root), [".git"]);
});

test("init の後の update で役割定義が系統ごとに作られ、上限を下げると上の系統が消え、知らせは差分が無くても表示される", (t) => {
  const root = temporary(t);
  const initialized = runOrSkip(t, root, ["init"]);
  if (!initialized) return;
  assert.equal(initialized.status, 0, initialized.stderr);

  const claudeHooks = JSON.stringify(readJson(path.join(root, ".claude/settings.json")));
  const codexHooks = JSON.stringify(readJson(path.join(root, ".codex/hooks.json")));
  assert.match(claudeHooks, /subagent-check\.mjs/);
  assert.match(codexHooks, /subagent-check\.mjs/);
  const agents = (dir, pattern) => fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)).filter((name) => pattern.test(name)).sort() : [];
  assert.equal(agents(".claude/agents", /^cc-sdd-.*\.md$/).length, 12);
  assert.deepEqual(agents(".codex/agents", /^cc_sdd_.*\.toml$/), ["cc_sdd_implement.toml"]);
  assert.ok(fs.existsSync(path.join(root, ".agent-hooks/cc-sdd-bootstrap/subagent-check.mjs")));
  assert.ok(fs.existsSync(path.join(root, ".agent-hooks/cc-sdd-bootstrap/delegate.mjs")));

  // 差分が無い 2 回目でも、設定から作るファイルの知らせを落とさない
  const repeated = runOrSkip(t, root, ["update"]);
  if (!repeated) return;
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /変更はありません/);
  assert.match(repeated.stdout, /読み取り専用を適用できない/);

  // 子の上限を下げると上の系統の定義が消える
  const config = path.join(root, ".cc-sdd-bootstrap.json");
  fs.writeFileSync(config, `${JSON.stringify({ ...readJson(config), subagents: { maxModel: { claude: "sonnet" } } }, null, 2)}\n`);
  const lowered = runOrSkip(t, root, ["update"]);
  if (!lowered) return;
  assert.equal(lowered.status, 0, lowered.stderr);
  const after = agents(".claude/agents", /^cc-sdd-.*\.md$/);
  assert.ok(after.length > 0 && after.length < 12);
  assert.ok(!after.some((name) => /-opus\.md$/.test(name)), after.join(","));
  assert.match(lowered.stdout, /削除: .*cc-sdd-.*-opus\.md/);
  assert.match(lowered.stdout, /読み取り専用を適用できない/);
});

test("定義のファイルに差分が無く設定の変更で新しい知らせだけが生じる update でも、知らせを表示する", (t) => {
  const root = temporary(t);
  const initialized = runOrSkip(t, root, ["init"]);
  if (!initialized) return;
  assert.equal(initialized.status, 0, initialized.stderr);
  const settled = runOrSkip(t, root, ["update"]);
  if (!settled) return;
  assert.equal(settled.status, 0, settled.stderr);
  const novel = /役割 review のモデル terra は Claude Code の定義には使わず/;
  assert.doesNotMatch(settled.stdout, novel);

  const config = path.join(root, ".cc-sdd-bootstrap.json");
  const current = readJson(config);
  current.subagents = { roles: { claude: { review: { model: "terra" } } } };
  fs.writeFileSync(config, `${JSON.stringify(current, null, 2)}\n`);
  const changed = runOrSkip(t, root, ["update"]);
  if (!changed) return;
  assert.equal(changed.status, 0, changed.stderr);
  assert.match(changed.stdout, /変更はありません。/);
  assert.match(changed.stdout, novel);
});

test("一時の git リポジトリで init すると承認の記録が 10 件書かれ、uninstall で取り除かれる", (t) => {
  const root = temporary(t);
  const initialized = runOrSkip(t, root, ["init"]);
  if (!initialized) return;
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.match(initialized.stdout, /Codex のフックの承認の記録を書きました/);
  assert.ok(!initialized.stdout.includes("信頼の承認が必要です"), initialized.stdout);

  const config = path.join(isolationOf(root).codexHome, "config.toml");
  const written = fs.readFileSync(config, "utf8");
  assert.equal((written.match(/trusted_hash/g) ?? []).length, 10);
  for (const name of ["codex-trust.mjs", "codex-trust-rules.mjs"]) {
    assert.ok(fs.existsSync(path.join(root, ".agent-hooks/cc-sdd-bootstrap", name)), `${name} が導入先に写されていません`);
  }

  const removed = runOrSkip(t, root, ["uninstall"]);
  if (!removed) return;
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /Codex のフックの承認の記録を取り除きました/);
  assert.equal((fs.readFileSync(config, "utf8").match(/trusted_hash/g) ?? []).length, 0);
  const hooks = path.join(root, ".codex/hooks.json");
  assert.ok(!fs.existsSync(hooks) || !fs.readFileSync(hooks, "utf8").includes(".agent-hooks/cc-sdd-bootstrap/"));
});
