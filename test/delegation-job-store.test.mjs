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
