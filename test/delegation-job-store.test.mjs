import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelegationJobStore } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-store.mjs";

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "delegation-job-store-"));
  const project = join(base, "project"), writable = join(base, "writable"), runtime = join(base, "runtime");
  await Promise.all([mkdir(project), mkdir(writable)]);
  const resolveWorktreeRoot = async () => project;
  return { base, project, writable, runtime, resolveWorktreeRoot,
    store: createDelegationJobStore({ root: runtime, writableRoots: [writable], resolveWorktreeRoot }) };
}

test("same work resend under another request ID attaches exclusively to original record", async () => {
  const f = await fixture();
  try {
    const first = await f.store.reserve({ requestId: "req-1", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2" });
    const second = await f.store.reserve({ requestId: "req-2", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2" });
    assert.equal(first.kind, "created");
    assert.equal(second.kind, "existing");
    assert.equal(second.record.requestId, "req-1");
    assert.deepEqual(second.record.requestIds, ["req-1", "req-2"]);
    assert.equal(await f.store.markUnknown({ requestId: "req-2", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2" }), true);
    assert.equal((await f.store.reserve({ requestId: "req-3", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2" })).kind, "blocked");
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("terminal と owner を記録し、後続照会と unknown の書き込み再送を安全に扱う", async () => {
  const f = await fixture();
  try {
    const input = { requestId: "terminal-a", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.5-terminal" };
    const created = await f.store.reserve(input);
    const generation = created.record.generation;
    assert.equal(await f.store.recordOwner({ requestId: input.requestId, project: input.project, cwd: input.cwd, skill: input.skill, taskId: input.taskId, generation, pid: 987654321, now: 10 }), true);
    assert.equal(await f.store.heartbeat({ ...input, generation, now: 20 }), true);
    assert.deepEqual(await f.store.inspectOwner({ ...input, generation, now: 21, heartbeatTtlMs: 5, isAlive: () => true }), { kind: "alive" });
    const terminal = { ...input, generation, status: "succeeded", summary: "完了", now: 30 };
    assert.equal(await f.store.recordTerminal(terminal), true);
    assert.deepEqual(await f.store.inspectOwner({ ...input, generation, now: 31, heartbeatTtlMs: 5, isAlive: () => false }), { kind: "terminal", result: { status: "succeeded", summary: "完了", at: 30 } });
    assert.deepEqual(await f.store.reserve({ ...input, requestId: "terminal-b" }), { kind: "existing", status: "terminal", result: { status: "succeeded", summary: "完了", at: 30 } });
    assert.deepEqual(await f.store.resolveControlTarget({ ...input, requestId: "terminal-b" }), { kind: "terminal", result: { status: "succeeded", summary: "完了", at: 30 } });
    assert.equal(await f.store.markUnknown({ ...input, reason: "秘密指示は含めない" }), false);
    assert.equal((await f.store.reserve({ ...input, requestId: "terminal-c" })).status, "terminal");
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("unknown は書き込み再送を別依頼 ID でも止め、read-only track は許可する", async () => {
  const f = await fixture();
  try {
    const input = { requestId: "unknown-a", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.5-unknown" };
    const record = (await f.store.reserve(input)).record;
    assert.equal(await f.store.recordOwner({ ...input, generation: record.generation, pid: 987654321, now: 1 }), true);
    assert.equal(await f.store.markUnknown({ ...input, reason: "connection lost" }), true);
    assert.deepEqual(await f.store.reserve({ ...input, requestId: "unknown-b" }), { kind: "blocked", reason: "終了を確認できません。確認または停止してから再実行してください" });
    assert.equal((await f.store.track({ ...input, requestId: "readonly-retry" })).kind, "tracked");
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("稼働中の書き込み予約と同じ依頼 ID への read-only track は制御先を変更しない", async () => {
  const f = await fixture();
  try {
    const input = { requestId: "shared-id", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.4" };
    const write = await f.store.reserve(input);
    assert.equal(write.kind, "created");
    const tracked = await f.store.track(input);
    assert.equal(tracked.kind, "blocked", "稼働中の書き込み依頼 ID を追跡登録しない");
    const target = await f.store.resolveControlTarget(input);
    assert.equal(target.generation, write.record.generation, "元の書き込み世代を保持する");
    assert.equal(target.controlDirectory, write.record.controlDirectory);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("read-only track 後の同じ依頼 ID の書き込み予約は拒否し、元の制御先を保つ", async () => {
  const f = await fixture();
  try {
    const input = { requestId: "shared-readonly-id", project: f.project, cwd: f.project, skill: "kiro-review", taskId: "4.4" };
    const tracked = await f.store.track(input);
    assert.equal(tracked.kind, "tracked");
    const reservation = await f.store.reserve(input);
    assert.equal(reservation.kind, "blocked", "read-only 追跡と衝突する書き込み予約を拒否する");
    const target = await f.store.resolveControlTarget(input);
    assert.equal(target.generation, tracked.record.generation, "拒否後も元の read-only 所有世代を保持する");
    assert.equal(target.controlDirectory, tracked.record.controlDirectory);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("owner updates reject mismatched request, work identity, and generation without changing records", async () => {
  const f = await fixture();
  try {
    const write = { requestId: "owner-a", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.5-owner" };
    const reserved = (await f.store.reserve(write)).record;
    await f.store.reserve({ ...write, requestId: "owner-b" });
    const read = { requestId: "owner-read", project: f.project, cwd: f.project, skill: "kiro-review", taskId: "4.5-read" };
    const tracked = (await f.store.track(read)).record;
    const owner = (request, generation) => ({ requestId: request.requestId, project: request.project, cwd: request.cwd, skill: request.skill, taskId: request.taskId, generation, now: 10 });
    assert.equal(await f.store.recordOwner({ ...owner({ ...write, requestId: "outsider" }, reserved.generation), pid: 123 }), false);
    assert.equal(await f.store.recordOwner({ ...owner({ ...read, taskId: "other-task" }, tracked.generation), pid: 123 }), false);
    assert.equal(await f.store.recordOwner({ ...owner(read, "0".repeat(32)), pid: 123 }), false);
    assert.equal(await f.store.heartbeat({ ...owner({ ...write, requestId: "outsider" }, reserved.generation), now: 20 }), false);
    assert.equal(await f.store.heartbeat({ ...owner({ ...read, skill: "kiro-implement" }, tracked.generation), now: 20 }), false);
    assert.equal(await f.store.recordTerminal({ ...owner({ ...write, requestId: "outsider" }, reserved.generation), status: "succeeded", summary: "誤", now: 30 }), false);
    assert.equal(await f.store.recordTerminal({ ...owner({ ...read, taskId: "other-task" }, tracked.generation), status: "succeeded", summary: "誤", now: 30 }), false);
    assert.equal(await f.store.recordOwner({ ...owner({ ...write, requestId: "owner-b" }, reserved.generation), pid: 123 }), true);
    assert.equal(await f.store.heartbeat({ ...owner(read, tracked.generation), now: 20 }), true);
    assert.equal(await f.store.recordTerminal({ ...owner(read, tracked.generation), status: "succeeded", summary: "正", now: 30 }), true);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("候補不在時に予約を解放すると同じ作業を再予約できる", async () => {
  const f = await fixture();
  try {
    const input = { requestId: "req-release", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.3" };
    assert.equal((await f.store.reserve(input)).kind, "created");
    assert.equal(await f.store.release(input), true);
    assert.equal((await f.store.reserve({ ...input, requestId: "req-retry" })).kind, "created");
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("並行再送 A→B の後に A を解放すると B が予約を引き継いで起動できる", async () => {
  const f = await fixture();
  try {
    const base = { project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.3-race" };
    assert.equal((await f.store.reserve({ ...base, requestId: "race-a" })).kind, "created");
    assert.equal((await f.store.reserve({ ...base, requestId: "race-b" })).kind, "existing");
    assert.equal(await f.store.release({ ...base, requestId: "race-a" }), true);
    const next = await f.store.reserve({ ...base, requestId: "race-b" });
    assert.equal(next.kind, "created", "解放された予約は代表の再送依頼が引き継ぐ");
    assert.deepEqual(next.record.requestIds, ["race-b"]);
    assert.equal((await f.store.reserve({ ...base, requestId: "race-c" })).kind, "existing", "B 実行中の C は保留される");
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("非代表 B の解放は A の reserved 状態を維持し、A 再送は existing になる", async () => {
  const f = await fixture();
  try {
    const base = { project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.3-nonrepresentative-release" };
    assert.equal((await f.store.reserve({ ...base, requestId: "A" })).kind, "created");
    assert.equal((await f.store.reserve({ ...base, requestId: "B" })).kind, "existing");
    assert.equal(await f.store.release({ ...base, requestId: "B" }), true);
    const retryA = await f.store.reserve({ ...base, requestId: "A" });
    assert.equal(retryA.kind, "existing", "B 解放後も A の予約を維持する");
    assert.equal(retryA.record.requestId, "A");
    assert.deepEqual(retryA.record.requestIds, ["A"]);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("A 解放後の B 解放は予約引き継ぎに横取りされず記録を削除する", async () => {
  const f = await fixture();
  try {
    const base = { project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.3-release-handoff" };
    assert.equal((await f.store.reserve({ ...base, requestId: "handoff-a" })).kind, "created");
    assert.equal((await f.store.reserve({ ...base, requestId: "handoff-b" })).kind, "existing");
    assert.equal(await f.store.release({ ...base, requestId: "handoff-a" }), true);
    assert.equal(await f.store.release({ ...base, requestId: "handoff-b" }), true);
    assert.equal((await f.store.reserve({ ...base, requestId: "handoff-c" })).kind, "created");
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("available 状態で markUnknown は予約引き継ぎに横取りされない", async () => {
  const f = await fixture();
  try {
    const base = { project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.3-unknown-handoff" };
    assert.equal((await f.store.reserve({ ...base, requestId: "unknown-a" })).kind, "created");
    assert.equal((await f.store.reserve({ ...base, requestId: "unknown-b" })).kind, "existing");
    assert.equal(await f.store.release({ ...base, requestId: "unknown-a" }), true);
    assert.equal(await f.store.markUnknown({ ...base, requestId: "unknown-b" }), true);
    assert.equal((await f.store.reserve({ ...base, requestId: "unknown-c" })).kind, "blocked");
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("request IDs inherited from Object.prototype are reserved, reused, and isolated by own keys", async () => {
  const f = await fixture();
  try {
    for (const requestId of ["constructor", "toString", "hasOwnProperty"]) {
      const taskId = `4.2-${requestId}`;
      const first = await f.store.reserve({ requestId, project: f.project, cwd: f.project, skill: "kiro-implement", taskId });
      assert.equal(first.kind, "created", `${requestId}: first reservation`);
      const resend = await f.store.reserve({ requestId, project: f.project, cwd: f.project, skill: "kiro-implement", taskId });
      assert.equal(resend.kind, "existing", `${requestId}: same work resend`);
      const reuse = await f.store.reserve({ requestId, project: f.project, cwd: f.project, skill: "kiro-review", taskId });
      assert.equal(reuse.kind, "blocked", `${requestId}: different work reuse`);
    }
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("controls は prototype 名の依頼 ID を JSON 再読込後も追跡できる", async () => {
  const f = await fixture();
  try {
    for (const requestId of ["constructor", "toString", "__proto__"]) {
      const input = { requestId, project: f.project, cwd: f.project, skill: "kiro-review", taskId: `4.4-${requestId}` };
      const first = await f.store.track(input);
      assert.equal(first.kind, "tracked", `${requestId}: 初回追跡`);
      const reloadedStore = createDelegationJobStore({ root: f.runtime, writableRoots: [f.writable], resolveWorktreeRoot: f.resolveWorktreeRoot });
      const second = await reloadedStore.track(input);
      assert.equal(second.kind, "existing", `${requestId}: 再読込後の重複追跡`);
      assert.equal(second.record.generation, first.record.generation, `${requestId}: 世代を保持`);
      assert.deepEqual(await reloadedStore.resolveControlTarget(input), {
        generation: first.record.generation, controlDirectory: first.record.controlDirectory,
      });
    }
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("malformed inputs, request ID reuse for different work, corrupt records, and unwritable runtime fail closed", async () => {
  const f = await fixture();
  try {
    for (const args of [null, [], { requestId: "x", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2", unexpected: true },
      { requestId: " ", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2" },
      { requestId: "x", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: " " }]) {
      assert.equal((await f.store.reserve(args)).kind, "blocked");
    }
    await f.store.reserve({ requestId: "same", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2" });
    assert.equal((await f.store.reserve({ requestId: "same", project: f.project, cwd: f.project, skill: "kiro-review", taskId: "4.2" })).kind, "blocked");
    await writeFile(join(f.runtime, "jobs.json"), "broken");
    assert.equal((await f.store.reserve({ requestId: "another", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2" })).kind, "blocked");
    const blocked = createDelegationJobStore({ root: join(f.base, "unwritable"), writableRoots: [f.writable], resolveWorktreeRoot: f.resolveWorktreeRoot });
    await writeFile(join(f.base, "unwritable"), "not a directory");
    assert.equal((await blocked.reserve({ requestId: "blocked", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2" })).kind, "blocked");
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("rejects malformed factory options and detects tampered work keys and independent paths", async () => {
  const f = await fixture();
  try {
    assert.doesNotThrow(() => createDelegationJobStore(null));
    const workspace = join(f.base, "workspace");
    await mkdir(workspace);
    const adjacent = createDelegationJobStore({ root: f.runtime, writableRoots: [workspace], resolveWorktreeRoot: f.resolveWorktreeRoot });
    assert.equal((await adjacent.reserve({ requestId: "path-ok", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2" })).kind, "created");
    const key = (await import("node:crypto")).createHash("sha256").update(`${f.project}\0kiro-implement\0${"4.2"}`).digest("hex");
    const forged = "f".repeat(64);
    const ledger = JSON.parse(await (await import("node:fs/promises")).readFile(join(f.runtime, "jobs.json"), "utf8"));
    ledger.records[forged] = ledger.records[key];
    delete ledger.records[key];
    ledger.requests["path-ok"] = forged;
    await writeFile(join(f.runtime, "jobs.json"), JSON.stringify(ledger));
    assert.equal((await adjacent.reserve({ requestId: "new-id", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2" })).kind, "blocked");
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("拒否: 実行時領域と作業ツリーが重なる場合は予約を作らない", async () => {
  const f = await fixture();
  try {
    const nestedRoot = createDelegationJobStore({ root: join(f.project, "runtime"), writableRoots: [f.writable], resolveWorktreeRoot: f.resolveWorktreeRoot });
    assert.equal((await nestedRoot.reserve({ requestId: "nested-root", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2" })).kind, "blocked");
    const nestedProject = join(f.base, "nested-project");
    await mkdir(nestedProject);
    const parentRoot = createDelegationJobStore({ root: f.base, writableRoots: [f.writable], resolveWorktreeRoot: f.resolveWorktreeRoot });
    assert.equal((await parentRoot.reserve({ requestId: "nested-project", project: nestedProject, cwd: nestedProject, skill: "kiro-implement", taskId: "4.2" })).kind, "blocked");
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("拒否: 型が壊れた既存台帳は新規予約を作らない", async () => {
  const f = await fixture();
  try {
    const created = await f.store.reserve({ requestId: "valid-record", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2" });
    const ledgerPath = join(f.runtime, "jobs.json");
    const ledger = JSON.parse(await (await import("node:fs/promises")).readFile(ledgerPath, "utf8"));
    ledger.records[Object.keys(ledger.records)[0]].skill = [];
    await writeFile(ledgerPath, JSON.stringify(ledger));
    assert.equal(created.kind, "created");
    assert.equal((await f.store.reserve({ requestId: "new-request", project: f.project, cwd: f.project, skill: "kiro-review", taskId: "4.2" })).kind, "blocked");
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("valid request identifiers are tied to canonical worktree, skill, and task", async () => {
  const f = await fixture();
  try {
    const first = await f.store.reserve({ requestId: "a", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2" });
    const differentTask = await f.store.reserve({ requestId: "b", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.3" });
    assert.equal(first.kind, "created");
    assert.equal(differentTask.kind, "created");
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("異なる依頼 ID と cwd でも project が同じなら先行作業へ束ねる", async () => {
  const f = await fixture();
  try {
    const nested = join(f.project, "src");
    await mkdir(nested);
    const first = await f.store.reserve({ requestId: "root-request", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2" });
    const resend = await f.store.reserve({ requestId: "nested-request", project: f.project, cwd: nested, skill: "kiro-implement", taskId: "4.2" });
    assert.equal(first.kind, "created");
    assert.equal(resend.kind, "existing");
    assert.deepEqual(resend.record.requestIds, ["root-request", "nested-request"]);
    await f.store.markUnknown({ requestId: "root-request", project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2" });
    assert.equal((await f.store.reserve({ requestId: "unknown-resend", project: f.project, cwd: nested, skill: "kiro-implement", taskId: "4.2" })).kind, "blocked");
    assert.equal((await f.store.reserve({ requestId: "outside", project: f.project, cwd: f.base, skill: "kiro-implement", taskId: "4.2" })).kind, "blocked");
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("project が cwd の git 作業ツリー正規ルートと一致しない場合は予約しない", async () => {
  const f = await fixture();
  try {
    const nested = join(f.project, "src");
    await mkdir(nested);
    const worktreeRoot = async () => f.project;
    const store = createDelegationJobStore({ root: f.runtime, writableRoots: [f.writable], resolveWorktreeRoot: worktreeRoot });
    const mismatches = await store.reserve({ requestId: "ancestor", project: f.base, cwd: nested, skill: "kiro-implement", taskId: "4.2" });
    assert.equal(mismatches.kind, "blocked");
    const created = await store.reserve({ requestId: "canonical", project: f.project, cwd: nested, skill: "kiro-implement", taskId: "4.2" });
    assert.equal(created.kind, "created");
    await store.markUnknown({ requestId: "canonical", project: f.project, cwd: nested, skill: "kiro-implement", taskId: "4.2" });
    const changedProject = await store.reserve({ requestId: "changed", project: nested, cwd: nested, skill: "kiro-implement", taskId: "4.2" });
    assert.equal(changedProject.kind, "blocked");
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("依頼記録は実 registry と実 Codex MCP の公開契約を通した実行文脈で作成できる", async () => {
  const { PassThrough } = await import("node:stream");
    const { listRegistrations, resolveRegistration } = await import("../.agent-hooks/cc-sdd-bootstrap/delegation-registry.mjs");
  const { serve } = await import("../.agent-hooks/cc-sdd-bootstrap/codex-agent-mcp.mjs");
  const f = await fixture();
  try {
    const registrations = await listRegistrations("claude", { cwd: f.project, run: async (_exe, args) =>
      args[1] === "list" ? "agent: Connected" : "Name: agent\nScope: User config\nType: stdio\nStatus: Connected\nCommand: node\nArgs: server.mjs" });
    assert.equal(registrations[0].status, "eligible");
    const registration = registrations[0];
    const saved = { family: "claude", scope: registration.scope, registrationName: registration.name, registrationId: registration.registrationId };
    assert.equal(resolveRegistration(registration, saved, { verifiedFamily: "claude" }).status, "eligible");
    const input = new PassThrough(), output = new PassThrough();
    let response = "";
    output.on("data", (chunk) => { response += chunk.toString(); });
    const serving = serve({ input, output, listModels: async () => [
      { model: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
    ] });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codex_capabilities", arguments: {} } })}\n`);
    input.end();
    await serving;
    assert.equal(JSON.parse(response.trim()).result.structuredContent.kind, "agent");
    const selection = JSON.parse(response.trim()).result.structuredContent;
    let launches = 0;
    const startIfReserved = async (requestId) => {
      const reservation = await f.store.reserve({ requestId, project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2" });
      if (reservation.kind === "created") launches += 1;
      return reservation;
    };
    const first = await startIfReserved("integrated-1");
    const resend = await startIfReserved("integrated-2");
    assert.equal(first.kind, "created");
    assert.equal(resend.kind, "existing");
    assert.equal(selection.kind, "agent");
    assert.equal(launches, 1);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("同じ作業への同時予約は一件だけを新規作成する", async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => f.store.reserve({
      requestId: `parallel-${index}`, project: f.project, cwd: f.project, skill: "kiro-implement", taskId: "4.2",
    })));
    assert.equal(results.filter((result) => result.kind === "created").length, 1);
    assert.equal(results.filter((result) => result.kind === "existing").length, 5);
    assert.equal(new Set(results.map((result) => result.record.generation)).size, 1);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});
