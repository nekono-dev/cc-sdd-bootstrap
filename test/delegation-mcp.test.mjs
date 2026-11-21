import { test } from "node:test";
import assert from "node:assert/strict";
import * as mcp from "../.agent-hooks/cc-sdd-bootstrap/delegation-mcp.mjs";
import { serve as serveCodex } from "../.agent-hooks/cc-sdd-bootstrap/codex-agent-mcp.mjs";
import { PassThrough, Writable } from "node:stream";
import { fingerprintTransport, listRegistrations, resolveRegistration } from "../.agent-hooks/cc-sdd-bootstrap/delegation-registry.mjs";

const ok = (result) => ({ jsonrpc: "2.0", id: result.id, result });
function tool(name, required, properties) {
  return { name, inputSchema: { type: "object", required, properties, additionalProperties: false } };
}
const string = { type: "string" };
const transport = { type: "stdio", command: "pi", args: ["mcp"], cwd: "/repo", env: { TOKEN: "secret" } };
const resolveTestRegistration = async (registration) => ({ ...registration, transportFingerprint: fingerprintTransport(transport) });
const piRegistration = (overrides = {}) => ({ status: "eligible", host: "pi", name: "pi-agent", family: "pi", scope: "project", registrationId: "registry-id", enabled: true, approved: true, trusted: true, transportType: "stdio", ...overrides });
const piTools = [
  tool("pi_capabilities", [], {}), tool("pi_models", [], {}),
  tool("pi_start", ["cwd", "instruction"], {
    cwd: string, instruction: string, model: string, access: { type: "string", enum: ["read-only", "workspace-write"] }, thinking: { type: "string", enum: ["off", "medium", "high"] }, session_id: { anyOf: [string, { type: "null" }] },
  }),
  tool("pi_status", ["job_id"], { job_id: string }),
  tool("pi_cancel", ["job_id"], { job_id: string }),
];

function fakeServer({ jsonText = false, tools = piTools, serverName = "pi-agent", protocolVersion = "2025-06-18" } = {}) {
  let input = "";
  let nextId;
  let killed = 0;
  const calls = [];
  const output = [];
  const response = (message) => {
    let result;
    if (message.method === "initialize") result = { ...(protocolVersion === null ? {} : { protocolVersion }), capabilities: { tools: {} }, serverInfo: { name: serverName, version: "1" } };
    else if (message.method === "tools/list") result = { tools };
    else if (message.method === "tools/call") {
      calls.push(message.params);
      const value = message.params.name === "pi_capabilities"
        ? { kind: "agent", harness: "pi", tier: "local", models: [{ id: "m1", accepted: [{ access: "workspace-write", effort: "off" }] }, { id: "m2", accepted: [{ access: "read-only", effort: "off" }] }] }
        : message.params.name === "pi_models" ? ["m1", "m2"]
          : message.params.name === "pi_start" ? { job_id: "j1", session_id: "s1" }
            : message.params.name === "pi_status" ? { status: "running" }
              : { status: "stopped" };
      result = jsonText ? { content: [{ type: "text", text: JSON.stringify(value) }] } : { structuredContent: value, content: [] };
    } else return;
    output.push(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
    queueMicrotask(() => { while (output.length) child.stdout.data?.(output.shift()); });
  };
  const child = {
    stdin: { write(chunk) { input += chunk; let index; while ((index = input.indexOf("\n")) >= 0) { const line = input.slice(0, index); input = input.slice(index + 1); const message = JSON.parse(line); if (message.id !== undefined) nextId = message.id; response(message); } return true; } },
    stdout: { setEncoding() {}, on(event, handler) { if (event === "data") this.data = handler; } },
    stderr: null,
    on() {}, kill() { killed += 1; },
  };
  return { child, calls, output, get killed() { return killed; }, get nextId() { return nextId; } };
}

test("Pi 接続は承認済みの同一 stdio 登録だけを初期化し、能力・モデルと各ジョブ操作を同じ接続で行う", async () => {
  const fake = fakeServer({ jsonText: true });
  const connection = await mcp.connectStdioRegistration({
    registration: piRegistration(),
    saved: { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: "registry-id" },
    verifiedFamily: "pi", readTransport: async () => transport, resolveRegistration: resolveTestRegistration, spawnProcess: () => fake.child,
  });
  assert.equal(connection.serverInfo.name, "pi-agent");
  const adapter = await mcp.createPiAdapter(connection);
  assert.deepEqual((await adapter.capabilities()).models[0].accepted, [{ access: "workspace-write", effort: "off" }]);
  assert.deepEqual(await adapter.models(), ["m1", "m2"]);
  const started = await adapter.start({ cwd: "/repo", instruction: "do it", model: "m1", access: "workspace-write", effort: "off" });
  assert.deepEqual(started, { kind: "started", job: { serverId: connection.serverId, connectionId: connection.connectionId, jobId: "j1" } });
  assert.deepEqual(await adapter.status("j1"), { status: "running" });
  assert.deepEqual(await adapter.cancel("j1"), { status: "stopped" });
  assert.deepEqual(fake.calls.map((call) => call.name), ["pi_capabilities", "pi_models", "pi_capabilities", "pi_models", "pi_start", "pi_status", "pi_cancel"]);
  assert.equal(connection.closed, false);
  await connection.close();
});

test("Codex 公開契約を共通能力へ変換し、起動後の MCP エラーを unknown とする", async () => {
  const codexTools = [
    tool("codex_capabilities", [], {}), tool("codex_models", [], {}),
    tool("codex_start", ["cwd", "model", "effort", "access", "instruction"], { cwd: string, model: string, effort: { type: "string", enum: ["medium", "high", "off"] }, access: { type: "string", enum: ["read-only", "workspace-write"] }, instruction: string }),
    tool("codex_status", ["jobId"], { jobId: string }), tool("codex_stop", ["jobId"], { jobId: string }),
  ];
  const calls = [];
  const connection = { serverInfo: { name: "cc-sdd-codex" }, tools: new Map(codexTools.map((entry) => [entry.name, entry])),
    async request(_method, { name }) { calls.push(name); if (name === "codex_capabilities") return { structuredContent: { kind:"agent", harness:"codex", tier:"cloud", models:[{id:"gpt", accepted:[{access:"read-only",effort:"high"}]}] } }; if (name === "codex_models") return { structuredContent:{ models:["gpt"] } }; if (name === "codex_start") return { isError:true, content:[] }; return { structuredContent:{status:"running"} }; }, close() {} };
  const adapter = await mcp.createCodexAdapter(connection);
  assert.deepEqual(await adapter.capabilities(), { kind:"agent", harness:"codex", tier:"cloud", models:[{id:"gpt",accepted:[{access:"read-only",effort:"high"}]}] });
  assert.deepEqual(await adapter.models(), ["gpt"]);
  assert.deepEqual(await adapter.start({cwd:"/repo", instruction:"work", model:"gpt", access:"read-only", effort:"high"}), {kind:"unknown", reason:"Codex 起動後の MCP 応答を確認できません"});
  assert.deepEqual(calls, ["codex_capabilities", "codex_models", "codex_capabilities", "codex_models", "codex_start"]);
});

test("Codex と Pi の起動入力は未知キーを起動前に拒否する", async () => {
  const codexTools = [
    tool("codex_capabilities", [], {}), tool("codex_models", [], {}),
    tool("codex_start", ["cwd", "model", "effort", "access", "instruction"], { cwd: string, model: string, effort: { type: "string", enum: ["medium", "high", "off"] }, access: { type: "string", enum: ["read-only", "workspace-write"] }, instruction: string }),
    tool("codex_status", ["jobId"], { jobId: string }), tool("codex_stop", ["jobId"], { jobId: string }),
  ];
  const codexCalls = [];
  const codex = await mcp.createCodexAdapter({ serverInfo: { name: "cc-sdd-codex" }, tools: new Map(codexTools.map((entry) => [entry.name, entry])), async request(_method, { name }) { codexCalls.push(name); if (name === "codex_capabilities") return { structuredContent: { kind: "agent", harness: "codex", tier: "cloud", models: [{ id: "gpt", accepted: [{ access: "read-only", effort: "high" }] }] } }; if (name === "codex_models") return { structuredContent: { models: ["gpt"] } }; return { structuredContent: { kind: "started", jobId: "j1" } }; } });
  const codexResult = await codex.start({ cwd: "/repo", instruction: "work", model: "gpt", access: "read-only", effort: "high", unexpected: true });
  assert.equal(codexResult.kind, "not-started");
  assert.equal(codexCalls.includes("codex_start"), false);

  const pi = fakeServer();
  const connection = await mcp.connectStdioRegistration({ registration: piRegistration(), saved: { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: "registry-id" }, verifiedFamily: "pi", readTransport: async () => transport, resolveRegistration: resolveTestRegistration, spawnProcess: () => pi.child });
  try {
    const adapter = await mcp.createPiAdapter(connection);
    assert.equal((await adapter.start({ cwd: "/repo", instruction: "do it", model: "m1", access: "workspace-write", effort: "off", unexpected: true })).kind, "not-started");
    assert.equal(pi.calls.some((call) => call.name === "pi_start"), false);
  } finally { await connection.close(); }
});

test("実 Codex MCP の公開契約で能力・モデル・起動・状態・停止を変換する", async () => {
  const clientInput = new PassThrough();
  const serverInput = new PassThrough();
  const clientOutput = new PassThrough();
  const serverChild = { stdin: clientInput, stdout: clientOutput, stderr: null, on() {}, kill() {} };
  const runnerEvents = new Map();
  const runnerChild = { pid: 4242, stdin: { end() {}, on() {} }, stdout: new PassThrough(), on(event, callback) { runnerEvents.set(event, callback); if (event === "spawn") queueMicrotask(callback); }, once(event, callback) { runnerEvents.set(event, callback); if (event === "spawn") queueMicrotask(callback); }, off() {} };
  const mcpServer = serveCodex({ input: serverInput, output: new Writable({ write(chunk, _encoding, callback) { clientOutput.write(chunk); callback(); } }),
    listModels: async () => [{ model: "gpt-test", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] }],
    spawnProcess: () => runnerChild, killProcess: (_pid, signal) => { if (signal === "SIGTERM") runnerEvents.get("exit")?.(null, "SIGTERM"); else throw Object.assign(new Error("gone"), { code: "ESRCH" }); } });
  clientInput.on("data", (chunk) => serverInput.write(chunk));
  const connection = await mcp.connectStdioRegistration({ registration: piRegistration({ host: "codex", name: "cc-sdd-codex", family: "codex" }),
    saved: { family: "codex", scope: "project", registrationName: "cc-sdd-codex", registrationId: "registry-id" }, verifiedFamily: "codex",
    readTransport: async () => transport, resolveRegistration: async (entry) => ({ ...entry, transportFingerprint: fingerprintTransport(transport) }), spawnProcess: () => serverChild });
  try {
    const adapter = await mcp.createCodexAdapter(connection);
    const capabilities = await adapter.capabilities();
    assert.equal(capabilities.kind, "agent");
    assert.equal(capabilities.tier, "cloud");
    assert.deepEqual(await adapter.models(), ["gpt-test"]);
    const started = await adapter.start({ cwd: process.cwd(), instruction: "work", model: "gpt-test", access: "read-only", effort: "medium" });
    assert.equal(started.kind, "started", started.reason);
    const status = await adapter.status(started.job.jobId);
    assert.equal(status.status, "running");
    const stopped = await adapter.stop(started.job.jobId);
    assert.equal(stopped.jobId, started.job.jobId);
    assert.equal(stopped.status, "stopped");
  } finally { await connection.close(); serverInput.end(); await mcpServer; }
});

test("Codex の未知スキーマ制約を除外し、起動前の一般エラーを not-started とする", async () => {
  const base = [tool("codex_capabilities", [], {}), tool("codex_models", [], {}),
    tool("codex_start", ["cwd", "model", "effort", "access", "instruction"], { cwd: string, model: string, effort: { type: "string", enum: ["medium", "high", "off"] }, access: { type: "string", enum: ["read-only", "workspace-write"] }, instruction: string }),
    tool("codex_status", ["jobId"], { jobId: string }), tool("codex_stop", ["jobId"], { jobId: string })];
  for (const constraint of [{ type: "string", pattern: "^safe" }, { type: "string", minimum: 1 }]) {
    const tools = base.map((entry) => entry.name === "codex_start" ? { ...entry, inputSchema: { ...entry.inputSchema, properties: { ...entry.inputSchema.properties, cwd: constraint } } } : entry);
    await assert.rejects(mcp.createCodexAdapter({ serverInfo: { name: "cc-sdd-codex" }, tools: new Map(tools.map((entry) => [entry.name, entry])) }), /スキーマ/);
  }
  const restricted = base.map((entry) => entry.name === "codex_start" ? { ...entry, inputSchema: { ...entry.inputSchema, properties: { ...entry.inputSchema.properties, cwd: { type: "string", enum: ["/another/path"] } } } } : entry);
  const published = (name) => name === "codex_capabilities"
    ? { structuredContent: { kind: "agent", harness: "codex", tier: "cloud", models: [{ id: "gpt", accepted: [{ access: "read-only", effort: "high" }] }] } }
    : { structuredContent: { models: ["gpt"] } };
  let constrainedStarts = 0;
  const constrained = await mcp.createCodexAdapter({ serverInfo: { name: "cc-sdd-codex" }, tools: new Map(restricted.map((entry) => [entry.name, entry])), request: async (_method, { name }) => { if (name === "codex_start") constrainedStarts += 1; return published(name); } });
  const constraintResult = await constrained.start({ cwd: "/repo", instruction: "work", model: "gpt", access: "read-only", effort: "high" });
  assert.equal(constraintResult.kind, "not-started");
  assert.match(constraintResult.reason, /公開スキーマの制約/);
  assert.equal(constrainedStarts, 0);

  const compatible = await mcp.createCodexAdapter({ serverInfo: { name: "cc-sdd-codex" }, tools: new Map(base.map((entry) => [entry.name, entry])), request: async (_method, { name }) => published(name) });
  for (const unsupported of [
    { model: "unpublished", access: "read-only", effort: "high" },
    { model: "gpt", access: "workspace-write", effort: "high" },
    { model: "gpt", access: "read-only", effort: "medium" },
  ]) {
    const rejected = await compatible.start({ cwd: "/repo", instruction: "work", ...unsupported });
    assert.equal(rejected.kind, "not-started");
    assert.match(rejected.reason, /公開していない/);
  }
  const tools = new Map(base.map((entry) => [entry.name, entry]));
  const unavailable = await mcp.createCodexAdapter({ serverInfo: { name: "cc-sdd-codex" }, tools,
    async request(_method, { name }) { if (name === "codex_capabilities") throw new Error("一般的な MCP エラー"); return { structuredContent: { models: ["gpt"] } }; } });
  assert.equal((await unavailable.start({ cwd: "/repo", instruction: "work", model: "gpt", access: "read-only", effort: "high" })).kind, "not-started");
});

test("Codex 状態・停止の jobId enum 制約は互換性を起動前に拒否する", async () => {
  const base = [tool("codex_capabilities", [], {}), tool("codex_models", [], {}),
    tool("codex_start", ["cwd", "model", "effort", "access", "instruction"], { cwd: string, model: string, effort: { type: "string", enum: ["medium", "high", "off"] }, access: { type: "string", enum: ["read-only", "workspace-write"] }, instruction: string }),
    tool("codex_status", ["jobId"], { jobId: string }), tool("codex_stop", ["jobId"], { jobId: string })];
  for (const [name, values] of [["codex_status", ["job-1"]], ["codex_stop", ["job-1"]]]) {
    const constrained = base.map((entry) => entry.name === name
      ? { ...entry, inputSchema: { ...entry.inputSchema, properties: { ...entry.inputSchema.properties, jobId: { type: "string", enum: values } } } }
      : entry);
    let starts = 0;
    await assert.rejects(mcp.createCodexAdapter({ serverInfo: { name: "cc-sdd-codex" }, tools: new Map(constrained.map((entry) => [entry.name, entry])),
      async request(_method, { name }) {
        if (name === "codex_start") starts += 1;
        if (name === "codex_capabilities") return { structuredContent: { kind: "agent", harness: "codex", tier: "cloud", models: [{ id: "gpt", accepted: [{ access: "read-only", effort: "high" }] }] } };
        if (name === "codex_models") return { structuredContent: { models: ["gpt"] } };
        return { structuredContent: { kind: "started", jobId: "job-unknown" } };
      } }), /スキーマ/);
    assert.equal(starts, 0, name);
  }

  const incompatible = base.map((entry) => entry.name === "codex_status"
    ? { ...entry, inputSchema: { ...entry.inputSchema, properties: { ...entry.inputSchema.properties, jobId: { type: "string", enum: ["status-only"] } } } }
    : entry.name === "codex_stop"
      ? { ...entry, inputSchema: { ...entry.inputSchema, properties: { ...entry.inputSchema.properties, jobId: { type: "string", enum: ["stop-only"] } } } }
      : entry);
  let incompatibleStarts = 0;
  await assert.rejects(mcp.createCodexAdapter({ serverInfo: { name: "cc-sdd-codex" }, tools: new Map(incompatible.map((entry) => [entry.name, entry])),
    async request(_method, { name }) {
      if (name === "codex_start") incompatibleStarts += 1;
      if (name === "codex_capabilities") return { structuredContent: { kind: "agent", harness: "codex", tier: "cloud", models: [{ id: "gpt", accepted: [{ access: "read-only", effort: "high" }] }] } };
      if (name === "codex_models") return { structuredContent: { models: ["gpt"] } };
      return { structuredContent: { kind: "started", jobId: "status-only" } };
    } }), /スキーマ/);
  assert.equal(incompatibleStarts, 0);
});

test("Codex unknown 起動結果の jobId を共通 job に変換して状態照会に使う", async () => {
  const base = [tool("codex_capabilities", [], {}), tool("codex_models", [], {}),
    tool("codex_start", ["cwd", "model", "effort", "access", "instruction"], { cwd: string, model: string, effort: { type: "string", enum: ["medium", "high", "off"] }, access: { type: "string", enum: ["read-only", "workspace-write"] }, instruction: string }),
    tool("codex_status", ["jobId"], { jobId: string }), tool("codex_stop", ["jobId"], { jobId: string })];
  const calls = [];
  const adapter = await mcp.createCodexAdapter({ serverInfo: { name: "cc-sdd-codex" }, tools: new Map(base.map((entry) => [entry.name, entry])),
    async request(_method, { name, arguments: args }) {
      calls.push({ name, args });
      if (name === "codex_capabilities") return { structuredContent: { kind: "agent", harness: "codex", tier: "cloud", models: [{ id: "gpt", accepted: [{ access: "read-only", effort: "high" }] }] } };
      if (name === "codex_models") return { structuredContent: { models: ["gpt"] } };
      if (name === "codex_start") return { structuredContent: { kind: "unknown", reason: "応答が途切れました", jobId: "job-7" } };
      return { structuredContent: { status: "running", jobId: args.jobId } };
    } });
  const result = await adapter.start({ cwd: "/repo", instruction: "work", model: "gpt", access: "read-only", effort: "high" });
  assert.deepEqual(result, { kind: "unknown", reason: "応答が途切れました", job: { serverId: "mcp:cc-sdd-codex", connectionId: result.job.connectionId, jobId: "job-7" } });
  assert.deepEqual(await adapter.status(result.job.jobId), { status: "running", jobId: "job-7" });
  assert.equal(calls.at(-1).name, "codex_status");
  assert.equal(calls.at(-1).args.jobId, "job-7");
});

test("Codex 起動応答は許可リストで共通結果へ変換する", async () => {
  const base = [tool("codex_capabilities", [], {}), tool("codex_models", [], {}),
    tool("codex_start", ["cwd", "model", "effort", "access", "instruction"], { cwd: string, model: string, effort: { type: "string", enum: ["medium", "high", "off"] }, access: { type: "string", enum: ["read-only", "workspace-write"] }, instruction: string }),
    tool("codex_status", ["jobId"], { jobId: string }), tool("codex_stop", ["jobId"], { jobId: string })];
  const responses = [
    { kind: "started", job: { forged: true }, extra: "drop" },
    { kind: "not-started", extra: "drop" },
    { kind: "unknown", job: { forged: true }, extra: "drop" },
    { kind: "unknown", reason: "uncertain", jobId: "job-8", extra: "drop" },
    { kind: "started", jobId: "job-9", extra: "drop" },
    { kind: "future-kind", jobId: "job-10", reason: "ignore" },
  ];
  const adapter = await mcp.createCodexAdapter({ serverInfo: { name: "cc-sdd-codex" }, tools: new Map(base.map((entry) => [entry.name, entry])),
    async request(_method, { name }) {
      if (name === "codex_capabilities") return { structuredContent: { kind: "agent", harness: "codex", tier: "cloud", models: [{ id: "gpt", accepted: [{ access: "read-only", effort: "high" }] }] } };
      if (name === "codex_models") return { structuredContent: { models: ["gpt"] } };
      return { structuredContent: responses.shift() };
    } });
  const start = () => adapter.start({ cwd: "/repo", instruction: "work", model: "gpt", access: "read-only", effort: "high" });
  assert.deepEqual(await start(), { kind: "unknown", reason: "Codex 起動結果を確認できません" });
  assert.deepEqual(await start(), { kind: "not-started", reason: "Codex 起動前に拒否されました" });
  assert.deepEqual(await start(), { kind: "unknown", reason: "Codex 起動結果を確認できません" });
  const unknown = await start();
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.reason, "uncertain");
  assert.equal(unknown.job.jobId, "job-8");
  assert.deepEqual(Object.keys(unknown), ["kind", "reason", "job"]);
  const started = await start();
  assert.equal(started.kind, "started");
  assert.equal(started.job.jobId, "job-9");
  assert.deepEqual(Object.keys(started.job).sort(), ["connectionId", "jobId", "serverId"]);
  assert.deepEqual(await start(), { kind: "unknown", reason: "Codex 起動結果を確認できません" });
});

test("Codex 起動応答で空 jobId を拒否し、unknown の jobId も共通検証する", async () => {
  const base = [tool("codex_capabilities", [], {}), tool("codex_models", [], {}),
    tool("codex_start", ["cwd", "model", "effort", "access", "instruction"], { cwd: string, model: string, effort: { type: "string", enum: ["medium", "high", "off"] }, access: { type: "string", enum: ["read-only", "workspace-write"] }, instruction: string }),
    tool("codex_status", ["jobId"], { jobId: string }), tool("codex_stop", ["jobId"], { jobId: string })];
  const responses = [
    { kind: "started", jobId: "" },
    { kind: "unknown", reason: "uncertain", jobId: "" },
    { kind: "started", jobId: "valid-job" },
    { kind: "unknown", reason: "uncertain", jobId: "valid-job" },
  ];
  const adapter = await mcp.createCodexAdapter({ serverInfo: { name: "cc-sdd-codex" }, tools: new Map(base.map((entry) => [entry.name, entry])),
    async request(_method, { name }) {
      if (name === "codex_capabilities") return { structuredContent: { kind: "agent", harness: "codex", tier: "cloud", models: [{ id: "gpt", accepted: [{ access: "read-only", effort: "high" }] }] } };
      if (name === "codex_models") return { structuredContent: { models: ["gpt"] } };
      return { structuredContent: responses.shift() };
    } });
  assert.deepEqual(await adapter.start({ cwd: "/repo", instruction: "work", model: "gpt", access: "read-only", effort: "high" }), { kind: "unknown", reason: "Codex 起動結果を確認できません" });
  assert.deepEqual(await adapter.start({ cwd: "/repo", instruction: "work", model: "gpt", access: "read-only", effort: "high" }), { kind: "unknown", reason: "uncertain" });
  const started = await adapter.start({ cwd: "/repo", instruction: "work", model: "gpt", access: "read-only", effort: "high" });
  assert.equal(started.kind, "started");
  assert.deepEqual(await adapter.start({ cwd: "/repo", instruction: "work", model: "gpt", access: "read-only", effort: "high" }), { kind: "unknown", reason: "uncertain", job: { ...started.job } });
});

test("stdio 以外・起動スキーマ不一致は接続候補にしない", async () => {
  const base = piRegistration();
  const saved = { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: base.registrationId };
  await assert.rejects(mcp.connectStdioRegistration({ registration: base, saved, verifiedFamily: "pi", readTransport: async () => ({ type: "http", url: "https://invalid" }), resolveRegistration: resolveTestRegistration, spawnProcess: () => fakeServer().child }));
  const fake = fakeServer({ tools: piTools.map((entry) => entry.name === "pi_start" ? { ...entry, inputSchema: { type: "object", properties: { cwd: string, instruction: string }, required: ["cwd", "instruction"] } } : entry) });
  const connected = await mcp.connectStdioRegistration({ registration: base, saved, verifiedFamily: "pi", readTransport: async () => transport, resolveRegistration: resolveTestRegistration, spawnProcess: () => fake.child });
  await assert.rejects(mcp.createPiAdapter(connected), /スキーマ/);
});

test("構造化応答と JSON テキストを読み、応答の JSON 形が崩れたら拒否する", async () => {
  const fake = fakeServer({ jsonText: false });
  const connection = await mcp.connectStdioRegistration({ registration: piRegistration(),
    saved: { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: piRegistration().registrationId }, verifiedFamily: "pi", readTransport: async () => transport, resolveRegistration: resolveTestRegistration, spawnProcess: () => fake.child });
  const adapter = await mcp.createPiAdapter(connection);
  assert.equal((await adapter.capabilities()).kind, "agent");
  await connection.close();
});

test("registry の eligible 結果を受け取り、接続先の系統を維持する", async () => {
  const registration = piRegistration({ host: "codex" });
  const saved = { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: "registry-id" };
  const fake = fakeServer();
  const connection = await mcp.connectStdioRegistration({ registration, saved, verifiedFamily: "pi",
    readTransport: async () => transport, resolveRegistration: resolveTestRegistration, spawnProcess: () => fake.child });
  assert.equal(connection.serverInfo.name, "pi-agent");
  await connection.close();
  await connection.close();
});

test("Pi起動はモデルごとの公開された権限・推論量だけを受け付ける", async () => {
  const fake = fakeServer();
  const connection = await mcp.connectStdioRegistration({ registration: piRegistration(),
    saved: { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: "registry-id" },
    verifiedFamily: "pi", readTransport: async () => transport, resolveRegistration: resolveTestRegistration, spawnProcess: () => fake.child });
  const adapter = await mcp.createPiAdapter(connection);
  const rejected = await adapter.start({ cwd: "/repo", instruction: "do it", model: "m1", access: "workspace-write", effort: "medium" });
  assert.equal(rejected.kind, "not-started");
  await connection.close();
});

test("接続時に承認済み登録を再解決し、stdio の指紋一致を確認する", async () => {
  const { fingerprintTransport, resolveRegistration } = await import("../.agent-hooks/cc-sdd-bootstrap/delegation-registry.mjs");
  const source = { host: "pi", name: "pi-agent", family: "pi", scope: "project", enabled: true, approved: true, trusted: true, transport };
  const saved = { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: fingerprintTransport(transport) };
  const registration = resolveRegistration(source, saved, { verifiedFamily: "pi" });
  assert.equal(registration.status, "eligible");
  assert.equal(registration.transportFingerprint, fingerprintTransport(transport));
  for (const [read, resolve] of [[async () => ({ ...transport, command: "other" }), async () => registration], [async () => transport, async () => ({ ...registration, status: "disabled" })]]) {
    let spawned = false;
    await assert.rejects(mcp.connectStdioRegistration({ registration, saved, verifiedFamily: "pi", readTransport: read, resolveRegistration: resolve, spawnProcess: () => { spawned = true; return fakeServer().child; } }));
    assert.equal(spawned, false);
  }
});

test("未対応または欠落した initialize protocolVersion はツール照会前に拒否して子を解放する", async () => {
  for (const protocolVersion of ["2025-11-25", null]) {
    const fake = fakeServer({ protocolVersion });
    await assert.rejects(mcp.connectStdioRegistration({ registration: piRegistration(), saved: { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: "registry-id" }, verifiedFamily: "pi", readTransport: async () => transport, resolveRegistration: resolveTestRegistration, spawnProcess: () => fake.child }));
    assert.equal(fake.killed, 1);
    assert.equal(fake.nextId, 1);
  }
});

test("Pi 公開スキーマの全引数型を照合し、不正型を除外する", async () => {
  const variants = [
    ["model", { type: "integer" }], ["instruction", { type: "integer"}], ["cwd", { type: "integer"}],
    ["session_id", { anyOf: [{ type: "integer" }, { type: "null" }] }],
    ["access", { type: "integer", enum: ["read-only", "workspace-write"] }],
    ["thinking", { type: "integer", enum: ["off", "medium", "high"] }],
  ];
  for (const [field, value] of variants) {
    const tools = piTools.map((entry) => entry.name === "pi_start" ? { ...entry, inputSchema: { ...entry.inputSchema, properties: { ...entry.inputSchema.properties, [field]: value } } } : entry);
    const fake = fakeServer({ tools });
    const conn = await mcp.connectStdioRegistration({ registration: piRegistration(), saved: { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: "registry-id" }, verifiedFamily: "pi", readTransport: async () => transport, resolveRegistration: resolveTestRegistration, spawnProcess: () => fake.child });
    await assert.rejects(mcp.createPiAdapter(conn), /スキーマ/);
    assert.equal(conn.closed, true);
  }
});

test("Pi 起動値を制限する公開 enum は不一致なら起動前に除外する", async () => {
  const variants = [
    ["model", { type: "string", enum: ["other"] }],
    ["session_id", { type: "string", enum: ["other"] }],
    ["instruction", { type: "string", enum: ["other"] }],
    ["cwd", { type: "string", enum: ["/other"] }],
  ];
  for (const [field, value] of variants) {
    const tools = piTools.map((entry) => entry.name === "pi_start" ? { ...entry, inputSchema: { ...entry.inputSchema, properties: { ...entry.inputSchema.properties, [field]: value } } } : entry);
    const fake = fakeServer({ tools });
    const conn = await mcp.connectStdioRegistration({ registration: piRegistration(), saved: { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: "registry-id" }, verifiedFamily: "pi", readTransport: async () => transport, resolveRegistration: resolveTestRegistration, spawnProcess: () => fake.child });
    const adapter = await mcp.createPiAdapter(conn);
    assert.equal((await adapter.start({ cwd: "/repo", instruction: "do it", model: "m1", access: "workspace-write", effort: "off", session_id: "s1" })).kind, "not-started");
    assert.equal(fake.calls.some((call) => call.name === "pi_start"), false);
  }
});

test("評価できない起動スキーマ制約と job_id enum は該当ツール呼び出し前に拒否する", async () => {
  const variants = [
    ["pi_start", "model", { type: "string", const: "m1" }],
    ["pi_start", "instruction", { type: "string", pattern: "^safe" }],
    ["pi_start", "cwd", { type: "string", allOf: [{ type: "string" }] }],
    ["pi_status", "job_id", { type: "string", enum: ["other"] }],
    ["pi_cancel", "job_id", { type: "string", enum: ["other"] }],
    ["pi_status", "job_id", { type: "string", allOf: [{ type: "string" }] }],
    ["pi_cancel", "job_id", { type: "string", allOf: [{ type: "string" }] }],
  ];
  for (const [toolName, field, value] of variants) {
    const tools = piTools.map((entry) => entry.name === toolName
      ? { ...entry, inputSchema: { ...entry.inputSchema, properties: { ...entry.inputSchema.properties, [field]: value } } }
      : entry);
    const fake = fakeServer({ tools });
    const connection = await mcp.connectStdioRegistration({ registration: piRegistration(),
      saved: { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: "registry-id" },
      verifiedFamily: "pi", readTransport: async () => transport, resolveRegistration: resolveTestRegistration, spawnProcess: () => fake.child });
    let adapter;
    try { adapter = await mcp.createPiAdapter(connection); }
    catch { /* スキーマ検証時点で候補を除外 */ }
    if (adapter && toolName === "pi_start") await assert.rejects(adapter.start({ cwd: "/repo", instruction: "do it", model: "m1", access: "workspace-write", effort: "off" }));
    if (adapter && toolName === "pi_status") await assert.rejects(adapter.status("j1"));
    if (adapter && toolName === "pi_cancel") await assert.rejects(adapter.cancel("j1"));
    assert.equal(fake.calls.some((call) => call.name === toolName), false, `${toolName} が呼び出されない`);
  }
});

test("Pi inputSchema 直下の評価できない制約を候補採用前に拒否する", async () => {
  const variants = [
    ["pi_start", { allOf: [{ properties: { model: { const: "m1" } } }] }],
    ["pi_status", { oneOf: [{ type: "object" }] }],
    ["pi_cancel", { oneOf: [{ type: "object" }] }],
  ];
  for (const [toolName, constraint] of variants) {
    const tools = piTools.map((entry) => entry.name === toolName
      ? { ...entry, inputSchema: { ...entry.inputSchema, ...constraint } }
      : entry);
    const fake = fakeServer({ tools });
    const connection = await mcp.connectStdioRegistration({ registration: piRegistration(),
      saved: { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: "registry-id" },
      verifiedFamily: "pi", readTransport: async () => transport, resolveRegistration: resolveTestRegistration, spawnProcess: () => fake.child });
    await assert.rejects(mcp.createPiAdapter(connection), /スキーマ/, `${toolName} は採用されない`);
    assert.equal(fake.calls.some((call) => call.name === toolName), false, `${toolName} の tools/call を送信しない`);
  }
});

test("transportFingerprint 付きの分類結果を再解決し、一致時だけ接続を起動する", async () => {
  const fingerprinted = { ...piRegistration(), transportFingerprint: fingerprintTransport(transport) };
  const listed = [{ ...fingerprinted }];
  const saved = { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: "registry-id" };
  const resolved = resolveRegistration(listed[0], saved, { verifiedFamily: "pi" });
  assert.equal(resolved.status, "eligible");
  assert.equal(resolved.transportFingerprint, fingerprintTransport(transport));

  let spawned = false;
  const connection = await mcp.connectStdioRegistration({ registration: listed[0], saved, verifiedFamily: "pi",
    readTransport: async () => transport,
    resolveRegistration: async (source, identity, family) => resolveRegistration(source, identity, { verifiedFamily: family }),
    spawnProcess: () => { spawned = true; return fakeServer().child; },
  });
  assert.equal(spawned, true);
  await connection.close();
});

test("listRegistrations の保存済み Codex 登録を再解決して同じ指紋の stdio だけ起動する", async () => {
  const listedTransport = { type: "stdio", command: "pi", args: ["mcp"], env: { TOKEN: "secret" } };
  const codexList = JSON.stringify([{ name: "pi-agent", enabled: true, disabled_reason: null, transport: listedTransport }]);
  const config = { mcp_servers: { "pi-agent": { command: "pi", args: ["mcp"], env: { TOKEN: "secret" } } } };
  const originName = { type: "user", file: "/home/u/.codex/config.toml" };
  const listed = await listRegistrations("codex", { cwd: "/repo", run: async () => codexList,
    appServer: async () => ({ config, origins: {
      "mcp_servers.pi-agent.command": { name: originName, version: "1" },
      "mcp_servers.pi-agent.args": { name: originName, version: "1" },
      "mcp_servers.pi-agent.env.TOKEN": { name: originName, version: "1" },
    }, layers: [{ name: originName, disabledReason: null, config: {} }] }),
  });
  const registration = listed[0];
  const saved = { family: "codex", scope: registration.scope, registrationName: registration.name, registrationId: registration.registrationId };
  const resolved = resolveRegistration(registration, saved, { verifiedFamily: "codex" });
  assert.equal(registration.status, "eligible");
  assert.equal(resolved.status, "eligible");
  assert.equal(resolved.transportFingerprint, fingerprintTransport(listedTransport));

  const fake = fakeServer();
  const connection = await mcp.connectStdioRegistration({ registration, saved, verifiedFamily: "codex",
    readTransport: async () => listedTransport,
    resolveRegistration: async (source, identity, family) => resolveRegistration(source, identity, { verifiedFamily: family }),
    spawnProcess: () => fake.child,
  });
  assert.equal(connection.serverInfo.name, "pi-agent");
  await connection.close();
  let spawned = false;
  await assert.rejects(mcp.connectStdioRegistration({ registration, saved, verifiedFamily: "codex",
    readTransport: async () => ({ ...listedTransport, args: ["other"] }),
    resolveRegistration: async (source, identity, family) => resolveRegistration(source, identity, { verifiedFamily: family }),
    spawnProcess: () => { spawned = true; return fakeServer().child; },
  }));
  assert.equal(spawned, false);
});

test("必須の未送信引数がある能力・モデル・起動スキーマは除外する", async () => {
  for (const name of ["pi_capabilities", "pi_models", "pi_start"]) {
    const fake = fakeServer({ tools: piTools.map((entry) => entry.name === name
      ? { ...entry, inputSchema: { ...entry.inputSchema, required: [...(entry.inputSchema.required ?? []), "unsupported"] } }
      : entry) });
    const connection = await mcp.connectStdioRegistration({ registration: piRegistration(),
      saved: { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: "registry-id" },
      verifiedFamily: "pi", readTransport: async () => transport, resolveRegistration: resolveTestRegistration, spawnProcess: () => fake.child });
    await assert.rejects(mcp.createPiAdapter(connection), /スキーマ/);
    assert.equal(connection.closed, true);
  }
});

test("MCP 初期化前のストリーム設定失敗でも子プロセスを解放する", async () => {
  const fake = fakeServer();
  fake.child.stdout.setEncoding = () => { throw new Error("broken stream"); };
  await assert.rejects(mcp.connectStdioRegistration({ registration: piRegistration(),
    saved: { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: "registry-id" },
    verifiedFamily: "pi", readTransport: async () => transport, resolveRegistration: resolveTestRegistration, spawnProcess: () => fake.child }));
  assert.equal(fake.killed, 1);
});

test("registry の pending・disabled・unknown は起動前に拒否する", async () => {
  for (const status of ["pending", "disabled", "unknown"]) {
    let spawned = false;
    await assert.rejects(mcp.connectStdioRegistration({ registration: piRegistration({ status }), saved: { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: "registry-id" }, verifiedFamily: "pi", readTransport: async () => transport, resolveRegistration: resolveTestRegistration, spawnProcess: () => { spawned = true; return fakeServer().child; } }));
    assert.equal(spawned, false);
  }
});

test("stdin の非同期 EPIPE は接続失敗として処理し未処理例外にしない", async () => {
  const fake = fakeServer();
  let onError;
  fake.child.stdin.on = (event, handler) => { if (event === "error") onError = handler; };
  fake.child.stdin.write = () => { queueMicrotask(() => onError(Object.assign(new Error("pipe closed"), { code: "EPIPE" }))); return true; };
  await assert.rejects(mcp.connectStdioRegistration({ registration: piRegistration(), saved: { family: "pi", scope: "project", registrationName: "pi-agent", registrationId: "registry-id" }, verifiedFamily: "pi", readTransport: async () => transport, resolveRegistration: resolveTestRegistration, spawnProcess: () => fake.child }), /終了|応答/);
  assert.equal(fake.killed, 1);
});
