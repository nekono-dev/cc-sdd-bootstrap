import { mkdir, readdir, readFile, rename, chmod, writeFile, unlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDelegationIdentifier } from "./delegation-job-store.mjs";

const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const id = isDelegationIdentifier;
const keys = (v, allowed) => obj(v) && Object.keys(v).every((k) => allowed.has(k));
const baseFields = new Set(["root", "requestId", "generation"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const directory = (root, requestId, controlDirectory) => join(root, controlDirectory ?? `control-${requestId}`);
const atomic = async (path, value) => {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(tmp, path);
};

export function safeControlResult(value) {
  if (!obj(value) || Object.keys(value).some((key) => !["status", "state", "jobId", "reason", "output"].includes(key))) return { status: "unknown" };
  const state = value.status ?? value.state;
  if (!new Set(["running", "succeeded", "failed", "stopped", "unknown"]).has(state) ||
      value.status !== undefined && value.state !== undefined ||
      value.jobId !== undefined && !id(value.jobId) ||
      value.reason !== undefined && (typeof value.reason !== "string" || !value.reason) ||
      value.output !== undefined && typeof value.output !== "string") return { status: "unknown" };
  return { status: state, ...(value.jobId === undefined ? {} : { jobId: value.jobId }), ...(value.reason === undefined ? {} : { reason: value.reason }), ...(value.output === undefined ? {} : { output: value.output }) };
}

/** 所有者へ要求を原子的に渡し、期限内の対応応答だけを返す。 */
export async function requestControl(input) {
  if (!keys(input, new Set([...baseFields, "kind", "timeoutMs", "controlDirectory"])) || typeof input.root !== "string" || !input.root || !id(input.requestId) || !id(input.generation) || input.controlDirectory !== undefined && (typeof input.controlDirectory !== "string" || !/^control-[A-Za-z0-9._:-]{1,128}$/.test(input.controlDirectory)) || !["status", "stop"].includes(input.kind) || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 60000)
    return { kind: "unavailable", reason: "制御要求の入力が不正です" };
  const folder = directory(input.root, input.requestId, input.controlDirectory);
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink() || typeof process.getuid === "function" && info.uid !== process.getuid()) return { kind: "unavailable", reason: "制御ディレクトリを利用できません" };
    await chmod(folder, 0o700);
  }
  catch { return { kind: "unavailable", reason: "制御ディレクトリを利用できません" }; }
  const controlId = randomUUID();
  const deadline = Date.now() + input.timeoutMs;
  const requestPath = join(folder, `request-${controlId}.json`);
  try { await atomic(requestPath, { requestId: input.requestId, generation: input.generation, controlId, kind: input.kind, deadline }); }
  catch { return { kind: "unavailable", reason: "制御要求を送信できません" }; }
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(await readFile(join(folder, `response-${controlId}.json`), "utf8"));
      if (keys(response, new Set(["requestId", "generation", "controlId", "ownerAlive", "result"])) && response.requestId === input.requestId && response.generation === input.generation && response.controlId === controlId && response.ownerAlive === true && obj(response.result)) {
        await unlink(join(folder, `response-${controlId}.json`)).catch(() => {});
        return safeControlResult(response.result);
      }
    } catch {}
    await sleep(Math.min(15, Math.max(1, deadline - Date.now())));
  }
  await unlink(requestPath).catch(() => {});
  return { kind: "unknown", requestId: input.requestId, reason: "制御所有者から応答がありません" };
}

/** 記録 API から制御先を許可リストで解決する。 */
export async function resolveControlTarget(input) {
  const allowed = new Set(["store", "requestId", "project", "cwd", "skill", "taskId"]);
  if (!keys(input, allowed) || !obj(input.store) || typeof input.store.resolveControlTarget !== "function" ||
      !id(input.requestId) || typeof input.project !== "string" || !input.project || typeof input.cwd !== "string" || !input.cwd ||
      typeof input.skill !== "string" || !input.skill || typeof input.taskId !== "string" || !input.taskId)
    return { kind: "unavailable", reason: "制御先の入力が不正です" };
  try {
    const result = await input.store.resolveControlTarget({ requestId: input.requestId, project: input.project, cwd: input.cwd, skill: input.skill, taskId: input.taskId });
    if (keys(result, new Set(["kind", "result"])) && result.kind === "terminal" && keys(result.result, new Set(["status", "summary", "at"])) &&
        new Set(["succeeded", "failed", "stopped"]).has(result.result.status) && typeof result.result.summary === "string" && Number.isFinite(result.result.at))
      return { kind: "terminal", result: { status: result.result.status, summary: result.result.summary, at: result.result.at } };
    if (!keys(result, new Set(["generation", "controlDirectory"])) || typeof result.generation !== "string" || !/^[a-f0-9]{32}$/.test(result.generation) ||
        result.controlDirectory !== `control-${result.generation}`) return { kind: "unavailable", reason: "制御先を確認できません" };
    return { generation: result.generation, controlDirectory: result.controlDirectory };
  } catch { return { kind: "unavailable", reason: "制御先を確認できません" }; }
}

/** 制御要求を順番に処理する所有者ループ。close で停止する。 */
export async function serveControl(worker, input) {
  if (!keys(input, new Set([...baseFields, "pollIntervalMs", "controlDirectory", "acceptedRequestIds", "acceptRequest", "isCurrentGeneration", "onInspect"])) || typeof input.root !== "string" || !input.root || !id(input.requestId) || !id(input.generation) || input.controlDirectory !== undefined && (typeof input.controlDirectory !== "string" || !/^control-[A-Za-z0-9._:-]{1,128}$/.test(input.controlDirectory)) || input.acceptedRequestIds !== undefined && (!Array.isArray(input.acceptedRequestIds) || !input.acceptedRequestIds.every(id) || new Set(input.acceptedRequestIds).size !== input.acceptedRequestIds.length) || input.acceptRequest !== undefined && typeof input.acceptRequest !== "function" || input.isCurrentGeneration !== undefined && typeof input.isCurrentGeneration !== "function" || input.onInspect !== undefined && typeof input.onInspect !== "function" || input.pollIntervalMs !== undefined && (!Number.isInteger(input.pollIntervalMs) || input.pollIntervalMs < 1 || input.pollIntervalMs > 1000) || !obj(worker) || typeof worker.status !== "function" || typeof worker.stop !== "function") return { close: async () => {} };
  const folder = directory(input.root, input.requestId, input.controlDirectory);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const info = await lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink() || typeof process.getuid === "function" && info.uid !== process.getuid()) return { close: async () => {} };
  await chmod(folder, 0o700);
  const processed = new Set(); let closed = false; let active = false;
  const accepts = async (requestId) => input.acceptRequest
    ? await input.acceptRequest(requestId) === true
    : new Set(input.acceptedRequestIds ?? [input.requestId]).has(requestId);
  const loop = async () => {
    if (closed || active) return;
    active = true;
    try {
      for (const name of (await readdir(folder)).filter((n) => /^request-[0-9a-f-]+\.json$/.test(n)).sort()) {
        const source = join(folder, name); const claim = `${source}.claimed`;
        let offered;
        try { offered = JSON.parse(await readFile(source, "utf8")); } catch { continue; }
        input.onInspect?.(offered);
        const allowed = new Set(["requestId", "generation", "controlId", "kind", "deadline"]);
        if (!obj(offered) || !id(offered.requestId) || offered.generation !== input.generation || !await accepts(offered.requestId)) continue;
        if (input.isCurrentGeneration && await input.isCurrentGeneration() !== true) continue;
        try { await rename(source, claim); } catch { continue; }
        try {
          const request = JSON.parse(await readFile(claim, "utf8"));
          if (!keys(request, allowed) || !id(request.requestId) || request.generation !== input.generation ||
              !await accepts(request.requestId) || !id(request.controlId) ||
              !["status", "stop"].includes(request.kind) || !Number.isFinite(request.deadline) || request.deadline < Date.now() || processed.has(request.controlId)) continue;
          if (input.isCurrentGeneration && await input.isCurrentGeneration() !== true) continue;
          processed.add(request.controlId);
          const result = typeof worker[`control${request.kind === "status" ? "Status" : "Stop"}`] === "function"
            ? await worker[`control${request.kind === "status" ? "Status" : "Stop"}`](request.requestId, request.deadline)
            : await worker[request.kind](request.requestId, request.deadline);
          await atomic(join(folder, `response-${request.controlId}.json`), { requestId: request.requestId, generation: input.generation, controlId: request.controlId, ownerAlive: true, result: safeControlResult(result) });
        } catch {} finally { await unlink(claim).catch(() => {}); }
      }
    } finally { active = false; }
  };
  const timer = setInterval(() => { loop().catch(() => {}); }, input.pollIntervalMs ?? 20);
  return { close: async () => { closed = true; clearInterval(timer); while (active) await sleep(1); } };
}
