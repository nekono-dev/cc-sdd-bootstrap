import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestControl, safeControlResult, serveControl } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-control.mjs";
import { createDelegationJobStore } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-store.mjs";
import { createJobWorker } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-worker.mjs";

test("受信 control 応答の result は許可リストへ変換する", async () => {
  assert.deepEqual(safeControlResult({ status: "invalid", extra: true }), { status: "unknown" });
  assert.deepEqual(safeControlResult({ status: "running", output: "ok", injected: true }), { status: "unknown" });
  const root = await mkdtemp(join(tmpdir(), "delegation-control-safe-result-"));
  try {
    const server = await serveControl({ status: async () => ({ status: "invalid", extra: true }), stop: async () => ({ status: "stopped" }) }, { root, requestId: "job", generation: "generation-1", pollIntervalMs: 5 });
    try {
      assert.deepEqual(await requestControl({ root, requestId: "job", generation: "generation-1", kind: "status", timeoutMs: 1000 }), { status: "unknown" });
    } finally { await server.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("依頼 ID の許可文字 . と : で制御要求を配送する", async () => {
  const root = await mkdtemp(join(tmpdir(), "delegation-control-id-"));
  const requestId = "request.4:4";
  try {
    await mkdir(join(root, `control-${requestId}`), { mode: 0o700 });
    const server = await serveControl({ status: async () => ({ status: "running" }), stop: async () => ({ status: "stopped" }) }, { root, requestId, generation: "generation-1", pollIntervalMs: 5 });
    try {
      assert.deepEqual(await requestControl({ root, requestId, generation: "generation-1", kind: "status", timeoutMs: 1000 }), { status: "running" });
    } finally { await server.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("ドットとコロンを含む依頼 ID は台帳の再読み込み後も制御先へ解決する", async () => {
  const root = await mkdtemp(join(tmpdir(), "delegation-control-ledger-id-"));
  const project = join(root, "project"), runtime = join(root, "runtime"), writable = join(root, "writable");
  await Promise.all([mkdir(project), mkdir(writable)]);
  const requestId = "request.4:4";
  try {
    const options = { root: runtime, writableRoots: [writable], resolveWorktreeRoot: async () => project };
    const firstStore = createDelegationJobStore(options);
    const request = { requestId, project, cwd: project, skill: "kiro-implement", taskId: "4.4" };
    const tracked = await firstStore.track(request);
    assert.equal(tracked.kind, "tracked", JSON.stringify(tracked));
    const secondStore = createDelegationJobStore(options);
    const resolved = await secondStore.resolveControlTarget(request);
    assert.ok(resolved?.generation, `再読込後に所有世代を解決する: ${JSON.stringify(resolved)} ledger=${await readFile(join(runtime, "jobs.json"), "utf8")}`);
    assert.match(resolved.controlDirectory, /^control-[a-f0-9]{32}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("所有者は別世代と無関係な依頼 ID の要求を保持し worker に渡さない", async () => {
  const root = await mkdtemp(join(tmpdir(), "delegation-control-generation-"));
  const folder = join(root, "control-job-old-generation");
  await mkdir(folder, { mode: 0o700 });
  let calls = 0;
  let inspected;
  const inspection = new Promise((resolve) => { inspected = resolve; });
  const server = await serveControl({ status: async () => { calls++; return { status: "running" }; }, stop: async () => { calls++; return { status: "stopped" }; } },
    { root, requestId: "job", controlDirectory: "control-job-old-generation", generation: "old-generation", pollIntervalMs: 5, onInspect: (request) => { if (request?.generation === "new-generation") inspected(); } });
  const file = join(folder, "request-abcdef01-1111-4111-8111-abcdefabcdef.json");
  try {
    await writeFile(file, JSON.stringify({ requestId: "unrelated", generation: "new-generation", controlId: "abcdef01-1111-4111-8111-abcdefabcdef", kind: "status", deadline: Date.now() + 10000 }));
    await inspection;
    assert.equal(calls, 0, "別世代の要求では worker を呼ばない");
    assert.equal((await readdir(folder)).includes("request-abcdef01-1111-4111-8111-abcdefabcdef.json"), true, "旧所有者は新世代要求を残す");
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("同じ依頼の旧・新世代所有者が並行しても新要求は新所有者だけが処理する", async () => {
  const root = await mkdtemp(join(tmpdir(), "delegation-control-overlap-"));
  let oldCalls = 0, newCalls = 0;
  const oldOwner = await serveControl({ status: async () => { oldCalls++; return { status: "running" }; }, stop: async () => ({ status: "stopped" }) },
    { root, requestId: "job", controlDirectory: "control-old", generation: "generation-old", pollIntervalMs: 5 });
  const newOwner = await serveControl({ status: async () => { newCalls++; return { status: "running" }; }, stop: async () => ({ status: "stopped" }) },
    { root, requestId: "job", controlDirectory: "control-new", generation: "generation-new", pollIntervalMs: 5 });
  try {
    assert.deepEqual(await requestControl({ root, requestId: "job", controlDirectory: "control-new", generation: "generation-new", kind: "status", timeoutMs: 1000 }), { status: "running" });
    assert.equal(oldCalls, 0);
    assert.equal(newCalls, 1);
  } finally { await oldOwner.close(); await newOwner.close(); await rm(root, { recursive: true, force: true }); }
});

test("worker controlTarget は不正入力を拒否し、無関係な依頼 ID で worker を呼ばない", async () => {
  let statusCalls = 0;
  const store = {
    reserve: async () => ({ kind: "created", record: { generation: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", requestIds: ["owned"], controlDirectory: "control-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }),
    markUnknown: async () => true,
    resolveControlTarget: async () => ({ generation: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", controlDirectory: "control-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
  };
  const worker = createJobWorker({ store, now: Date.now, select: async () => ({ kind: "unavailable", reasons: [] }), connect: async () => null });
  assert.deepEqual(await worker.controlTarget(null), { kind: "unavailable", reason: "制御先の入力が不正です" });
  assert.deepEqual(await worker.controlTarget({ requestId: "owned", project: "/p", cwd: "/p", skill: "kiro-implement", taskId: "4.4", extra: true }), { kind: "unavailable", reason: "制御先の入力が不正です" });
  const controlled = createJobWorker({
    store: { ...store, reserve: async () => ({ kind: "created", record: { generation: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", requestIds: ["owned"], controlDirectory: "control-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }) },
    now: Date.now,
    select: async () => ({ kind: "mcp", access: "workspace-write", model: "m", effort: "off", candidate: {} }),
    connect: async () => ({ capabilities: async () => ({ kind: "agent", harness: "x", tier: "local", models: [{ id: "m", accepted: [{ access: "workspace-write", effort: "off" }] }] }), models: async () => ["m"], start: async () => ({ kind: "started", job: { serverId: "s", connectionId: "c", jobId: "j" } }), status: async () => { statusCalls++; return { status: "running" }; }, stop: async () => ({ status: "stopped" }) }),
  });
  await controlled.start({ requestId: "owned", project: "/p", cwd: "/p", role: "manufacture", instruction: "x", skill: "kiro-implement", taskId: "4.4", access: "workspace-write" });
  assert.deepEqual(await controlled.controlStatus("unrelated"), { status: "unknown", reason: "この worker は依頼を所有していません" });
  assert.equal(statusCalls, 0, "無関係な依頼 ID では状態照会しない");
});
