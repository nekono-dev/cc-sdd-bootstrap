import { test } from "node:test";
import assert from "node:assert/strict";
import * as mcp from "../.agent-hooks/cc-sdd-bootstrap/delegation-mcp.mjs";
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
  assert.deepEqual(await adapter.start({ cwd: "/repo", instruction: "do it", model: "m1", access: "workspace-write", effort: "off" }), { job_id: "j1", session_id: "s1" });
  assert.deepEqual(await adapter.status("j1"), { status: "running" });
  assert.deepEqual(await adapter.cancel("j1"), { status: "stopped" });
  assert.deepEqual(fake.calls.map((call) => call.name), ["pi_capabilities", "pi_models", "pi_capabilities", "pi_models", "pi_start", "pi_status", "pi_cancel"]);
  assert.equal(connection.closed, false);
  await connection.close();
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
  await assert.rejects(adapter.start({ cwd: "/repo", instruction: "do it", model: "m1", access: "workspace-write", effort: "medium" }), /公開|対応/);
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
    await assert.rejects(adapter.start({ cwd: "/repo", instruction: "do it", model: "m1", access: "workspace-write", effort: "off", session_id: "s1" }), /公開|スキーマ/);
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
