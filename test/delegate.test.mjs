import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createDelegate, parseDelegateArgs } from "../.agent-hooks/cc-sdd-bootstrap/delegate.mjs";
import { createKiroDelegationContext } from "../.agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs";
import { classifyRegistration } from "../.agent-hooks/cc-sdd-bootstrap/delegation-registry.mjs";
import { createDelegationJobStore } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-store.mjs";
import { serveControl } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-control.mjs";
import { createDefaultJobWorker, runWorkerProcess } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-worker.mjs";
import * as jobWorkerModule from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-worker.mjs";

const INSTRUCTION = "秘密の指示本文 ZX-9";
const SAVED = { family: "codex", scope: "project", registrationName: "cc-sdd-codex", registrationId: "reg-1", models: {} };
const LOCAL = { family: "pi", scope: "project", registrationName: "local", registrationId: "reg-local", models: {} };
const CLOUD = { family: "pi", scope: "project", registrationName: "cloud", registrationId: "reg-cloud", models: {} };

async function fixture(t, { delegation, nativeAdapter, subagents } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "delegate-test-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project"), runtimeBase = join(base, "runtime"), skillsRoot = join(base, "skills");
  await Promise.all([mkdir(project), mkdir(runtimeBase), mkdir(skillsRoot)]);
  await mkdir(join(skillsRoot, "kiro-impl"));
  await writeFile(join(skillsRoot, "kiro-impl", "SKILL.md"), "手順");
  await writeFile(join(project, "instruction.md"), INSTRUCTION);
  const config = { format: 1, ccSdd: { version: "3.1.0", lang: "ja", keepTemplates: false }, clients: "codex", codex: { enabled: false } };
  if (delegation) config.delegation = delegation;
  if (subagents) config.subagents = subagents;
  await writeFile(join(project, ".cc-sdd-bootstrap.json"), JSON.stringify(config));
  const context = createKiroDelegationContext({ runtimeRoot: join(base, "context"), writableRoots: [project], skillsRoot, client: "codex", nativeAdapter });
  const projectKey = createHash("sha256").update(project).digest("hex").slice(0, 24);
  const runtimeRoot = join(runtimeBase, "cc-sdd-bootstrap", projectKey);
  return { base, project, runtimeBase, runtimeRoot, context, resolveWorktreeRoot: async () => project };
}

const eventFor = (f, extra = {}) => ({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", toolName: "Bash", toolUseId: `tool-${randomUUID()}`, command: "node .agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs enter kiro-impl", ...extra });

/** 呼び出し参照を一つ発行する（ホストのフックと同じ経路）。 */
async function referenceFor(f, turnId = "turn-a") {
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId, prompt: "/kiro-impl" });
  const prepared = await f.context.trustedPreToolUse(eventFor(f, { turnId }));
  assert.ok(prepared?.reference, "参照を発行できません");
  return prepared.reference;
}

const argvFor = (f, reference, extra = []) => [
  "start", "--skill", "kiro-impl", "--task-id", "5.2", "--request-id", "req-1", "--role", "review",
  "--work-dir", f.project, "--instruction-file", join(f.project, "instruction.md"), "--reference", reference, ...extra,
];

const observed = (name, registrationId = "reg-local", scope = "project") => classifyRegistration({
  host: "codex", name, family: null, scope, enabled: true, approved: true, trusted: true, transportType: "stdio", registrationId,
});

/** 標準入力の依頼を受け取り、応答を返す偽の一時プロセス。 */
function fakeSpawner(responder, calls = []) {
  return () => {
    const stdin = new PassThrough(), stdout = new PassThrough();
    let input = "";
    stdin.on("data", (chunk) => {
      input += chunk;
      if (!input.endsWith("\n")) return;
      const request = JSON.parse(input);
      calls.push(request);
      setImmediate(() => stdout.write(`${JSON.stringify(responder(request))}\n`));
    });
    return { stdin, stdout, unref() {} };
  };
}

const started = { kind: "started", job: { serverId: "s", connectionId: "c", jobId: "j-1" } };
const unavailable = (reason) => ({ kind: "unavailable", reasons: [reason] });

test("引数は許可リストで検証し、不正な入力は参照を消費せず拒否する", async (t) => {
  const f = await fixture(t);
  assert.equal(parseDelegateArgs(["start", "--skill", "kiro-impl", "--unknown", "x"]), null);
  assert.equal(parseDelegateArgs(["start", "--skill", "impl", "--task-id", "5.2", "--request-id", "r", "--role", "review", "--work-dir", "/x", "--instruction-file", "/y", "--reference", "abc"]), null);
  assert.equal(parseDelegateArgs(["status", "--skill", "kiro-impl", "--task-id", "5.2", "--request-id", "r", "--work-dir", "/x", "--reference", "abc", "--read-only"]), null);
  assert.equal(parseDelegateArgs(["start", "--skill", "kiro-impl", "--skill", "kiro-impl"]), null);
  assert.equal(parseDelegateArgs(["explode"]), null);
  const calls = [];
  const delegate = createDelegate({ contexts: [{ client: "codex", context: f.context }], runtimeBase: f.runtimeBase, spawnWorker: fakeSpawner(() => started, calls), listRegistrations: async () => [] });
  const reference = await referenceFor(f);
  const bad = await delegate.run(argvFor(f, reference).map((item, index, all) => (all[index - 1] === "--role" ? "nobody" : item)), { cwd: f.project });
  assert.equal(bad.kind, "unavailable");
  assert.equal(calls.length, 0);
  const valid = await delegate.run(argvFor(f, reference), { cwd: f.project });
  assert.doesNotMatch(valid.reasons.join("\n"), /呼び出し参照/, "不正入力では参照を消費しないこと");
});

test("参照が無い・消費済み・別の作業先の文脈は拒否し、起動しない", async (t) => {
  const f = await fixture(t, { delegation: { codex: { local: [], cloud: [] } } });
  const calls = [];
  const delegate = createDelegate({ contexts: [{ client: "codex", context: f.context }], runtimeBase: f.runtimeBase, spawnWorker: fakeSpawner(() => started, calls), listRegistrations: async () => [] });
  const other = join(f.project, "other-work");
  await mkdir(other);
  const reference = await referenceFor(f);
  const forged = await delegate.run(argvFor(f, "forged-reference-value-0000000000000000000000"), { cwd: f.project });
  assert.equal(forged.kind, "unavailable");
  assert.match(forged.reasons[0], /呼び出し参照/);
  const elsewhere = await delegate.run(argvFor(f, reference).map((item, index, all) => (all[index - 1] === "--work-dir" ? other : item)), { cwd: other });
  assert.equal(elsewhere.kind, "unavailable");
  assert.match(elsewhere.reasons[0], /呼び出し参照/, "作業範囲の内側でも、参照は発行先の作業先でしか受理されない");
  const first = await delegate.run(argvFor(f, reference), { cwd: f.project });
  assert.equal(first.kind, "unavailable");
  assert.doesNotMatch(first.reasons.join("\n"), /呼び出し参照/, "最初の消費は参照として受理される");
  const second = await delegate.run(argvFor(f, reference), { cwd: f.project });
  assert.equal(second.kind, "unavailable");
  assert.match(second.reasons[0], /呼び出し参照/, "消費済みの参照は拒否される");
  assert.equal(calls.length, 0, "候補が無いため一時プロセスは起動しない");
});

test("候補が無く、ネイティブも無いときは起動せず理由を返す", async (t) => {
  const f = await fixture(t, { delegation: { codex: { local: [], cloud: [] } } });
  const calls = [];
  const delegate = createDelegate({ contexts: [{ client: "codex", context: f.context }], runtimeBase: f.runtimeBase, spawnWorker: fakeSpawner(() => started, calls), listRegistrations: async () => [] });
  const reference = await referenceFor(f);
  const result = await delegate.run(argvFor(f, reference), { cwd: f.project });
  assert.equal(result.kind, "unavailable");
  assert.ok(result.reasons.length >= 1);
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(result).includes(INSTRUCTION), false, "指示本文を理由に出してはいけません");
});

test("ローカルを先に試し、起動済みならクラウドは呼ばない", async (t) => {
  const f = await fixture(t, { delegation: { codex: { local: [{ ...LOCAL, family: "codex" }], cloud: [{ ...CLOUD, family: "pi" }] } } });
  const calls = [];
  const delegate = createDelegate({ contexts: [{ client: "codex", context: f.context }], runtimeBase: f.runtimeBase,
    spawnWorker: fakeSpawner(() => started, calls),
    listRegistrations: async () => [observed("local", "reg-local"), observed("cloud", "reg-cloud")] });
  const reference = await referenceFor(f);
  const result = await delegate.run(argvFor(f, reference), { cwd: f.project });
  assert.equal(result.kind, "pending");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].candidates[0].registration.registrationName, "local");
  assert.equal(calls[0].candidates[0].tier, "local");
});

test("起動前の不成立だけ次の候補へ進み、送信後の不明では次へ進まない", async (t) => {
  const f = await fixture(t, { delegation: { codex: { local: [{ ...LOCAL, family: "codex" }], cloud: [{ ...CLOUD, family: "pi" }] } } });
  const calls = [];
  const delegate = createDelegate({ contexts: [{ client: "codex", context: f.context }], runtimeBase: f.runtimeBase,
    spawnWorker: fakeSpawner((request) => request.candidates[0].registration.registrationName === "local" ? unavailable("ローカルは起動前に拒否されました") : started, calls),
    listRegistrations: async () => [observed("local", "reg-local"), observed("cloud", "reg-cloud")] });
  const reference = await referenceFor(f);
  const result = await delegate.run(argvFor(f, reference), { cwd: f.project });
  assert.equal(result.kind, "pending");
  assert.deepEqual(calls.map((request) => request.candidates[0].registration.registrationName), ["local", "cloud"]);

  const unknownCalls = [];
  const unknownDelegate = createDelegate({ contexts: [{ client: "codex", context: f.context }], runtimeBase: f.runtimeBase,
    spawnWorker: fakeSpawner((request) => request.candidates[0].registration.registrationName === "local"
      ? { kind: "pending", requestId: request.requestId, reason: "起動後の状態が不明です" } : started, unknownCalls),
    listRegistrations: async () => [observed("local", "reg-local"), observed("cloud", "reg-cloud")] });
  const second = await referenceFor(f, "turn-b");
  const unknownResult = await unknownDelegate.run(argvFor(f, second), { cwd: f.project });
  assert.equal(unknownResult.kind, "pending");
  assert.deepEqual(unknownCalls.map((request) => request.candidates[0].registration.registrationName), ["local"]);
});

test("MCP を選んだときは事前確認を発行せず、ネイティブを選んだときだけ一回限りの確認を発行する", async (t) => {
  const nativeAdapter = {
    normalizeLaunch: ({ toolName, toolInput }) => ({ ok: true, value: { toolName, agentName: toolInput.agent_type, argsFingerprint: "a".repeat(64) } }),
    collectEvidence: async ({ policy }) => ({ role: policy.role, client: policy.client, agentName: policy.agentName, definitionVerified: true, parentModelId: "gpt-6-luna", childModelId: policy.modelId, effort: policy.effort, access: policy.access, historyInherited: false }),
  };
  const mcp = await fixture(t, { delegation: { codex: { local: [{ ...LOCAL, family: "codex" }], cloud: [] } }, nativeAdapter });
  const mcpDelegate = createDelegate({ contexts: [{ client: "codex", context: mcp.context }], runtimeBase: mcp.runtimeBase, spawnWorker: fakeSpawner(() => started), listRegistrations: async () => [observed("local", "reg-local")] });
  const mcpReference = await referenceFor(mcp);
  assert.equal((await mcpDelegate.run(argvFor(mcp, mcpReference), { cwd: mcp.project })).kind, "pending");
  assert.deepEqual((await mcp.context.current({ cwd: mcp.project, sessionId: "session-a" })).nativePreflights, {});

  const native = await fixture(t, { delegation: { codex: { local: [], cloud: [] } }, nativeAdapter });
  const delegate = createDelegate({ contexts: [{ client: "codex", context: native.context }], runtimeBase: native.runtimeBase, spawnWorker: fakeSpawner(() => started), listRegistrations: async () => [] });
  const reference = await referenceFor(native);
  const result = await delegate.run(argvFor(native, reference), { cwd: native.project });
  assert.equal(result.kind, "native");
  assert.equal(result.agentName, "cc_sdd_review");
  assert.equal(result.toolName, "spawn_agent");
  assert.deepEqual(result.toolInput, { agent_type: "cc_sdd_review", fork_turns: "none" });
  const state = await native.context.current({ cwd: native.project, sessionId: "session-a" });
  assert.equal(Object.keys(state.nativePreflights).length, 1);
  const allowed = await native.context.trustedNativePreToolUse({ trusted: true, source: "host", cwd: native.project, sessionId: "session-a", turnId: "turn-a", toolUseId: "native-1", toolName: "spawn_agent", toolInput: result.toolInput });
  assert.deepEqual(allowed, { action: "allow" });
  const reused = await native.context.trustedNativePreToolUse({ trusted: true, source: "host", cwd: native.project, sessionId: "session-a", turnId: "turn-a", toolUseId: "native-2", toolName: "spawn_agent", toolInput: result.toolInput });
  assert.equal(reused.action, "deny");
});

test("終了したターンの後でも、新しいターンの参照で既存ジョブを照会・停止できる", async (t) => {
  const f = await fixture(t, { delegation: { codex: { local: [], cloud: [] } } });
  const store = createDelegationJobStore({ root: f.runtimeRoot, writableRoots: [f.project], resolveWorktreeRoot: f.resolveWorktreeRoot });
  const key = { requestId: "req-1", project: f.project, cwd: f.project, skill: "kiro-impl", taskId: "5.2" };
  const tracked = await store.track(key);
  assert.equal(tracked.kind, "tracked");
  const { generation, controlDirectory } = tracked.record;
  await store.recordOwner({ ...key, generation, pid: process.pid, now: Date.now() });
  const worker = { status: async () => ({ status: "running" }), stop: async () => ({ status: "stopped" }), controlStatus: async () => ({ status: "running" }), controlStop: async () => ({ status: "stopped" }) };
  const owner = await serveControl(worker, { root: f.runtimeRoot, requestId: "req-1", generation, controlDirectory, acceptedRequestIds: ["req-1"], pollIntervalMs: 5 });
  t.after(() => owner.close());
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-after", prompt: "/kiro-impl" });
  const reference = (await f.context.trustedPreToolUse(eventFor(f, { turnId: "turn-after" })))?.reference;
  const delegate = createDelegate({ contexts: [{ client: "codex", context: f.context }], runtimeBase: f.runtimeBase, resolveWorktreeRoot: f.resolveWorktreeRoot, controlTimeoutMs: 2000, listRegistrations: async () => [] });
  const status = await delegate.run(["status", "--skill", "kiro-impl", "--task-id", "5.2", "--request-id", "req-1", "--work-dir", f.project, "--reference", reference], { cwd: f.project });
  assert.equal(status.kind, "status");
  assert.equal(status.status, "running");
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-stop", prompt: "/kiro-impl" });
  const stopReference = (await f.context.trustedPreToolUse(eventFor(f, { turnId: "turn-stop" })))?.reference;
  const stopped = await delegate.run(["stop", "--skill", "kiro-impl", "--task-id", "5.2", "--request-id", "req-1", "--work-dir", f.project, "--reference", stopReference], { cwd: f.project });
  assert.equal(stopped.status, "stopped");
  const outside = await delegate.run(["status", "--skill", "kiro-impl", "--task-id", "5.2", "--request-id", "req-1", "--work-dir", f.runtimeBase, "--reference", "forged-reference-value-0000000000000000000000"], { cwd: f.project });
  assert.equal(outside.kind, "unavailable");
  assert.match(outside.reasons[0], /作業範囲/);
});

test("実 store・実 registry・実 worker 入口を通し、適格な MCP が無いときはネイティブへ移る", async (t) => {
  const nativeAdapter = {
    normalizeLaunch: ({ toolName, toolInput }) => ({ ok: true, value: { toolName, agentName: toolInput.agent_type, argsFingerprint: "b".repeat(64) } }),
    collectEvidence: async ({ policy }) => ({ role: policy.role, client: policy.client, agentName: policy.agentName, definitionVerified: true, parentModelId: "gpt-6-luna", childModelId: policy.modelId, effort: policy.effort, access: policy.access, historyInherited: false }),
  };
  const f = await fixture(t, { delegation: { codex: { local: [{ ...LOCAL, family: "codex" }], cloud: [] } }, nativeAdapter });
  const workerCalls = [];
  const delegate = createDelegate({ contexts: [{ client: "codex", context: f.context }], runtimeBase: f.runtimeBase, resolveWorktreeRoot: f.resolveWorktreeRoot,
    listRegistrations: async () => [observed("local", "reg-local")],
    spawnWorker: () => {
      const stdin = new PassThrough(), stdout = new PassThrough();
      const store = createDelegationJobStore({ root: f.runtimeRoot, writableRoots: [f.project], resolveWorktreeRoot: f.resolveWorktreeRoot });
      const worker = createDefaultJobWorker({ store, select: async (request) => { workerCalls.push(request.candidates.length); return unavailable("接続できる MCP がありません"); } });
      runWorkerProcess({ stdin, stdout, deps: { worker } }).catch(() => {});
      return { stdin, stdout, unref() {} };
    } });
  const reference = await referenceFor(f);
  const result = await delegate.run(argvFor(f, reference), { cwd: f.project });
  assert.equal(result.kind, "native");
  assert.equal(result.agentName, "cc_sdd_review");
  assert.deepEqual(workerCalls, [1]);
  assert.equal(JSON.stringify(result).includes(INSTRUCTION), false);
});

const LOCAL_SAVED = { family: "pi", scope: "project", registrationName: "local", registrationId: "reg-local", models: {} };
const CLOUD_SAVED = { family: "pi", scope: "project", registrationName: "cloud", registrationId: "reg-cloud", models: { review: { compatibleIds: ["cloud-model"] } } };
const TRANSPORTS = { local: { type: "stdio", command: "fake-local" }, cloud: { type: "stdio", command: "fake-cloud" } };
const registered = (name, registrationId, command) => classifyRegistration({ host: "codex", name, family: null, scope: "project", enabled: true, approved: true, trusted: true,
  transportType: "stdio", registrationId, transport: { type: "stdio", command } });
const LISTED = { local: registered("local", "reg-local", "fake-local"), cloud: registered("cloud", "reg-cloud", "fake-cloud") };

/** 偽の MCP 子プロセス。起動された実行ファイル名を記録し、初期化と一覧だけに応答する（実プロセスは起動しない）。 */
function fakeMcpSpawn(spawned) {
  return (command) => {
    spawned.push(command);
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin.setEncoding("utf8");
    let buffer = "";
    child.stdin.on("data", (chunk) => {
      buffer += chunk;
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: command } } })}\n`);
        else if (message.method === "tools/list") child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } })}\n`);
      }
    });
    return child;
  };
}

/** 接続先の名前から、役割に適合する能力を公開する偽の adapter。 */
function fakeAdapterFor(connection) {
  const name = connection.serverInfo.name;
  const tier = name.includes("cloud") ? "cloud" : "local";
  const modelId = tier === "cloud" ? "cloud-model" : "local-model";
  return {
    async capabilities() { return { kind: "agent", harness: "pi", tier, models: [{ id: modelId, accepted: [{ access: "read-only", effort: "medium" }] }] }; },
    async models() { return [modelId]; },
    async start() { return { kind: "started", job: { serverId: "s", connectionId: "c", jobId: `job-${name}` } }; },
    async status() { return { status: "succeeded", output: "完了" }; },
    async stop() { return { status: "stopped" }; },
    async close() {},
  };
}

/**
 * 本番の依頼用プロセスを作る。登録の再照合・選択・接続は本番の経路を通り、MCP の子プロセスだけを偽物にする。
 * 終了を待てるように、各プロセスの完了を finished に積む。
 */
function productionWorkerSpawner({ f, listRegistrations, transports, spawned, finished }) {
  return () => {
    const stdin = new PassThrough(), stdout = new PassThrough();
    finished.push(runWorkerProcess({ stdin, stdout, deps: { createWorker: (request) => jobWorkerModule.createProjectJobWorker(request, {
      runtime: f.runtimeBase, listRegistrations, resolveWorktreeRoot: f.resolveWorktreeRoot,
      readTransport: async (registration) => transports[registration.name === "cloud" ? "cloud" : "local"],
      spawnProcess: fakeMcpSpawn(spawned), adapterFactory: async (connection) => fakeAdapterFor(connection),
    }) } }).catch(() => {}));
    return { stdin, stdout, unref() {} };
  };
}

/** 一時プロセスが終端まで進むのを待つ。固定ミリ秒の待ちではなく、完了の Promise を待ち、上限時間だけ見張る。 */
async function settleWorkers(finished) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("一時プロセスが終了しません")), 5000); });
  try { await Promise.race([Promise.all(finished), limit]); } finally { clearTimeout(timer); }
}

/** XDG_RUNTIME_DIR を作業用の領域へ向け、テスト終了時に戻す（制御ディレクトリを実際の実行時領域に作らない）。 */
function pinRuntime(t, runtimeBase) {
  const before = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeBase;
  t.after(() => { if (before === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = before; });
}

const delegationSettings = (candidates) => ({ subagents: { localModels: { review: "local-model" } }, delegation: { codex: candidates } });

test("本番の登録照合を通し、適格な MCP が起動できれば pending になる", async (t) => {
  const f = await fixture(t);
  pinRuntime(t, f.runtimeBase);
  const spawned = [], finished = [];
  const delegate = createDelegate({ contexts: [{ client: "codex", context: f.context }], runtimeBase: f.runtimeBase, resolveWorktreeRoot: f.resolveWorktreeRoot,
    readSettings: async () => delegationSettings({ local: [LOCAL_SAVED], cloud: [] }),
    listRegistrations: async () => [LISTED.local],
    spawnWorker: productionWorkerSpawner({ f, listRegistrations: async () => [LISTED.local], transports: TRANSPORTS, spawned, finished }) });
  const reference = await referenceFor(f);
  const result = await delegate.run(argvFor(f, reference), { cwd: f.project });
  assert.equal(result.kind, "pending", JSON.stringify(result));
  assert.deepEqual(spawned, ["fake-local"], "承認済みの接続先だけを起動する");
  await settleWorkers(finished);
});

test("接続情報の指紋が登録と一致しない候補は起動せず、次の候補へ進む", async (t) => {
  const f = await fixture(t);
  pinRuntime(t, f.runtimeBase);
  const spawned = [], finished = [];
  const changed = { ...TRANSPORTS, local: { type: "stdio", command: "fake-local-changed" } };
  const delegate = createDelegate({ contexts: [{ client: "codex", context: f.context }], runtimeBase: f.runtimeBase, resolveWorktreeRoot: f.resolveWorktreeRoot,
    readSettings: async () => delegationSettings({ local: [LOCAL_SAVED], cloud: [CLOUD_SAVED] }),
    listRegistrations: async () => [LISTED.local, LISTED.cloud],
    spawnWorker: productionWorkerSpawner({ f, listRegistrations: async () => [LISTED.local, LISTED.cloud], transports: changed, spawned, finished }) });
  const reference = await referenceFor(f);
  const result = await delegate.run(argvFor(f, reference), { cwd: f.project });
  assert.equal(result.kind, "pending", JSON.stringify(result));
  assert.deepEqual(spawned, ["fake-cloud"], "指紋が一致しない局所の接続先は起動しない");
  await settleWorkers(finished);
});

test("照合の直前に登録が消えた候補は起動せず、次の候補へ進む", async (t) => {
  const f = await fixture(t);
  pinRuntime(t, f.runtimeBase);
  const spawned = [], finished = [];
  let calls = 0;
  // 一回目は指揮役の列挙（両方見える）、以降は一時プロセスの再照合（局所の登録が消えている）。
  const listRegistrations = async () => (++calls === 1 ? [LISTED.local, LISTED.cloud] : [LISTED.cloud]);
  const delegate = createDelegate({ contexts: [{ client: "codex", context: f.context }], runtimeBase: f.runtimeBase, resolveWorktreeRoot: f.resolveWorktreeRoot,
    readSettings: async () => delegationSettings({ local: [LOCAL_SAVED], cloud: [CLOUD_SAVED] }),
    listRegistrations,
    spawnWorker: productionWorkerSpawner({ f, listRegistrations, transports: TRANSPORTS, spawned, finished }) });
  const reference = await referenceFor(f);
  const result = await delegate.run(argvFor(f, reference), { cwd: f.project });
  assert.equal(result.kind, "pending", JSON.stringify(result));
  assert.deepEqual(spawned, ["fake-cloud"], "消えた局所の登録は接続しない");
  await settleWorkers(finished);
});

/** 同じ書き込み作業（project・skill・taskId）に、終了を確認できない記録を実 store で残す。 */
async function leaveUnknownWriteRecord(f) {
  const store = createDelegationJobStore({ root: f.runtimeRoot, writableRoots: [f.project], resolveWorktreeRoot: f.resolveWorktreeRoot });
  const key = { project: f.project, cwd: f.project, skill: "kiro-impl", taskId: "5.2" };
  const reserved = await store.reserve({ ...key, requestId: "req-earlier" });
  assert.equal(reserved.kind, "created", "先行の書き込み記録を作れること");
  await store.markUnknown({ ...key, requestId: "req-earlier", reason: "先行の終了を確認できません" });
}

const manufactureArgv = (f, reference) => argvFor(f, reference).map((item, index, all) => (all[index - 1] === "--role" ? "manufacture" : item));

test("終了を確認できない書き込み記録があるとき、候補が無くてもネイティブへ移らず、事前確認も発行しない", async (t) => {
  const nativeAdapter = {
    normalizeLaunch: ({ toolName, toolInput }) => ({ ok: true, value: { toolName, agentName: toolInput.agent_type, argsFingerprint: "c".repeat(64) } }),
    collectEvidence: async ({ policy }) => ({ role: policy.role, client: policy.client, agentName: policy.agentName, definitionVerified: true, parentModelId: "gpt-6-luna", childModelId: policy.modelId, effort: policy.effort, access: policy.access, historyInherited: false }),
  };
  const f = await fixture(t, { delegation: { codex: { local: [], cloud: [] } }, nativeAdapter, subagents: { codexModels: { manufacture: "gpt-6-sol" } } });
  await leaveUnknownWriteRecord(f);
  const calls = [];
  const delegate = createDelegate({ contexts: [{ client: "codex", context: f.context }], runtimeBase: f.runtimeBase, resolveWorktreeRoot: f.resolveWorktreeRoot,
    spawnWorker: fakeSpawner(() => started, calls), listRegistrations: async () => [] });
  const reference = await referenceFor(f);
  const result = await delegate.run(manufactureArgv(f, reference), { cwd: f.project });
  assert.notEqual(result.kind, "native", "終了未確認の同じ作業をネイティブで再委任しない: " + JSON.stringify(result));
  assert.equal(result.kind, "unavailable", JSON.stringify(result));
  assert.match(result.reasons.join("\n"), /終了を確認/);
  const state = await f.context.current({ cwd: f.project, sessionId: "session-a" });
  assert.deepEqual(state.nativePreflights, {}, "事前確認を発行しない");
  assert.equal(calls.length, 0, "一時プロセスを起動しない");
});

test("終了を確認できない書き込み記録があるとき、候補が blocked で不成立でも次の候補やネイティブへ進まない", async (t) => {
  const nativeAdapter = {
    normalizeLaunch: ({ toolName, toolInput }) => ({ ok: true, value: { toolName, agentName: toolInput.agent_type, argsFingerprint: "d".repeat(64) } }),
    collectEvidence: async ({ policy }) => ({ role: policy.role, client: policy.client, agentName: policy.agentName, definitionVerified: true, parentModelId: "gpt-6-luna", childModelId: policy.modelId, effort: policy.effort, access: policy.access, historyInherited: false }),
  };
  const f = await fixture(t, { delegation: { codex: { local: [{ ...LOCAL, family: "codex" }], cloud: [] } }, nativeAdapter, subagents: { codexModels: { manufacture: "gpt-6-sol" } } });
  pinRuntime(t, f.runtimeBase);
  await leaveUnknownWriteRecord(f);
  const spawned = [], selected = [];
  const delegate = createDelegate({ contexts: [{ client: "codex", context: f.context }], runtimeBase: f.runtimeBase, resolveWorktreeRoot: f.resolveWorktreeRoot,
    readSettings: async () => delegationSettings({ local: [LOCAL_SAVED], cloud: [] }),
    listRegistrations: async () => [LISTED.local],
    spawnWorker: () => {
      spawned.push(1);
      const stdin = new PassThrough(), stdout = new PassThrough();
      const store = createDelegationJobStore({ root: f.runtimeRoot, writableRoots: [f.project], resolveWorktreeRoot: f.resolveWorktreeRoot });
      const worker = createDefaultJobWorker({ store, select: async () => { selected.push(1); return unavailable("接続できる MCP がありません"); } });
      runWorkerProcess({ stdin, stdout, deps: { worker } }).catch(() => {});
      return { stdin, stdout, unref() {} };
    } });
  const reference = await referenceFor(f);
  const result = await delegate.run(manufactureArgv(f, reference), { cwd: f.project });
  assert.notEqual(result.kind, "native", JSON.stringify(result));
  assert.equal(result.kind, "unavailable", JSON.stringify(result));
  assert.match(result.reasons.join("\n"), /終了を確認/);
  const state = await f.context.current({ cwd: f.project, sessionId: "session-a" });
  assert.deepEqual(state.nativePreflights, {}, "事前確認を発行しない");
  assert.deepEqual(selected, [], "候補の選択まで進まない");
  assert.ok(spawned.length <= 1, "2つ目の一時プロセスを起動しない");
});

test("一時プロセスが書き込みを blocked と返したら、次の候補もネイティブも試さない", async (t) => {
  const nativeAdapter = {
    normalizeLaunch: ({ toolName, toolInput }) => ({ ok: true, value: { toolName, agentName: toolInput.agent_type, argsFingerprint: "e".repeat(64) } }),
    collectEvidence: async ({ policy }) => ({ role: policy.role, client: policy.client, agentName: policy.agentName, definitionVerified: true, parentModelId: "gpt-6-luna", childModelId: policy.modelId, effort: policy.effort, access: policy.access, historyInherited: false }),
  };
  const f = await fixture(t, { delegation: { codex: { local: [{ ...LOCAL, family: "codex" }], cloud: [{ ...CLOUD, family: "pi" }] } }, nativeAdapter, subagents: { codexModels: { manufacture: "gpt-6-sol" } } });
  const calls = [];
  const delegate = createDelegate({ contexts: [{ client: "codex", context: f.context }], runtimeBase: f.runtimeBase, resolveWorktreeRoot: f.resolveWorktreeRoot,
    spawnWorker: fakeSpawner((request) => ({ kind: "blocked", reasons: ["書き込み依頼の予約が競合しています"] }), calls),
    listRegistrations: async () => [observed("local", "reg-local"), observed("cloud", "reg-cloud")] });
  const reference = await referenceFor(f);
  const result = await delegate.run(manufactureArgv(f, reference), { cwd: f.project });
  assert.equal(result.kind, "unavailable", JSON.stringify(result));
  assert.match(result.reasons.join("\n"), /競合/);
  assert.deepEqual(calls.map((request) => request.candidates[0].registration.registrationName), ["local"], "blocked の後で次の候補へ進まない");
  const state = await f.context.current({ cwd: f.project, sessionId: "session-a" });
  assert.deepEqual(state.nativePreflights, {}, "事前確認を発行しない");
});
