import test from "node:test";
import assert from "node:assert/strict";
import { computePlan, assertAllowedPath } from "../lib/plan-new.mjs";
import { catalog } from "../lib/catalog.mjs";

const fields = [{ path: "sample.enabled", kind: "boolean", defaultValue: true, validate: (v) => typeof v === "boolean" ? null : "真偽値で指定してください" }];
const empty = () => ({ config: null, claudeSettings: null, codexHooks: null, gitignore: null, agentDocs: { claude: null, codex: null }, deployDirFiles: {}, generatedFiles: {}, sourceFiles: {} });
const run = (operation, snapshot) => computePlan({ operation, snapshot, catalog, fields });

test("init は設定があれば中止し変更を返さない", () => {
  const result = run("init", { ...empty(), config: '{"format":1}' });
  assert.deepEqual(result, { ok: false, aborts: [{ code: "CONFIG_EXISTS" }] });
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
  for (const c of first.changes) {
    if (c.kind !== "write") continue;
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
  for (const change of initialized.changes) {
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
