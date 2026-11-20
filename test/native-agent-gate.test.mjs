import test from "node:test";
import assert from "node:assert/strict";
import { decideNativeAgentGate } from "../.agent-hooks/cc-sdd-bootstrap/native-agent-gate.mjs";

const policy = Object.freeze({ role: "review", client: "codex", agentName: "cc_sdd_review", modelId: "gpt-6.1-sol", effort: "medium", access: "read-only" });
const good = Object.freeze({
  role: "review", client: "codex", agentName: "cc_sdd_review",
  definitionVerified: true, parentModelId: "gpt-6-luna", childModelId: "gpt-6.1-sol",
  effort: "medium", access: "read-only", historyInherited: false,
  alternatives: [{ modelId: "gpt-6.2-sol", effort: "medium", access: "read-only", agentName: "cc_sdd_review", verified: true, role: "review", client: "codex" }],
});

test("確認済みの別モデルと役割条件だけを許可する", () => {
  assert.deepEqual(decideNativeAgentGate(policy, good), { allowed: true, reason: null, alternatives: [] });
});

test("同一モデル、履歴継承、定義不一致、条件不一致、証拠不足を理由付きで拒否する", () => {
  for (const [key, value, reason] of [
    ["childModelId", "gpt-6-luna", "same-model"],
    ["historyInherited", true, "history-inherited"],
    ["agentName", "custom_agent", "definition-mismatch"],
    ["effort", "high", "effort-mismatch"],
    ["access", "workspace-write", "access-mismatch"],
    ["childModelId", undefined, "insufficient-evidence"],
  ]) {
    const evidence = { ...good, [key]: value };
    const result = decideNativeAgentGate(policy, evidence);
    assert.equal(result.allowed, false, key);
    assert.equal(result.reason, reason, key);
  }
});

test("モデル別名解決は上流で正規化し、正規 ID のみ比較する", () => {
  assert.equal(decideNativeAgentGate(policy, { ...good, parentModelId: "canonical-x", childModelId: "canonical-x" }).reason, "same-model");
});

test("代替案は同じ役割条件を満たすことが確認された候補だけを返す", () => {
  const result = decideNativeAgentGate(policy, { ...good, childModelId: "gpt-6-luna" });
  assert.deepEqual(result.alternatives, [good.alternatives[0]]);
});

test("ポリシーと証拠の必須 own field、列挙値、予約名を厳密に検証する", () => {
  for (const [subject, value] of [
    ["policy", { ...policy, effort: undefined }],
    ["policy", { ...policy, role: "unknown" }],
    ["policy", { ...policy, client: "pi" }],
    ["policy", { ...policy, agentName: "other" }],
    ["policy", { ...policy, modelId: "  " }],
    ["policy", { ...policy, effort: "banana" }],
    ["policy", { ...policy, access: "banana" }],
    ["evidence", { ...good, effort: "banana", access: "banana" }],
    ["both", { ...policy, effort: "banana", access: "banana" }],
    ["both", { ...policy, modelId: " gpt-6.1-sol " }],
    ["evidence", Object.assign(Object.create({ role: "review" }), Object.fromEntries(Object.entries(good).filter(([key]) => key !== "role")))],
  ]) {
    const result = decideNativeAgentGate(subject === "policy" || subject === "both" ? value : policy, subject === "evidence" || subject === "both" ? value : good);
    assert.equal(result.allowed, false, subject);
  }
  assert.equal(decideNativeAgentGate(
    { ...policy, effort: "banana", access: "banana" },
    { ...good, effort: "banana", access: "banana" },
  ).allowed, false);
});

test("代替モデルは空白でなく、履歴継承拒否でも適格候補を案内する", () => {
  const evidence = {
    ...good,
    historyInherited: true,
    alternatives: [
      good.alternatives[0],
      { ...good.alternatives[0], modelId: "" },
      { ...good.alternatives[0], modelId: "   " },
      { ...good.alternatives[0], modelId: "gpt-6-luna" },
    ],
  };
  const result = decideNativeAgentGate(policy, evidence);
  assert.equal(result.reason, "history-inherited");
  assert.deepEqual(result.alternatives, [good.alternatives[0]]);
});
