import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelegationJobStore } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-store.mjs";
import { createJobWorker } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-worker.mjs";

test("読み取り専用の起動前拒否は制御記録を世代照合して解放し、再試行できる", async () => {
  const root = await mkdtemp(join(tmpdir(), "delegation-readonly-retry-"));
  const project = join(root, "project"), runtime = join(root, "runtime");
  await Promise.all([mkdir(project), mkdir(runtime, { mode: 0o700 })]);
  try {
    const store = createDelegationJobStore({ root: runtime, writableRoots: [project], resolveWorktreeRoot: async () => project });
    let starts = 0;
    const worker = createJobWorker({ store, now: Date.now,
      select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "read-only", effort: "medium" }),
      connect: async () => ({ capabilities: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: "read-only", effort: "medium" }] }] }),
        models: async () => ["m"], start: async () => ++starts === 1 ? { kind: "not-started", reason: "起動前拒否" } : { kind: "started", job: { serverId: "s", connectionId: "c", jobId: "job-1" } },
        status: async () => ({ status: "running" }), stop: async () => ({ status: "stopped" }), close: async () => {} }) });
    const request = { requestId: "retry-4.4", project, cwd: project, role: "review", instruction: "確認", skill: "kiro-implement", taskId: "4.4", access: "read-only" };
    assert.equal((await worker.start(request)).kind, "unavailable");
    assert.equal(await store.resolveControlTarget({ requestId: request.requestId, project, cwd: project, skill: request.skill, taskId: request.taskId }), null);
    const retry = await worker.start(request);
    assert.equal(retry.kind, "started", `同じ依頼を再試行できる: 実際=${JSON.stringify(retry)}`);
    assert.equal(starts, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
