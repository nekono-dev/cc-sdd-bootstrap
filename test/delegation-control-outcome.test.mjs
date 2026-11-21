import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestControl } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-control.mjs";

test("公開済み stop の応答期限切れは unavailable でなく requestId 付き unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "delegation-control-outcome-"));
  try {
    assert.deepEqual(await requestControl({ root, requestId: "timeout-job", generation: "owner-generation", kind: "stop", timeoutMs: 10 }),
      { kind: "unknown", requestId: "timeout-job", reason: "制御所有者から応答がありません" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
