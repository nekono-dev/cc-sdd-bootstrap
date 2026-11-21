import { test } from "node:test";
import assert from "node:assert/strict";
import { makePlan } from "../lib/plan.mjs";
import { parseLedger, sha256 } from "../lib/ledger.mjs";

const config = { format: 1, clients: "both", codex: { enabled: true } };
const baseLedger = { format: 1, bootstrapVersion: "0.1.0", clients: "both", files: {} };
function input({ operation = "init", configValue = config, mcp = null, ledger = null } = {}) {
  return {
    operation, config: configValue,
    snapshot: { config: null, ledger: ledger === null ? null : JSON.stringify(ledger), settings: null, codexHooksJson: null,
      mcpJson: mcp, gitignore: null, claudeMd: null, agentsMd: null, files: {}, modes: {}, ignoredPresent: [] },
    catalog: { files: [], hooks: [], codexHooks: [], gitignore: [], claudeSections: [], agentsSections: [] },
    packageFiles: {}, bootstrapVersion: "0.1.0", force: false,
  };
}
const registrationFrom = (plan) => JSON.parse(plan.changes.find((c) => c.path === ".mcp.json")?.content ?? "null");

test("Claude Code と Codex 利用選択が有効なら管理登録を追加し、他の設定を保つ", () => {
  const plan = makePlan(input({ mcp: JSON.stringify({ other: 7, mcpServers: { user: { command: "user" } } }) }));
  const result = registrationFrom(plan);
  assert.equal(result.other, 7);
  assert.deepEqual(result.mcpServers.user, { command: "user" });
  assert.equal(result.mcpServers["cc-sdd-codex"].command, "sh");
  assert.match(result.mcpServers["cc-sdd-codex"].args[1], /git rev-parse --show-toplevel/);
  assert.ok(parseLedger(plan.changes.find((c) => c.path.endsWith("installed.json")).content.toString()).registrations.codexMcp);
  assert.equal(plan.blocks.length, 0);
});

test("Claude 導入で Codex 利用が無効、または Claude を対象外なら登録しない", () => {
  for (const configValue of [
    { ...config, codex: { enabled: false } },
    { ...config, clients: "codex", codex: { enabled: true } },
  ]) {
    const plan = makePlan(input({ configValue }));
    assert.equal(plan.changes.some((c) => c.path === ".mcp.json"), false);
  }
});

test("配置記録と一致する管理登録だけを更新・削除し、編集された値は保持する", () => {
  const installed = makePlan(input());
  const installedMcp = registrationFrom(installed);
  const ledgerText = installed.changes.find((c) => c.path.endsWith("installed.json")).content.toString();
  const update = makePlan(input({ operation: "update", mcp: JSON.stringify({ ...installedMcp, other: "user" }), ledger: JSON.parse(ledgerText) }));
  assert.equal(update.changes.some((c) => c.path === ".mcp.json"), false);
  assert.equal(update.blocks.length, 0);

  const disabled = makePlan(input({ operation: "update", configValue: { ...config, codex: { enabled: false } }, mcp: JSON.stringify(installedMcp), ledger: JSON.parse(ledgerText) }));
  assert.equal(JSON.parse(disabled.changes.find((c) => c.path === ".mcp.json").content).mcpServers, undefined);

  const editedMcp = structuredClone(installedMcp);
  editedMcp.mcpServers["cc-sdd-codex"].args.push("user-edit");
  const edited = makePlan(input({ operation: "update", configValue: { ...config, codex: { enabled: false } }, mcp: JSON.stringify(editedMcp), ledger: JSON.parse(ledgerText) }));
  assert.equal(edited.changes.some((c) => c.path === ".mcp.json"), false);
  assert.ok(edited.notices.some((n) => n.includes("書き換え")));
});

test("同名の利用者登録と破損した設定を上書きせず計画を中止する", () => {
  const conflict = makePlan(input({ mcp: JSON.stringify({ mcpServers: { "cc-sdd-codex": { command: "mine" } } }) }));
  assert.ok(conflict.blocks.some((b) => b.path === ".mcp.json"));
  assert.equal(conflict.changes.some((c) => c.path === ".mcp.json"), false);
  const malformed = makePlan(input({ mcp: "{" }));
  assert.ok(malformed.blocks.some((b) => b.path === ".mcp.json"));
  assert.equal(malformed.changes.some((c) => c.path === ".mcp.json"), false);
});

test("配置記録のない同一内容の利用者登録を管理対象にせず保持する", () => {
  const matching = JSON.stringify({ mcpServers: { "cc-sdd-codex": { command: "sh", args: ["-c", 'repo_root="$(git rev-parse --show-toplevel)" && exec node "$repo_root/.agent-hooks/cc-sdd-bootstrap/codex-agent-mcp.mjs"'] } } });
  const init = makePlan(input({ mcp: matching }));
  assert.ok(init.blocks.some((b) => b.path === ".mcp.json"));
  assert.equal(init.changes.some((c) => c.path === ".mcp.json"), false);
  assert.equal(parseLedger(init.changes.find((c) => c.path.endsWith("installed.json")).content.toString()).registrations?.codexMcp, undefined);
  const disabled = makePlan(input({ operation: "update", configValue: { ...config, codex: { enabled: false } }, mcp: matching }));
  assert.equal(disabled.changes.some((c) => c.path === ".mcp.json"), false);
  const uninstall = makePlan(input({ operation: "uninstall", configValue: null, mcp: matching }));
  assert.equal(uninstall.changes.some((c) => c.path === ".mcp.json"), false);
});

test("ホスト側の承認設定は変更対象にしない", () => {
  const plan = makePlan(input());
  const paths = plan.changes.map((c) => c.path);
  assert.ok(paths.includes(".mcp.json"));
  assert.ok(!paths.includes(".claude/settings.json"));
});

test("アンインストールでは記録した登録だけを削除し、他の登録を残す", () => {
  const installed = makePlan(input());
  const managed = registrationFrom(installed);
  const ledger = JSON.parse(installed.changes.find((c) => c.path.endsWith("installed.json")).content.toString());
  const uninstall = makePlan(input({ operation: "uninstall", configValue: null,
    mcp: JSON.stringify({ mcpServers: { ...managed.mcpServers, user: { command: "keep" } }, custom: true }), ledger }));
  const change = uninstall.changes.find((c) => c.path === ".mcp.json");
  assert.ok(change);
  const next = JSON.parse(change.content);
  assert.equal(next.custom, true);
  assert.deepEqual(next.mcpServers, { user: { command: "keep" } });
  assert.equal(uninstall.blocks.length, 0);
});


test("無効化時に登録書き込みが失敗しても、再計画で管理登録を削除できる", () => {
  const installed = makePlan(input());
  const managed = registrationFrom(installed);
  const ledgerText = installed.changes.find((c) => c.path.endsWith("installed.json")).content.toString();
  const state = input({ operation: "update", configValue: { ...config, codex: { enabled: false } }, mcp: JSON.stringify(managed), ledger: JSON.parse(ledgerText) });

  const failedPlan = makePlan(state);
  assert.ok(failedPlan.changes.findIndex((c) => c.path.endsWith("installed.json")) < failedPlan.changes.findIndex((c) => c.path === ".mcp.json"));
  // 配置記録だけ適用された後に .mcp.json の書き込みが失敗した状態から再計画する。
  const ledgerChange = failedPlan.changes.find((c) => c.path.endsWith("installed.json"));
  const retry = makePlan({ ...state, snapshot: { ...state.snapshot, ledger: ledgerChange.content.toString() } });
  const removal = retry.changes.find((c) => c.path === ".mcp.json");
  assert.ok(removal);
  assert.equal(JSON.parse(removal.content).mcpServers, undefined);
});

test("旧管理登録の更新で登録書き込みが失敗しても、許可ハッシュ記録から再計画で収束する", () => {
  const oldEntry = { command: "old-managed-command", args: [] };
  const oldHash = parseLedger(makePlan(input()).changes.find((c) => c.path.endsWith("installed.json")).content.toString()).registrations.codexMcp.sha256;
  // 旧版の記録とエントリが一致する状態を作る。
  const previousHash = sha256(Buffer.from(JSON.stringify({ args: [], command: "old-managed-command" })));
  const state = input({ operation: "update", mcp: JSON.stringify({ mcpServers: { "cc-sdd-codex": oldEntry } }), ledger: { ...baseLedger, registrations: { codexMcp: { sha256: previousHash } } } });

  const update = makePlan(state);
  const registrationChange = update.changes.find((c) => c.path === ".mcp.json");
  assert.ok(registrationChange);
  const ledgerChange = update.changes.find((c) => c.path.endsWith("installed.json"));
  const afterLedgerOnly = { ...state, snapshot: { ...state.snapshot, ledger: ledgerChange.content.toString() } };
  const retry = makePlan(afterLedgerOnly);
  assert.equal(retry.blocks.some((b) => b.path === ".mcp.json"), false);
  assert.ok(retry.changes.some((c) => c.path === ".mcp.json"));
  const retryLedger = JSON.parse(ledgerChange.content.toString());
  assert.deepEqual(retryLedger.registrations.codexMcp.allowedHashes, [previousHash, oldHash]);
  assert.notEqual(oldHash, previousHash);
});
