import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestControl, resolveControlTarget, serveControl } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-control.mjs";
import { createDelegationJobStore } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-store.mjs";

test("再送依頼 B は台帳の代表 A の制御先へ配送される", async () => {
  const root = await mkdtemp(join(tmpdir(), "delegation-control-resend-"));
  const project = join(root, "project"), runtime = join(root, "runtime"), writable = join(root, "writable");
  await Promise.all([mkdir(project), mkdir(writable)]);
  try {
    const store = createDelegationJobStore({ root: runtime, writableRoots: [writable], resolveWorktreeRoot: async () => project });
    const base = { project, cwd: project, skill: "kiro-implement", taskId: "4.4-resend" };
    const owner = await store.reserve({ ...base, requestId: "owner-A" });
    await store.reserve({ ...base, requestId: "resend-B" });
    const target = await resolveControlTarget({ store, ...base, requestId: "resend-B" });
    let called = 0;
    const server = await serveControl({ status: async (requestId) => { called++; assert.equal(requestId, "resend-B"); return { status: "running" }; }, stop: async () => ({ status: "stopped" }) },
      { root: runtime, requestId: "owner-A", controlDirectory: owner.record.controlDirectory, generation: owner.record.generation, acceptedRequestIds: ["resend-B"], pollIntervalMs: 5 });
    try {
      assert.deepEqual(await requestControl({ root: runtime, requestId: "resend-B", controlDirectory: target.controlDirectory, generation: target.generation, kind: "status", timeoutMs: 1000 }), { status: "running" });
      assert.equal(called, 1);
    } finally { await server.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("同じ読み取り専用依頼の再送は稼働中所有者を維持し照会と停止を配送する", async () => {
  const root = await mkdtemp(join(tmpdir(), "delegation-control-generation-"));
  const project = join(root, "project"), runtime = join(root, "runtime"), writable = join(root, "writable");
  await Promise.all([mkdir(project), mkdir(writable)]);
  try {
    const store = createDelegationJobStore({ root: runtime, writableRoots: [writable], resolveWorktreeRoot: async () => project });
    const request = { requestId: "same-readonly", project, cwd: project, skill: "kiro-implement", taskId: "4.4-restart" };
    const first = await store.track(request), second = await store.track(request);
    assert.equal(second.kind, "existing", "再送は新規追跡と区別される");
    assert.equal(second.record.generation, first.record.generation, "再送は稼働中の所有者世代を保持する");
    assert.equal(second.record.controlDirectory, first.record.controlDirectory, "再送は既存の制御ディレクトリを保持する");
    const calls = [];
    const server = await serveControl({ status: async (requestId) => { calls.push(["status", requestId]); return { status: "running" }; }, stop: async (requestId) => { calls.push(["stop", requestId]); return { status: "stopped" }; } },
      { root: runtime, requestId: "same-readonly", controlDirectory: first.record.controlDirectory, generation: first.record.generation, pollIntervalMs: 5 });
    try {
      const target = await resolveControlTarget({ store, ...request });
      assert.deepEqual(target, { generation: first.record.generation, controlDirectory: first.record.controlDirectory });
      assert.deepEqual(await requestControl({ root: runtime, requestId: "same-readonly", ...target, kind: "status", timeoutMs: 1000 }), { status: "running" });
      assert.deepEqual(await requestControl({ root: runtime, requestId: "same-readonly", ...target, kind: "stop", timeoutMs: 1000 }), { status: "stopped" });
      assert.deepEqual(calls, [["status", "same-readonly"], ["stop", "same-readonly"]]);
    } finally { await server.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("別プロセス worker の読み取り専用再送は新しい接続所有者を起動しない", { timeout: 10000 }, async () => {
  const { fork } = await import("node:child_process");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { createHash } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "delegation-control-owner-resend-"));
  const project = join(root, "project"), runtime = join(root, "runtime");
  await Promise.all([mkdir(project), mkdir(runtime)]);
  const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "delegation-control-worker.mjs");
  const request = { requestId: "same-readonly", project, cwd: project, role: "review", instruction: "inspect", skill: "kiro-implement", taskId: "4.4-owner", access: "read-only" };
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const owner = fork(fixture, [project], { env, execArgv: [], stdio: ["pipe", "pipe", "pipe", "ipc"] });
  const resend = fork(fixture, [project], { env, execArgv: [], stdio: ["pipe", "pipe", "pipe", "ipc"] });
  const childState = new Map();
  for (const child of [owner, resend]) {
    const state = { messages: [], exit: null, error: null };
    childState.set(child, state);
    child.on("message", (message) => { state.messages.push(message); });
    child.once("error", (error) => { state.error = error; });
    child.once("exit", (code, signal) => { state.exit = { code, signal }; });
  }
  const waitFor = (child, predicate, label, timeoutMs = 8000) => new Promise((resolve, reject) => {
    const state = childState.get(child);
    const found = state.messages.find(predicate);
    if (found) return resolve(found);
    if (state.error) return reject(state.error);
    if (state.exit) return reject(new Error(`${label}: worker exited before event: code=${state.exit.code} signal=${state.exit.signal}`));
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      error ? reject(error) : resolve(value);
    };
    const onMessage = (message) => { if (predicate(message)) finish(null, message); };
    const onExit = (code, signal) => finish(new Error(`${label}: worker exited before event: code=${code} signal=${signal}`));
    const onError = (error) => finish(error);
    const timer = setTimeout(() => finish(new Error(`${label}: event deadline exceeded`)), timeoutMs);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
  const waitForExit = (child, label, timeoutMs = 8000) => new Promise((resolve, reject) => {
    const state = childState.get(child);
    if (state.exit) return state.exit.code === 0 ? resolve(state.exit) : reject(new Error(`${label}: worker exited with ${state.exit.code}`));
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      error ? reject(error) : resolve(value);
    };
    const onExit = (code, signal) => code === 0 ? finish(null, { code, signal }) : finish(new Error(`${label}: worker exited with ${code}`));
    const timer = setTimeout(() => finish(new Error(`${label}: exit deadline exceeded`)), timeoutMs);
    child.once("exit", onExit);
  });
  const outputs = (child) => waitFor(child, (message) => message?.event === "output", "worker output").then((message) => JSON.parse(message.text.trim()));
  try {
    await Promise.all([waitFor(owner, (message) => message?.event === "ready", "owner ready"), waitFor(resend, (message) => message?.event === "ready", "resend ready")]);
    const firstOutput = outputs(owner);
    owner.send(request);
    const first = await firstOutput;
    assert.equal(first.kind, "started");
    const secondOutput = outputs(resend);
    resend.send(request);
    const second = await secondOutput;
    assert.equal(second.kind, "pending", `既存所有者がある再送を pending にする: 実際=${JSON.stringify(second)}`);
    assert.equal(second.job?.jobId, undefined);
    assert.equal(second.control?.generation, first.control?.generation);
    const rootPath = join(runtime, "cc-sdd-bootstrap", createHash("sha256").update(project).digest("hex").slice(0, 24));
    const controlArgs = { root: rootPath, requestId: request.requestId, controlDirectory: first.control.controlDirectory,
      generation: first.control.generation, timeoutMs: 3000 };
    assert.deepEqual(await requestControl({ ...controlArgs, kind: "status" }), { status: "running" });
    const stopped = waitFor(owner, (message) => message?.event === "stopped", "owner stopped");
    assert.deepEqual(await requestControl({ ...controlArgs, kind: "stop" }), { status: "stopped" });
    assert.equal((await stopped).event, "stopped");
    await Promise.all([waitForExit(owner, "owner"), waitForExit(resend, "resend")]);
  } finally {
    for (const child of [owner, resend]) child.disconnect();
    await rm(root, { recursive: true, force: true });
  }
});
