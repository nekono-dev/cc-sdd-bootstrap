import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ACCEPTED_EFFORTS = new Set(["medium", "high"]);
const ACCEPTED_ACCESS = new Set(["read-only", "workspace-write"]);
const PROTOCOL_VERSION = "2025-06-18";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Codex app-server のモデル一覧だけを実行受付の根拠として正規化する。 */
export function capabilitiesFromCatalog(catalog) {
  if (!Array.isArray(catalog)) throw new Error("Codex モデルカタログの形式が不正です");
  const models = [];
  const seen = new Set();
  for (const item of catalog) {
    if (!isRecord(item) || typeof item.model !== "string" || !item.model || seen.has(item.model) ||
        !Array.isArray(item.supportedReasoningEfforts)) continue;
    const efforts = [...new Set(item.supportedReasoningEfforts
      .filter((entry) => isRecord(entry) && ACCEPTED_EFFORTS.has(entry.reasoningEffort))
      .map((entry) => entry.reasoningEffort))];
    if (!efforts.length) continue;
    seen.add(item.model);
    models.push({
      id: item.model,
      accepted: [...ACCEPTED_ACCESS].flatMap((access) => efforts.map((effort) => ({ access, effort }))),
    });
  }
  return { kind: "agent", harness: "codex", tier: "cloud", models };
}

/** カタログの受付条件と起動時にも使う組み合わせ判定。 */
export function isAccepted(capabilities, input = {}) {
  if (!isRecord(input) || Object.keys(input).some((key) => !["model", "access", "effort"].includes(key))) return false;
  const { model, access, effort } = input;
  if (!isRecord(capabilities) || !Array.isArray(capabilities.models) ||
      typeof model !== "string" || !ACCEPTED_ACCESS.has(access) || !ACCEPTED_EFFORTS.has(effort)) return false;
  const entry = capabilities.models.find((candidate) => isRecord(candidate) && candidate.id === model);
  return Boolean(entry && Array.isArray(entry.accepted) && entry.accepted.some((value) =>
    isRecord(value) && value.access === access && value.effort === effort));
}

/** カタログ障害は実行不可ではなく、受付可否を確認できない状態として返す。 */
export async function getCapabilities({ listModels } = {}) {
  if (typeof listModels !== "function") return { kind: "unavailable", reason: "モデルカタログを取得できず、受付可否を確認できません" };
  try {
    return capabilitiesFromCatalog(await listModels());
  } catch {
    return { kind: "unavailable", reason: "モデルカタログを取得できず、受付可否を確認できません" };
  }
}

export async function loadCapabilities(options = {}) {
  const result = await getCapabilities(options);
  if (result.kind === "unavailable") throw new Error(result.reason);
  return result;
}

/** Codex app-server からモデルカタログを読み取る。認証や利用権は照会しない。 */
export function listCodexModels({ spawnProcess = spawn, timeoutMs = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true });
    } catch {
      reject(new Error("Codex app-server を起動できません"));
      return;
    }
    const lines = createInterface({ input: child.stdout });
    let id = 0;
    const pending = new Map();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      try { child.kill(); } catch { /* 終了済み */ }
      error ? reject(error) : resolve(value);
    };
    const request = (method, params) => {
      const requestId = ++id;
      pending.set(requestId, { method });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, ...(params === undefined ? {} : { params }) })}\n`);
      return requestId;
    };
    const timer = setTimeout(() => finish(new Error("Codex カタログ応答が時間内に届きません")), timeoutMs);
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return finish(new Error("Codex app-server 応答が不正です")); }
      if (!isRecord(message) || !Number.isInteger(message.id) || !pending.has(message.id)) return;
      const { method } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) return finish(new Error("Codex app-server カタログ要求に失敗しました"));
      if (method === "initialize") {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
        request("model/list", { limit: 100 });
      } else if (method === "model/list") {
        if (!isRecord(message.result) || !Array.isArray(message.result.data)) return finish(new Error("Codex モデルカタログの形式が不正です"));
        finish(null, message.result.data);
      }
    });
    child.on("error", () => finish(new Error("Codex app-server に接続できません")));
    child.on("exit", () => { if (!settled) finish(new Error("Codex app-server がカタログ応答前に終了しました")); });
    child.stdin.on("error", () => finish(new Error("Codex app-server に要求を送信できません")));
    request("initialize", { clientInfo: { name: "cc-sdd-bootstrap", version: "0" } });
  });
}

const toolDefinitions = [
  { name: "codex_capabilities", description: "Codex の実行能力と受け付けるモデル・権限・推論量を返す", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
  { name: "codex_models", description: "Codex が受け付けるモデル ID を返す", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
];

/** Codex MCP の最小 JSON-RPC サーバー。 */
export async function serve({ input = process.stdin, output = process.stdout, listModels = listCodexModels } = {}) {
  const send = (message) => output.write(`${JSON.stringify(message)}\n`);
  const lines = createInterface({ input });
  for await (const line of lines) {
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (!isRecord(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") continue;
    const respond = (result) => { if (Object.hasOwn(request, "id")) send({ jsonrpc: "2.0", id: request.id, result }); };
    if (request.method === "initialize") {
      respond({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "cc-sdd-codex", version: "0" } });
    } else if (request.method === "tools/list") {
      respond({ tools: toolDefinitions });
    } else if (request.method === "tools/call") {
      const name = request.params?.name;
      if (name !== "codex_capabilities" && name !== "codex_models") {
        if (Object.hasOwn(request, "id")) send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "未対応のツールです" } });
        continue;
      }
      const args = request.params?.arguments;
      if (!isRecord(args) || Object.keys(args).length !== 0) {
        if (Object.hasOwn(request, "id")) send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "ツール引数がスキーマに適合しません" } });
        continue;
      }
      const capability = await getCapabilities({ listModels });
      const result = capability.kind === "unavailable" ? capability : name === "codex_models" ? { models: capability.models.map((item) => item.id) } : capability;
      respond({ structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] });
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  serve().catch(() => { process.exitCode = 1; });
}
