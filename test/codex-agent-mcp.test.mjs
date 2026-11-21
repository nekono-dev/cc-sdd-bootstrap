import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import * as codex from "../.agent-hooks/cc-sdd-bootstrap/codex-agent-mcp.mjs";

test("Codex の公開モデルはカタログの受付 ID・推論量と実行可能な権限を返す", async () => {
  const catalog = [
    { model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
    { model: "model-b", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
  ];
  const capabilities = await codex.loadCapabilities({ listModels: async () => catalog });
  assert.deepEqual(capabilities, {
    kind: "agent", harness: "codex", tier: "cloud",
    models: [
      { id: "model-a", accepted: [{ access: "read-only", effort: "medium" }, { access: "read-only", effort: "high" }, { access: "workspace-write", effort: "medium" }, { access: "workspace-write", effort: "high" }] },
    ],
  });
});

test("公開判定と起動前の受付判定は同じモデル・権限・推論量の組み合わせを使う", async () => {
  const catalog = [{ model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }];
  const capabilities = await codex.loadCapabilities({ listModels: async () => catalog });
  assert.equal(codex.isAccepted(capabilities, { model: "model-a", access: "workspace-write", effort: "medium" }), true);
  assert.equal(codex.isAccepted(capabilities, { model: "model-a", access: "workspace-write", effort: "high" }), false);
  assert.equal(codex.isAccepted(capabilities, { model: "model-b", access: "workspace-write", effort: "medium" }), false);
  assert.equal(codex.isAccepted(capabilities, { model: "model-a", access: "admin", effort: "medium" }), false);
  assert.equal(codex.isAccepted(capabilities, { model: "model-a", access: "workspace-write", effort: "low" }), false);
});

test("モデルカタログ取得に失敗したとき利用可否は不明で、利用権を判定しない", async () => {
  const result = await codex.getCapabilities({ listModels: async () => { throw new Error("offline"); } });
  assert.deepEqual(result, { kind: "unavailable", reason: "モデルカタログを取得できず、受付可否を確認できません" });
});

test("MCP はカタログを能力とモデル一覧として公開し、利用権確認は呼び出さない", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let response = "";
  output.on("data", (chunk) => { response += chunk; });
  let catalogCalls = 0;
  const serving = codex.serve({ input, output, listModels: async () => {
    catalogCalls += 1;
    return [{ model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }];
  } });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "codex_capabilities", arguments: {} } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "codex_models", arguments: {} } })}\n`);
  input.end();
  await serving;
  const results = response.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(results[0].result.tools.map((tool) => tool.name), ["codex_capabilities", "codex_models", "codex_start", "codex_status", "codex_stop"]);
  assert.equal(results[1].result.structuredContent.models[0].id, "model-a");
  assert.deepEqual(results[2].result.structuredContent, { models: ["model-a"] });
  assert.equal(catalogCalls, 2);
});

test("tools/call は未知・配列・不正型の引数を照会前に拒否する", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let response = "";
  output.on("data", (chunk) => { response += chunk; });
  let calls = 0;
  const serving = codex.serve({ input, output, listModels: async () => { calls += 1; return []; } });
  for (const [id, args] of [[1, { unexpected: true }], [2, []], [3, "bad"]]) {
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "codex_models", arguments: args } })}\n`);
  }
  input.end();
  await serving;
  const results = response.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls, 0);
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.error?.code === -32602));
});

test("本番カタログ照会は initialize と model/list だけを送り利用権を照会しない", async () => {
  const { EventEmitter } = await import("node:events");
  const childProcess = { spawn: undefined };
  const spawned = [];
  const spawnProcess = (command, args, options) => {
    childProcess.spawn = { command, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    child.stdin.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const message = JSON.parse(line);
        spawned.push(message);
        if (!message.id) continue;
        const result = message.method === "initialize" ? {} : { data: [{ model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] };
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`));
      }
    });
    return child;
  };
  const models = await codex.listCodexModels({ spawnProcess });
  assert.equal(childProcess.spawn.command, "codex");
  assert.deepEqual(childProcess.spawn.args, ["app-server"]);
  assert.deepEqual(models.map((model) => model.model), ["model-a"]);
  assert.deepEqual(spawned.map((message) => message.method), ["initialize", "initialized", "model/list"]);
  assert.ok(!spawned.some((message) => /auth|entitlement|account|subscription/i.test(message.method)));
});

test("本番カタログ照会に失敗した場合は受付可否を確定できない", async () => {
  const { EventEmitter } = await import("node:events");
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    child.stdin.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const message = JSON.parse(line);
        if (message.id) queueMicrotask(() => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? {} : undefined, ...(message.method === "model/list" ? { error: { code: -1, message: "offline" } } : {}) })}\n`));
      }
    });
    return child;
  };
  const result = await codex.getCapabilities({ listModels: () => codex.listCodexModels({ spawnProcess }) });
  assert.deepEqual(result, { kind: "unavailable", reason: "モデルカタログを取得できず、受付可否を確認できません" });
});

test("起動受付判定は未知キーと不正な入力型を例外なく拒否する", async () => {
  const capabilities = await codex.loadCapabilities({ listModels: async () => [{ model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] });
  assert.equal(codex.isAccepted(capabilities, { model: "model-a", access: "workspace-write", effort: "medium", unexpected: true }), false);
  for (const input of [null, [], "bad"]) {
    assert.doesNotThrow(() => assert.equal(codex.isAccepted(capabilities, input), false));
  }
});

test("codex_start は検査済み設定を直接起動し、指示本文を stdin のみに渡して状態・停止を返す", async () => {
  const { EventEmitter } = await import("node:events");
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "codex-job-"));
  const cwd = join(root, "work"); await mkdir(cwd);
  const input = new PassThrough(); const output = new PassThrough(); let response = "";
  output.on("data", (chunk) => { response += chunk; });
  const spawns = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 4321; child.exitCode = null; child.signalCode = null;
    let stdin = ""; child.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
    child.terminate = () => { child.exitCode = 0; child.emit("exit", 0, null); };
    child.kill = (signal) => { child.lastSignal = signal; if (signal === "SIGKILL") child.terminate(); return true; };
    queueMicrotask(() => child.emit("spawn"));
    spawns.push({ command, args, options, child, get stdin() { return stdin; } }); return child;
  };
  const serving = codex.serve({ input, output, listModels: async () => [{ model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], spawnProcess, killProcess: (pid, signal) => { if (signal === 0) { if (spawns[0]?.child.exitCode !== null) throw Object.assign(new Error("gone"), { code: "ESRCH" }); return true; } spawns[0]?.child.kill(signal); }, allowedRoots: [root], stopGraceMs: 5 });
  const call = (id, name, args) => input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  call(1, "codex_start", { cwd, model: "model-a", effort: "medium", access: "read-only", instruction: "private instruction" });
  while (!response.includes('"id":1')) await new Promise((resolve) => setTimeout(resolve, 2));
  const started = JSON.parse(response.trim().split("\n")[0]).result.structuredContent;
  assert.equal(started.kind, "started"); assert.ok(started.jobId);
  assert.equal(spawns[0].command, "codex"); assert.deepEqual(spawns[0].args, ["-a", "never", "exec", "--sandbox", "read-only", "--model", "model-a", "--config", "model_reasoning_effort=\"medium\"", "--cd", cwd, "-"]);
  assert.equal(spawns[0].options.shell, false); assert.equal(spawns[0].options.detached, true);
  assert.equal(spawns[0].stdin, "private instruction"); assert.ok(!response.includes("private instruction"));
  call(2, "codex_status", { jobId: started.jobId });
  while (!response.includes('"id":2')) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(JSON.parse(response.trim().split("\n")[1]).result.structuredContent.status, "running");
  call(3, "codex_stop", { jobId: started.jobId });
  while (!response.includes('"id":3')) await new Promise((resolve) => setTimeout(resolve, 2));
  while (JSON.parse(response.trim().split("\n")[2]).result.structuredContent.status !== "stopped") await new Promise((resolve) => setTimeout(resolve, 2));
  input.end(); await serving; await rm(root, { recursive: true, force: true });
});

test("未対応設定・範囲外や不正引数は spawn 前に拒否し、停止確認前は stopped にしない", async () => {
  const { mkdtemp, mkdir, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "codex-job-check-")); const outside = await mkdtemp(join(tmpdir(), "codex-job-out-"));
  const cwd = join(root, "work"); await mkdir(cwd); await symlink(outside, join(root, "escape"));
  const input = new PassThrough(); const output = new PassThrough(); let response = ""; output.on("data", (chunk) => { response += chunk; });
  let spawnCount = 0; const spawnProcess = () => { spawnCount += 1; throw new Error("unexpected"); };
  const serving = codex.serve({ input, output, listModels: async () => [{ model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], spawnProcess, allowedRoots: [root] });
  const send = (id, name, args) => input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  send(1, "codex_start", { cwd, model: "model-a", effort: "off", access: "read-only", instruction: "x" });
  send(2, "codex_start", { cwd: outside, model: "model-a", effort: "medium", access: "read-only", instruction: "x" });
  send(3, "codex_start", { cwd: join(root, "escape"), model: "model-a", effort: "medium", access: "read-only", instruction: "x" });
  send(4, "codex_start", { cwd, model: "model-a", effort: "medium", access: "workspace-write", instruction: "x", extra: true });
  while (!response.includes('"id":4')) await new Promise((resolve) => setTimeout(resolve, 2));
  const messages = response.trim().split("\n").map((line) => JSON.parse(line));
  const results = messages.slice(0, 3).map((message) => message.result.structuredContent);
  assert.equal(spawnCount, 0); assert.ok(results.every((result) => result.kind === "not-started"));
  assert.equal(messages[3].error.code, -32602);
  input.end(); await serving; await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
});

test("停止応答は子プロセスの終了確認前に stopped を返さず、spawn 後の追跡不能は unknown とする", async () => {
  const { EventEmitter } = await import("node:events");
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "codex-job-pending-")); const cwd = join(root, "work"); await mkdir(cwd);
  const input = new PassThrough(); const output = new PassThrough(); let response = ""; output.on("data", (chunk) => { response += chunk; });
  let child;
  const spawnProcess = () => { child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.pid = 987654; child.kill = () => true; queueMicrotask(() => child.emit("spawn")); return child; };
  const serving = codex.serve({ input, output, listModels: async () => [{ model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], spawnProcess, killProcess: (pid, signal) => { if (signal === 0) return true; }, allowedRoots: [root], stopGraceMs: 30 });
  const send = (id, name, args) => input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  send(1, "codex_start", { cwd, model: "model-a", effort: "medium", access: "read-only", instruction: "x" });
  while (!response.includes('"id":1')) await new Promise((resolve) => setTimeout(resolve, 2));
  const jobId = JSON.parse(response.trim().split("\n")[0]).result.structuredContent.jobId;
  send(2, "codex_stop", { jobId }); while (!response.includes('"id":2')) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(JSON.parse(response.trim().split("\n")[1]).result.structuredContent.status, "running");
  child.emit("error", new Error("lost"));
  send(3, "codex_status", { jobId }); while (!response.includes('"id":3')) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(JSON.parse(response.trim().split("\n")[2]).result.structuredContent.status, "unknown");
  input.end(); await serving; await rm(root, { recursive: true, force: true });
});

test("spawn 前の非同期失敗は not-started、stdin の非同期失敗は unknown として追跡する", async () => {
  const { EventEmitter } = await import("node:events");
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "codex-job-errors-")); const cwd = join(root, "work"); await mkdir(cwd);
  const input = new PassThrough(); const output = new PassThrough(); let response = ""; output.on("data", (chunk) => { response += chunk; });
  let child; let calls = 0;
  const spawnProcess = () => {
    calls += 1; child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.pid = 1234;
    if (calls === 1) queueMicrotask(() => child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" })));
    else {
      child.stdin.end = () => { queueMicrotask(() => child.stdin.emit("error", new Error("EPIPE"))); };
      queueMicrotask(() => child.emit("spawn"));
    }
    return child;
  };
  const serving = codex.serve({ input, output, listModels: async () => [{ model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], spawnProcess, allowedRoots: [root] });
  const send = (id) => input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "codex_start", arguments: { cwd, model: "model-a", effort: "medium", access: "read-only", instruction: "x" } } })}\n`);
  send(1); while (!response.includes('"id":1')) await new Promise((resolve) => setTimeout(resolve, 2));
  const first = JSON.parse(response.trim().split("\n")[0]).result.structuredContent; assert.equal(first.kind, "not-started");
  send(2); while (!response.includes('"id":2')) await new Promise((resolve) => setTimeout(resolve, 2));
  const second = JSON.parse(response.trim().split("\n")[1]).result.structuredContent; assert.equal(second.kind, "started"); assert.ok(second.jobId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "codex_status", arguments: { jobId: second.jobId } } })}\n`);
  while (!response.includes('"id":3')) await new Promise((resolve) => setTimeout(resolve, 2));
  const status = JSON.parse(response.trim().split("\n")[2]).result.structuredContent; assert.equal(status.status, "unknown"); assert.match(status.reason, /送信できたか確認できません/);
  input.end(); await serving; await rm(root, { recursive: true, force: true });
});

test("unknown 中の停止も終了確認までシグナルを送り続ける", async () => {
  const { EventEmitter } = await import("node:events");
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "codex-stop-unknown-")); const cwd = join(root, "work"); await mkdir(cwd);
  const input = new PassThrough(); const output = new PassThrough(); let response = ""; output.on("data", (chunk) => { response += chunk; });
  let child; let signals = []; let groupAlive = true;
  const spawnProcess = () => {
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.pid = 12345; child.on("exit", () => { groupAlive = false; });
    child.kill = (signal) => { signals.push(signal); return true; };
    child.stdin.end = () => { queueMicrotask(() => child.stdin.emit("error", new Error("EPIPE"))); };
    queueMicrotask(() => child.emit("spawn")); return child;
  };
  const serving = codex.serve({ input, output, listModels: async () => [{ model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], spawnProcess, killProcess: (pid, signal) => { if (signal === 0) { if (!groupAlive) throw Object.assign(new Error("gone"), { code: "ESRCH" }); return true; } child.kill(signal); }, allowedRoots: [root], stopGraceMs: 20 });
  const send = (id, name, args) => input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  send(1, "codex_start", { cwd, model: "model-a", effort: "medium", access: "read-only", instruction: "x" });
  while (!response.includes('"id":1')) await new Promise((resolve) => setTimeout(resolve, 2));
  const jobId = JSON.parse(response.trim().split("\n")[0]).result.structuredContent.jobId;
  await new Promise((resolve) => setTimeout(resolve, 0));
  send(2, "codex_stop", { jobId }); while (!response.includes('"id":2')) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(signals.includes("SIGTERM"), "unknown ジョブにも SIGTERM を送る");
  assert.equal(JSON.parse(response.trim().split("\n")[1]).result.structuredContent.status, "unknown", "終了確認前は stopped にしない");
  child.emit("exit", null, "SIGTERM");
  send(3, "codex_status", { jobId }); while (!response.includes('"id":3')) await new Promise((resolve) => setTimeout(resolve, 2));
  await new Promise((resolve) => setTimeout(resolve, 20));
  send(4, "codex_status", { jobId }); while (!response.includes('"id":4')) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(JSON.parse(response.trim().split("\n")[3]).result.structuredContent.status, "stopped");
  input.end(); await serving; await rm(root, { recursive: true, force: true });
});

test("停止処理中に stdin が失敗しても猶予後に SIGKILL を送り終了を待つ", async (t) => {
  const { EventEmitter } = await import("node:events");
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "codex-stop-kill-")); const cwd = join(root, "work"); await mkdir(cwd);
  const input = new PassThrough(); const output = new PassThrough(); let responseBuffer = ""; const waiting = new Map();
  output.on("data", (chunk) => { responseBuffer += chunk; let newline; while ((newline = responseBuffer.indexOf("\n")) >= 0) { const line = responseBuffer.slice(0, newline); responseBuffer = responseBuffer.slice(newline + 1); const message = JSON.parse(line); waiting.get(message.id)?.(line); waiting.delete(message.id); } });
  const responseFor = (id) => new Promise((resolve) => waiting.set(id, resolve));
  let child; const signals = []; let resolveKill; let resolveTerm; let resolveGone; let groupAlive = true;
  const killed = new Promise((resolve) => { resolveKill = resolve; });
  const termed = new Promise((resolve) => { resolveTerm = resolve; });
  const goneChecked = new Promise((resolve) => { resolveGone = resolve; });
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const spawnProcess = () => {
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.pid = 12346; child.on("exit", () => { groupAlive = false; });
    child.kill = (signal) => { signals.push(signal); if (signal === "SIGTERM") resolveTerm(); if (signal === "SIGKILL") resolveKill(); return true; };
    child.stdin.end = () => {};
    queueMicrotask(() => child.emit("spawn")); return child;
  };
  const serving = codex.serve({ input, output, listModels: async () => [{ model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], spawnProcess, killProcess: (pid, signal) => { if (signal === 0) { if (!groupAlive) { resolveGone(); throw Object.assign(new Error("gone"), { code: "ESRCH" }); } return true; } child.kill(signal); }, allowedRoots: [root], stopGraceMs: 20 });
  const send = (id, name, args) => input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  const startedResponse = responseFor(1);
  send(1, "codex_start", { cwd, model: "model-a", effort: "medium", access: "read-only", instruction: "x" });
  const jobId = JSON.parse(await startedResponse).result.structuredContent.jobId;
  const stoppedResponse = responseFor(2);
  send(2, "codex_stop", { jobId });
  await termed;
  child.stdin.emit("error", new Error("EPIPE"));
  await killed;
  assert.ok(signals.includes("SIGKILL"), "stdin エラー後も SIGKILL まで停止を続ける");
  const stopResult = JSON.parse(await stoppedResponse).result.structuredContent;
  assert.equal(stopResult.status, "unknown", "子プロセスの終了確認前は停止済みとしない");
  child.emit("exit", null, "SIGKILL");
  await goneChecked;
  const finalStatusResponse = responseFor(3);
  send(3, "codex_status", { jobId });
  assert.equal(JSON.parse(await finalStatusResponse).result.structuredContent.status, "stopped");
  input.end(); await serving; await rm(root, { recursive: true, force: true });
});

test("exit 後の遅延 error と stdin error は終端状態を上書きせず停止も終端結果を返す", async () => {
  const { EventEmitter } = await import("node:events");
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "codex-exit-errors-")); const cwd = join(root, "work"); await mkdir(cwd);
  const input = new PassThrough(); const output = new PassThrough(); let response = ""; output.on("data", (chunk) => { response += chunk; });
  let child;
  const spawnProcess = () => {
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.pid = 98765;
    child.kill = () => true; queueMicrotask(() => child.emit("spawn")); return child;
  };
  const serving = codex.serve({ input, output, listModels: async () => [{ model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], spawnProcess, allowedRoots: [root] });
  const send = (id, name, args) => input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  send(1, "codex_start", { cwd, model: "model-a", effort: "medium", access: "read-only", instruction: "x" });
  while (!response.includes('"id":1')) await new Promise((resolve) => setTimeout(resolve, 2));
  const jobId = JSON.parse(response.trim().split("\n")[0]).result.structuredContent.jobId;
  child.emit("exit", 0, null);
  child.emit("error", new Error("late process error"));
  child.stdin.emit("error", new Error("late stdin error"));
  send(2, "codex_status", { jobId });
  while (!response.includes('"id":2')) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(JSON.parse(response.trim().split("\n")[1]).result.structuredContent.status, "succeeded");
  send(3, "codex_stop", { jobId });
  while (!response.includes('"id":3')) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(JSON.parse(response.trim().split("\n")[2]).result.structuredContent.status, "succeeded");
  input.end(); await serving; await rm(root, { recursive: true, force: true });
});

test("既定の許可範囲は起動時の cwd でなく配置物から決まる", async () => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "codex-default-root-")); const cwd = process.cwd();
  const work = join(root, "work"); await mkdir(work);
  const input = new PassThrough(); const output = new PassThrough(); let response = ""; output.on("data", (chunk) => { response += chunk; });
  let spawnCount = 0;
  const old = process.cwd(); process.chdir(root);
  const serving = codex.serve({ input, output, listModels: async () => [{ model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], spawnProcess: () => { spawnCount += 1; throw new Error("unexpected"); } });
  process.chdir(old);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codex_start", arguments: { cwd: work, model: "model-a", effort: "medium", access: "read-only", instruction: "x" } } })}\n`);
  while (!response.includes('"id":1')) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(JSON.parse(response.trim()).result.structuredContent.kind, "not-started"); assert.equal(spawnCount, 0);
  input.end(); await serving; await rm(root, { recursive: true, force: true });
});

test("停止はプロセス本体の exit 後もグループ消滅まで待ち、猶予後にグループへ SIGKILL を送る", async () => {
  const { EventEmitter } = await import("node:events");
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "codex-stop-descendant-"));
  const cwd = join(root, "work"); await mkdir(cwd);
  const input = new PassThrough(); const output = new PassThrough(); let response = ""; output.on("data", (chunk) => { response += chunk; });
  const signals = []; let groupAlive = true; let child;
  const killProcess = (pid, signal) => {
    signals.push([pid, signal]);
    if (signal === 0) { if (groupAlive) return true; throw Object.assign(new Error("gone"), { code: "ESRCH" }); }
    if (signal === "SIGKILL") groupAlive = false;
    return true;
  };
  const spawnProcess = () => {
    child = new EventEmitter();
    child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.pid = 4_000_000_000;
    child.kill = () => true; child.stdin.end = () => {}; queueMicrotask(() => child.emit("spawn")); return child;
  };
  const serving = codex.serve({ input, output, listModels: async () => [{ model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], spawnProcess, killProcess, allowedRoots: [root], stopGraceMs: 15 });
  const send = (id, name, args) => input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  send(1, "codex_start", { cwd, model: "model-a", effort: "medium", access: "read-only", instruction: "x" });
  while (!response.includes('"id":1')) await new Promise((resolve) => setTimeout(resolve, 2));
  const jobId = JSON.parse(response.trim().split("\n")[0]).result.structuredContent.jobId;
  send(2, "codex_stop", { jobId });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const termWasInjected = signals.some(([, signal]) => signal === "SIGTERM");
  child.emit("exit", null, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(termWasInjected, "停止シグナルは注入した kill 経由で送る");
  assert.notEqual(JSON.parse(response.trim().split("\n")[1]).result.structuredContent.status, "stopped", "子孫が残る間は停止済みにしない");
  assert.ok(signals.some(([, signal]) => signal === "SIGKILL"), "猶予後に SIGKILL を送る");
  await new Promise((resolve) => setTimeout(resolve, 20));
  send(3, "codex_status", { jobId }); while (!response.includes('"id":3')) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(JSON.parse(response.trim().split("\n")[2]).result.structuredContent.status, "stopped");
  assert.ok(signals.every(([pid]) => pid === -4_000_000_000), "テストの偽 kill だけを使う");
  input.end(); await serving; await rm(root, { recursive: true, force: true });
});
