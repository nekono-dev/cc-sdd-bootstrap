import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDelegationOrder } from "../lib/delegation-setup.mjs";

test("役割別モデルの部分更新は未指定の保存値を保持する", () => {
  const candidate = { family: "pi", scope: "project", registrationName: "ready", registrationId: "r1", models: {} };
  const previous = { manufacture: { fixed: "old" }, review: { fixed: "review-model" } };
  const result = applyDelegationOrder({ delegation: { claude: { local: [{ ...candidate, models: previous }] } }, host: "claude", tier: "local", order: ["r1"], candidates: [candidate], models: { r1: { manufacture: { fixed: "new" } } } });
  assert.deepEqual(result.delegation.claude.local[0].models, { manufacture: { fixed: "new" }, review: { fixed: "review-model" } });
});
