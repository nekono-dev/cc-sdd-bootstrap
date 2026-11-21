import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createDelegationJobStore } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-store.mjs";
import { createJobWorker } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-worker.mjs";
import { runWorkerProcess } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-worker.mjs";

test("実 store と worker は所有者消失・heartbeat 期限切れを unknown にし、書き込みを再起動しない", async () => {
  const base = await mkdtemp(join(tmpdir(), "delegation-owner-lost-"));
  const project = join(base, "project"), root = join(base, "runtime");
  await Promise.all([mkdir(project), mkdir(root, { mode: 0o700 })]);
  try {
    const store = createDelegationJobStore({ root, writableRoots: [project], resolveWorktreeRoot: async () => project });
    let starts = 0;
    const makeWorker = (now, isAlive) => createJobWorker({ store, now: () => now, isAlive,
      select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }),
      connect: async () => ({ capabilities: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: "workspace-write", effort: "high" }] }] }),
        models: async () => ["m"], start: async () => { starts++; return { kind: "started", job: { serverId: "s", connectionId: "c", jobId: "never-started-again" } }; },
        status: async () => ({ status: "unknown" }), stop: async () => ({ status: "unknown" }), close: async () => {} }) });
    const request = { requestId: "owner.loss:1", project, cwd: project, role: "manufacture", instruction: "編集", skill: "kiro-implement", taskId: "4.5-owner-loss", access: "workspace-write" };
    const storeRequest = { requestId: request.requestId, project, cwd: project, skill: request.skill, taskId: request.taskId };
    const reservation = await store.reserve(storeRequest);
    assert.equal(reservation.kind, "created");
    assert.equal(await store.recordOwner({ requestId: request.requestId, project, cwd: project, skill: request.skill, taskId: request.taskId,
      generation: reservation.record.generation, pid: 12345, now: 10 }), true);
    const deadOwner = makeWorker(11, async () => false);
    assert.deepEqual(await deadOwner.controlTarget({ requestId: request.requestId, project, cwd: project, skill: request.skill, taskId: request.taskId }),
      { kind: "unavailable", reason: "制御所有者を確認できません。終了を確認できません。確認または停止してから再実行してください" });
    assert.deepEqual(await store.reserve({ requestId: "owner.loss:2", project, cwd: project, skill: request.skill, taskId: request.taskId }),
      { kind: "blocked", reason: "終了を確認できません。確認または停止してから再実行してください" });
    assert.equal(starts, 0);

    const heartbeatRequest = { ...request, requestId: "owner.ttl:1", taskId: "4.5-owner-ttl" };
    const heartbeatStoreRequest = { requestId: heartbeatRequest.requestId, project, cwd: project, skill: request.skill, taskId: heartbeatRequest.taskId };
    const heartbeatReservation = await store.reserve(heartbeatStoreRequest);
    assert.equal(await store.recordOwner({ requestId: heartbeatRequest.requestId, project, cwd: project, skill: request.skill, taskId: heartbeatRequest.taskId,
      generation: heartbeatReservation.record.generation, pid: 12345, now: 10 }), true);
    const staleOwner = makeWorker(10 + 120001, async () => true);
    assert.deepEqual(await staleOwner.controlTarget({ requestId: heartbeatRequest.requestId, project, cwd: project, skill: request.skill, taskId: heartbeatRequest.taskId }),
      { kind: "unavailable", reason: "制御所有者を確認できません。終了を確認できません。確認または停止してから再実行してください" });
    assert.deepEqual(await store.reserve({ requestId: "owner.ttl:2", project, cwd: project, skill: request.skill, taskId: heartbeatRequest.taskId }),
      { kind: "blocked", reason: "終了を確認できません。確認または停止してから再実行してください" });
    assert.equal(starts, 0);

    const readOnly = { ...request, requestId: "owner.readonly:1", taskId: "4.5-owner-readonly", access: "read-only" };
    const readOnlyStoreRequest = { requestId: readOnly.requestId, project, cwd: project, skill: readOnly.skill, taskId: readOnly.taskId };
    const tracked = await store.track(readOnlyStoreRequest);
    assert.equal(tracked.kind, "tracked");
    assert.equal(await store.recordOwner({ requestId: readOnly.requestId, project, cwd: project, skill: readOnly.skill, taskId: readOnly.taskId,
      generation: tracked.record.generation, pid: 12345, now: 10 }), true);
    assert.equal((await makeWorker(120011, async () => false).controlTarget({ requestId: readOnly.requestId, project, cwd: project, skill: readOnly.skill, taskId: readOnly.taskId })).kind, "unavailable");
    assert.equal((await store.track({ ...readOnlyStoreRequest, requestId: "owner.readonly:2" })).kind, "tracked", "read-only 再試行は unknown 制御記録で妨げない");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("実 store と worker は接続断の状態照会を unknown として所有を維持する", async () => {
  const base = await mkdtemp(join(tmpdir(), "delegation-connection-lost-"));
  const project = join(base, "project"), root = join(base, "runtime");
  await Promise.all([mkdir(project), mkdir(root, { mode: 0o700 })]);
  try {
    const store = createDelegationJobStore({ root, writableRoots: [project], resolveWorktreeRoot: async () => project });
    let starts = 0, closes = 0;
    const worker = createJobWorker({ store, now: () => 10, isAlive: async () => true,
      select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }),
      connect: async () => ({ capabilities: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: "workspace-write", effort: "high" }] }] }),
        models: async () => ["m"], start: async () => { starts++; return { kind: "started", job: { serverId: "s", connectionId: "c", jobId: "connection-lost" } }; },
        status: async () => { throw new Error("connection lost"); }, stop: async () => { throw new Error("connection lost"); }, close: async () => { closes++; } }) });
    const request = { requestId: "connection.lost:1", project, cwd: project, role: "manufacture", instruction: "編集", skill: "kiro-implement", taskId: "4.5-connection", access: "workspace-write" };
    assert.equal((await worker.start(request)).kind, "started");
    assert.deepEqual(await worker.status("connection-lost"), { status: "unknown", reason: "同じ接続から状態を確認できません" });
    assert.equal(worker.isBusy(), true, "接続断でも worker の所有を保持する");
    assert.equal(closes, 0, "終了不明の接続を閉じない");
    assert.deepEqual(await store.reserve({ requestId: "connection.lost:2", project, cwd: project, skill: request.skill, taskId: request.taskId }),
      { kind: "blocked", reason: "終了を確認できません。確認または停止してから再実行してください" });
    assert.equal(starts, 1);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("read-only control record accepts owner and terminal state, then returns the terminal result", async () => {
  const base = await mkdtemp(join(tmpdir(), "delegation-terminal-red-"));
  const project = join(base, "project"), root = join(base, "runtime");
  await Promise.all([mkdir(project), mkdir(root, { mode: 0o700 })]);
  try {
    const store = createDelegationJobStore({ root, writableRoots: [project], resolveWorktreeRoot: async () => project });
    const input = { requestId: "read.only:4.5", project, cwd: project, skill: "kiro-implement", taskId: "4.5" };
    const tracked = await store.track(input);
    assert.equal(tracked.kind, "tracked");
    const owner = { ...input, generation: tracked.record.generation, pid: process.pid, now: 10 };
    assert.equal(await store.recordOwner(owner), true);
    const terminal = { ...input, generation: tracked.record.generation, status: "succeeded", summary: "完了", now: 20 };
    assert.equal(await store.recordTerminal(terminal), true);
    assert.deepEqual(await store.inspectOwner({ ...input, generation: tracked.record.generation, now: 21, heartbeatTtlMs: 5, isAlive: () => false }),
      { kind: "terminal", result: { status: "succeeded", summary: "完了", at: 20 } });
    assert.deepEqual(await store.track(input), { kind: "existing", status: "terminal", result: { status: "succeeded", summary: "完了", at: 20 } });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("実 worker は read-only 終端を保存し、後続照会で記録結果を返す", async () => {
  const base = await mkdtemp(join(tmpdir(), "delegation-terminal-worker-"));
  const project = join(base, "project"), root = join(base, "runtime");
  await Promise.all([mkdir(project), mkdir(root, { mode: 0o700 })]);
  try {
    const store = createDelegationJobStore({ root, writableRoots: [project], resolveWorktreeRoot: async () => project });
    const request = { requestId: "readonly.terminal:1", project, cwd: project, role: "review", instruction: "確認", skill: "kiro-implement", taskId: "4.5", access: "read-only" };
    let starts = 0;
    const makeWorker = () => createJobWorker({ store, now: () => 30, isAlive: async () => true,
      select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "read-only", effort: "medium" }),
      connect: async () => ({ capabilities: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: "read-only", effort: "medium" }] }] }),
        models: async () => ["m"], start: async () => { starts++; return { kind: "started", job: { serverId: "s", connectionId: "c", jobId: "read-job" } }; },
        status: async () => ({ status: "succeeded", output: "完了" }), stop: async () => ({ status: "stopped" }), close: async () => {} }) });
    const first = makeWorker();
    assert.equal((await first.start(request)).kind, "started");
    assert.deepEqual(await first.status("read-job"), { status: "succeeded", output: "完了" });
    const second = makeWorker();
    assert.deepEqual(await second.start(request), { kind: "terminal", result: { status: "succeeded", summary: "完了", at: 30 } });
    assert.equal(starts, 1, "終端記録がある依頼は再起動しない");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("書き込み終端は後続の制御先照会へ結果を返す", async () => {
  const base = await mkdtemp(join(tmpdir(), "delegation-write-terminal-"));
  const project = join(base, "project"), root = join(base, "runtime");
  await Promise.all([mkdir(project), mkdir(root, { mode: 0o700 })]);
  try {
    const store = createDelegationJobStore({ root, writableRoots: [project], resolveWorktreeRoot: async () => project });
    let starts = 0;
    const makeWorker = () => createJobWorker({ store, now: () => 42, select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }),
      connect: async () => ({ capabilities: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: "workspace-write", effort: "high" }] }] }),
        models: async () => ["m"], start: async () => { starts++; return { kind: "started", job: { serverId: "s", connectionId: "c", jobId: "write-terminal" } }; },
        status: async () => ({ status: "succeeded", output: "書き込み完了" }), stop: async () => ({ status: "stopped" }), close: async () => {} }) });
    const request = { requestId: "write.terminal", project, cwd: project, role: "manufacture", instruction: "編集", skill: "kiro-implement", taskId: "4.5-write", access: "workspace-write" };
    const first = makeWorker();
    assert.equal((await first.start(request)).kind, "started");
    assert.deepEqual(await first.status("write-terminal"), { status: "succeeded", output: "書き込み完了" });
    const later = makeWorker();
    assert.deepEqual(await later.controlTarget({ requestId: request.requestId, project, cwd: project, skill: request.skill, taskId: request.taskId }),
      { kind: "terminal", result: { status: "succeeded", summary: "書き込み完了", at: 42 } });
    assert.equal((await later.start(request)).kind, "terminal");
    assert.equal(starts, 1);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("制御先の読み取り間に終端へ遷移した場合は記録済み結果を返す", async () => {
  const generation = "b".repeat(32);
  const request = { requestId: "control.race", project: "/project", cwd: "/project", skill: "kiro-implement", taskId: "4.5" };
  let inspections = 0;
  const worker = createJobWorker({ store: {
    reserve: async () => ({ kind: "created" }), markUnknown: async () => true,
    resolveControlTarget: async () => ({ generation, controlDirectory: `control-${generation}` }),
    inspectOwner: async () => { inspections++; return { kind: "terminal", result: { status: "succeeded", summary: "完了", at: 45 } }; },
  }, now: () => 45,
    select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }),
    connect: async () => ({ capabilities: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: "workspace-write", effort: "high" }] }] }),
      models: async () => ["m"], start: async () => ({ kind: "not-started", reason: "未使用" }), status: async () => ({ status: "unknown" }), stop: async () => ({ status: "unknown" }), close: async () => {} }),
  });
  assert.deepEqual(await worker.controlTarget(request),
    { kind: "terminal", result: { status: "succeeded", summary: "完了", at: 45 } },
    "inspectOwner が確認した終端結果を返す");
  assert.equal(inspections, 1, "依存検証を通過して inspectOwner を呼び出す");
});

test("不正な所有者応答は制御先として返さない", async () => {
  const generation = "c".repeat(32);
  const request = { requestId: "control.invalid-owner", project: "/project", cwd: "/project", skill: "kiro-implement", taskId: "4.5" };
  for (const owner of [null, { kind: "alive", extra: true }, { kind: "unknown-kind" }, { kind: "terminal", result: { status: "succeeded", summary: "完了", at: 45, extra: true } }, { kind: "lost", reason: "期限切れ", extra: true }]) {
    let inspections = 0;
    const worker = createJobWorker({ store: { reserve: async () => ({ kind: "created" }), markUnknown: async () => true,
      resolveControlTarget: async () => ({ generation, controlDirectory: `control-${generation}` }), inspectOwner: async () => { inspections++; return owner; } }, now: () => 45,
      select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }),
      connect: async () => ({ capabilities: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: "workspace-write", effort: "high" }] }] }),
        models: async () => ["m"], start: async () => ({ kind: "not-started", reason: "未使用" }), status: async () => ({ status: "unknown" }), stop: async () => ({ status: "unknown" }), close: async () => {} }),
    });
    const result = await worker.controlTarget(request);
    assert.equal(result.kind, "unavailable", `不正な所有者応答を拒否する: ${JSON.stringify(owner)}`);
    assert.equal(inspections, 1, "依存検証を通過して inspectOwner の応答を検証する");
  }
});

test("シンボリックリンク表記の作業先でも書き込み終端を保存し後続照会へ返す", async () => {
  const base = await mkdtemp(join(tmpdir(), "delegation-symlink-terminal-"));
  const project = join(base, "project"), alias = join(base, "project-alias"), root = join(base, "runtime");
  await Promise.all([mkdir(project), mkdir(root, { mode: 0o700 })]);
  await symlink(project, alias, "dir");
  try {
    const store = createDelegationJobStore({ root, writableRoots: [project], resolveWorktreeRoot: async () => project });
    let starts = 0, closes = 0;
    const makeWorker = () => createJobWorker({ store, now: () => 52,
      select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }),
      connect: async () => ({ capabilities: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: "workspace-write", effort: "high" }] }] }),
        models: async () => ["m"], start: async () => { starts++; return { kind: "started", job: { serverId: "s", connectionId: "c", jobId: "symlink-write" } }; },
        status: async () => ({ status: "succeeded", output: "完了" }), stop: async () => ({ status: "stopped" }), close: async () => { closes++; } }) });
    const request = { requestId: "symlink.terminal", project: alias, cwd: alias, role: "manufacture", instruction: "編集", skill: "kiro-implement", taskId: "4.5-symlink", access: "workspace-write" };
    const first = makeWorker();
    assert.equal((await first.start(request)).kind, "started");
    assert.deepEqual(await first.status("symlink-write"), { status: "succeeded", output: "完了" });
    const later = makeWorker();
    assert.deepEqual(await later.controlTarget({ requestId: request.requestId, project: alias, cwd: alias, skill: request.skill, taskId: request.taskId }),
      { kind: "terminal", result: { status: "succeeded", summary: "完了", at: 52 } });
    assert.equal((await later.start(request)).kind, "terminal");
    assert.equal(starts, 1, "終端済み書き込みを再起動しない");
    assert.equal(closes, 1, "終端保存後に所有接続を終了する");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("実 worker は送信後不明の書き込みを別依頼 ID でも再起動しない", async () => {
  const base = await mkdtemp(join(tmpdir(), "delegation-unknown-worker-"));
  const project = join(base, "project"), root = join(base, "runtime");
  await Promise.all([mkdir(project), mkdir(root, { mode: 0o700 })]);
  try {
    const store = createDelegationJobStore({ root, writableRoots: [project], resolveWorktreeRoot: async () => project });
    let starts = 0;
    const makeWorker = () => createJobWorker({ store, now: Date.now,
      select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }),
      connect: async () => ({ capabilities: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: "workspace-write", effort: "high" }] }] }),
        models: async () => ["m"], start: async () => { starts++; return { kind: "unknown", reason: "応答欠落" }; },
        status: async () => ({ status: "unknown" }), stop: async () => ({ status: "unknown" }), close: async () => {} }) });
    const baseRequest = { project, cwd: project, role: "manufacture", instruction: "編集", skill: "kiro-implement", taskId: "4.5", access: "workspace-write" };
    assert.equal((await makeWorker().start({ ...baseRequest, requestId: "write.unknown:1" })).kind, "pending");
    const retry = await makeWorker().start({ ...baseRequest, requestId: "write.unknown:2" });
    assert.equal(retry.kind, "unavailable");
    assert.match(retry.reasons.join(" "), /終了を確認できません/);
    assert.equal(starts, 1, "不明な先行書き込みの後に候補を起動しない");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("本番 worker 入口は realpath 正規化後の実 store に書き込み再送を結び付ける", async () => {
  const base = await mkdtemp(join(tmpdir(), "delegation-entry-symlink-"));
  const project = join(base, "project"), alias = join(base, "alias"), root = join(base, "runtime");
  await Promise.all([mkdir(project), mkdir(root, { mode: 0o700 })]); await symlink(project, alias, "dir");
  try {
    let starts = 0;
    const invoke = async (path, requestId) => {
      const stdin = new EventEmitter(); stdin.setEncoding = () => {}; stdin.off = stdin.removeListener.bind(stdin);
      const stdout = new EventEmitter(); stdout.write = () => true;
      const request = { requestId, project: path, cwd: path, role: "manufacture", instruction: "編集", skill: "kiro-implement", taskId: "4.5-entry", access: "workspace-write" };
      const running = runWorkerProcess({ stdin, stdout, deps: { createWorker: async (normalized) => {
        const store = createDelegationJobStore({ root: join(root, createHash("sha256").update(normalized.project).digest("hex").slice(0, 24)), writableRoots: [normalized.project], resolveWorktreeRoot: async () => project });
        return createJobWorker({ store, now: Date.now, select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }), connect: async () => ({
          capabilities: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: "workspace-write", effort: "high" }] }] }), models: async () => ["m"],
          start: async () => { starts++; return { kind: "started", job: { serverId: "s", connectionId: "c", jobId: requestId } }; }, status: async () => ({ status: "succeeded", output: "完了" }), stop: async () => ({ status: "stopped" }), close: async () => {} }) });
      } } });
      await new Promise((resolve) => setImmediate(resolve)); stdin.emit("data", `${JSON.stringify(request)}\n`); stdin.emit("end"); await running;
    };
    await invoke(project, "entry.real:1"); await invoke(alias, "entry.alias:2");
    assert.equal(starts, 1, "別表記・別依頼 ID でも同じ未確定書き込みを再起動しない");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("recordTerminal が失敗したら worker は所有者を維持して unknown を返す", async () => {
  let closed = 0;
  const store = { reserve: async () => ({ kind: "created", record: { generation: "a".repeat(32), requestIds: ["terminal-fail"] } }),
    recordOwner: async () => true, recordTerminal: async () => false, markUnknown: async () => true };
  const worker = createJobWorker({ store, now: Date.now,
    select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }),
    connect: async () => ({ capabilities: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: "workspace-write", effort: "high" }] }] }),
      models: async () => ["m"], start: async () => ({ kind: "started", job: { serverId: "s", connectionId: "c", jobId: "j" } }),
      status: async () => ({ status: "succeeded" }), stop: async () => ({ status: "unknown" }), close: async () => { closed++; } }) });
  const project = "/tmp/terminal-fail-project";
  const request = { requestId: "terminal-fail", project, cwd: project, role: "manufacture", instruction: "作業", skill: "kiro-implement", taskId: "4.5", access: "workspace-write" };
  assert.equal((await worker.start(request)).kind, "started");
  assert.equal((await worker.status("j")).status, "unknown");
  assert.equal(worker.isBusy(), true);
  assert.equal(closed, 0, "保存失敗時に接続所有を閉じない");
});

test("未知または非終端の store 結果は書き込み・read-only の再照会で公開せず再起動しない", async () => {
  const project = "/tmp/terminal-allowlist-project";
  const request = { requestId: "terminal.allowlist", project, cwd: project, role: "manufacture", instruction: "編集", skill: "kiro-implement", taskId: "4.5-allowlist", access: "workspace-write" };
  const invalidResults = [null, { status: "running", summary: "未完了", at: 1 }, { status: "succeeded", summary: "完了", at: 1, extra: true }];
  for (const result of invalidResults) {
    let starts = 0, connects = 0;
    const makeWorker = (readOnly) => createJobWorker({ now: () => 10,
      select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: readOnly ? "read-only" : "workspace-write", effort: "high" }),
      connect: async () => { connects++; return { capabilities: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: readOnly ? "read-only" : "workspace-write", effort: "high" }] }] }), models: async () => ["m"], start: async () => { starts++; return { kind: "started", job: { serverId: "s", connectionId: "c", jobId: "j" } }; }, status: async () => ({ status: "running" }), stop: async () => ({ status: "unknown" }), close: async () => {} }; },
      store: { reserve: async () => ({ kind: "existing", status: "terminal", result }), track: async () => ({ kind: "existing", status: "terminal", result, record: { generation: "a".repeat(32), controlDirectory: `control-${"a".repeat(32)}` } }), markUnknown: async () => true },
    });
    const writeResult = await makeWorker(false).start(request);
    assert.notEqual(writeResult.kind, "terminal", `書き込みの不正記録を終端として公開しない: ${JSON.stringify(result)}`);
    assert.equal(starts, 0, "不正記録のために同じ作業を再起動しない");
    const readResult = await makeWorker(true).start({ ...request, access: "read-only" });
    assert.notEqual(readResult.kind, "terminal", `read-only の不正記録を終端として公開しない: ${JSON.stringify(result)}`);
    assert.equal(starts, 0);
    assert.ok(connects <= invalidResults.indexOf(result) + 1, "不正な既存結果の検証後に余分な接続を保持しない");
  }
});

test("実ストアの永続化拒否を recordOwner と recordTerminal の失敗として扱う", async () => {
  const base = await mkdtemp(join(tmpdir(), "delegation-ledger-blocked-"));
  const project = join(base, "project"), root = join(base, "runtime");
  await Promise.all([mkdir(project), mkdir(root, { mode: 0o700 })]);
  try {
    const store = createDelegationJobStore({ root, writableRoots: [project], resolveWorktreeRoot: async () => project });
    const input = { requestId: "blocked.owner", project, cwd: project, skill: "kiro-implement", taskId: "4.5-owner" };
    const reservation = await store.reserve(input);
    await (await import("node:fs/promises")).writeFile(join(root, "jobs.json"), "broken");
    const ownerResult = await store.recordOwner({ ...input, generation: reservation.record.generation, pid: process.pid, now: 1 });
    assert.equal(ownerResult, false, "{kind:'blocked'} を保存成功として扱わない");
    const terminalResult = await store.recordTerminal({ ...input, generation: reservation.record.generation, status: "succeeded", summary: "完了", now: 2 });
    assert.equal(terminalResult, false, "終端記録の {kind:'blocked'} も保存失敗として扱う");

    let closed = 0;
    const workerStore = {
      ...store,
      reserve: async () => ({ kind: "created", record: { generation: "b".repeat(32), requestIds: [input.requestId] } }),
      recordOwner: async () => ({ kind: "blocked", reason: "破損" }),
      recordTerminal: async () => ({ kind: "blocked", reason: "破損" }),
      markUnknown: async () => ({ kind: "blocked", reason: "破損" }),
    };
    const worker = createJobWorker({ store: workerStore, now: () => 10, select: async () => ({ kind: "mcp", candidate: {}, model: "m", access: "workspace-write", effort: "high" }),
      connect: async () => ({ capabilities: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [{ id: "m", accepted: [{ access: "workspace-write", effort: "high" }] }] }),
        models: async () => ["m"], start: async () => ({ kind: "started", job: { serverId: "s", connectionId: "c", jobId: "blocked-job" } }),
        status: async () => ({ status: "succeeded" }), stop: async () => ({ status: "unknown" }), close: async () => { closed++; } }) });
    assert.equal((await worker.start({ ...input, role: "manufacture", instruction: "編集", access: "workspace-write" })).kind, "pending");
    assert.equal((await worker.status("blocked-job")).status, "unknown");
    assert.equal(worker.isBusy(), true);
    assert.equal(closed, 0, "記録できない終端では接続所有を維持する");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("store は各操作で未定義キーとその操作の不正型を拒否する", async () => {
  const base = await mkdtemp(join(tmpdir(), "delegation-store-allowlist-"));
  const project = join(base, "project"), root = join(base, "runtime");
  await Promise.all([mkdir(project), mkdir(root, { mode: 0o700 })]);
  try {
    const store = createDelegationJobStore({ root, writableRoots: [project], resolveWorktreeRoot: async () => project });
    const input = { requestId: "allowlist", project, cwd: project, skill: "kiro-implement", taskId: "4.5-keys" };
    assert.equal((await store.reserve({ ...input, now: "不正型" })).kind, "blocked", "reserve は now を許可しない");
    assert.equal((await store.track({ ...input, generation: "a".repeat(32) })).kind, "blocked", "track は generation を許可しない");
    const reserved = await store.reserve(input);
    assert.equal(await store.recordOwner({ ...input, generation: reserved.record.generation, pid: process.pid, now: 1, summary: "不許可" }), false);
    assert.equal(await store.heartbeat({ ...input, generation: reserved.record.generation, now: 2, pid: 1 }), false);
    assert.equal(await store.recordTerminal({ ...input, generation: reserved.record.generation, status: "succeeded", summary: "x", now: 3, reason: "不許可" }), false);
    assert.equal((await store.resolveControlTarget({ ...input, reason: "不許可" })).kind, "blocked");
  } finally { await rm(base, { recursive: true, force: true }); }
});
