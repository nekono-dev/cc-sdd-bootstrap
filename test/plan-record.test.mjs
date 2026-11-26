// 導入・更新の計画に版と指紋の記録（install-record.json）を足す処理の試験（1.6）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computePlan } from "../lib/plan.mjs";
import { catalog, AGENT_SECTION_FILES, CONFIG_PATH, CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH, DEPLOY_DIR } from "../lib/catalog.mjs";
import { RECORD_PATH, fingerprint, parseRecord } from "../.agent-hooks/cc-sdd-bootstrap/freshness-rules.mjs";

const FRESHNESS = `${DEPLOY_DIR}/freshness.mjs`;
const RULES = `${DEPLOY_DIR}/freshness-rules.mjs`;
const COMMIT = "a".repeat(40);
const expectedKeys = [...catalog.files.map((file) => file.path), AGENT_SECTION_FILES.claude, AGENT_SECTION_FILES.codex].sort();

// 配布物の同梱の内容（リポジトリの実ファイル）
const sourcesOf = () => Object.fromEntries(catalog.files.map(({ path }) => [path, readFileSync(new URL(`../${path}`, import.meta.url))]));
const empty = (extra = {}) => ({
  config: null, claudeSettings: null, codexHooks: null, gitignore: null,
  agentDocs: { claude: null, codex: null }, deployDirFiles: {}, generatedFiles: {},
  sourceFiles: sourcesOf(), ...extra,
});
const run = (operation, snapshot) => computePlan({ operation, snapshot, catalog, fields: [] });
const recordChange = (result) => result.changes.find((change) => change.path === RECORD_PATH);
const contentOf = (result, path) => result.changes.find((change) => change.path === path && change.kind === "write")?.content;
const recordOf = (text) => {
  const parsed = parseRecord(text);
  assert.equal(parsed.state, "ok", "記録が正常な形になっていません");
  return parsed.record;
};

test("init の計画に記録の書き込みが作成として入り、配置の書き込みの最後に並ぶ", () => {
  const result = run("init", empty());
  assert.equal(result.ok, true);
  const change = recordChange(result);
  assert.ok(change, "記録の書き込みがありません");
  assert.equal(change.kind, "write");
  assert.equal(change.created, true);
  assert.equal(result.changes.at(-1).path, RECORD_PATH);
});

test("記録のファイル一覧は配置物と運用の区画の 2 ファイルに一致し、記録自身を含まない", () => {
  const result = run("init", empty());
  const record = recordOf(recordChange(result).content);
  assert.deepEqual(Object.keys(record.files).sort(), expectedKeys);
  assert.ok(Object.keys(record.files).includes(FRESHNESS));
  assert.ok(Object.keys(record.files).includes(RULES));
  assert.ok(!Object.keys(record.files).includes(RECORD_PATH));
});

test("記録の各指紋は、書き込む内容の SHA-256 と一致する", () => {
  const result = run("init", empty());
  const record = recordOf(recordChange(result).content);
  for (const key of expectedKeys) {
    assert.equal(record.files[key], fingerprint(contentOf(result, key)), key);
  }
});

test("記録の source は取り出した版をそのまま入れ、取り出せない null も保つ", () => {
  const withVersion = recordOf(recordChange(run("init", empty({ source: { commit: COMMIT, ref: "main" } }))).content);
  assert.deepEqual(withVersion.source, { commit: COMMIT, ref: "main" });
  const unknown = recordOf(recordChange(run("init", empty({ source: { commit: null, ref: null } }))).content);
  assert.deepEqual(unknown.source, { commit: null, ref: null });
  const absent = recordOf(recordChange(run("init", empty())).content);
  assert.deepEqual(absent.source, { commit: null, ref: null });
});

test("同梱の内容が変わると、その配置物の指紋だけが変わる", () => {
  const base = recordOf(recordChange(run("init", empty())).content);
  const sources = sourcesOf();
  sources[FRESHNESS] = Buffer.from("変更後の入口\n");
  const changed = recordOf(recordChange(run("init", empty({ sourceFiles: sources }))).content);
  assert.notEqual(changed.files[FRESHNESS], base.files[FRESHNESS]);
  assert.equal(changed.files[RULES], base.files[RULES]);
});

test("同じ内容・同じ版なら、2 回目の計画に記録の変更は無い", () => {
  const first = run("init", empty());
  const snapshot = empty({ config: contentOf(first, CONFIG_PATH) });
  const fixed = new Map([
    [CLAUDE_SETTINGS_PATH, "claudeSettings"],
    [CODEX_HOOKS_PATH, "codexHooks"],
    [".gitignore", "gitignore"],
  ]);
  for (const change of first.changes) {
    if (change.kind !== "write" || change.path === CONFIG_PATH) continue;
    if (fixed.has(change.path)) snapshot[fixed.get(change.path)] = change.content;
    else if (change.path.startsWith(`${DEPLOY_DIR}/`)) snapshot.deployDirFiles[change.path] = change.content;
    else snapshot.generatedFiles[change.path] = change.content;
  }
  const second = run("update", snapshot);
  assert.equal(second.ok, true);
  assert.equal(recordChange(second), undefined);
  assert.deepEqual(second.changes, []);
});

test("古い記録は内容の違いとして上書きされる（作成ではない）", () => {
  const result = run("update", empty({ config: '{"format":1}', deployDirFiles: { [RECORD_PATH]: Buffer.from("{}\n") } }));
  const change = recordChange(result);
  assert.ok(change);
  assert.equal(change.kind, "write");
  assert.equal(change.created, false);
});

test("既存の記録は配置ディレクトリの削除対象にならず、古い配置物だけが削除される", () => {
  const result = run("update", empty({
    config: '{"format":1}',
    deployDirFiles: { [RECORD_PATH]: Buffer.from("旧"), [`${DEPLOY_DIR}/old.mjs`]: Buffer.from("旧") },
  }));
  assert.ok(!result.changes.some((change) => change.kind === "delete" && change.path === RECORD_PATH));
  assert.ok(result.changes.some((change) => change.kind === "delete" && change.path === `${DEPLOY_DIR}/old.mjs`));
});

test("同梱が読めなかった配置物は記録に含めない", () => {
  const sources = sourcesOf();
  delete sources[FRESHNESS];
  const record = recordOf(recordChange(run("init", empty({ sourceFiles: sources }))).content);
  assert.ok(!Object.keys(record.files).includes(FRESHNESS));
  assert.ok(Object.keys(record.files).includes(RULES));
});

test("uninstall の計画は記録に触れない（既存の記録があっても削除も書き込みもしない）", () => {
  const result = run("uninstall", {
    config: null, claudeSettings: null, codexHooks: null, gitignore: null,
    agentDocs: { claude: null, codex: null }, deployDirFiles: { [RECORD_PATH]: Buffer.from("記録") },
    generatedFiles: {}, sourceFiles: {},
  });
  assert.equal(result.ok, true);
  assert.ok(!result.changes.some((change) => change.path === RECORD_PATH));
});
