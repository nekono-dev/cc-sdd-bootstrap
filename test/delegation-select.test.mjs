import { test } from "node:test";
import assert from "node:assert/strict";
import { selectDelegate } from "../.agent-hooks/cc-sdd-bootstrap/delegation-select.mjs";
import { listRegistrations, resolveRegistration } from "../.agent-hooks/cc-sdd-bootstrap/delegation-registry.mjs";
import { serve as createCodexServer } from "../.agent-hooks/cc-sdd-bootstrap/codex-agent-mcp.mjs";
import { PassThrough } from "node:stream";

const capability = (harness, tier, models) => ({ kind: "agent", harness, tier, models });
const model = (id, access = "read-only", effort = "medium") => ({ id, accepted: [{ access, effort }] });
const saved = (family, registrationName, models = {}) => ({ family, scope: "user", registrationName, registrationId: `${registrationName}-id`, models });

test("段優先順と各段の保存順を使い、公開一覧から自動モデルを選ぶ", () => {
  const result = selectDelegate({
    settings: { subagents: { localModels: { review: "local-v1" } } }, role: "review", host: "claude",
    candidates: [
      { saved: saved("cloud-a", "cloud"), capability: capability("cloud-a", "cloud", [model("cloud-v1")]), models: ["cloud-v1"] },
      { saved: saved("local-a", "local"), capability: capability("local-a", "local", [model("local-v1")]), models: ["local-v1"] },
      { saved: saved("local-b", "local2"), capability: capability("local-b", "local", [model("local-v2")]), models: ["local-v2"] },
    ], native: { client: "claude", available: true },
  });
  assert.deepEqual(result, { kind: "mcp", tier: "local", candidate: { family: "local-a", scope: "user", registrationName: "local", registrationId: "local-id" }, model: "local-v1", access: "read-only", effort: "medium" });
});

test("固定モデル消失時は保存値を保持したまま次候補へ進み、同系統クラウドを除外する", () => {
  const fixed = saved("cloud-a", "fixed", { review: { fixed: "gone" } });
  const result = selectDelegate({
    settings: {}, role: "review", host: "claude",
    candidates: [
      { saved: fixed, capability: capability("cloud-a", "cloud", [model("other")]), models: ["other"] },
      { saved: saved("claude", "same"), capability: capability("claude", "cloud", [model("same")]), models: ["same"] },
      { saved: saved("cloud-b", "next", { review: { compatibleIds: ["next"] } }), capability: capability("cloud-b", "cloud", [model("next")]), models: ["next"] },
    ], native: { client: "claude", available: false },
  });
  assert.equal(fixed.models.review.fixed, "gone");
  assert.equal(result.candidate.registrationName, "next");
});

test("ローカル非対応推論量は除外し、全候補なしは理由を返す", () => {
  const noLocal = selectDelegate({ settings: { subagents: { localModels: { review: "x" } } }, role: "review", host: "claude", candidates: [
    { saved: saved("local", "local"), capability: capability("local", "local", [model("x", "read-only", "off")]), models: ["x"] },
  ], native: { client: "claude", available: false } });
  assert.equal(noLocal.kind, "unavailable");
  assert.match(noLocal.reasons.join(" "), /役割条件を満たす候補がありません/);
  const supported = selectDelegate({ settings: { subagents: { localModels: { review: "x" } } }, role: "review", host: "claude", candidates: [
    { saved: saved("local", "local"), capability: capability("local", "local", [model("x", "read-only", "medium")]), models: ["x"] },
  ], native: { client: "claude", available: false } });
  assert.equal(supported.kind, "mcp");
  assert.equal(supported.model, "x");
});

test("自動選択は更新された公開一覧と互換 ID の保存順を毎回照合する", () => {
  const item = saved("cloud", "ordered", { review: { compatibleIds: ["removed", "current", "later"] } });
  const result = selectDelegate({ settings: {}, role: "review", host: "claude", candidates: [
    { saved: item, capability: capability("cloud", "cloud", [model("current"), model("later")]), models: ["current", "later"] },
  ], native: { client: "claude", available: false } });
  assert.equal(result.kind, "mcp");
  assert.equal(result.model, "current");
});

test("不正な公開入力は例外にせず拒否する", () => {
  for (const input of [null, [], { settings: {}, role: "review", host: "claude", candidates: [], native: {}, surprise: true }]) {
    assert.equal(selectDelegate(input).kind, "unavailable");
  }
});

test("空白だけまたは前後に空白を含む候補識別子とモデル ID は拒否する", () => {
  const valid = { saved: saved("cloud", "agent", { review: { compatibleIds: ["m"] } }),
    capability: capability("cloud", "cloud", [model("m")]), models: ["m"] };
  const variants = [
    (candidate) => { candidate.saved.registrationId = " "; },
    (candidate) => { candidate.saved.registrationName = " agent"; },
    (candidate) => { candidate.saved.family = "  "; },
    (candidate) => { candidate.capability.harness = "cloud "; },
    (candidate) => { candidate.models = [" "]; },
    (candidate) => { candidate.capability.models = [model(" m")]; candidate.models = [" m"]; },
    (candidate) => { candidate.saved.models.review.compatibleIds = ["m "]; },
  ];
  for (const mutate of variants) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    const result = selectDelegate({ settings: {}, role: "review", host: "claude", candidates: [candidate],
      native: { client: "claude", available: false } });
    assert.equal(result.kind, "unavailable");
  }
});

test("現在のホストと異なるネイティブ候補は選ばない", () => {
  const result = selectDelegate({ settings: {}, role: "review", host: "codex", candidates: [],
    native: { client: "claude", available: true } });
  assert.equal(result.kind, "unavailable");
});

test("選択結果は同名登録を識別できる全登録情報を保持する", () => {
  const first = saved("cloud", "same", { review: { compatibleIds: ["m"] } });
  first.scope = "project";
  first.registrationId = "unique-registration-1";
  const result = selectDelegate({ settings: {}, role: "review", host: "claude", candidates: [
    { saved: first, capability: capability("cloud", "cloud", [model("m")]), models: ["m"] },
  ], native: { client: "claude", available: false } });
  assert.deepEqual(result.candidate, { family: first.family, scope: first.scope, registrationName: first.registrationName, registrationId: first.registrationId });
});

test("ローカルの固定モデルは役割条件を満たす場合だけ選び、消失時は候補を外す", () => {
  const mk = (fixed) => ({
    settings: { subagents: { localModels: { review: "role-local" } } }, role: "review", host: "claude",
    candidates: [{ saved: saved("local", "local-fixed", { review: { fixed } }),
      capability: capability("local", "local", [model("role-local")]), models: ["role-local"] }],
    native: { client: "claude", available: false },
  });
  assert.equal(selectDelegate(mk("missing")).kind, "unavailable");
  assert.equal(selectDelegate(mk("role-local")).model, "role-local");
});

test("公開済みでも役割の許容 ID 外のローカル固定モデルは選ばない", () => {
  const result = selectDelegate({
    settings: { subagents: { localModels: { review: "role-local" } } }, role: "review", host: "claude",
    candidates: [{ saved: saved("local", "local-fixed", { review: { fixed: "other-local" } }),
      capability: capability("local", "local", [model("other-local")]), models: ["other-local"] }],
    native: { client: "claude", available: false },
  });
  assert.equal(result.kind, "unavailable");
  assert.match(result.reasons.join(" "), /local-fixed: 公開モデルに役割条件を満たす候補がありません/);
});

test("異系統ホストでも Codex MCP は RolePolicy の Codex ネイティブモデルを初期候補にする", () => {
  const result = selectDelegate({ settings: {}, role: "review", host: "claude", candidates: [
    { saved: saved("codex", "codex-mcp"), capability: capability("codex", "cloud", [model("gpt-6.1-sol")]), models: ["gpt-6.1-sol"] },
  ], native: { client: "claude", available: false } });
  assert.equal(result.kind, "mcp");
  assert.equal(result.model, "gpt-6.1-sol");
});

test("同じ段の適格クラウド候補は保存順を保ち、同系統候補は適格でも除外する", () => {
  const result = selectDelegate({ settings: {}, role: "review", host: "claude", candidates: [
    { saved: saved("claude", "same", { review: { compatibleIds: ["same-model"] } }),
      capability: capability("claude", "cloud", [model("same-model")]), models: ["same-model"] },
    { saved: saved("cloud", "first", { review: { compatibleIds: ["first-model"] } }),
      capability: capability("cloud", "cloud", [model("first-model")]), models: ["first-model"] },
    { saved: saved("cloud", "second", { review: { compatibleIds: ["second-model"] } }),
      capability: capability("cloud", "cloud", [model("second-model")]), models: ["second-model"] },
  ], native: { client: "claude", available: false } });
  assert.equal(result.candidate.registrationName, "first");
});

test("実 registry の一覧出力を解決し、実 Codex MCP の公開能力を選択へ接続する", async () => {
  const registrations = await listRegistrations("claude", { cwd: process.cwd(), run: async (_exe, args) =>
    args[1] === "list" ? "agent: Connected" : "Name: agent\nScope: User config\nType: stdio\nStatus: Connected\nCommand: node\nArgs: server.mjs" });
  const registered = registrations[0];
  assert.equal(registered.status, "eligible");
  const resolved = resolveRegistration(registered, {
    family: "claude", registrationName: registered.name, scope: registered.scope, registrationId: registered.registrationId,
  }, { verifiedFamily: "claude" });
  assert.equal(resolved.status, "eligible");

  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = "";
  output.on("data", (chunk) => { buffer += chunk.toString(); });
  const server = createCodexServer({ input, output, listModels: async () => [
    { model: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
  ] });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codex_capabilities", arguments: {} } })}\n`);
  input.end();
  await server;
  const response = JSON.parse(buffer.trim());
  const published = response.result.structuredContent;
  const selected = selectDelegate({ settings: {}, role: "review", host: "claude", candidates: [
    { saved: { family: resolved.host, scope: resolved.scope, registrationName: resolved.name, registrationId: resolved.registrationId }, capability: published, models: published.models.map(({ id }) => id) },
  ], native: { client: "claude", available: false } });
  assert.equal(selected.model, "gpt-6.1-sol");
});

test("Pi など未知ホストでも適格な MCP を選び、ネイティブは一致する既知クライアントだけ使う", () => {
  const candidate = { saved: saved("cloud", "cloud-agent", { review: { compatibleIds: ["m"] } }),
    capability: capability("cloud", "cloud", [model("m")]), models: ["m"] };
  for (const [host, nativeClient] of [["pi", "pi"], ["muse", "muse"], ["pi", "claude"]]) {
    const result = selectDelegate({ settings: {}, role: "review", host, candidates: [candidate],
      native: { client: nativeClient, available: true } });
    assert.equal(result.kind, "mcp", `${host}/${nativeClient} should continue MCP evaluation`);
    assert.equal(result.candidate.registrationName, "cloud-agent");
  }
  for (const [host, client] of [["pi", "pi"], ["muse", "claude"], ["unknown", "unknown"]]) {
    const result = selectDelegate({ settings: {}, role: "review", host, candidates: [],
      native: { client, available: true } });
    assert.equal(result.kind, "unavailable", `${host}/${client} must not select unsupported native`);
  }
});


test("ネイティブ RolePolicy の空白付き modelId は理由付きで利用不可にする", () => {
  const result = selectDelegate({ settings: { subagents: { claudeModels: { review: " sonnet " } } }, role: "review", host: "claude", candidates: [], native: { client: "claude", available: true } });
  assert.equal(result.kind, "unavailable");
  assert.ok(result.reasons.some((reason) => reason.includes("ネイティブの役割条件が不正")));
});

test("ネイティブの agentName を含むすべての返却識別子が検証される", () => {
  const result = selectDelegate({ settings: {}, role: "review", host: "claude", candidates: [], native: { client: "claude", available: true } });
  assert.equal(result.kind, "native");
  for (const value of [result.client, result.agentName, result.model]) assert.equal(value.trim(), value);
});
