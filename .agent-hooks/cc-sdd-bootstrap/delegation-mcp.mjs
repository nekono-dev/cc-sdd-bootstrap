import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
      serverId: createHash("sha256").update(JSON.stringify([registration.host, registration.scope, registration.name, registration.registrationId])).digest("hex"),
      connectionId: randomUUID(),
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
  const jobIdentity = { serverId: connection.serverId ?? `mcp:${connection.serverInfo.name}`, connectionId: connection.connectionId ?? randomUUID() };
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
    async start(args = {}) {
      if (!isObject(args) || Object.keys(args).some((key) => !["cwd", "instruction", "model", "access", "effort", "session_id"].includes(key))) return { kind: "not-started", reason: "Pi 起動条件が不正です" };
      const { cwd, instruction, model, access, effort, session_id } = args;
      if (![cwd, instruction, model].every((value) => typeof value === "string" && value.length > 0) ||
          !["read-only", "workspace-write"].includes(access) || !["off", "medium", "high"].includes(effort) ||
          session_id !== undefined && typeof session_id !== "string") return { kind: "not-started", reason: "Pi 起動条件が不正です" };
      const advertised = await this.capabilities();
      if (!advertised.models.some((entry) => entry.id === model && entry.accepted.some((item) => item.access === access && item.effort === effort))) {
        return { kind: "not-started", reason: "Pi が公開していないモデル・権限・推論量の組み合わせです" };
      }
      const acceptedModels = await this.models();
      if (!acceptedModels.includes(model)) return { kind: "not-started", reason: "Pi の受付モデル一覧にありません" };
      const startSchema = connection.tools.get("pi_start").inputSchema;
      if ([...advertised.models.map((entry) => entry.id), ...acceptedModels].some((id) => !schemaAccepts(startSchema, "model", id))) {
        return { kind: "not-started", reason: "Pi の受付モデルが公開スキーマの制約に適合しません" };
      }
      if (![cwd, instruction, model, access, effort].every((value, index) => schemaAccepts(startSchema, ["cwd", "instruction", "model", "access", "thinking"][index], value)) ||
          session_id !== undefined && !schemaAccepts(startSchema, "session_id", session_id)) {
        return { kind: "not-started", reason: "Pi 起動値が公開スキーマの制約に適合しません" };
      }
      const value = await call("pi_start", { cwd, instruction, model, access, thinking: effort, ...(session_id === undefined ? {} : { session_id }) });
      if (!isObject(value) || typeof value.job_id !== "string" || !value.job_id) return { kind: "unknown", reason: "Pi 起動結果にジョブ識別子がありません" };
      return { kind: "started", job: { ...jobIdentity, jobId: value.job_id } };
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

// Codex の公開操作を委任ランナー共通の能力・起動契約へ変換する。
export async function createCodexAdapter(connection) {
  const failSchema = () => fail("Codex 公開スキーマを確認できません");
  if (!connection || connection.serverInfo?.name !== "cc-sdd-codex" || !(connection.tools instanceof Map)) throw failSchema();
  const expected = {
    codex_capabilities: [], codex_models: [],
    codex_start: ["cwd", "model", "effort", "access", "instruction"],
    codex_status: ["jobId"], codex_stop: ["jobId"],
  };
  for (const [name, requiredFields] of Object.entries(expected)) {
    const schema = connection.tools.get(name)?.inputSchema;
    if (!isObject(schema) || schema.type !== "object" || !isObject(schema.properties) ||
        schema.additionalProperties !== false || Object.keys(schema).some((key) => !["type", "properties", "required", "additionalProperties", "title", "description", "$schema"].includes(key)) ||
        Object.keys(schema.properties).some((key) => ![...requiredFields, ...(name === "codex_start" ? [] : [])].includes(key)) ||
        !Array.isArray(schema.required) || schema.required.length !== requiredFields.length || requiredFields.some((field) => !schema.required.includes(field)) ||
        requiredFields.some((field) => schema.properties[field]?.type !== "string") ||
        requiredFields.some((field) => !codexPropertySupported(schema.properties[field])) ||
        ["codex_status", "codex_stop"].includes(name) && Object.hasOwn(schema.properties.jobId, "enum") ||
        name === "codex_start" && (!Array.isArray(schema.properties.effort.enum) || !["medium", "high", "off"].every((v) => schema.properties.effort.enum.includes(v)) || !Array.isArray(schema.properties.access.enum) || !["read-only", "workspace-write"].every((v) => schema.properties.access.enum.includes(v)))) throw failSchema();
  }
  function codexPropertySupported(property) {
    if (!isObject(property)) return false;
    const allowed = new Set(["type", "enum", "title", "description", "default"]);
    if (Object.keys(property).some((key) => !allowed.has(key))) return false;
    if (property.enum !== undefined && (!Array.isArray(property.enum) || property.enum.some((value) => typeof value !== "string"))) return false;
    return true;
  }
  const accepts = (toolName, args) => Object.entries(args).every(([key, value]) => {
    const property = connection.tools.get(toolName).inputSchema.properties[key];
    return property?.type === "string" && (property.enum === undefined || property.enum.includes(value));
  });
  const validJobId = (jobId, toolName) => typeof jobId === "string" && jobId.length > 0 && accepts(toolName, { jobId });
  const jobIdentity = { serverId: connection.serverId ?? `mcp:${connection.serverInfo.name}`, connectionId: connection.connectionId ?? randomUUID() };
  const call = async (name, args) => {
    const result = await connection.request("tools/call", { name, arguments: args });
    if (!isObject(result) || result.isError === true || result.error) throw fail("Codex MCP 操作が失敗しました");
    if (Object.hasOwn(result, "structuredContent")) return result.structuredContent;
    const text = result.content?.find((part) => isObject(part) && part.type === "text")?.text;
    if (typeof text !== "string") throw fail("Codex MCP 応答に結果がありません");
    try { return JSON.parse(text); } catch { throw fail("Codex MCP 応答が不正です"); }
  };
  return {
    async capabilities() {
      const value = await call("codex_capabilities", {});
      const c = value?.result ?? value;
      if (!isObject(c) || c.kind !== "agent" || c.harness !== "codex" || c.tier !== "cloud" || !Array.isArray(c.models) ||
          !c.models.every((m) => isObject(m) && typeof m.id === "string" && m.id && Array.isArray(m.accepted) && m.accepted.every((x) => isObject(x) && ["read-only", "workspace-write"].includes(x.access) && ["medium", "high"].includes(x.effort)))) throw fail("Codex 能力応答を確認できません");
      return { kind: c.kind, harness: c.harness, tier: c.tier, models: c.models };
    },
    async models() { const value = await call("codex_models", {}); const models = value?.result ?? value; if (!isObject(models) || !Array.isArray(models.models) || !models.models.every((x) => typeof x === "string" && x)) throw fail("Codex 受付モデル一覧を確認できません"); return models.models; },
    async start(args = {}) {
      if (!isObject(args) || Object.keys(args).some((key) => !["cwd", "instruction", "model", "access", "effort"].includes(key))) return { kind: "not-started", reason: "Codex 起動条件が不正です" };
      const { cwd, instruction, model, access, effort } = args;
      if (![cwd, instruction, model].every((x) => typeof x === "string" && x) || !["read-only", "workspace-write"].includes(access) || !["medium", "high"].includes(effort)) return { kind: "not-started", reason: "Codex 起動条件が不正です" };
      let cap, models;
      try {
        [cap, models] = await Promise.all([this.capabilities(), this.models()]);
        if (!models.includes(model) || !cap.models.some((m) => m.id === model && m.accepted.some((x) => x.access === access && x.effort === effort))) return { kind: "not-started", reason: "Codex が公開していないモデル・権限・推論量の組み合わせです" };
      } catch (error) { return { kind: "not-started", reason: error.message || "Codex 起動前の受付可否を確認できません" }; }
      const startArgs = { cwd, instruction, model, access, effort };
      if (!accepts("codex_start", startArgs) || models.some((id) => !accepts("codex_start", { ...startArgs, model: id })) ||
          cap.models.some((entry) => !accepts("codex_start", { ...startArgs, model: entry.id }))) return { kind: "not-started", reason: "Codex 起動値が公開スキーマの制約に適合しません" };
      try {
        const result = await call("codex_start", { cwd, instruction, model, access, effort });
        const v = result?.result ?? result;
        if (!isObject(v)) return { kind: "unknown", reason: "Codex 起動結果を確認できません" };
        if (v.kind === "not-started") {
          const reason = typeof v.reason === "string" && v.reason.length > 0 ? v.reason : "Codex 起動結果を確認できません";
          if (Object.keys(v).length === 2 && Object.hasOwn(v, "kind") && Object.hasOwn(v, "reason") && typeof v.reason === "string" && v.reason.length > 0)
            return { kind: "not-started", reason };
          return {
            kind: "unknown",
            reason,
            ...(validJobId(v.jobId, "codex_status") && validJobId(v.jobId, "codex_stop") ? { job: { ...jobIdentity, jobId: v.jobId } } : {}),
          };
        }
        if (v.kind === "unknown") return {
          kind: "unknown",
          reason: typeof v.reason === "string" ? v.reason : "Codex 起動結果を確認できません",
          ...(validJobId(v.jobId, "codex_status") && validJobId(v.jobId, "codex_stop") ? { job: { ...jobIdentity, jobId: v.jobId } } : {}),
        };
        if (v.kind === "started" && validJobId(v.jobId, "codex_status") && validJobId(v.jobId, "codex_stop")) return { kind: "started", job: { ...jobIdentity, jobId: v.jobId } };
        return { kind: "unknown", reason: "Codex 起動結果を確認できません" };
      } catch { return { kind: "unknown", reason: "Codex 起動後の MCP 応答を確認できません" }; }
    },
    status(jobId) { if (!validJobId(jobId, "codex_status")) throw fail("Codex 状態照会値が公開スキーマの制約に適合しません"); return call("codex_status", { jobId }); },
    stop(jobId) { if (!validJobId(jobId, "codex_stop")) throw fail("Codex 停止値が公開スキーマの制約に適合しません"); return call("codex_stop", { jobId }); },
  };
}
