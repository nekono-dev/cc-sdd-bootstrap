import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computePlan, assertAllowedPath } from "../lib/plan-new.mjs";
import { catalog } from "../lib/catalog.mjs";

const fields = [{ path: "sample.enabled", kind: "boolean", defaultValue: true, validate: (v) => typeof v === "boolean" ? null : "真偽値で指定してください" }];
const sources = Object.fromEntries(catalog.files.map(({ path }) => [path, readFileSync(new URL(`../${path}`, import.meta.url))]));
const empty = () => ({ config: null, claudeSettings: null, codexHooks: null, gitignore: null, agentDocs: { claude: null, codex: null }, deployDirFiles: {}, generatedFiles: {}, sourceFiles: sources });
const run = (operation, snapshot) => computePlan({ operation, snapshot, catalog, fields });

const generatedCatalog = (render, owns = [".claude/agents/cc-sdd-*.md"]) => ({
  ...catalog,
  generated: [{ id: "agents", owns, render }],
});

test("init は設定があれば中止し変更を返さない", () => {
  const result = run("init", { ...empty(), config: '{"format":1}' });
  assert.deepEqual(result, { ok: false, aborts: [{ code: "CONFIG_EXISTS" }] });
});

test("設定から作るファイルを違う内容だけ書き、知らせを計画に載せる", () => {
  const custom = generatedCatalog((config) => ({ files: [
    { path: ".claude/agents/cc-sdd-one.md", content: `設定:${config.sample.enabled}` },
    { path: ".claude/agents/cc-sdd-same.md", content: "同じ" },
  ], notices: ["役割を作りました"] }));
  const result = computePlan({ operation: "init", catalog: custom, snapshot: {
    ...empty(), generatedFiles: { ".claude/agents/cc-sdd-same.md": Buffer.from("同じ") },
  }, fields });
  assert.equal(result.ok, true);
  assert.ok(result.changes.some((change) => change.kind === "write" && change.path === ".claude/agents/cc-sdd-one.md" && change.content === "設定:true"));
  assert.ok(!result.changes.some((change) => change.path === ".claude/agents/cc-sdd-same.md"));
  assert.ok(result.notices.some((notice) => notice.code === "GENERATED_NOTICE" && notice.id === "agents" && notice.messages[0] === "役割を作りました"));
});

test("設定から作るファイルは型に当たり、返されなかった既存ファイルだけ削除する", () => {
  const custom = generatedCatalog(() => ({ files: [{ path: ".claude/agents/cc-sdd-kept.md", content: "新" }], notices: [] }));
  const result = computePlan({ operation: "update", catalog: custom, snapshot: {
    ...empty(), config: '{"format":1}', generatedFiles: {
      ".claude/agents/cc-sdd-old.md": Buffer.from("旧"),
      ".claude/agents/other.md": Buffer.from("残す"),
    },
  }, fields });
  assert.equal(result.ok, true);
  assert.ok(result.changes.some((change) => change.kind === "write" && change.path === ".claude/agents/cc-sdd-kept.md"));
  assert.ok(result.changes.some((change) => change.kind === "delete" && change.path === ".claude/agents/cc-sdd-old.md"));
  assert.ok(!result.changes.some((change) => change.path === ".claude/agents/other.md"));
});

test("設定から作るファイルが型の外の道筋を返したら例外にする", () => {
  const custom = generatedCatalog(() => ({ files: [{ path: ".claude/agents/other.md", content: "誤り" }], notices: [] }));
  assert.throws(() => computePlan({ operation: "init", catalog: custom, snapshot: empty(), fields }), /許可範囲外/);
});

test("設定が不正なら設定から作るファイルの作成関数を呼ばない", () => {
  let called = false;
  const custom = generatedCatalog(() => { called = true; return { files: [], notices: [] }; });
  const result = computePlan({ operation: "update", catalog: custom, snapshot: { ...empty(), config: '{"format":1,"sample":{"enabled":"誤り"}}' }, fields });
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("update は設定が無ければ中止し変更を返さない", () => {
  assert.deepEqual(run("update", empty()), { ok: false, aborts: [{ code: "CONFIG_MISSING" }] });
});

test("init は既定値の設定と両方のフック・gitignore の差分を作る", () => {
  const result = run("init", empty());
  assert.equal(result.ok, true);
  assert.ok(result.changes.some((c) => c.path === ".cc-sdd-bootstrap.json" && JSON.parse(c.content).sample.enabled));
  assert.ok(result.changes.some((c) => c.path === ".claude/settings.json"));
  assert.ok(result.changes.some((c) => c.path === ".codex/hooks.json"));
  assert.ok(result.changes.some((c) => c.path === ".gitignore"));
  assert.ok(result.changes.every((c) => c.kind === "write" ? typeof c.created === "boolean" : c.kind === "delete"));
});

test("update は設定の不足項目を補い、設定の誤りも収集する", () => {
  const snapshot = { ...empty(), config: '{"format":1,"keep":7}' };
  const result = run("update", snapshot);
  const configChange = result.changes.find((c) => c.path === ".cc-sdd-bootstrap.json");
  assert.equal(JSON.parse(configChange.content).keep, 7);
  assert.equal(JSON.parse(configChange.content).sample.enabled, true);
  const broken = run("update", { ...snapshot, config: '{"format":1,"sample":{"enabled":"bad"}}', claudeSettings: "{" });
  assert.equal(broken.ok, false);
  assert.equal(broken.aborts.length, 2);
});

test("同じ状態を再計算すると変更は空", () => {
  const first = run("init", empty());
  const current = { ...empty() };
  current.deployDirFiles = { ...current.sourceFiles };
  for (const c of first.changes) {
    if (c.kind !== "write") continue;
    if (c.path.startsWith(".agent-hooks/cc-sdd-bootstrap/")) current.deployDirFiles[c.path] = Buffer.from(c.content);
    if (c.path === ".cc-sdd-bootstrap.json") current.config = c.content;
    else if (c.path === ".claude/settings.json") current.claudeSettings = c.content;
    else if (c.path === ".codex/hooks.json") current.codexHooks = c.content;
    else if (c.path === ".gitignore") current.gitignore = c.content;
  }
  assert.deepEqual(run("update", current).changes, []);
});

test("update は補う項目がなければ設定の書式を変えない", () => {
  const initialized = run("init", empty());
  const snapshot = { ...empty(), config: '{"format":1,"sample":{"enabled":true}}\n' };
  snapshot.deployDirFiles = { ...snapshot.sourceFiles };
  for (const change of initialized.changes) {
    if (change.path.startsWith(".agent-hooks/cc-sdd-bootstrap/")) snapshot.deployDirFiles[change.path] = Buffer.from(change.content);
    if (change.path === ".claude/settings.json") snapshot.claudeSettings = change.content;
    else if (change.path === ".codex/hooks.json") snapshot.codexHooks = change.content;
    else if (change.path === ".gitignore") snapshot.gitignore = change.content;
  }
  const result = run("update", snapshot);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changes, []);
});

test("変更の道筋外は例外にする", () => {
  assert.throws(() => assertAllowedPath("outside.txt"), /許可範囲外/);
  assert.throws(() => assertAllowedPath(".agent-hooks/cc-sdd-bootstrap/../../unrelated.txt"), /許可範囲外/);
  assert.doesNotThrow(() => assertAllowedPath(".agent-hooks/cc-sdd-bootstrap/file.mjs"));
});

test("配置先の古いファイルを削除し、カタログの内容を配置する", () => {
  const snapshot = {
    ...empty(),
    deployDirFiles: {
      [catalog.files[0].path]: Buffer.from("古い内容"),
      [`${catalog.files[0].path}.old`]: Buffer.from("旧版"),
      [".agent-hooks/cc-sdd-bootstrap/installed.json"]: Buffer.from("{}"),
    },
    sourceFiles: Object.fromEntries(catalog.files.map(({ path }) => [path, Buffer.from(`内容:${path}`)])),
  };
  const result = run("init", snapshot);
  assert.equal(result.ok, true);
  assert.ok(result.changes.some((change) => change.kind === "delete" && change.path.endsWith(".old")));
  assert.ok(result.changes.some((change) => change.kind === "delete" && change.path.endsWith("installed.json")));
  assert.ok(result.changes.some((change) => change.kind === "write" && change.path === catalog.files[0].path && change.content.equals(snapshot.sourceFiles[catalog.files[0].path])));
});

test("両ツールの運用区画を配置し、同じ内容なら再配置しない", () => {
  const first = run("init", empty());
  assert.equal(first.ok, true);
  const sectionPaths = ["claude", "codex"].map((tool) => `.agent-hooks/cc-sdd-bootstrap/agent-section-${tool}.md`);
  const sections = first.changes.filter((change) => change.kind === "write" && sectionPaths.includes(change.path));
  assert.equal(sections.length, 2);
  for (const section of sections) {
    assert.match(section.content, /^<!-- cc-sdd-bootstrap:begin.* -->\n/);
    assert.match(section.content, /<!-- cc-sdd-bootstrap:end -->\n$/);
    assert.match(section.content, /この区画は cc-sdd-bootstrap の導入のたびに書き足される/);
    assert.equal((section.content.match(/<!-- cc-sdd-bootstrap:begin/g) ?? []).length, 1);
    assert.equal((section.content.match(/<!-- cc-sdd-bootstrap:end/g) ?? []).length, 1);
  }
  const current = { ...empty(), config: first.changes.find((c) => c.path === ".cc-sdd-bootstrap.json").content };
  current.deployDirFiles = { ...current.sourceFiles };
  for (const change of first.changes) {
    if (change.path === ".claude/settings.json") current.claudeSettings = change.content;
    if (change.path === ".codex/hooks.json") current.codexHooks = change.content;
    if (change.path === ".gitignore") current.gitignore = change.content;
    if (sectionPaths.includes(change.path)) current.deployDirFiles[change.path] = Buffer.from(change.content);
  }
  assert.deepEqual(run("update", current).changes, []);
});

test("配置先のカタログファイルが同じ内容なら書き込みに載せない", () => {
  const sourceFiles = Object.fromEntries(catalog.files.map(({ path }) => [path, Buffer.from(`内容:${path}`)]));
  const result = run("init", { ...empty(), sourceFiles, deployDirFiles: { [catalog.files[0].path]: sourceFiles[catalog.files[0].path] } });
  assert.equal(result.ok, true);
  assert.ok(!result.changes.some((change) => change.kind === "write" && change.path === catalog.files[0].path));
});

test("uninstall はフック登録と運用区画だけを外し、設定や配置物を求めない", () => {
  const begin = "<!-- cc-sdd-bootstrap:begin（この区画は cc-sdd の導入のたびに書き足される。編集しない） -->";
  const end = "<!-- cc-sdd-bootstrap:end -->";
  const claude = `標準文書\n\n${begin}\n運用案内\n${end}\n`;
  const codex = `標準文書\n\n${begin}\n運用案内\n${end}\n`;
  const result = run("uninstall", {
    claudeSettings: JSON.stringify({ other: true, hooks: { Stop: [{ hooks: [{ command: "node /repo/.agent-hooks/cc-sdd-bootstrap/hook.mjs" }] }] } }),
    codexHooks: JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "node /repo/.agent-hooks/cc-sdd-bootstrap/hook.mjs" }] }] } }),
    agentDocs: { claude, codex },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changes.map(({ path, kind }) => [path, kind]), [
    [".claude/settings.json", "write"], [".codex/hooks.json", "delete"], ["CLAUDE.md", "write"], ["AGENTS.md", "write"],
  ]);
  assert.deepEqual(result.removed, [".claude/settings.json", ".codex/hooks.json", "CLAUDE.md", "AGENTS.md"]);
  assert.ok(result.changes.find((c) => c.path === "CLAUDE.md").content.includes("標準文書"));
  assert.ok(!result.changes.some((c) => c.path.includes(".cc-sdd-bootstrap.json") || c.path.includes(".gitignore") || c.path.includes(".agent-hooks/")));
});

test("uninstall は区画の無い文書を変更しない", () => {
  const result = run("uninstall", { ...empty(), config: "壊れているが読まない", agentDocs: { claude: "文書", codex: null } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.removed, []);
});

test("uninstall は壊れた区画と読めない設定をすべて集めて変更を返さない", () => {
  const begin = "<!-- cc-sdd-bootstrap:begin（この区画は cc-sdd の導入のたびに書き足される。編集しない） -->";
  const result = run("uninstall", { ...empty(), claudeSettings: "{", codexHooks: "[]", agentDocs: { claude: `${begin}\n壊れた`, codex: "<!-- cc-sdd-bootstrap:end -->\n" } });
  assert.equal(result.ok, false);
  assert.equal(result.aborts.length, 4);
  assert.deepEqual(result.aborts.map((a) => a.file), [".claude/settings.json", ".codex/hooks.json", "CLAUDE.md", "AGENTS.md"]);
});

test("init は agent 文書を変更せず、存在案内と Codex・既定値の案内を付ける", () => {
  const result = run("init", { ...empty(), agentDocs: { claude: "既存", codex: "既存" } });
  assert.equal(result.ok, true);
  assert.ok(!result.changes.some((change) => ["CLAUDE.md", "AGENTS.md"].includes(change.path)));
  assert.ok(result.notices.some((notice) => notice.code === "EXISTING_AGENT_DOCS" && notice.files.join(",") === "CLAUDE.md,AGENTS.md"));
  assert.ok(result.notices.some((notice) => notice.code === "CODEX_TRUST"));
  assert.ok(result.notices.some((notice) => notice.code === "CONFIG_CREATED"));
});
