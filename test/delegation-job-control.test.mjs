import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { lstat, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requestControl, resolveControlTarget } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-control.mjs";
import { createDelegationJobStore } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workerEntry = join(here, "fixtures", "delegation-control-worker.mjs");
const input = (project, requestId = "request-alpha") => ({ requestId, project, cwd: project, role: "manufacture", instruction: "確認用", skill: "kiro-implement", taskId: "4.4", access: "workspace-write", candidates: [] });
const event = (child, name) => new Promise((resolve, reject) => {
  const onMessage = (message) => { if (message?.event === name) { cleanup(); resolve(message); } };
  const onExit = (code, signal) => { cleanup(); reject(new Error(`worker exited (${code ?? signal}) before ${name}`)); };
  const cleanup = () => { child.off("message", onMessage); child.off("exit", onExit); };
  child.on("message", onMessage); child.once("exit", onExit);
});
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  if (child.connected) child.disconnect();
  await exited;
}

test("別プロセス runWorkerProcess に status と stop を届け、終了確認後に stopped を返す", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "delegation-control-integration-"));
  const project = join(root, "project"), runtime = join(root, "runtime");
  await Promise.all([mkdir(project), mkdir(runtime)]);
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime, CONTROL_TEST_ROOT: runtime };
  const child = fork(workerEntry, [project], { env, execArgv: [], stdio: ["pipe", "pipe", "pipe", "ipc"] });
  let stdout = "";
  child.on("message", (message) => { if (message?.event === "output") stdout += message.text; });
  try {
    await event(child, "ready");
    child.send(input(project));
    child.send(input(project));
    const output = await event(child, "output"); stdout = output.text;
    const started = JSON.parse(stdout.trim());
    assert.equal(started.kind, "started");
    assert.notEqual(started.job.jobId, "request-alpha", "依頼 ID と jobId は別の識別子");
    const store = createDelegationJobStore({ root: join(runtime, "cc-sdd-bootstrap", (await import("node:crypto")).createHash("sha256").update(project).digest("hex").slice(0, 24)), writableRoots: [project], resolveWorktreeRoot: async () => project });
    await store.reserve({ requestId: "request-beta", project, cwd: project, skill: "kiro-implement", taskId: "4.4" });
    const target = await resolveControlTarget({ store, requestId: "request-beta", project, cwd: project, skill: "kiro-implement", taskId: "4.4" });
    assert.ok(target.generation, `control target unresolved: ${JSON.stringify(target)}`);
    assert.match(target.controlDirectory, /^control-/);
    const control = { root: join(runtime, "cc-sdd-bootstrap", (await import("node:crypto")).createHash("sha256").update(project).digest("hex").slice(0, 24)), requestId: "request-beta", controlDirectory: target.controlDirectory, generation: target.generation, timeoutMs: 3000 };
    assert.deepEqual(await requestControl({ ...control, kind: "status" }), { status: "running" });
    const stoppedEvent = event(child, "stopped");
    assert.deepEqual(await requestControl({ ...control, kind: "stop" }), { status: "stopped" });
    await stoppedEvent;
  } finally {
    await stopChild(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("期限切れ・別世代・重複 controlId・未知キーは実 worker を呼び出さない", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "delegation-control-files-"));
  const folder = join(root, "control-job");
  await mkdir(folder, { mode: 0o700 });
  let calls = 0;
  const worker = { status: async () => { calls++; return { status: "running" }; }, stop: async () => { calls++; return { status: "stopped" }; } };
  const { serveControl } = await import("../.agent-hooks/cc-sdd-bootstrap/delegation-job-control.mjs");
  const serving = await serveControl(worker, { root, requestId: "job", generation: "owner-generation", pollIntervalMs: 5 });
  const controlId = "abcdef01-1111-4111-8111-abcdefabcdef";
  const requests = [
    { requestId: "job", generation: "owner-generation", controlId, kind: "status", deadline: Date.now() - 1 },
    { requestId: "job", generation: "other-generation", controlId: "abcdef02-1111-4111-8111-abcdefabcdef", kind: "status", deadline: Date.now() + 1000 },
    { requestId: "job", generation: "owner-generation", controlId: "abcdef03-1111-4111-8111-abcdefabcdef", kind: "status", deadline: Date.now() + 1000 },
    { requestId: "job", generation: "owner-generation", controlId: "abcdef03-1111-4111-8111-abcdefabcdef", kind: "stop", deadline: Date.now() + 1000 },
    { requestId: "job", generation: "owner-generation", controlId: "abcdef04-1111-4111-8111-abcdefabcdef", kind: "status", deadline: Date.now() + 1000, extra: true },
  ];
  try {
    for (let i = 0; i < requests.length; i++) await writeFile(join(folder, `request-${String(i).padStart(32, "0")}.json`), JSON.stringify(requests[i]));
    let attempts = 0;
    while (((await readdir(folder)).some((name) => ["request-00000000000000000000000000000002.json", "request-00000000000000000000000000000003.json", "request-00000000000000000000000000000004.json"].includes(name) || name.endsWith(".claimed")) || calls === 0) && attempts++ < 10000) await new Promise((resolve) => setImmediate(resolve));
    const remaining = (await readdir(folder)).filter((name) => name.startsWith("request-"));
    assert.deepEqual(remaining.sort(), ["request-00000000000000000000000000000001.json"], "別世代要求を旧所有者が削除しない");
    assert.equal(calls, 1, "一意な有効 controlId は一度だけ worker を呼ぶ");
    assert.equal((await readdir(folder)).filter((name) => name.startsWith("response-")).length, 1, "有効要求だけに応答を生成する");
  } finally { await serving.close(); await rm(root, { recursive: true, force: true }); }
});

test("読み取り専用ジョブも別プロセスから制御でき、request ID の . と : を維持する", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "delegation-control-readonly-"));
  const project = join(root, "project"), runtime = join(root, "runtime");
  await Promise.all([mkdir(project), mkdir(runtime)]);
  const requestId = "readonly.task:4.4";
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime, CONTROL_TEST_ROOT: runtime };
  const child = fork(workerEntry, [project], { env, execArgv: [], stdio: ["pipe", "pipe", "pipe", "ipc"] });
  try {
    await event(child, "ready");
    child.send({ ...input(project, requestId), access: "read-only", readOnly: true });
    const output = await event(child, "output");
    assert.equal(JSON.parse(output.text.trim()).kind, "started");
    const store = createDelegationJobStore({ root: join(runtime, "cc-sdd-bootstrap", (await import("node:crypto")).createHash("sha256").update(project).digest("hex").slice(0, 24)), writableRoots: [project], resolveWorktreeRoot: async () => project });
    const target = await resolveControlTarget({ store, requestId, project, cwd: project, skill: "kiro-implement", taskId: "4.4" });
    assert.ok(target.generation, `読み取り専用の制御先が記録される: ${JSON.stringify(target)}`);
    const control = { root: join(runtime, "cc-sdd-bootstrap", (await import("node:crypto")).createHash("sha256").update(project).digest("hex").slice(0, 24)), requestId, controlDirectory: target.controlDirectory, generation: target.generation, timeoutMs: 3000 };
    assert.deepEqual(await requestControl({ ...control, kind: "status" }), { status: "running" });
    assert.deepEqual(await requestControl({ ...control, kind: "stop" }), { status: "stopped" });
  } finally { await stopChild(child); await rm(root, { recursive: true, force: true }); }
});

test("受信 control 応答の result は同じ許可リストでサニタイズする", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "delegation-control-response-"));
  try {
    const owner = await import("../.agent-hooks/cc-sdd-bootstrap/delegation-job-control.mjs");
    const { serveControl } = owner;
    const server = await serveControl({ status: async () => ({ status: "invalid", extra: true }), stop: async () => ({ status: "stopped" }) }, { root, requestId: "job", generation: "owner-generation", pollIntervalMs: 5 });
    try {
      assert.deepEqual(await requestControl({ root, requestId: "job", generation: "owner-generation", kind: "status", timeoutMs: 1000 }), { status: "unknown" });
    } finally { await server.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("要求公開後に応答が期限切れなら停止済みの可能性を unknown として返す", async () => {
  const root = await mkdtemp(join(tmpdir(), "delegation-control-timeout-"));
  try {
    assert.deepEqual(await requestControl({ root, requestId: "timeout-job", generation: "owner-generation", kind: "stop", timeoutMs: 10 }),
      { kind: "unknown", requestId: "timeout-job", reason: "制御所有者から応答がありません" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("control directory は 0700、所有者外・symlink・不正 ID を拒否する", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "delegation-control-security-"));
  const outside = await mkdtemp(join(tmpdir(), "delegation-control-outside-"));
  try {
    const { serveControl } = await import("../.agent-hooks/cc-sdd-bootstrap/delegation-job-control.mjs");
    const owner = await serveControl({ status: async () => ({ status: "running" }), stop: async () => ({ status: "stopped" }) }, { root, requestId: "secure-job", generation: "owner-generation", pollIntervalMs: 5 });
    try {
      assert.equal((await lstat(join(root, "control-secure-job"))).mode & 0o777, 0o700);
      assert.deepEqual(await requestControl({ root, requestId: "secure-job", generation: "wrong", kind: "status", timeoutMs: 30 }), { kind: "unknown", requestId: "secure-job", reason: "制御所有者から応答がありません" });
      assert.deepEqual(await requestControl({ root, requestId: "../outside", generation: "g", kind: "status", timeoutMs: 20 }), { kind: "unavailable", reason: "制御要求の入力が不正です" });
      await symlink(outside, join(root, "control-linked"));
      assert.deepEqual(await requestControl({ root, requestId: "linked", generation: "g", kind: "status", timeoutMs: 20 }), { kind: "unavailable", reason: "制御ディレクトリを利用できません" });
      assert.equal((await readdir(outside)).length, 0, "symlink 先へ要求を書き込まない");
    } finally { await owner.close(); }
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
