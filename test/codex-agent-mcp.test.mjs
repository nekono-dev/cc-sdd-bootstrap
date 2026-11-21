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
  assert.deepEqual(results[0].result.tools.map((tool) => tool.name), ["codex_capabilities", "codex_models"]);
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
