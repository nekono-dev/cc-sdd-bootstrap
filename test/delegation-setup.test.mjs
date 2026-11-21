import { test } from "node:test";
import assert from "node:assert/strict";
import * as setup from "../lib/delegation-setup.mjs";
import { PassThrough } from "node:stream";
import { fingerprintTransport, listRegistrations, readTransport } from "../.agent-hooks/cc-sdd-bootstrap/delegation-registry.mjs";
import { connectStdioRegistration, createCodexAdapter } from "../.agent-hooks/cc-sdd-bootstrap/delegation-mcp.mjs";
import { serve } from "../.agent-hooks/cc-sdd-bootstrap/codex-agent-mcp.mjs";

test("登録探査を既存・予定・承認待ち・利用不可に分け、系統は能力確認値からだけ保存する", () => {
  assert.equal(typeof setup.buildDelegationSetup, "function");
  const result = setup.buildDelegationSetup({
    registrations: [
      { host: "claude", name: "ready", scope: "project", registrationId: "r1", status: "eligible" },
      { host: "claude", name: "waiting", scope: "project", registrationId: "r2", status: "pending", reason: "承認待ち" },
      { host: "claude", name: "off", scope: "user", registrationId: "r3", status: "disabled", reason: "無効" },
    ],
    verified: { r1: { kind: "agent", harness: "pi", tier: "local", models: [{ id: "m1" }] } },
    planned: [{ host: "claude", name: "cc-sdd-codex", status: "planned" }],
    removing: [{ host: "claude", name: "old-server" }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.groups.eligible.map((x) => [x.registrationName, x.family, x.tier]), [["ready", "pi", "local"]]);
  assert.equal(result.groups.pending[0].registrationName, "waiting");
  assert.equal(result.groups.unavailable[0].registrationName, "off");
  assert.equal(result.groups.planned[0].registrationName, "cc-sdd-codex");
  assert.deepEqual(result.groups.removing, [{ host: "claude", registrationName: "old-server", status: "removal-planned" }]);
});

test("明示順序を検証して選択済みだけを段別に保存し、既存候補を黙って消さない", () => {
  assert.equal(typeof setup.applyDelegationOrder, "function");
  const candidate = { family: "pi", scope: "project", registrationName: "ready", registrationId: "r1", host: "pi", tier: "local", models: [{ id: "m1" }] };
  const stored = { family: "pi", scope: "project", registrationName: "ready", registrationId: "r1", models: {} };
  const current = { pi: { local: [stored], cloud: [] } };
  const result = setup.applyDelegationOrder({ delegation: current, host: "pi", tier: "local", order: ["r1"], candidates: [candidate] });
  assert.deepEqual(result.delegation.pi.local, [stored]);
  assert.equal(setup.applyDelegationOrder({ delegation: current, host: "pi", tier: "local", order: ["missing"], candidates: [candidate] }).ok, false);
});

test("不正な探査入力と未知のモデル項目を拒否する", () => {
  assert.equal(setup.buildDelegationSetup(null).ok, false);
  const result = setup.buildDelegationSetup({ registrations: [{ host: "claude", name: "ready", scope: "project", registrationId: "r1", status: "eligible" }], verified: { r1: { kind: "agent", harness: "pi", tier: "local", models: [{ id: "m1", extra: true }] } }, planned: [] });
  assert.equal(result.groups.eligible.length, 0);
  assert.equal(result.groups.unavailable.length, 1);
});

test("登録の入れ子 scope は許可値だけを候補にし、互換モデル順を保存する", () => {
  const invalid = setup.buildDelegationSetup({ registrations: [{ host: "claude", name: "ready", scope: { unexpected: true }, registrationId: "r1", status: "eligible" }], verified: { r1: { kind: "agent", harness: "pi", tier: "local", models: [{ id: "m1" }] } }, planned: [] });
  assert.equal(invalid.groups.eligible.length, 0);
  const candidate = { family: "pi", scope: "project", registrationName: "ready", registrationId: "r1", models: [{ id: "m1" }, { id: "m2" }] };
  const result = setup.applyDelegationOrder({ delegation: {}, host: "claude", tier: "local", order: ["r1"], candidates: [candidate], models: { r1: { review: { compatibleIds: ["m2", "m1"] } } } });
  assert.deepEqual(result.delegation.claude.local[0].models.review, { compatibleIds: ["m2", "m1"] });
});

test("保存候補を設定スキーマ形式へ正規化し、モデル固定値と未知項目を検証する", () => {
  const candidate = { family: "pi", scope: "project", registrationName: "ready", registrationId: "r1", tier: "local", host: "claude", models: [{ id: "m1" }] };
  const result = setup.applyDelegationOrder({ delegation: {}, host: "claude", tier: "local", order: ["r1"], candidates: [candidate], models: { r1: { manufacture: { fixed: "m1" } } } });
  assert.deepEqual(result.delegation.claude.local, [{ family: "pi", scope: "project", registrationName: "ready", registrationId: "r1", models: { manufacture: { fixed: "m1" } } }]);
  const preserved = setup.applyDelegationOrder({ delegation: { claude: { local: [{ family: "pi", scope: "project", registrationName: "ready", registrationId: "r1", models: { review: { fixed: "retired-model" } } }] } }, host: "claude", tier: "local", order: ["r1"], candidates: [candidate] });
  assert.equal(preserved.delegation.claude.local[0].models.review.fixed, "retired-model");
  assert.equal(setup.applyDelegationOrder({ delegation: {}, host: "claude", tier: "local", order: ["r1"], candidates: [{ ...candidate, injected: true }] }).ok, false);
});

test("再解決済み登録の transport fingerprint を readTransport が許可する", async () => {
  assert.equal(await readTransport({ host: "claude", name: "ready", scope: "project", registrationId: "r1", status: "eligible", transportFingerprint: "abc" }, { cwd: "/missing" }), null);
});

test("不正な保存済み段は例外でなく拒否結果にする", () => {
  const result = setup.applyDelegationOrder({ delegation: { claude: { local: {} } }, host: "claude", tier: "local", order: ["r1"], candidates: [{ family: "pi", scope: "project", registrationName: "ready", registrationId: "r1" }] });
  assert.equal(result.ok, false);
});

test("保存形式の候補から host と tier を導出して明示順序を適用する", () => {
  const stored = { family: "codex", scope: "project", registrationName: "managed", registrationId: "r2", models: {} };
  const result = setup.applyDelegationOrder({ delegation: { claude: { cloud: [stored] } }, host: "claude", tier: "cloud", order: ["r2"], candidates: [stored] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.delegation.claude.cloud, [stored]);
});

test("部分的なモデル指定は指定した役割だけ更新し、他の役割を保持する", () => {
  const candidate = { family: "pi", scope: "project", registrationName: "ready", registrationId: "r1", models: {} };
  const previous = { manufacture: { fixed: "old" }, review: { fixed: "review-model" } };
  const result = setup.applyDelegationOrder({ delegation: { claude: { local: [{ ...candidate, models: previous }] } }, host: "claude", tier: "local", order: ["r1"], candidates: [candidate], models: { r1: { manufacture: { fixed: "new" } } } });
  assert.deepEqual(result.delegation.claude.local[0].models, { manufacture: { fixed: "new" }, review: { fixed: "review-model" } });
});

test("不正モデル値と選択外候補のモデル指定は保存前に拒否する", () => {
  const candidate = { family: "pi", scope: "project", registrationName: "ready", registrationId: "r1", models: {} };
  for (const value of [null, [], { unknown: true }, { fixed: " " }, { compatibleIds: ["m", "m"] }]) {
    const result = setup.applyDelegationOrder({ delegation: {}, host: "claude", tier: "local", order: ["r1"], candidates: [candidate], models: { r1: { review: value } } });
    assert.equal(result.ok, false, `拒否される値: ${JSON.stringify(value)}`);
  }
  const outside = setup.applyDelegationOrder({ delegation: {}, host: "claude", tier: "local", order: ["r1"], candidates: [candidate], models: { r2: { review: { fixed: "m" } } } });
  assert.equal(outside.ok, false, "選択していない登録 ID のモデル指定を拒否");
});

test("空の候補順を明示して保存でき、未指定とは区別する", () => {
  const original = { claude: { local: [{ family: "pi", scope: "project", registrationName: "ready", registrationId: "r1", models: {} }] } };
  const result = setup.applyDelegationOrder({ delegation: original, host: "claude", tier: "local", order: [], candidates: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.delegation.claude.local, []);
  assert.equal(original.claude.local.length, 1);
});

test("実 Registry と実 Codex MCP サーバーで承認登録と公開能力を照合する", async () => {
  const name = { type: "user", file: "/user/config.toml" };
  const registry = await listRegistrations("codex", {
    cwd: "/repo",
    run: async (_bin, args) => args.join(" ") === "mcp list --json" ? JSON.stringify([{ name: "codex-agent", enabled: true, transport: { type: "stdio", command: "codex-agent" } }]) : "",
    appServer: async () => ({ config: { mcp_servers: { "codex-agent": { command: "codex-agent" } } },
      origins: { "mcp_servers.codex-agent.command": { name } }, layers: [{ name, disabledReason: null, config: {} }] }),
  });
  assert.equal(registry[0].status, "eligible");

  const input = new PassThrough(), output = new PassThrough();
  let wire = "";
  output.on("data", (chunk) => { wire += chunk; });
  const serving = serve({ input, output, listModels: async () => [{ model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] });
  input.end('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"codex_capabilities","arguments":{}}}\n');
  await serving;
  const messages = wire.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(messages[0].result.serverInfo.name, "cc-sdd-codex");
  assert.deepEqual(messages[1].result.structuredContent.models, [{ id: "model-a", accepted: [{ access: "read-only", effort: "medium" }, { access: "workspace-write", effort: "medium" }] }]);
});

test("実 Registry の承認結果から能力・候補選択・保存までを通す", async () => {
  const appServer = async () => ({ config: { mcp_servers: { agent: { command: "agent" } } },
    origins: { "mcp_servers.agent.command": { name: { type: "user", file: "/user/config.toml" } } },
    layers: [{ name: { type: "user", file: "/user/config.toml" }, disabledReason: null, config: {} }] });
  const run = async (_bin, args) => args.join(" ") === "mcp list --json"
    ? JSON.stringify([{ name: "agent", enabled: true, transport: { type: "stdio", command: "agent" } }]) : "";
  const registryOptions = { cwd: "/repo", run, appServer };
  const registration = (await listRegistrations("codex", registryOptions))[0];
  assert.equal(registration.status, "eligible");

  const input = new PassThrough(), output = new PassThrough();
  const child = { stdin: input, stdout: output, stderr: new PassThrough(), on(event, handler) { input.on(event, handler); output.on(event, handler); }, kill() { input.end(); } };
  const serving = serve({ input, output, listModels: async () => [{ model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] });
  const transport = { type: "stdio", command: "agent" };
  const saved = { family: "codex", scope: registration.scope, registrationName: registration.name, registrationId: registration.registrationId };
  const connection = await connectStdioRegistration({ registration, saved, verifiedFamily: "codex",
    readTransport: async () => transport,
    resolveRegistration: async () => (await listRegistrations("codex", registryOptions))[0],
    spawnProcess: () => child });
  try {
    const adapter = await createCodexAdapter(connection);
    const capability = await adapter.capabilities();
    const models = await adapter.models();
    const candidates = setup.buildDelegationSetup({ registrations: [registration], verified: { [registration.registrationId]: capability.models.length ? {
      kind: capability.kind, harness: capability.harness, tier: capability.tier, models: models.map((id) => ({ id })),
    } : null }, planned: [] });
    assert.equal(candidates.groups.eligible.length, 1);
    const chosen = setup.applyDelegationOrder({ delegation: {}, host: "codex", tier: "cloud", order: [registration.registrationId], candidates: candidates.groups.eligible });
    assert.equal(chosen.ok, true);
    assert.equal(chosen.delegation.codex.cloud[0].registrationId, registration.registrationId);
  } finally { connection.close(); input.end(); await serving; }
});

test("同じ registrationId の別名登録を別候補として取り違えない", () => {
  const candidates = [
    { family: "codex", scope: "project", registrationName: "managed", registrationId: "same", host: "claude", tier: "cloud", models: [] },
    { family: "codex", scope: "project", registrationName: "alias", registrationId: "same", host: "claude", tier: "cloud", models: [] },
  ];
  const result = setup.applyDelegationOrder({ delegation: {}, host: "claude", tier: "cloud", order: ["same"], candidates });
  assert.equal(result.ok, false, "曖昧な登録 ID の選択は拒否される");
  const chosen = setup.applyDelegationOrder({ delegation: {}, host: "claude", tier: "cloud", order: ["alias:same"], candidates });
  assert.equal(chosen.ok, true, "登録名と登録 ID の組で別名登録を選べる");
  assert.equal(chosen.delegation.claude.cloud[0].registrationName, "alias");
});
