import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveNative, resolveRole } from "../.agent-hooks/cc-sdd-bootstrap/role-policy.mjs";

test("全役割の権限・ローカル候補なし・ネイティブ既定値を解決する", () => {
  const roles = ["manufacture", "review", "design", "research", "debug"];
  for (const role of roles) {
    const result = resolveRole({}, role);
    assert.equal(result.ok, true);
    assert.equal(result.value.role, role);
    assert.deepEqual(result.value.localModelIds, []);
  }
  assert.equal(resolveRole({}, "manufacture").value.access, "workspace-write");
  for (const role of ["review", "research", "debug"]) {
    assert.equal(resolveRole({}, role).value.access, "read-only");
  }
  assert.equal(resolveRole({}, "design").value.access, "workspace-write");
  assert.equal(resolveRole({}, "design", { readOnly: true }).value.access, "read-only");
  assert.equal(resolveRole({}, "manufacture").value.effort, "medium");
  assert.equal(resolveRole({}, "review").value.effort, "medium");
  assert.equal(resolveRole({}, "design").value.effort, "high");
  assert.equal(resolveRole({}, "manufacture", { readOnly: true }).ok, false);
  assert.equal(resolveNative({}, "claude", "design", { readOnly: true }).value.agentName, "cc-sdd-design-read-only");
  assert.equal(resolveNative({}, "codex", "design", { readOnly: true }).value.agentName, "cc_sdd_design_read_only");

  const expected = {
    claude: { manufacture: ["haiku", "medium"], review: ["sonnet", "medium"], design: ["sonnet", "high"] },
    codex: { manufacture: ["gpt-6-luna", "medium"], review: ["gpt-6.1-sol", "medium"], design: ["gpt-6.1-sol", "high"] },
  };
  for (const [client, assignments] of Object.entries(expected)) {
    for (const [role, [modelId, effort]] of Object.entries(assignments)) {
      const result = resolveNative({}, client, role);
      assert.equal(result.ok, true);
      assert.equal(result.value.modelId, modelId);
      assert.equal(result.value.effort, effort);
      assert.equal(result.value.agentName, `${client === "claude" ? "cc-sdd-" : "cc_sdd_"}${role}`);
    }
  }
});

test("明示したクライアント別設定、旧設定、既定値の順で解決する", () => {
  const settings = {
    models: { review: "legacy-model", research: "legacy-research", debug: "legacy-debug" },
    subagents: {
      claudeModels: { review: "explicit-claude" },
      codexModels: { review: "explicit-codex" },
      efforts: { review: "high" },
    },
  };
  assert.equal(resolveNative(settings, "claude", "review").value.modelId, "explicit-claude");
  assert.equal(resolveNative(settings, "codex", "review").value.modelId, "explicit-codex");
  assert.equal(resolveNative(settings, "claude", "research").value.modelId, "legacy-research");
  assert.equal(resolveNative(settings, "codex", "debug").value.modelId, "legacy-debug");
  assert.equal(resolveNative(settings, "claude", "manufacture").value.modelId, "haiku");
  assert.equal(resolveNative(settings, "codex", "review").value.effort, "high");
});

test("他クライアントと分かる旧モデルは理由付きで拒否し、能力比較は行わない", () => {
  const result = resolveNative({ models: { review: "gpt-6.1-sol" } }, "claude", "review");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_SETTING");
  assert.match(result.error.reason, /models\.review/);
  assert.match(result.error.reason, /Codex/);

  const opaque = resolveNative({ models: { review: "custom-model-id" } }, "claude", "review");
  assert.equal(opaque.ok, true);
  assert.equal(opaque.value.modelId, "custom-model-id");
});

test("明示ローカル ID は完全一致で保ち、未知役割や不正設定から候補を作らない", () => {
  const id = "vendor/model:revision-01";
  assert.deepEqual(resolveRole({ subagents: { localModels: { review: id } } }, "review").value.localModelIds, [id]);
  assert.equal(resolveRole({ subagents: { localModels: { review: id } } }, "unverified-role").ok, false);
  assert.deepEqual(resolveRole({ subagents: { localModels: { unverified: id } } }, "review").value.localModelIds, []);
  assert.equal(resolveRole({ subagents: { localModels: { review: " " } } }, "review").ok, false);
  assert.equal(resolveRole({}, "unverified-role").error.code, "UNKNOWN_ROLE");
  assert.equal(resolveNative({}, "pi", "review").error.code, "INVALID_SETTING");
});

test("読み取り専用の設計だけ専用名になり、既存の読み取り役割名は維持する", () => {
  assert.equal(resolveNative({}, "claude", "review", { readOnly: true }).value.agentName, "cc-sdd-review");
  assert.equal(resolveNative({}, "codex", "research", { readOnly: true }).value.agentName, "cc_sdd_research");
});

test("旧モデルのクライアント判定は既知の ID に限定し、不明な ID を保持する", () => {
  const vendorId = "vendor/lunar-v2";
  assert.equal(resolveNative({ models: { review: vendorId } }, "claude", "review").value.modelId, vendorId);
});

test("options と readOnly は own boolean 値のみ受け付ける", () => {
  assert.equal(resolveRole({}, "review", null).error.code, "INVALID_SETTING");
  assert.equal(resolveRole({}, "review", { readOnly: "true" }).error.code, "INVALID_SETTING");
  const inherited = Object.create({ readOnly: true });
  assert.equal(resolveRole({}, "design", inherited).value.access, "workspace-write");
});

test("努力量の役割参照は own 値だけを読む", () => {
  const efforts = Object.create({ review: "high" });
  const result = resolveRole({ subagents: { efforts } }, "review");
  assert.equal(result.ok, true);
  assert.equal(result.value.effort, "medium");
});

test("非列挙 own map 値も検証し、継承した map 値は無視する", () => {
  const efforts = {};
  Object.defineProperty(efforts, "review", { value: "extreme" });
  assert.equal(resolveRole({ subagents: { efforts } }, "review").error.code, "INVALID_SETTING");

  const localModels = {};
  Object.defineProperty(localModels, "review", { value: "  " });
  assert.equal(resolveRole({ subagents: { localModels } }, "review").error.code, "INVALID_SETTING");

  const claudeModels = {};
  Object.defineProperty(claudeModels, "review", { value: 42 });
  assert.equal(resolveNative({ subagents: { claudeModels } }, "claude", "review").error.code, "INVALID_SETTING");

  const validEfforts = {};
  Object.defineProperty(validEfforts, "review", { value: "high" });
  assert.equal(resolveRole({ subagents: { efforts: validEfforts } }, "review").value.effort, "high");

  const inherited = Object.create({ review: "bad" });
  const result = resolveRole({ subagents: { efforts: inherited, localModels: inherited } }, "review");
  assert.equal(result.ok, true);
  assert.equal(result.value.effort, "medium");
  assert.deepEqual(result.value.localModelIds, []);
  const inheritedContainer = Object.create({ subagents: { efforts: { review: "high" } } });
  assert.equal(resolveRole(inheritedContainer, "review").value.effort, "medium");
});

test("旧モデル ID の既知クライアント判定は大文字小文字を区別する", () => {
  const result = resolveNative({ models: { review: "SONNET" } }, "codex", "review");
  assert.equal(result.ok, true);
  assert.equal(result.value.modelId, "SONNET");
});
