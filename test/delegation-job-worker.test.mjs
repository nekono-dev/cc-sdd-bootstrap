import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createJobWorker, createDefaultJobWorker } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-worker.mjs";
import { createCodexAdapter } from "../.agent-hooks/cc-sdd-bootstrap/delegation-mcp.mjs";
import { fingerprintTransport, resolveRegistration as resolveSavedRegistration } from "../.agent-hooks/cc-sdd-bootstrap/delegation-registry.mjs";
import { serve as createCodexServer } from "../.agent-hooks/cc-sdd-bootstrap/codex-agent-mcp.mjs";

const request = { requestId: "req-1", project: "/repo", cwd: "/repo", role: "review", instruction: "inspect", skill: "kiro-feature", taskId: "1.1", access: "workspace-write", model: "m", effort: "high" };
function harness(overrides = {}) {
  const calls = []; let closes = 0; let active = 0; let maximum = 0;
  const adapter = {
    async capabilities() { calls.push("capabilities"); return { kind: "agent", harness: "test", tier: "cloud", models: [{ id: "m", accepted: [{ access: "workspace-write", effort: "high" }] }] }; },
    async models() { calls.push("models"); return ["m"]; },
    async start() { calls.push("start"); return { kind: "started", job: { serverId: "s", connectionId: "c", jobId: "j" } }; },
    async status() { active++; maximum = Math.max(maximum, active); calls.push("status"); await Promise.resolve(); active--; return { status: "running" }; },
    async stop() { active++; maximum = Math.max(maximum, active); calls.push("stop"); await Promise.resolve(); active--; return { status: "stopped" }; },
    async close() { closes++; },
  };
  const deps = { select: async () => ({ kind: "mcp", candidate: { registrationName: "server" }, model: "m", access: "workspace-write", effort: "high" }), connect: async () => { calls.push("connect"); return adapter; }, store: { reserve: async () => ({ kind: "created" }), markUnknown: async () => true }, now: () => 1, ...overrides };
  const worker = createJobWorker(deps);
  return { worker, calls, adapter, closes: () => closes, close() { closes++; }, max: () => maximum };
}

test("同一接続の adapter で能力確認・起動・状態・停止し、終端で解放する", async () => {
  const h = harness();
  const started = await h.worker.start(request);
  assert.equal(started.kind, "started");
  assert.deepEqual(h.calls.slice(0, 4), ["connect", "capabilities", "models", "start"]);
  assert.equal((await h.worker.status("j")).status, "running");
  assert.equal((await h.worker.stop("j")).status, "stopped");
  assert.equal(h.closes(), 1);
  assert.equal(h.worker.isBusy(), false);
});

test("制御要求は依頼 ID を所有 jobId に解決し、所有外は拒否する", async () => {
  const h = harness();
  assert.equal((await h.worker.start(request)).kind, "started");
  assert.equal((await h.worker.controlStatus("req-1")).status, "running");
  assert.equal((await h.worker.controlStop("req-1")).status, "stopped");
  assert.equal((await h.worker.controlStatus("not-owned")).status, "unknown");
  assert.match((await h.worker.controlStatus("not-owned")).reason, /所有/);
});

test("適格候補なしは接続・起動せず、予約を解放する", async () => {
  let connected = 0; let started = 0; let released = 0;
  const h = harness({ select: async () => ({ kind: "unavailable", reasons: ["候補なし"] }), connect: async () => { connected++; return { ...h.adapter, start: async () => { started++; } }; }, store: { reserve: async () => ({ kind: "created" }), release: async () => { released++; return true; }, markUnknown: async () => true } });
  assert.equal((await h.worker.start(request)).kind, "unavailable");
  assert.equal(connected, 0); assert.equal(started, 0); assert.equal(released, 1);
});

test("入力契約から実選択・登録再解決・同一接続の起動まで既定 worker を結線する", async () => {
  const events = [];
  const saved = { family: "pi", scope: "user", registrationName: "agent", registrationId: "reg-1" };
  const registration = { host: "pi", scope: "user", registrationName: "agent", registrationId: "reg-1" };
  const adapter = {
    async capabilities() { events.push("capabilities"); return { kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: "read-only", effort: "medium" }] }] }; },
    async models() { events.push("models"); return ["m"]; },
    async start() { events.push("start"); return { kind: "started", job: { serverId: "s", connectionId: "c", jobId: "j" } }; },
    async status() { events.push("status"); return { status: "running" }; },
    async stop() { events.push("stop"); return { status: "stopped" }; }, async close() { events.push("close"); },
  };
  const worker = createDefaultJobWorker({
    store: { reserve: async () => ({ kind: "created" }), release: async () => true, markUnknown: async () => true },
    resolveRegistration: async (source, savedArg, { verifiedFamily }) => { events.push("resolve"); assert.equal(source.registrationId, registration.registrationId); assert.equal(savedArg.registrationId, saved.registrationId); assert.equal(verifiedFamily, "pi"); return resolveSavedRegistration({ ...source, enabled: true, approved: true, trusted: true, transportType: "stdio", transportFingerprint: fingerprintTransport({ type: "stdio", command: "fake-agent" }) }, savedArg, { verifiedFamily }); },
    readTransport: async () => { events.push("readTransport"); return { type: "stdio", command: "fake-agent" }; },
    spawnProcess: () => { events.push("spawn"); const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {}; child.stdin.setEncoding("utf8"); let buffer = ""; child.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const index = buffer.indexOf("\n"); if (index < 0) break; const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake" } } })}\n`); else if (message.method === "tools/list") child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } })}\n`); } }); return child; }, adapterFactory: async () => adapter,
  });
  const input = { ...request, access: "read-only", settings: { subagents: { localModels: { review: "m" } } }, host: "claude", native: { client: "claude", available: false }, candidates: [{ registration, saved, verifiedFamily: "pi", tier: "local" }] };
  const started = await worker.start(input);
  assert.equal(started.kind, "started", JSON.stringify({ started, events }));
  assert.deepEqual(events.slice(0, 5), ["resolve", "readTransport", "spawn", "capabilities", "models"]);
  assert.ok(events.includes("start"));
  assert.equal((await worker.status("j")).status, "running");
  assert.equal((await worker.stop("j")).status, "stopped");
  assert.equal(events.filter((event) => event === "spawn").length, 1);
});

test("既定 worker は全候補不適格の接続を解放する", async () => {
  let closed = 0;
  const worker = defaultSelectionWorker({ candidates: [defaultCandidate("bad")], closed: { add: () => { closed++; } },
    adapterFactory: async () => ({ capabilities: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [] }), models: async () => [], start: async () => {}, status: async () => ({}), stop: async () => ({}) }) });
  const result = await worker.start(defaultRequest([defaultCandidate("bad")]));
  assert.equal(result.kind, "unavailable", JSON.stringify(result));
  assert.equal(closed, 1, `適格候補がない場合に確立済み接続を閉じる: ${JSON.stringify(result)}`);
});

test("既定 worker は複数候補から未選択候補の接続を解放する", async () => {
  const closed = [];
  const worker = defaultSelectionWorker({ candidates: [defaultCandidate("first"), defaultCandidate("second")], closed,
    adapterFactory: async () => ({ capabilities: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: "read-only", effort: "medium" }] }] }), models: async () => ["m"], start: async () => ({ kind: "started", job: { serverId: "s", connectionId: "c", jobId: "j" } }), status: async () => ({ status: "running" }), stop: async () => ({ status: "stopped" }) }) });
  const result = await worker.start(defaultRequest([defaultCandidate("first"), defaultCandidate("second")]));
  assert.equal(result.kind, "started");
  assert.deepEqual(closed, ["second"], "選ばれなかった接続だけを閉じる");
});

test("既定 worker は能力取得失敗と後続候補の不正で全接続を解放する", async () => {
  for (const candidates of [[defaultCandidate("failure")], [defaultCandidate("first"), { ...defaultCandidate("invalid"), extra: true }]]) {
    const closed = [];
    let opened = 0;
    const worker = defaultSelectionWorker({ candidates, closed, onSpawn: () => { opened++; },
      adapterFactory: async (connection) => ({ capabilities: async () => { if (connection.serverInfo.name === "failure") throw new Error("能力取得失敗"); return { kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: "read-only", effort: "medium" }] }] }; }, models: async () => ["m"], start: async () => ({ kind: "started", job: { serverId: "s", connectionId: "c", jobId: "j" } }), status: async () => ({ status: "running" }), stop: async () => ({ status: "stopped" }) }) });
    const result = await worker.start(defaultRequest(candidates));
    assert.equal(result.kind, "unavailable");
    assert.deepEqual(closed, candidates[0].registration.registrationId === "failure" ? ["failure"] : [], "不正候補は接続前に拒否し、既存接続を残さない");
    if (candidates.length > 1) assert.equal(opened, 0, "後続候補が不正なら先行候補への接続前に拒否する");
  }
});

function defaultCandidate(name) {
  const registrationId = name;
  const registration = { host: "pi", scope: "user", registrationName: name, registrationId };
  const saved = { family: "pi", scope: "user", registrationName: name, registrationId };
  return { registration, saved, verifiedFamily: "pi", tier: "local" };
}

function defaultRequest(candidates) {
  return { ...request, access: "read-only", settings: { subagents: { localModels: { review: "m" } } }, host: "claude", native: { client: "claude", available: false }, candidates: candidates ?? [defaultCandidate("candidate")] };
}

function defaultSelectionWorker({ candidates, adapterFactory, closed = [], onSpawn = () => {} }) {
  return createDefaultJobWorker({ store: { reserve: async () => ({ kind: "created" }), release: async () => true, markUnknown: async () => true },
    resolveRegistration: async (source, saved, { verifiedFamily }) => ({ ...source, enabled: true, approved: true, trusted: true, status: "eligible", transportType: "stdio", transportFingerprint: fingerprintTransport({ type: "stdio", command: source.registrationId }) }),
    readTransport: async (source) => ({ type: "stdio", command: source.registrationId }),
    spawnProcess: (command) => { onSpawn(command); const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { if (typeof closed.add === "function") closed.add(command); else closed.push(command); }; child.stdin.setEncoding("utf8"); let buffer = ""; child.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const index = buffer.indexOf("\n"); if (index < 0) break; const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: command } } })}\n`); else if (message.method === "tools/list") child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } })}\n`); } }); return child; }, adapterFactory });
}

test("起動前の接続・能力・識別子失敗は予約を解放し、Job 全識別子を検証する", async () => {
  for (const failure of [
    { connect: async () => { throw new Error("接続失敗"); } },
    { connect: async () => ({ close() {} }) },
    { connect: async () => ({ ...harness().adapter, capabilities: async () => { throw new Error("能力取得失敗"); } }) },
  ]) {
    let released = 0; let unknown = 0;
    const h = harness({ ...failure, store: { reserve: async () => ({ kind: "created" }), release: async () => { released++; return true; }, markUnknown: async () => { unknown++; return true; } } });
    const result = await h.worker.start(request);
    assert.notEqual(result.kind, "started");
    assert.equal(released, 1, "起動前失敗は予約を解放する");
    assert.equal(unknown, 0, "未送信を unknown にしない");
  }
  for (const key of ["serverId", "connectionId", "jobId"]) {
    const h = harness({ connect: async () => ({ ...harness().adapter, start: async () => ({ kind: "started", job: { serverId: "s", connectionId: "c", jobId: "j", [key]: "" } }) }) });
    assert.equal((await h.worker.start(request)).kind, "pending", `${key} の空値は送信後 unknown として扱う`);
  }
});

test("実 worker の終端状態を観測するまで process runner が所有接続を維持する", async () => {
  const { runWorkerProcess } = await import("../.agent-hooks/cc-sdd-bootstrap/delegation-job-worker.mjs");
  const input = new PassThrough(); const output = new PassThrough();
  let closed = 0; let statusCalls = 0;
  const adapter = { ...harness().adapter, async status() { statusCalls++; return statusCalls === 1 ? { status: "running" } : { status: "succeeded" }; }, async close() { closed++; } };
  const worker = createJobWorker({ select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }), connect: async () => adapter, store: { reserve: async () => ({ kind: "created" }), release: async () => true, markUnknown: async () => true }, now: Date.now });
  const running = runWorkerProcess({ stdin: input, stdout: output, deps: { worker } });
  input.write(`${JSON.stringify({ ...request, project: process.cwd(), cwd: process.cwd() })}\n`);
  const result = await running;
  assert.equal(result.kind, "started");
  assert.ok(statusCalls > 0, "worker が状態をポーリングする");
  assert.equal(closed, 1);
});

test("選択権限が要求より強い場合は起動前に拒否する", async () => {
  let connected = 0;
  const h = harness({ select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }), connect: async () => { connected++; } });
  assert.equal((await h.worker.start({ ...request, access: "read-only" })).kind, "unavailable");
  assert.equal(connected, 0);
});

test("worker process は start 応答後も busy 中に stdin/stdout 処理を保持する", async () => {
  const { runWorkerProcess } = await import("../.agent-hooks/cc-sdd-bootstrap/delegation-job-worker.mjs");
  assert.equal(typeof runWorkerProcess, "function", "runWorkerProcess が公開されていない");
  const input = new PassThrough(); const output = new PassThrough();
  let releaseJob; let started; let busy = false;
  const startPromise = new Promise((resolve) => { started = resolve; });
  const worker = { start: async () => { busy = true; started(); await new Promise((resolve) => { releaseJob = () => { busy = false; resolve(); }; }); return { kind: "started" }; }, isBusy: () => busy, release: async () => {} };
  const lines = []; output.setEncoding("utf8"); output.on("data", (chunk) => lines.push(chunk));
  let exited = false;
  const running = runWorkerProcess({ stdin: input, stdout: output, deps: { worker } }).then(() => { exited = true; });
  input.write(`${JSON.stringify(request)}\n`);
  await startPromise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exited, false);
  releaseJob();
  input.end();
  await running;
  assert.equal(exited, true);
  assert.equal(lines.length, 1);
});

test("不正入力は例外でなく拒否結果になる", async () => {
  const h = harness();
  assert.equal((await h.worker.start({ ...request, injected: true })).kind, "unavailable");
});

test("トップレベル readOnly の矛盾は予約・MCP 接続より前に拒否する", async () => {
  let connected = 0; let reserved = 0;
  const h = harness({ connect: async () => { connected++; return h.adapter; }, store: { reserve: async () => { reserved++; return { kind: "created" }; }, release: async () => true, markUnknown: async () => true } });
  const result = await h.worker.start({ ...request, readOnly: true, access: "workspace-write" });
  assert.equal(result.kind, "unavailable", `readOnly/access の矛盾を起動前に拒否する: 実際=${JSON.stringify(result)}`);
  assert.equal(reserved, 0, "矛盾した権限は予約しない");
  assert.equal(connected, 0, "矛盾した権限では MCP 接続・起動しない");
});

test("既定 worker は readOnly を役割選択条件へ渡す", async () => {
  const closed = []; let started = 0;
  const candidate = defaultCandidate("readonly-role");
  const worker = defaultSelectionWorker({ candidates: [candidate], closed, adapterFactory: async () => ({
    capabilities: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: "read-only", effort: "high" }] }] }),
    models: async () => ["m"], start: async () => { started++; return { kind: "started", job: { serverId: "s", connectionId: "c", jobId: "j" } }; },
    status: async () => ({ status: "running" }), stop: async () => ({ status: "stopped" }),
  }) });
  const input = { ...defaultRequest([candidate]), role: "design", readOnly: true, access: "read-only", settings: { subagents: { localModels: { design: "m" } } } };
  const result = await worker.start(input);
  assert.equal(result.kind, "started", `readOnly の役割条件で適格候補を選ぶ: 実際=${JSON.stringify(result)}`);
  assert.equal(started, 1);

  const withoutReadOnly = await worker.start({ ...input, readOnly: false, access: "workspace-write" });
  assert.equal(withoutReadOnly.kind, "unavailable", `readOnly を外すと read-only 専用候補は不適格: 実際=${JSON.stringify(withoutReadOnly)}`);
  assert.equal(started, 1, "readOnly 条件なしでは起動しない");
});

test("unknown は接続所有を保ち、状態・停止が同時でも adapter 操作を直列化する", async () => {
  let closed = 0;
  let start = 0;
  let simultaneous = 0;
  let max = 0;
  const adapter = {
    capabilities: async () => ({ kind: "agent", harness: "test", tier: "cloud", models: [{ id: "m", accepted: [{ access: "workspace-write", effort: "high" }] }] }),
    models: async () => ["m"],
    start: async () => { start++; return { kind: "unknown", reason: "送信後不明", job: { jobId: "j" } }; },
    status: async () => { simultaneous++; max = Math.max(max, simultaneous); await new Promise((resolve) => setImmediate(resolve)); simultaneous--; return { status: "unknown" }; },
    stop: async () => { simultaneous++; max = Math.max(max, simultaneous); await new Promise((resolve) => setImmediate(resolve)); simultaneous--; return { status: "stopped" }; },
    close: async () => { closed++; },
  };
  const worker = createJobWorker({ select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }), connect: async () => adapter, store: { reserve: async () => ({ kind: "created" }), markUnknown: async () => true }, now: Date.now });
  assert.equal((await worker.start(request)).kind, "pending");
  assert.equal(start, 1);
  assert.equal(closed, 0);
  await Promise.all([worker.status("j"), worker.stop("j")]);
  assert.equal(max, 1);
  assert.equal(closed, 1);
  assert.equal(worker.isBusy(), false);
});

test("矛盾した not-started 起動応答は unknown として接続所有・予約を維持する", async () => {
  let released = 0; let markedUnknown = 0; let closed = 0;
  const adapter = { ...harness().adapter,
    async start() { return { kind: "not-started", reason: "拒否", job: { serverId: "s", connectionId: "c", jobId: "j" } }; },
    async status(jobId) { assert.equal(jobId, "j"); return { status: "running", jobId }; },
    async close() { closed++; },
  };
  const worker = createJobWorker({ select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }), connect: async () => adapter,
    store: { reserve: async () => ({ kind: "created" }), release: async () => { released++; return true; }, markUnknown: async () => { markedUnknown++; return true; } }, now: Date.now });
  const result = await worker.start(request);
  assert.equal(result.kind, "pending", `不正な送信後応答は pending/unknown で保持する: 実際=${JSON.stringify(result)}`);
  assert.equal(released, 0, "矛盾した応答で書き込み予約を解放しない");
  assert.equal(markedUnknown, 1, "送信後の不明状態を永続化する");
  assert.equal(worker.pendingJobId(), "j");
  assert.equal((await worker.status("j")).status, "running");
  assert.equal(closed, 0, "状態照会で終端が確定するまでは接続を所有する");
  assert.equal((await worker.stop("j")).status, "stopped");
  assert.equal(closed, 1);
});

test("読み取り専用の起動前拒否は制御記録を世代照合して解放し、再試行できる", async () => {
  let tracked = false; let releases = 0; let starts = 0;
  const store = {
    reserve: async () => ({ kind: "created" }), release: async () => true, markUnknown: async () => true,
    track: async () => tracked ? { kind: "existing", record: { generation: "a".repeat(32), controlDirectory: `control-${"a".repeat(32)}` } } : (tracked = true, { kind: "tracked", record: { generation: "a".repeat(32), controlDirectory: `control-${"a".repeat(32)}` } }),
    releaseTrack: async ({ generation }) => { assert.equal(generation, "a".repeat(32)); tracked = false; releases++; return true; },
  };
  const h = harness({ store, select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "read-only", effort: "high" }), connect: async () => ({ ...harness().adapter,
    capabilities: async () => ({ kind: "agent", harness: "test", tier: "cloud", models: [{ id: "m", accepted: [{ access: "read-only", effort: "high" }] }] }),
    start: async () => { starts++; return starts === 1 ? { kind: "not-started", reason: "起動前拒否" } : { kind: "started", job: { serverId: "s", connectionId: "c", jobId: "j" } }; } }) });
  const input = { ...request, access: "read-only" };
  assert.equal((await h.worker.start(input)).kind, "unavailable");
  assert.equal(releases, 1);
  assert.equal((await h.worker.start(input)).kind, "started", "同じ依頼を再試行できる");
});

test("不正な状態・停止応答は終端確定に使わず接続所有を保つ", async () => {
  let statusResult = { status: "running", extra: true };
  let stopResult = { status: "stopped", jobId: "other" };
  let closed = 0;
  const adapter = { ...harness().adapter, async status() { return statusResult; }, async stop() { return stopResult; }, async close() { closed++; } };
  const worker = createJobWorker({ select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }), connect: async () => adapter,
    store: { reserve: async () => ({ kind: "created" }), markUnknown: async () => true }, now: Date.now });
  assert.equal((await worker.start(request)).kind, "started");
  assert.equal((await worker.status("j")).status, "unknown", "未知フィールドを含む状態は unknown とする");
  assert.equal((await worker.stop("j")).status, "unknown", "別 jobId を含む停止結果は unknown とする");
  assert.equal(worker.isBusy(), true);
  assert.equal(closed, 0);
  stopResult = { status: "stopped", jobId: "j" };
  assert.equal((await worker.stop("j")).status, "stopped");
  assert.equal(closed, 1);
});

test("能力と受付モデルの未知フィールド・不正識別子は起動前に拒否する", async () => {
  for (const adapter of [
    { ...harness().adapter, async capabilities() { return { kind: "agent", harness: "test", tier: "cloud", models: [{ id: "m", accepted: [{ access: "workspace-write", effort: "high" }] }], injected: true }; } },
    { ...harness().adapter, async models() { return ["m", ""]; } },
  ]) {
    let released = 0; let starts = 0; let closed = 0;
    adapter.start = async () => { starts++; return { kind: "started", job: { serverId: "s", connectionId: "c", jobId: "j" } }; };
    adapter.close = async () => { closed++; };
    const worker = createJobWorker({ select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }), connect: async () => adapter,
      store: { reserve: async () => ({ kind: "created" }), release: async () => { released++; return true; }, markUnknown: async () => true }, now: Date.now });
    assert.equal((await worker.start(request)).kind, "unavailable");
    assert.equal(starts, 0);
    assert.equal(released, 1);
    assert.equal(closed, 1);
  }
});

test("書き込み予約 blocked は接続も起動もしない", async () => {
  let connected = 0;
  const worker = createJobWorker({ select: async () => ({ kind: "mcp" }), connect: async () => { connected++; }, store: { reserve: async () => ({ kind: "blocked", reason: "競合" }), markUnknown: async () => true }, now: Date.now });
  assert.equal((await worker.start(request)).kind, "unavailable");
  assert.equal(connected, 0);
});

test("状態照会が期限切れでも後続の停止要求を実行する", async () => {
  const base = harness();
  let stops = 0;
  const adapter = { ...base.adapter, status: async () => new Promise(() => {}), stop: async () => { stops++; return { status: "stopped" }; } };
  const worker = createJobWorker({ select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }), connect: async () => adapter, store: { reserve: async () => ({ kind: "created" }), markUnknown: async () => true }, now: Date.now, operationTimeoutMs: 10 });
  assert.equal((await worker.start(request)).kind, "started");
  const status = worker.status("j");
  const stopped = worker.stop("j");
  assert.equal((await status).status, "unknown");
  assert.equal((await stopped).status, "stopped");
  assert.equal(stops, 1);
});

test("状態照会が保留中も独立 heartbeat が所有者を生存扱いに保つ", async () => {
  const base = harness();
  let beat;
  let heartbeatAt = 10;
  let now = 10;
  let releaseStatus;
  const generation = "a".repeat(32);
  const store = {
    reserve: async () => ({ kind: "created", record: { generation, requestIds: [request.requestId] } }),
    recordOwner: async () => true,
    heartbeat: async (input) => { heartbeatAt = input.now; return true; },
    recordTerminal: async () => true,
    markUnknown: async () => true,
    resolveControlTarget: async () => ({ generation, controlDirectory: `control-${generation}` }),
    inspectOwner: async ({ now: at, heartbeatTtlMs }) => at - heartbeatAt > heartbeatTtlMs ? { kind: "lost", reason: "期限切れ" } : { kind: "alive" },
  };
  const worker = createJobWorker({ select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }), connect: async () => ({
    ...base.adapter,
    status: () => new Promise((resolve) => { releaseStatus = () => resolve({ status: "running" }); }),
  }), store, now: () => now, operationTimeoutMs: 60000,
    setInterval: (callback) => { beat = callback; return 1; }, clearInterval: () => {}, heartbeatIntervalMs: 5 });
  assert.equal((await worker.start(request)).kind, "started");
  const pendingStatus = worker.status("j");
  await new Promise((resolve) => setImmediate(resolve));
  now = 20000;
  await beat();
  const target = await worker.controlTarget({ requestId: request.requestId, project: request.project, cwd: request.cwd, skill: request.skill, taskId: request.taskId });
  assert.equal(target.generation, generation, `照会中の所有者を生存扱いにする: 実際=${JSON.stringify(target)}`);
  releaseStatus();
  await pendingStatus;
  await worker.stop("j");
});

test("共有キュー待機中に期限切れとなった制御停止は実行しない", async () => {
  const base = harness();
  let releaseStatus;
  let stops = 0;
  let now = 100;
  const adapter = { ...base.adapter, status: () => new Promise((resolve) => { releaseStatus = () => resolve({ status: "running" }); }), stop: async () => { stops++; return { status: "stopped" }; } };
  const worker = createJobWorker({ select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }), connect: async () => adapter, store: { reserve: async () => ({ kind: "created" }), markUnknown: async () => true }, now: () => now, operationTimeoutMs: 1000 });
  await worker.start(request);
  const status = worker.controlStatus("req-1");
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = worker.controlStop("req-1", 150);
  now = 151;
  releaseStatus();
  await status;
  assert.equal((await stopped).status, "unknown", "期限切れ要求は unknown を返す");
  assert.equal(stops, 0, "期限切れ要求で adapter.stop を呼ばない");
});

test("jobId がない送信後 unknown でも所有者を生存扱いにする", async () => {
  let closed = 0;
  const adapter = {
    capabilities: async () => ({ kind: "agent", harness: "test", tier: "cloud", models: [{ id: "m", accepted: [{ access: "workspace-write", effort: "high" }] }] }),
    models: async () => ["m"], start: async () => ({ kind: "unknown", reason: "応答欠落" }),
    status: async () => ({ status: "unknown" }), stop: async () => ({ status: "unknown" }), close: async () => { closed++; },
  };
  const worker = createJobWorker({ select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }), connect: async () => adapter, store: { reserve: async () => ({ kind: "created" }), markUnknown: async () => true }, now: Date.now });
  assert.equal((await worker.start(request)).kind, "pending");
  assert.equal(worker.isBusy(), true);
  await worker.release();
  assert.equal(closed, 0);
});

test("公開 tier と入力 tier が違う候補は除外し、探査接続を解放する", async () => {
  const closed = [];
  const worker = defaultSelectionWorker({ candidates: [defaultCandidate("tier-mismatch")], closed,
    adapterFactory: async () => ({ capabilities: async () => ({ kind: "agent", harness: "pi", tier: "cloud", models: [{ id: "m", accepted: [{ access: "read-only", effort: "medium" }] }] }), models: async () => ["m"], start: async () => { assert.fail("不一致候補を起動しない"); }, status: async () => ({ status: "unknown" }), stop: async () => ({ status: "unknown" }) }) });
  const result = await worker.start(defaultRequest([defaultCandidate("tier-mismatch")]));
  assert.equal(result.kind, "unavailable");
  assert.deepEqual(closed, ["tier-mismatch"]);
});

test("同一 registrationId の重複候補は接続前に拒否する", async () => {
  const candidate = defaultCandidate("duplicate-registration");
  const closed = [];
  let opened = 0;
  const worker = defaultSelectionWorker({ candidates: [candidate, structuredClone(candidate)], closed,
    onSpawn: () => { opened++; } });
  const result = await worker.start(defaultRequest([candidate, structuredClone(candidate)]));
  assert.equal(result.kind, "unavailable", `重複登録を拒否する: 実際=${JSON.stringify(result)}`);
  assert.equal(opened, 0, "重複の検査は接続前に行う");
  assert.deepEqual(closed, [], "重複候補で接続を残さない");
});

test("pending の既知 jobId は process runner が同じ worker 接続で終端まで照会する", async () => {
  const { runWorkerProcess } = await import("../.agent-hooks/cc-sdd-bootstrap/delegation-job-worker.mjs");
  const input = new PassThrough(); const output = new PassThrough();
  let statusCalls = 0; let closed = 0;
  const adapter = { ...harness().adapter,
    async start() { return { kind: "unknown", reason: "応答不明", job: { jobId: "j" } }; },
    async status() { statusCalls++; return { status: "succeeded" }; }, async close() { closed++; },
  };
  const worker = createJobWorker({ select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }), connect: async () => adapter, store: { reserve: async () => ({ kind: "created" }), release: async () => true, markUnknown: async () => true }, now: Date.now });
  const running = runWorkerProcess({ stdin: input, stdout: output, deps: { worker } });
  input.end(`${JSON.stringify({ ...request, project: process.cwd(), cwd: process.cwd() })}\n`);
  const result = await running;
  assert.equal(result.kind, "pending");
  assert.equal(statusCalls, 1);
  assert.equal(closed, 1);
});

test("実 Codex adapter と実 MCP server を介して起動・状態・停止する", async () => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const server = createCodexServer({ input: clientToServer, output: serverToClient, listModels: async () => [{ model: "gpt-test", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], allowedRoots: [process.cwd()], stopGraceMs: 10,
    spawnProcess() {
      const child = new EventEmitter(); fakeChild = child; child.pid = 456789; child.stdin = new PassThrough(); child.stdout = new PassThrough();
      child.kill = () => {};
      setImmediate(() => child.emit("spawn"));
      child.stdin.on("finish", () => {});
      return child;
    },
    killProcess(_pid, signal) { if (signal === 0) { const error = new Error("gone"); error.code = "ESRCH"; throw error; } if (signal === "SIGTERM") setImmediate(() => fakeChild?.emit("exit", null, signal)); },
  });
  let fakeChild;
  // spawn closure を取り出せるように依存関数を上書きする。
  const responses = new Map(); let id = 0; let buffer = "";
  serverToClient.setEncoding("utf8");
  serverToClient.on("data", (chunk) => {
    buffer += chunk;
    for (;;) { const at = buffer.indexOf("\n"); if (at < 0) break; const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); const message = JSON.parse(line); if (message.id) { const resolve = responses.get(message.id); if (resolve) { responses.delete(message.id); resolve(message.result); } } }
  });
  const send = (method, params) => new Promise((resolve) => { const callId = ++id; responses.set(callId, resolve); clientToServer.write(`${JSON.stringify({ jsonrpc: "2.0", id: callId, method, ...(params ? { params } : {}) })}\n`); });
  const initialized = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const listed = await send("tools/list");
  let workerAdapter;
  const adapter = await createCodexAdapter({ serverInfo: initialized.serverInfo, tools: new Map(listed.tools.map((item) => [item.name, item])), request: async (_method, params) => send("tools/call", params), close: () => clientToServer.end() });
  workerAdapter = { ...adapter, async start(args) { return adapter.start(args); }, async status(jobId) { return adapter.status(jobId); }, async stop(jobId) { return adapter.stop(jobId); }, async close() { clientToServer.end(); } };
  const worker = createJobWorker({ select: async () => ({ kind: "mcp", candidate: {}, model: "gpt-test", access: "workspace-write", effort: "high" }), connect: async () => workerAdapter, store: { reserve: async () => ({ kind: "created" }), markUnknown: async () => true }, now: Date.now });
  const started = await worker.start({ ...request, cwd: process.cwd(), project: process.cwd(), model: undefined, effort: undefined });
  assert.equal(started.kind, "started");
  assert.equal((await worker.status(started.job.jobId)).status, "running");
  // サーバー stop の process signal を偽の子へ向け、実プロセスには信号を送らない。
  assert.equal((await worker.stop(started.job.jobId)).status, "stopped");
  clientToServer.end();
  await server;
});

test("既定 worker は不正な関数オプションを例外でなく拒否する", async () => {
  const worker = createDefaultJobWorker({ store: { reserve: async () => ({ kind: "created" }), markUnknown: async () => true }, select: 42 });
  const result = await worker.start(defaultRequest());
  assert.equal(result.kind, "unavailable", "select の不正型を拒否する");
});

test("jobId のない unknown は再照会を連打せず待機し、予約と所有を維持する", async () => {
  const { runWorkerProcess } = await import("../.agent-hooks/cc-sdd-bootstrap/delegation-job-worker.mjs");
  const input = new PassThrough(); const output = new PassThrough();
  const events = []; let busy = true; let releaseWait; let notifyWaitStarted;
  const waitStarted = new Promise((resolve) => { notifyWaitStarted = resolve; });
  const waited = new Promise((resolve) => { releaseWait = resolve; });
  const worker = { start: async () => ({ kind: "pending", requestId: request.requestId, reason: "応答欠落" }), isBusy: () => busy, pendingJobId: () => null,
    status: async () => { events.push("status"); return { status: "unknown" }; }, release: async () => { events.push("release"); } };
  const running = runWorkerProcess({ stdin: input, stdout: output, wait: async () => { events.push("wait"); notifyWaitStarted(); await waited; }, deps: { worker } });
  input.end(`${JSON.stringify(request)}\n`);
  const observed = await Promise.race([waitStarted.then(() => "waited"), running.then(() => "finished")]);
  assert.equal(observed, "waited", "所有者は busy 中の即時終了でなく待機する");
  assert.deepEqual(events, ["wait"], "jobId がない間は照会せず待機する");
  assert.equal(busy, true, "unknown の予約と所有を維持する");
  busy = false; releaseWait(); await running;
  assert.deepEqual(events, ["wait", "release"]);
});

test("stdout の同期 EPIPE と error 通知でも busy な worker の所有を維持する", async () => {
  const { runWorkerProcess } = await import("../.agent-hooks/cc-sdd-bootstrap/delegation-job-worker.mjs");
  const input = new PassThrough();
  const output = new EventEmitter();
  output.write = () => { const error = new Error("closed pipe"); error.code = "EPIPE"; throw error; };
  const events = []; let busy = true; let releaseWait; let notifyWaitStarted;
  const waitStarted = new Promise((resolve) => { notifyWaitStarted = resolve; });
  const waited = new Promise((resolve) => { releaseWait = resolve; });
  const worker = { start: async () => ({ kind: "started", job: { serverId: "s", connectionId: "c", jobId: "j" } }), isBusy: () => busy,
    status: async () => { events.push("status"); return { status: "running" }; }, release: async () => { events.push("release"); } };
  const running = runWorkerProcess({ stdin: input, stdout: output, wait: async () => { events.push("wait"); notifyWaitStarted(); await waited; }, deps: { worker } });
  input.end(`${JSON.stringify(request)}\n`);
  const observed = await Promise.race([waitStarted.then(() => "waited"), running.then(() => "finished", () => "rejected")]);
  assert.equal(observed, "waited", "出力不能でも所有者は busy 中に終了しない");
  assert.deepEqual(events, ["status", "wait"]);
  output.emit("error", Object.assign(new Error("closed pipe"), { code: "EPIPE" }));
  assert.equal(busy, true);
  busy = false; releaseWait(); await running;
  assert.deepEqual(events, ["status", "wait", "status", "release"]);
});

test("不正な状態応答は status・stop とも unknown に留め、所有接続を解放しない", async (t) => {
  const invalidResponses = [
    ["他ジョブの jobId", { jobId: "other", status: "succeeded" }],
    ["未知状態", { jobId: "j", status: "finished" }],
    ["未知キー", { jobId: "j", status: "succeeded", extra: true }],
    ["状態欠落", { jobId: "j" }],
    ["状態が文字列", "stopped"],
  ];
  for (const [label, response] of invalidResponses) {
    await t.test(label, async () => {
      const h = harness({ connect: async () => ({ ...harness().adapter,
        async status() { return response; }, async stop() { return response; },
        async close() { hClosed++; },
      }) });
      let hClosed = 0;
      assert.equal((await h.worker.start(request)).kind, "started");
      assert.equal((await h.worker.status("j")).status, "unknown", "不正な照会応答を unknown とする");
      assert.equal(h.worker.isBusy(), true, "不正な照会応答で所有を維持する");
      assert.equal(hClosed, 0, "不正な照会応答で接続を閉じない");
      assert.equal((await h.worker.stop("j")).status, "unknown", "不正な停止応答を unknown とする");
      assert.equal(h.worker.isBusy(), true, "不正な停止応答で所有を維持する");
      assert.equal(hClosed, 0, "不正な停止応答で接続を閉じない");
    });
  }
});
