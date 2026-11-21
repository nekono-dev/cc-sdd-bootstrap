import { selectDelegate } from "./delegation-select.mjs";
import { connectStdioRegistration, createCodexAdapter, createPiAdapter } from "./delegation-mcp.mjs";
import { resolveRegistration } from "./delegation-registry.mjs";
import { createDelegationJobStore } from "./delegation-job-store.mjs";
import { createHash, randomUUID } from "node:crypto";
import { serveControl } from "./delegation-job-control.mjs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROLES = new Set(["manufacture", "review", "design", "research", "debug"]);
const ACCESS = new Set(["read-only", "workspace-write"]);
const FIELDS = new Set(["requestId", "project", "cwd", "role", "instruction", "skill", "taskId", "access", "readOnly", "model", "effort", "settings", "host", "candidates", "native", "options"]);
const DEFAULT_OPERATION_TIMEOUT_MS = 5000;
const TERMINAL = new Set(["succeeded", "failed", "stopped"]);
const STATES = new Set(["running", "succeeded", "failed", "stopped", "unknown"]);
const identity = (value) => typeof value === "string" && value.length > 0 && value.trim() === value;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value, keys) => object(value) && Object.keys(value).every((key) => keys.has(key));
const withTimeout = (promise, timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("MCP 操作が時間内に完了しません")), timeoutMs);
  Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
const closeAdapter = async (adapter) => { try { await adapter?.close?.(); } catch { /* 接続終了時の例外は呼び出し結果に混ぜない */ } };

function validRequest(value) {
  const optionsValid = value?.options === undefined || object(value.options) && Object.keys(value.options).every((key) => key === "readOnly") &&
    (value.options.readOnly === undefined || typeof value.options.readOnly === "boolean");
  const requestsReadOnly = value?.access === "read-only" || value?.readOnly === true || value?.options?.readOnly === true;
  const readOnlyConflict = requestsReadOnly && (value?.access !== "read-only" || value?.options?.readOnly === false);
  return object(value) && Object.keys(value).every((key) => FIELDS.has(key)) && optionsValid && !readOnlyConflict &&
    ["requestId", "project", "cwd", "role", "instruction", "skill", "taskId", "access"].every((key) => identity(value[key])) &&
    ROLES.has(value.role) && ACCESS.has(value.access) &&
    (value.readOnly === undefined || typeof value.readOnly === "boolean") &&
    (value.model === undefined || identity(value.model)) &&
    (value.effort === undefined || ["off", "medium", "high"].includes(value.effort));
}

function normalizeState(value, jobId) {
  const keys = new Set(["jobId", "status", "state", "kind", "output", "reason"]);
  const stateFields = ["status", "state", "kind"].filter((key) => Object.hasOwn(value ?? {}, key));
  if (!onlyKeys(value, keys) || stateFields.length !== 1 || !STATES.has(value.status ?? value.state ?? value.kind) ||
      value.jobId !== undefined && (!identity(value.jobId) || value.jobId !== jobId) ||
      value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length === 0) ||
      value.output !== undefined && typeof value.output !== "string") return { status: "unknown" };
  const status = value.status ?? value.state ?? value.kind;
  return { status, ...(value.reason === undefined ? {} : { reason: value.reason }), ...(value.output === undefined ? {} : { output: value.output }) };
}

function validCapabilities(value) {
  return onlyKeys(value, new Set(["kind", "harness", "tier", "models"])) && value.kind === "agent" && identity(value.harness) && ["local", "cloud"].includes(value.tier) && Array.isArray(value.models) &&
    value.models.every((entry) => onlyKeys(entry, new Set(["id", "accepted"])) && identity(entry.id) && Array.isArray(entry.accepted) && entry.accepted.every((item) => onlyKeys(item, new Set(["access", "effort"])) && ACCESS.has(item.access) && ["off", "medium", "high"].includes(item.effort)));
}

function validJob(value) {
  return onlyKeys(value, new Set(["serverId", "connectionId", "jobId"])) && [value.serverId, value.connectionId, value.jobId].every(identity);
}

function safeJobId(value) {
  return onlyKeys(value, new Set(["serverId", "connectionId", "jobId"])) && identity(value.jobId);
}

function classifyStart(value) {
  if (onlyKeys(value, new Set(["kind", "reason"])) && value.kind === "not-started" && typeof value.reason === "string" && value.reason.length > 0)
    return { kind: "not-started", reason: value.reason };
  if (onlyKeys(value, new Set(["kind", "job"])) && value.kind === "started" && validJob(value.job))
    return { kind: "started", job: { serverId: value.job.serverId, connectionId: value.job.connectionId, jobId: value.job.jobId } };
  if (onlyKeys(value, new Set(["kind", "reason", "job"])) && value.kind === "unknown" && typeof value.reason === "string" && value.reason.length > 0 &&
      (value.job === undefined || validJob(value.job)))
    return { kind: "unknown", reason: value.reason, ...(value.job === undefined ? {} : { job: { serverId: value.job.serverId, connectionId: value.job.connectionId, jobId: value.job.jobId } }) };
  return { kind: "unknown", reason: "起動応答の形式が不正です", ...(safeJobId(value?.job) ? { job: value.job } : {}) };
}

/** 依頼ごとに接続を保持し、MCP の起動・照会・停止を直列化する。 */
export function createJobWorker(deps) {
  if (!object(deps) || Object.keys(deps).some((key) => !["select", "connect", "store", "now", "operationTimeoutMs"].includes(key)) ||
      typeof deps.select !== "function" || typeof deps.connect !== "function" || !object(deps.store) ||
      typeof deps.store.reserve !== "function" || typeof deps.store.markUnknown !== "function" || typeof deps.now !== "function" ||
      deps.operationTimeoutMs !== undefined && (!Number.isInteger(deps.operationTimeoutMs) || deps.operationTimeoutMs < 1 || deps.operationTimeoutMs > 60000)) {
    return Object.freeze({ start: async () => ({ kind: "unavailable", reasons: ["worker の依存関係が不正です"] }), status: async () => ({ status: "unknown" }), stop: async () => ({ status: "unknown" }), release: async () => {}, isBusy: () => false });
  }
  const jobs = new Map();
  const requestJobs = new Map();
  const owned = new Set();
  let queue = Promise.resolve();
  const serialize = (fn) => {
    const result = queue.then(fn, fn);
    queue = result.catch(() => {});
    return result;
  };
  const close = async (entry) => {
    if (entry.closed) return;
    entry.closed = true;
    owned.delete(entry);
    try { await entry.adapter.close?.(); } catch { /* 接続終了後も終端結果は維持 */ }
  };
  const releaseReservation = async (request, generation) => {
    if (!request) return;
    try {
      const input = { requestId: request.requestId, project: request.project, cwd: request.cwd, skill: request.skill, taskId: request.taskId };
      if (request.access === "read-only") {
        if (generation && typeof deps.store.releaseTrack === "function") await deps.store.releaseTrack({ ...input, generation });
      } else if (typeof deps.store.release === "function") await deps.store.release(input);
    } catch { /* 起動前の拒否結果を維持 */ }
  };
  const finish = async (entry, state) => {
    entry.result = state;
    if (TERMINAL.has(state.status)) await close(entry);
    return state;
  };

  async function start(request) {
    if (!validRequest(request)) return { kind: "unavailable", reasons: ["依頼の入力が不正です"] };
    const readOnly = request.access === "read-only";
    let reservation;
    let reservationGeneration;
    if (!readOnly) {
      try { reservation = await deps.store.reserve({ requestId: request.requestId, project: request.project, cwd: request.cwd, skill: request.skill, taskId: request.taskId }); }
      catch { return { kind: "unavailable", reasons: ["書き込み依頼を排他記録できません"] }; }
      if (!object(reservation) || reservation.kind !== "created") {
        if (reservation?.kind === "existing") return { kind: "pending", requestId: request.requestId, reason: "同じ作業の先行記録があります" };
        return { kind: "unavailable", reasons: [typeof reservation?.reason === "string" ? reservation.reason : "書き込み依頼を予約できません"] };
      }
    }
    let selected;
    try { selected = await deps.select(request); }
    catch { selected = { kind: "unavailable", reasons: ["委任先を確認できません"] }; }
    if (!object(selected) || selected.kind !== "mcp") {
      if (reservation) await releaseReservation(request, reservationGeneration);
      return selected?.kind === "native"
      ? { kind: "native", agentName: identity(selected.agentName) ? selected.agentName : identity(selected.agent_name) ? selected.agent_name : "", reason: "対応する委任 MCP がありません" }
      : { kind: "unavailable", reasons: Array.isArray(selected?.reasons) && selected.reasons.every((item) => typeof item === "string") ? [...selected.reasons] : ["適格な委任先がありません"] };
    }
    if (!ACCESS.has(selected.access) || (readOnly && selected.access !== request.access)) {
      await deps.select.releaseProbed?.();
      if (reservation) await releaseReservation(request);
      return { kind: "unavailable", reasons: ["選択した権限が依頼の予約権限と一致しません"] };
    }

    let adapter;
    try { adapter = await deps.connect(selected.candidate); }
    catch (error) { if (reservation) await releaseReservation(request); return { kind: "unavailable", reasons: [error instanceof Error ? error.message : "MCP に接続できません"] }; }
    if (!object(adapter) || typeof adapter.capabilities !== "function" || typeof adapter.models !== "function" || typeof adapter.start !== "function" || typeof adapter.status !== "function" || !(typeof adapter.stop === "function" || typeof adapter.cancel === "function")) {
      await closeAdapter(adapter);
      if (reservation) await releaseReservation(request);
      return { kind: "unavailable", reasons: ["MCP adapter の契約を確認できません"] };
    }
    let capabilities;
    let models;
    try { [capabilities, models] = await Promise.all([adapter.capabilities(), adapter.models()]); }
    catch { await closeAdapter(adapter); if (reservation) await releaseReservation(request); return { kind: "unavailable", reasons: ["MCP の能力と受付モデルを確認できません"] }; }
    const model = selected.model;
    const accepted = validCapabilities(capabilities) && capabilities.models.some((entry) => entry.id === model && entry.accepted.some((item) => item.access === selected.access && item.effort === selected.effort));
    if (!accepted || !Array.isArray(models) || !models.every(identity) || new Set(models).size !== models.length || !models.includes(model)) {
      await closeAdapter(adapter);
      if (reservation) await releaseReservation(request);
      return { kind: "unavailable", reasons: ["選択したモデル・権限・推論量が現在の公開能力にありません"] };
    }
    if (readOnly && typeof deps.store.track === "function") {
      try {
        reservation = await deps.store.track({ requestId: request.requestId, project: request.project, cwd: request.cwd, skill: request.skill, taskId: request.taskId });
        if (!object(reservation) || !["tracked", "existing"].includes(reservation.kind) || !object(reservation.record) ||
            typeof reservation.record.generation !== "string" || typeof reservation.record.controlDirectory !== "string") {
          await closeAdapter(adapter);
          return { kind: "unavailable", reasons: [typeof reservation?.reason === "string" ? reservation.reason : "読み取り専用依頼の制御先を記録できません"] };
        }
        reservationGeneration = reservation.record.generation;
        if (reservation.kind === "existing") {
          await closeAdapter(adapter);
          return { kind: "pending", requestId: request.requestId, reason: "同じ読み取り専用依頼の接続所有者が稼働中です",
            control: { generation: reservation.record.generation, controlDirectory: reservation.record.controlDirectory } };
        }
      } catch {
        await closeAdapter(adapter);
        return { kind: "unavailable", reasons: ["読み取り専用依頼の制御先を記録できません"] };
      }
    }
    let result;
    try { result = await adapter.start({ cwd: request.cwd, instruction: request.instruction, model, access: selected.access, effort: selected.effort }); }
    catch { result = { kind: "unknown", reason: "起動要求の送信後に結果を確認できません" }; }
    result = classifyStart(result);
    if (result.kind === "not-started") {
      await closeAdapter(adapter);
      if (reservation) await releaseReservation(request, reservationGeneration);
      return { kind: "unavailable", reasons: [typeof result?.reason === "string" ? result.reason : "MCP が起動前に拒否しました"] };
    }
    if (result.kind === "unknown") {
      if (!readOnly) await deps.store.markUnknown({ requestId: request.requestId, project: request.project, cwd: request.cwd, skill: request.skill, taskId: request.taskId }).catch(() => false);
      const entry = { adapter, job: object(result?.job) ? result.job : null, request, generation: reservation?.record?.generation, requestIds: reservation?.record?.requestIds ?? [request.requestId], closed: false, result: { status: "unknown", ...(typeof result?.reason === "string" ? { reason: result.reason } : {}) } };
      owned.add(entry);
      if (entry.job) { jobs.set(entry.job.jobId, entry); requestJobs.set(request.requestId, entry.job.jobId); }
      for (const id of reservation?.record?.requestIds ?? []) if (identity(id)) requestJobs.set(id, entry.job?.jobId);
      return { kind: "pending", requestId: request.requestId, reason: entry.result.reason ?? "起動後の状態が不明です" };
    }
    const entry = { adapter, job: result.job, request, generation: reservation?.record?.generation, requestIds: reservation?.record?.requestIds ?? [request.requestId], closed: false, result: null };
    owned.add(entry);
    jobs.set(result.job.jobId, entry);
    requestJobs.set(request.requestId, result.job.jobId);
    for (const id of reservation?.record?.requestIds ?? []) if (identity(id)) requestJobs.set(id, result.job.jobId);
    return { kind: "started", job: { serverId: result.job.serverId, connectionId: result.job.connectionId, jobId: result.job.jobId },
      ...(readOnly && reservation?.record ? { control: { generation: reservation.record.generation, controlDirectory: reservation.record.controlDirectory } } : {}) };
  }

  async function status(jobId, deadline) {
    if (!identity(jobId)) return { status: "unknown", reason: "ジョブ識別子が不正です" };
    return serialize(async () => {
      if (deadline !== undefined && (!Number.isFinite(deadline) || deadline <= deps.now())) return { status: "unknown", reason: "制御要求の期限が切れました" };
      const entry = jobs.get(jobId);
      if (!entry) return { status: "unknown", reason: "この worker が所有するジョブではありません" };
      if (entry.result && TERMINAL.has(entry.result.status)) return entry.result;
      try { return await finish(entry, normalizeState(await withTimeout(entry.adapter.status(jobId), deps.operationTimeoutMs), entry.job?.jobId)); }
      catch { return { status: "unknown", reason: "同じ接続から状態を確認できません" }; }
    });
  }

  async function stop(jobId, deadline) {
    if (!identity(jobId)) return { status: "unknown", reason: "ジョブ識別子が不正です" };
    return serialize(async () => {
      if (deadline !== undefined && (!Number.isFinite(deadline) || deadline <= deps.now())) return { status: "unknown", reason: "制御要求の期限が切れました" };
      const entry = jobs.get(jobId);
      if (!entry) return { status: "unknown", reason: "この worker が所有するジョブではありません" };
      if (entry.result && TERMINAL.has(entry.result.status)) return entry.result;
      try { return await finish(entry, normalizeState(await withTimeout((entry.adapter.stop ?? entry.adapter.cancel)(jobId), deps.operationTimeoutMs), entry.job?.jobId)); }
      catch { return { status: "unknown", reason: "同じ接続から停止を確認できません" }; }
    });
  }

  async function release() {
    for (const entry of [...owned]) if (TERMINAL.has(entry.result?.status)) await close(entry);
  }
  const resolveRequest = (requestId) => identity(requestId) ? requestJobs.get(requestId) : undefined;
  const resolveControlJob = async (requestId) => {
    const known = resolveRequest(requestId);
    if (!known || !identity(requestId)) return undefined;
    const entry = jobs.get(known);
    return entry?.requestIds?.includes(requestId) || entry?.request?.requestId === requestId ? known : undefined;
  };
  const controlStatus = async (requestId, deadline) => {
    const jobId = await resolveControlJob(requestId);
    return jobId ? status(jobId, deadline) : { status: "unknown", reason: "この worker は依頼を所有していません" };
  };
  const controlStop = async (requestId, deadline) => {
    const jobId = await resolveControlJob(requestId);
    return jobId ? stop(jobId, deadline) : { status: "unknown", reason: "この worker は依頼を所有していません" };
  };
  const acceptedControlRequestIds = (request) => {
    if (!onlyKeys(request, new Set(["requestId", "project", "cwd", "skill", "taskId"])) || !identity(request.requestId)) return [];
    const jobId = resolveRequest(request.requestId);
    if (!jobId) return [request.requestId];
    return [...requestJobs].filter(([, id]) => id === jobId).map(([id]) => id).filter(identity);
  };
  const acceptControlRequest = async (requestId) => {
    if (!identity(requestId) || typeof deps.store.resolveControlTarget !== "function") return false;
    const source = [...jobs.values()].find((entry) => !entry.closed && entry.generation && entry.request);
    if (!source) return false;
    try {
      const target = await deps.store.resolveControlTarget({ requestId, project: source.request.project, cwd: source.request.cwd, skill: source.request.skill, taskId: source.request.taskId });
      if (!onlyKeys(target, new Set(["generation", "controlDirectory"])) || target.generation !== source.generation || target.controlDirectory !== `control-${source.generation}`) return false;
      const jobId = [...jobs].find(([, entry]) => entry === source)?.[0];
      if (!jobId) return false;
      requestJobs.set(requestId, jobId);
      if (!source.requestIds.includes(requestId)) source.requestIds.push(requestId);
      return true;
    } catch { return false; }
  };
  const controlTarget = async (request) => {
    const allowed = new Set(["requestId", "project", "cwd", "skill", "taskId"]);
    if (!onlyKeys(request, allowed) || Object.keys(request).length !== allowed.size || !identity(request.requestId) ||
        typeof request.project !== "string" || !isAbsolute(request.project) || typeof request.cwd !== "string" || !isAbsolute(request.cwd) ||
        typeof request.skill !== "string" || !/^kiro-[a-z0-9][a-z0-9-]*$/.test(request.skill) ||
        typeof request.taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.taskId))
      return { kind: "unavailable", reason: "制御先の入力が不正です" };
    if (typeof deps.store.resolveControlTarget !== "function") return { kind: "unavailable", reason: "制御先を確認できません" };
    try {
      const target = await deps.store.resolveControlTarget({ requestId: request.requestId, project: request.project, cwd: request.cwd, skill: request.skill, taskId: request.taskId });
      return onlyKeys(target, new Set(["generation", "controlDirectory"])) && typeof target.generation === "string" && /^[a-f0-9]{32}$/.test(target.generation) &&
        target.controlDirectory === `control-${target.generation}`
        ? { generation: target.generation, controlDirectory: target.controlDirectory }
        : { kind: "unavailable", reason: "制御先を確認できません" };
    } catch { return { kind: "unavailable", reason: "制御先を確認できません" }; }
  };
  return Object.freeze({ start, status, stop, controlStatus, controlStop, controlTarget, acceptedControlRequestIds, acceptControlRequest, release, pendingJobId: () => [...owned].find((entry) => entry.result?.status === "unknown" && identity(entry.job?.jobId))?.job.jobId ?? null, isBusy: () => owned.size > 0 });
}

/** 本番依存を接続し、選択した登録から Pi / Codex adapter を組み立てる。 */
export function createDefaultJobWorker(options) {
  if (!object(options) || Object.keys(options).some((key) => !["select", "store", "now", "connectOptions", "adapterFactory", "readTransport", "resolveRegistration", "spawnProcess"].includes(key)) ||
      !object(options.store) || Object.keys(options.store).some((key) => !["reserve", "release", "markUnknown", "track", "releaseTrack", "resolveControlTarget"].includes(key)) ||
      typeof options.store.reserve !== "function" || typeof options.store.markUnknown !== "function" || options.store.resolveControlTarget !== undefined && typeof options.store.resolveControlTarget !== "function" ||
      options.store.release !== undefined && typeof options.store.release !== "function" ||
      options.store.track !== undefined && typeof options.store.track !== "function" ||
      options.store.releaseTrack !== undefined && typeof options.store.releaseTrack !== "function" ||
      options.select !== undefined && typeof options.select !== "function" ||
      options.now !== undefined && typeof options.now !== "function" ||
      options.connectOptions !== undefined && !object(options.connectOptions) && typeof options.connectOptions !== "function" ||
      options.adapterFactory !== undefined && typeof options.adapterFactory !== "function" ||
      options.readTransport !== undefined && typeof options.readTransport !== "function" ||
      options.resolveRegistration !== undefined && typeof options.resolveRegistration !== "function" ||
      options.spawnProcess !== undefined && typeof options.spawnProcess !== "function") return createJobWorker(null);
  const adapterFactory = options.adapterFactory ?? (async (connection) => connection.serverInfo?.name === "cc-sdd-codex" ? createCodexAdapter(connection) : createPiAdapter(connection));
  const adapters = new Map();
  const connect = async (candidate) => {
    const key = candidate?.registrationId;
    if (typeof key === "string" && adapters.has(key)) { const adapter = adapters.get(key); adapters.delete(key); return adapter; }
    const context = typeof options.connectOptions === "function" ? await options.connectOptions(candidate) : options.connectOptions;
    const connection = await connectStdioRegistration({ ...context, ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}), registration: context?.registration ?? candidate.registration ?? candidate, saved: context?.saved ?? candidate.saved ?? candidate, verifiedFamily: context?.verifiedFamily ?? candidate.verifiedFamily ?? candidate.family,
      readTransport: context?.readTransport ?? options.readTransport ?? (async () => { throw new Error("登録元の再読み取りは管理入口の統合で提供されます"); }),
      resolveRegistration: context?.resolveRegistration ?? ((registration, saved, family) => (options.resolveRegistration ?? resolveRegistration)(registration, saved, { verifiedFamily: family })) });
    try {
      const adapter = await adapterFactory(connection);
      adapter.close = () => connection.close();
      return adapter;
    } catch (error) { connection.close(); throw error; }
  };
  const select = options.select ?? (async (request) => {
    if (!Array.isArray(request?.candidates)) return { kind: "unavailable", reasons: ["委任候補の形式が不正です"] };
    const validCandidates = request.candidates.every((item) =>
      onlyKeys(item, new Set(["registration", "saved", "verifiedFamily", "tier"])) &&
      onlyKeys(item.registration, new Set(["host", "scope", "registrationName", "registrationId"])) &&
      onlyKeys(item.saved, new Set(["family", "scope", "registrationName", "registrationId", "models"])) &&
      identity(item.registration.host) && ["project", "user"].includes(item.registration.scope) && identity(item.registration.registrationName) && identity(item.registration.registrationId) &&
      identity(item.saved.family) && ["project", "user"].includes(item.saved.scope) && identity(item.saved.registrationName) && identity(item.saved.registrationId) &&
      (item.saved.models === undefined || onlyKeys(item.saved.models, new Set(["manufacture", "review", "design", "research", "debug"])) && Object.values(item.saved.models).every((config) =>
        onlyKeys(config, new Set(["fixed", "compatibleIds"])) && Object.keys(config).length === 1 &&
        (identity(config.fixed) || Array.isArray(config.compatibleIds) && config.compatibleIds.every(identity) && new Set(config.compatibleIds).size === config.compatibleIds.length))) &&
      item.saved.family === item.verifiedFamily && item.saved.scope === item.registration.scope && item.saved.registrationName === item.registration.registrationName && item.saved.registrationId === item.registration.registrationId &&
      identity(item.verifiedFamily) && ["local", "cloud"].includes(item.tier));
    if (!validCandidates) return { kind: "unavailable", reasons: ["委任候補の形式が不正です"] };
    const registrationIds = request.candidates.map((item) => item.registration.registrationId);
    if (new Set(registrationIds).size !== registrationIds.length) return { kind: "unavailable", reasons: ["委任候補に重複した登録識別子があります"] };
    const candidates = [];
    const connectionFailures = [];
    for (const item of request.candidates) {
      const registration = { host: item.registration.host, scope: item.registration.scope, name: item.registration.registrationName, registrationId: item.registration.registrationId, status: "eligible" };
      let adapter;
      try {
        adapter = await connect({ registration, saved: item.saved, family: item.verifiedFamily, verifiedFamily: item.verifiedFamily, registrationId: item.registration.registrationId });
        const [capability, models] = await Promise.all([adapter.capabilities(), adapter.models()]);
        if (!object(capability) || capability.tier !== item.tier) { await closeAdapter(adapter); continue; }
        candidates.push({ saved: item.saved, capability, models });
        adapters.set(item.registration.registrationId, adapter);
      } catch (error) { await closeAdapter(adapter); connectionFailures.push(error instanceof Error ? error.message : "登録済み MCP に接続できません"); /* 接続・契約を確認できない候補は選択対象に含めない */ }
    }
    const selectionOptions = request.readOnly === true || request.access === "read-only" || request.options?.readOnly === true
      ? { ...(request.options ?? {}), readOnly: true }
      : request.options;
    const selected = selectDelegate({ settings: request.settings, role: request.role, host: request.host, candidates, native: request.native, options: selectionOptions });
    if (selected.kind !== "mcp") for (const adapter of adapters.values()) await closeAdapter(adapter);
    else for (const [id, adapter] of adapters) if (id !== selected.candidate.registrationId) { await closeAdapter(adapter); adapters.delete(id); }
    if (selected.kind === "mcp") selected.candidate.registrationId = selected.candidate.registrationId ?? request.candidates.find((item) => item.saved.registrationName === selected.candidate.registrationName)?.registration.registrationId;
    if (selected.kind === "unavailable" && connectionFailures.length) return { kind: "unavailable", reasons: [...new Set([...connectionFailures, ...selected.reasons])] };
    return selected;
  });
  select.releaseProbed = async () => { for (const adapter of adapters.values()) await closeAdapter(adapter); adapters.clear(); };
  return createJobWorker({ select, connect, store: options.store, now: options.now ?? Date.now });
}

/** 標準入力から依頼を一件受け、所有ジョブの終端までプロセスを維持する。 */
export async function runWorkerProcess(options) {
  if (!object(options) || Object.keys(options).some((key) => !["stdin", "stdout", "deps", "wait", "control"].includes(key)) || options.wait !== undefined && typeof options.wait !== "function") return { kind: "unavailable", reasons: ["worker process の入力形式が不正です"] };
  const { stdin, stdout, deps } = options;
  if (!stdin || typeof stdin.on !== "function" || !stdout || typeof stdout.write !== "function" || !object(deps) || Object.keys(deps).some((key) => key !== "worker" && key !== "createWorker")) return { kind: "unavailable", reasons: ["worker process の入出力または依存関係が不正です"] };
  // 呼び出し元が先に終了して出力先が閉じても、ジョブ所有者は処理の終端まで接続を保持する。
  stdout.on?.("error", () => {});
  let buffer = "";
  const lines = [];
  const onData = (chunk) => {
    buffer += String(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) { lines.push(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
  };
  stdin.setEncoding?.("utf8");
  await new Promise((resolve) => {
    const onLine = (chunk) => { onData(chunk); if (lines.length) { stdin.off("data", onLine); resolve(); } };
    stdin.on("data", onLine);
    stdin.once("end", () => { if (!lines.length && buffer) lines.push(buffer); resolve(); });
  });
  let request;
  try { request = JSON.parse(lines[0] ?? ""); } catch { request = null; }
  let worker;
  try { worker = deps.worker ?? await deps.createWorker?.(request); } catch { worker = null; }
  const raw = worker && typeof worker.start === "function" ? await worker.start(request) : { kind: "unavailable", reasons: ["worker を初期化できません"] };
  const control = object(raw?.control) && Object.keys(raw.control).every((key) => ["generation", "controlDirectory"].includes(key)) &&
    typeof raw.control.generation === "string" && /^[a-f0-9]{32}$/.test(raw.control.generation) && typeof raw.control.controlDirectory === "string" &&
    raw.control.controlDirectory === `control-${raw.control.generation}` ? { generation: raw.control.generation, controlDirectory: raw.control.controlDirectory } : null;
  const result = object(raw) && raw.kind === "started" && object(raw.job) && identity(raw.job.jobId)
    ? { kind: "started", job: { serverId: raw.job.serverId, connectionId: raw.job.connectionId, jobId: raw.job.jobId }, ...(control ? { control } : {}) }
    : object(raw) && raw.kind === "pending" && identity(raw.requestId) && typeof raw.reason === "string"
      ? { kind: "pending", requestId: raw.requestId, reason: raw.reason, ...(control ? { control } : {}) }
      : object(raw) && raw.kind === "native" && identity(raw.agentName) && typeof raw.reason === "string"
        ? { kind: "native", agentName: raw.agentName, reason: raw.reason }
        : { kind: "unavailable", reasons: object(raw) && raw.kind === "unavailable" && Array.isArray(raw.reasons) && raw.reasons.every((item) => typeof item === "string") ? [...raw.reasons] : ["worker が認識できない結果を返しました"] };
  try { stdout.write(`${JSON.stringify(result)}\n`); } catch { /* 出力不能でも所有ジョブの監視を続ける */ }
  if (worker && typeof worker.isBusy === "function" && worker.isBusy()) {
    const runtime = process.env.XDG_RUNTIME_DIR || (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "");
    const project = identity(request?.project) && isAbsolute(request.project) ? resolve(request.project) : null;
    const runtimeRoot = runtime && project ? join(resolve(runtime), "cc-sdd-bootstrap", createHash("sha256").update(project).digest("hex").slice(0, 24)) : null;
    const controlRequest = request && object(request) ? { requestId: request.requestId, project: request.project, cwd: request.cwd, skill: request.skill, taskId: request.taskId } : null;
    let target = null;
    try { target = await worker.controlTarget?.(controlRequest); } catch { target = null; }
    const controlInput = options.control ?? (runtimeRoot && identity(request?.requestId)
      ? { root: runtimeRoot, requestId: request.requestId,
          controlDirectory: target?.controlDirectory, generation: target?.generation ?? randomUUID().replaceAll("-", ""),
          acceptRequest: worker.acceptControlRequest ? (requestId) => worker.acceptControlRequest(requestId) : undefined,
          acceptedRequestIds: worker.acceptControlRequest ? undefined : worker.acceptedControlRequestIds?.(controlRequest) ?? [request.requestId],
          isCurrentGeneration: async () => (await worker.controlTarget?.(controlRequest))?.generation === target?.generation }
      : null);
    const control = controlInput ? await serveControl(worker, controlInput).catch(() => null) : null;
    await new Promise((resolve) => {
      const jobId = result.kind === "started" ? result.job.jobId : worker.pendingJobId?.() ?? null;
      const observe = async () => {
        if (jobId && typeof worker.status === "function") {
          try { await worker.status(jobId); } catch { /* 確認不能の間は所有者を維持 */ }
        }
        if (!worker.isBusy()) resolve();
        else {
          try {
            if (options.wait) await options.wait();
            else await new Promise((resolve) => setTimeout(resolve, 1000));
          } catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
          observe();
        }
      };
      setImmediate(observe);
    });
    await control?.close();
  }
  await worker?.release?.();
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const createWorker = (request) => {
    if (!object(request) || !identity(request.project) || !identity(request.cwd) || !isAbsolute(request.project) || !isAbsolute(request.cwd)) return createJobWorker(null);
    const runtime = process.env.XDG_RUNTIME_DIR || (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "");
    if (!runtime || !resolve(runtime).startsWith("/")) return createJobWorker(null);
    const projectKey = createHash("sha256").update(resolve(request.project)).digest("hex").slice(0, 24);
    const store = createDelegationJobStore({ root: join(resolve(runtime), "cc-sdd-bootstrap", projectKey), writableRoots: [resolve(request.project)] });
    return createDefaultJobWorker({ store });
  };
  runWorkerProcess({ stdin: process.stdin, stdout: process.stdout, deps: { createWorker } }).catch(() => { process.exitCode = 1; });
}
