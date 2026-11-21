import { spawn } from "node:child_process";
import { fingerprintTransport } from "./delegation-registry.mjs";

// MCP 接続と、確認済み Pi サーバーの公開契約を扱う。
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message) {
  return new Error(message);
}

function validateRegistration(registration, saved, verifiedFamily, transport) {
  if (!isObject(registration) || registration.status !== "eligible") throw fail("登録が承認済みではありません");
  if (!isObject(registration) || !["claude", "codex", "pi"].includes(registration.host) ||
      !["project", "user"].includes(registration.scope) || typeof registration.name !== "string" ||
      typeof registration.registrationId !== "string") throw fail("承認済み登録の記述が不正です");
  if (!isObject(saved) || saved.family !== verifiedFamily || saved.scope !== registration.scope ||
      saved.registrationName !== registration.name || saved.registrationId !== registration.registrationId) {
    throw fail("保存済み登録と一致しません");
  }
  if (typeof verifiedFamily !== "string" || !verifiedFamily) throw fail("接続先の系統を確認できません");
  if (!isObject(transport) || typeof transport.command !== "string" || !transport.command ||
      transport.type !== "stdio" ||
      transport.args !== undefined && (!Array.isArray(transport.args) || !transport.args.every((value) => typeof value === "string")) ||
      transport.cwd !== undefined && typeof transport.cwd !== "string" ||
      transport.env !== undefined && (!isObject(transport.env) || !Object.values(transport.env).every((value) => typeof value === "string"))) {
    throw fail("stdio 登録の形式を確認できません");
  }
  return transport;
}

/** MCP JSON-RPC 接続を初期化し、公開ツール一覧と同じプロセスへの要求口を返す。 */
export async function connectStdioRegistration({ registration, saved, verifiedFamily, readTransport, resolveRegistration, spawnProcess = spawn, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (typeof readTransport !== "function" || typeof resolveRegistration !== "function") throw fail("ホストから登録を再解決する関数が必要です");
  let transport;
  try {
    const current = await resolveRegistration(registration, saved, verifiedFamily);
    if (!isObject(current) || current.status !== "eligible") throw fail("登録が承認済みではありません");
    transport = validateRegistration(current, saved, verifiedFamily, await readTransport(current));
    if (typeof current.transportFingerprint !== "string" || fingerprintTransport(transport) !== current.transportFingerprint) throw fail("接続情報が承認済み登録と一致しません");
  }
  catch (error) { if (error instanceof Error) throw error; throw fail("登録情報を読み直せません"); }
  let child;
  try {
    child = spawnProcess(transport.command, transport.args ?? [], {
      cwd: transport.cwd,
      env: { ...process.env, ...(transport.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw fail("登録済み MCP を起動できません");
  }

  let buffer = "";
  child.stdin.on?.("error", () => close());
  child.stderr?.on("data", () => {});
  let id = 0;
  let closed = false;
  const pending = new Map();
  const finishPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    finishPending(fail("MCP 接続が終了しました"));
    try { child.kill(); } catch { /* 終了済み */ }
  };
  const onLine = (line) => {
    let message;
    try { message = JSON.parse(line); } catch { close(); return; }
    if (!isObject(message) || !Number.isInteger(message.id)) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(fail("MCP 要求が失敗しました"));
    else if (!Object.hasOwn(message, "result") || !isObject(message.result)) entry.reject(fail("MCP 応答の形式が不正です"));
    else entry.resolve(message.result);
  };
  try {
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (Buffer.byteLength(buffer) + Buffer.byteLength(chunk) > MAX_MESSAGE_BYTES) return close();
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0 && !closed) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
      index = buffer.indexOf("\n");
    }
  });
  child.on("error", close);
  child.on("exit", close);

  const notify = (method, params) => {
    if (closed) throw fail("MCP 接続が終了しました");
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`); }
    catch { close(); throw fail("MCP 通知を送信できません"); }
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed) return reject(fail("MCP 接続が終了しました"));
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(fail("MCP 応答が時間内に届きません"));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, ...(params === undefined ? {} : { params }) })}\n`); }
    catch { clearTimeout(timer); pending.delete(requestId); close(); reject(fail("MCP 要求を送信できません")); }
  });

    const initialized = await request("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cc-sdd-bootstrap", version: "0" },
    });
    if (!isObject(initialized.serverInfo) || typeof initialized.serverInfo.name !== "string") throw fail("MCP サーバー識別情報がありません");
    if (!SUPPORTED_PROTOCOL_VERSIONS.has(initialized.protocolVersion)) throw fail("MCP プロトコル版に対応していません");
    notify("notifications/initialized");
    const listed = await request("tools/list");
    if (!Array.isArray(listed.tools) || !listed.tools.every((tool) => isObject(tool) && typeof tool.name === "string")) throw fail("MCP 公開ツール一覧の形式が不正です");
    const tools = new Map();
    for (const tool of listed.tools) {
      if (tools.has(tool.name)) throw fail("MCP 公開ツール名が重複しています");
      tools.set(tool.name, tool);
    }
    return {
      serverInfo: initialized.serverInfo,
      tools,
      request,
      notify,
      close,
      get closed() { return closed; },
    };
  } catch (error) {
    close();
    throw error;
  }
}

function hasProperty(schema, name, expectedType) {
  const property = schema.properties?.[name];
  if (!isObject(property)) return false;
  if (expectedType && property.type !== expectedType) return false;
  return true;
}

function hasEnum(schema, name, values) {
  const property = schema.properties?.[name];
  return isObject(property) && Array.isArray(property.enum) && values.every((value) => property.enum.includes(value));
}

function schemaAccepts(schema, name, value) {
  const property = schema.properties?.[name];
  if (!isObject(property)) return false;
  const allowedKeys = new Set(["type", "enum", "anyOf", "title", "default", "description"]);
  if (Object.keys(property).some((key) => !allowedKeys.has(key))) return false;
  const accepts = (constraint) => {
    if (!isObject(constraint)) return false;
    if (Object.keys(constraint).some((key) => !allowedKeys.has(key))) return false;
    if (Array.isArray(constraint.anyOf) && !constraint.anyOf.every((item) => isObject(item) && Object.keys(item).length === 1 && typeof item.type === "string")) return false;
    if (Array.isArray(constraint.enum) && !constraint.enum.includes(value)) return false;
    const typeMatches = constraint.type === undefined ? true : constraint.type === "string" ? typeof value === "string" :
      constraint.type === "null" ? value === null : constraint.type === "integer" ? Number.isInteger(value) :
        constraint.type === "number" ? typeof value === "number" : constraint.type === "boolean" ? typeof value === "boolean" :
          constraint.type === "object" ? isObject(value) : constraint.type === "array" ? Array.isArray(value) : false;
    if (!typeMatches) return false;
    if (Array.isArray(constraint.anyOf) && !constraint.anyOf.some(accepts)) return false;
    return true;
  };
  return accepts(property);
}

function schemaAllowsSimpleArgument(schema, name, { rejectEnum = false } = {}) {
  const property = schema.properties?.[name];
  if (!isObject(property)) return false;
  const allowedKeys = new Set(["type", "enum", "anyOf", "title", "default", "description"]);
  if (Object.keys(property).some((key) => !allowedKeys.has(key))) return false;
  if (rejectEnum && Object.hasOwn(property, "enum")) return false;
  return property.anyOf === undefined || Array.isArray(property.anyOf) && property.anyOf.every((item) => isObject(item) && Object.keys(item).length === 1 && typeof item.type === "string");
}

function hasAnyOf(schema, name, allowedTypes) {
  const property = schema.properties?.[name];
  if (!isObject(property) || !Array.isArray(property.anyOf)) return false;
  const types = property.anyOf.map((item) => isObject(item) ? item.type : undefined);
  return allowedTypes.every((type) => types.includes(type)) && types.every((type) => allowedTypes.includes(type));
}

function validatePiTools(tools) {
  const validateRootSchema = (name, schema) => {
    const allowedKeys = new Set(["type", "properties", "required", "title", "description", "additionalProperties", "$schema"]);
    if (Object.keys(schema).some((key) => !allowedKeys.has(key)) ||
        schema.type !== "object" || !isObject(schema.properties) ||
        (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((field) => typeof field !== "string"))) ||
        (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") ||
        (["title", "description", "$schema"].some((key) => schema[key] !== undefined && typeof schema[key] !== "string"))) {
      throw fail(`Pi の ${name} 公開スキーマを確認できません`);
    }
  };
  const required = (name, names) => {
    const tool = tools.get(name);
    const requiredFields = Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [];
    if (!tool || !isObject(tool.inputSchema) || tool.inputSchema.type !== "object" || !isObject(tool.inputSchema.properties) ||
        names.some((field) => !tool.inputSchema.properties[field]) || requiredFields.some((field) => !names.includes(field))) {
      throw fail(`Pi の ${name} 公開スキーマを確認できません`);
    }
    validateRootSchema(name, tool.inputSchema);
    return tool.inputSchema;
  };
  required("pi_capabilities", []);
  required("pi_models", []);
  const start = required("pi_start", ["cwd", "instruction", "model", "access", "thinking"]);
  const startRequired = tools.get("pi_start").inputSchema.required ?? [];
  if (!["cwd", "instruction", "model"].every((name) => hasProperty(start, name, "string")) ||
      !["cwd", "instruction", "model", "access", "thinking", "session_id"].every((name) => schemaAllowsSimpleArgument(start, name)) ||
      !["cwd", "instruction"].every((name) => startRequired.includes(name)) ||
      !(hasProperty(start, "session_id", "string") || hasAnyOf(start, "session_id", ["string", "null"])) ||
      !hasProperty(start, "access", "string") || !hasEnum(start, "access", ["read-only", "workspace-write"]) ||
      !hasProperty(start, "thinking", "string") || !hasEnum(start, "thinking", ["off", "medium", "high"])) {
    throw fail("Pi の pi_start 公開スキーマを確認できません");
  }
  const status = required("pi_status", ["job_id"]);
  const cancel = required("pi_cancel", ["job_id"]);
  if (!hasProperty(status, "job_id", "string") || !hasProperty(cancel, "job_id", "string") ||
      !schemaAllowsSimpleArgument(status, "job_id", { rejectEnum: true }) || !schemaAllowsSimpleArgument(cancel, "job_id", { rejectEnum: true }) ||
      !tools.get("pi_status").inputSchema.required?.includes("job_id") || !tools.get("pi_cancel").inputSchema.required?.includes("job_id")) {
    throw fail("Pi のジョブ操作スキーマを確認できません");
  }
}

function parseToolResult(result) {
  if (!isObject(result) || result.isError === true) throw fail("Pi MCP 操作が失敗しました");
  if (Object.hasOwn(result, "structuredContent")) return result.structuredContent;
  if (!Array.isArray(result.content)) throw fail("Pi MCP 応答に結果がありません");
  const text = result.content.find((item) => isObject(item) && item.type === "text" && typeof item.text === "string")?.text;
  if (!text) throw fail("Pi MCP 応答に JSON テキストがありません");
  try { return JSON.parse(text); } catch { throw fail("Pi MCP 応答の JSON テキストが不正です"); }
}

/** Pi の能力・モデルと起動・状態・停止を一つの MCP 接続で操作するアダプター。 */
export async function createPiAdapter(connection) {
  if (!connection || connection.serverInfo?.name !== "pi-agent" || !(connection.tools instanceof Map)) {
    try { connection?.close?.(); } catch { /* 不適格接続を解放 */ }
    throw fail("確認済み Pi 接続ではありません");
  }
  try { validatePiTools(connection.tools); }
  catch (error) { connection.close(); throw error; }
  const call = async (name, arguments_) => {
    const result = await connection.request("tools/call", { name, arguments: arguments_ });
    return parseToolResult(result);
  };
  return {
    async capabilities() {
      const value = await call("pi_capabilities", {});
      const capabilities = value?.result ?? value;
      if (!isObject(capabilities) || capabilities.kind !== "agent" || capabilities.harness !== "pi" ||
          !["local", "cloud"].includes(capabilities.tier) || !Array.isArray(capabilities.models) ||
          !capabilities.models.every((model) => isObject(model) && typeof model.id === "string" && Array.isArray(model.accepted) &&
            model.accepted.every((combination) => isObject(combination) && ["read-only", "workspace-write"].includes(combination.access) && ["off", "medium", "high"].includes(combination.effort)))) {
        throw fail("Pi の能力応答を確認できません");
      }
      return { kind: capabilities.kind, harness: capabilities.harness, tier: capabilities.tier, models: capabilities.models };
    },
    async models() {
      let value = await call("pi_models", {});
      value = value?.result ?? value;
      if (!Array.isArray(value) || !value.every((model) => typeof model === "string" && model.length > 0)) throw fail("Pi の受付モデル一覧を確認できません");
      return value;
    },
    async start({ cwd, instruction, model, access, effort, session_id } = {}) {
      if (![cwd, instruction, model].every((value) => typeof value === "string" && value.length > 0) ||
          !["read-only", "workspace-write"].includes(access) || !["off", "medium", "high"].includes(effort) ||
          session_id !== undefined && typeof session_id !== "string") throw fail("Pi 起動条件が不正です");
      const advertised = await this.capabilities();
      if (!advertised.models.some((entry) => entry.id === model && entry.accepted.some((item) => item.access === access && item.effort === effort))) {
        throw fail("Pi が公開していないモデル・権限・推論量の組み合わせです");
      }
      const acceptedModels = await this.models();
      if (!acceptedModels.includes(model)) throw fail("Pi の受付モデル一覧にありません");
      const startSchema = connection.tools.get("pi_start").inputSchema;
      if ([...advertised.models.map((entry) => entry.id), ...acceptedModels].some((id) => !schemaAccepts(startSchema, "model", id))) {
        throw fail("Pi の受付モデルが公開スキーマの制約に適合しません");
      }
      if (![cwd, instruction, model, access, effort].every((value, index) => schemaAccepts(startSchema, ["cwd", "instruction", "model", "access", "thinking"][index], value)) ||
          session_id !== undefined && !schemaAccepts(startSchema, "session_id", session_id)) {
        throw fail("Pi 起動値が公開スキーマの制約に適合しません");
      }
      const value = await call("pi_start", { cwd, instruction, model, access, thinking: effort, ...(session_id === undefined ? {} : { session_id }) });
      if (!isObject(value) || typeof value.job_id !== "string" || !value.job_id) throw fail("Pi 起動結果にジョブ識別子がありません");
      return value;
    },
    async status(jobId) {
      if (typeof jobId !== "string" || !jobId) throw fail("Pi ジョブ識別子が不正です");
      if (!schemaAccepts(connection.tools.get("pi_status").inputSchema, "job_id", jobId)) throw fail("Pi 状態照会値が公開スキーマの制約に適合しません");
      return call("pi_status", { job_id: jobId });
    },
    async cancel(jobId) {
      if (typeof jobId !== "string" || !jobId) throw fail("Pi ジョブ識別子が不正です");
      if (!schemaAccepts(connection.tools.get("pi_cancel").inputSchema, "job_id", jobId)) throw fail("Pi 停止値が公開スキーマの制約に適合しません");
      return call("pi_cancel", { job_id: jobId });
    },
  };
}
