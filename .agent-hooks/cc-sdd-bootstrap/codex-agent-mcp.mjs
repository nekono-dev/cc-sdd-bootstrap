import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const ACCEPTED_EFFORTS = new Set(["medium", "high"]);
const ACCEPTED_ACCESS = new Set(["read-only", "workspace-write"]);
const PROTOCOL_VERSION = "2025-06-18";
const MAX_OUTPUT = 16_384;
const jobs = new Map();

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
  { name: "codex_start", description: "検証済みの設定で Codex ジョブを開始する", inputSchema: { type: "object", properties: { cwd: { type: "string" }, model: { type: "string" }, effort: { type: "string", enum: ["medium", "high", "off"] }, access: { type: "string", enum: ["read-only", "workspace-write"] }, instruction: { type: "string" } }, required: ["cwd", "model", "effort", "access", "instruction"], additionalProperties: false } },
  { name: "codex_status", description: "Codex ジョブの状態と出力末尾を取得する", inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"], additionalProperties: false } },
  { name: "codex_stop", description: "Codex ジョブの停止を要求する", inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"], additionalProperties: false } },
];

function validArguments(name, args) {
  if (!isRecord(args)) return false;
  if (name === "codex_capabilities" || name === "codex_models") return Object.keys(args).length === 0;
  const keys = name === "codex_start" ? ["cwd", "model", "effort", "access", "instruction"] : ["jobId"];
  return Object.keys(args).every((key) => keys.includes(key)) && keys.every((key) => typeof args[key] === "string") &&
    (name !== "codex_start" || (args.cwd.length > 0 && args.model.length > 0 && args.instruction.length > 0)) &&
    (name === "codex_start" || args.jobId.length > 0);
}

async function startJob(args, { listModels, spawnProcess, allowedRoots, stopGraceMs }) {
  try {
    const capabilities = await loadCapabilities({ listModels });
    if (!isAccepted(capabilities, { model: args.model, effort: args.effort, access: args.access })) return { kind: "not-started", reason: "指定されたモデル・推論量・権限の組み合わせは受け付けられません" };
    if (!ACCEPTED_EFFORTS.has(args.effort)) return { kind: "not-started", reason: "Codex は指定された推論量を受け付けません" };
    const roots = await Promise.all(allowedRoots.map((root) => realpath(root)));
    const directory = await realpath(args.cwd);
    if (!roots.some((root) => { const path = relative(root, directory); return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep)); })) return { kind: "not-started", reason: "作業先が許可範囲外です" };
    const jobId = randomUUID();
    const cliArgs = ["-a", "never", "exec", "--sandbox", args.access, "--model", args.model, "--config", `model_reasoning_effort=\"${args.effort}\"`, "--cd", directory, "-"];
    let child;
    try {
      child = spawnProcess("codex", cliArgs, { cwd: directory, stdio: ["pipe", "pipe", "ignore"], shell: false, detached: true, windowsHide: true });
    } catch (error) {
      return { kind: "not-started", reason: error?.code === "ENOENT" ? "Codex CLI が見つかりません" : "Codex CLI を起動できません" };
    }
    const job = { child, status: "running", output: "", stopPromise: null, exitObserved: false };
    jobs.set(jobId, job);
    child.stdout?.on("data", (chunk) => { job.output = (job.output + chunk.toString()).slice(-MAX_OUTPUT); });
    let spawned = false;
    child.on("spawn", () => { spawned = true; });
    child.on("error", () => {
      if (job.exitObserved) return;
      job.status = "unknown";
      if (!spawned) job.spawnError = true;
    });
    child.on("exit", (code, signal) => { job.exitObserved = true; job.status = job.stopRequested ? "unknown" : code === 0 ? "succeeded" : code === null ? "unknown" : "failed"; job.exitCode = code; job.signal = signal; });
    child.stdin?.on("error", () => {
      if (job.exitObserved) return;
      job.status = "unknown";
      job.error = "Codex 起動後に指示を送信できたか確認できません";
    });
    const spawnResult = await new Promise((resolveSpawn) => {
      const onSpawn = () => { cleanup(); resolveSpawn("spawned"); };
      const onError = (error) => { cleanup(); resolveSpawn(error); };
      const cleanup = () => { child.off("spawn", onSpawn); child.off("error", onError); };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    if (spawnResult !== "spawned") {
      jobs.delete(jobId);
      return { kind: "not-started", reason: spawnResult?.code === "ENOENT" ? "Codex CLI が見つかりません" : "Codex CLI を起動できません" };
    }
    try {
      child.stdin.end(args.instruction);
      return { kind: "started", jobId, status: "running" };
    } catch {
      job.status = "unknown";
      job.error = "Codex 起動後に指示を送信できたか確認できません";
      return { kind: "unknown", reason: "Codex 起動後に指示を送信できたか確認できません", jobId };
    }
  } catch (error) {
    return { kind: "not-started", reason: error?.code === "ENOENT" ? "作業先または許可範囲が存在しません" : "起動条件を検証できません" };
  }
}

function jobStatus(jobId) {
  const job = jobs.get(jobId);
  return job ? { jobId, status: job.status, output: job.output, ...(job.error ? { reason: job.error } : {}) } : { jobId, status: "unknown", reason: "ジョブを追跡できません" };
}

function processGroupGone(job, killProcess) {
  if (!Number.isInteger(job.child.pid)) return false;
  try {
    killProcess(-job.child.pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

async function stopJob(jobId, stopGraceMs, killProcess) {
  const job = jobs.get(jobId);
  if (!job) return { jobId, status: "unknown", reason: "ジョブを追跡できません" };
  if (job.exitObserved && !job.stopRequested) return jobStatus(jobId);
  if (!job.stopPromise) job.stopPromise = new Promise((resolve) => {
    job.stopRequested = true;
    try { killProcess(-job.child.pid, "SIGTERM"); } catch { /* 既に消滅したグループ */ }
    const timer = setTimeout(() => {
      try { killProcess(-job.child.pid, "SIGKILL"); } catch { /* 既に消滅したグループ */ }
    }, stopGraceMs);
    timer.unref?.();
    const check = setInterval(() => {
      if (job.exitObserved && processGroupGone(job, killProcess)) {
        clearTimeout(timer);
        clearInterval(check);
        job.status = "stopped";
        resolve();
      }
    }, 10);
    check.unref?.();
  });
  // 停止の完了を待ち続けず、確認前は停止済みと返さない。
  await Promise.race([job.stopPromise, new Promise((resolve) => setTimeout(resolve, 25))]);
  return jobStatus(jobId);
}

/** Codex MCP の最小 JSON-RPC サーバー。 */
export async function serve({ input = process.stdin, output = process.stdout, listModels = listCodexModels, spawnProcess = spawn, killProcess = process.kill.bind(process), allowedRoots = [resolve(dirname(fileURLToPath(import.meta.url)), "../..")], stopGraceMs = 1_000 } = {}) {
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
      if (!toolDefinitions.some((tool) => tool.name === name)) {
        if (Object.hasOwn(request, "id")) send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "未対応のツールです" } });
        continue;
      }
      const args = request.params?.arguments;
      if (!validArguments(name, args)) {
        if (Object.hasOwn(request, "id")) send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "ツール引数がスキーマに適合しません" } });
        continue;
      }
      let result;
      if (name === "codex_start") result = await startJob(args, { listModels, spawnProcess, allowedRoots, stopGraceMs });
      else if (name === "codex_status") result = jobStatus(args.jobId);
      else if (name === "codex_stop") result = await stopJob(args.jobId, stopGraceMs, killProcess);
      else {
        const capability = await getCapabilities({ listModels });
        result = capability.kind === "unavailable" ? capability : name === "codex_models" ? { models: capability.models.map((item) => item.id) } : capability;
      }
      respond({ structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] });
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  serve().catch(() => { process.exitCode = 1; });
}
