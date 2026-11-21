import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const SKILL = /^kiro-[a-z0-9][a-z0-9-]*$/;
const TASK = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,127}$/;
export const isDelegationIdentifier = (value) => typeof value === "string" && REQUEST.test(value);
const BASE_INPUT_KEYS = ["requestId", "project", "cwd", "skill", "taskId"];
const FACTORY_KEYS = new Set(["root", "writableRoots", "resolveWorktreeRoot"]);
const runFile = promisify(execFile);

/** 書き込み依頼を起動前に排他記録し、同じ作業の再送を既存記録へ束ねる。 */
export function createDelegationJobStore(options) {
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !FACTORY_KEYS.has(key)) ||
      typeof options.root !== "string" || !isAbsolute(options.root) || !Array.isArray(options.writableRoots) || !options.writableRoots.length ||
      options.writableRoots.some((path) => typeof path !== "string" || !isAbsolute(path)) ||
      (options.resolveWorktreeRoot !== undefined && typeof options.resolveWorktreeRoot !== "function")) {
    const blocked = async () => ({ kind: "blocked", reason: "実行時領域と書き込み可能な作業範囲が必要です" });
    return Object.freeze({ reserve: blocked, release: async () => false, markUnknown: async () => false, resolveControlTarget: async () => null });
  }
  const root = resolve(options.root);
  const writableRoots = options.writableRoots.map((path) => resolve(path));
  const ledger = join(root, "jobs.json");
  const lock = join(root, "jobs.lock");
  const resolveWorktreeRoot = options.resolveWorktreeRoot ?? (async (cwd) => {
    const { stdout } = await runFile("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
    return realpath(stdout.trim());
  });

  function validInput(input, optionalKeys = []) {
    return input !== null && typeof input === "object" && !Array.isArray(input) &&
      Object.keys(input).every((key) => BASE_INPUT_KEYS.includes(key) || optionalKeys.includes(key)) &&
      BASE_INPUT_KEYS.every((key) => Object.hasOwn(input, key)) &&
      typeof input.requestId === "string" && REQUEST.test(input.requestId) &&
      typeof input.project === "string" && isAbsolute(input.project) &&
      typeof input.cwd === "string" && isAbsolute(input.cwd) &&
      typeof input.skill === "string" && SKILL.test(input.skill) &&
      typeof input.taskId === "string" && TASK.test(input.taskId) &&
      (input.generation === undefined || typeof input.generation === "string" && /^[a-f0-9]{32}$/.test(input.generation));
  }

  async function prepare(project) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    const actual = await realpath(root).catch(() => null);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || actual !== root) return false;
    for (const writable of writableRoots) {
      const real = await realpath(writable).catch(() => null);
      if (!real) return false;
      if (inside(real, root) || inside(root, real)) return false;
    }
    const p = await realpath(project).catch(() => null);
    if (p !== project) return false;
    return !inside(p, root) && !inside(root, p);
  }

  function validLedger(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["version", "records", "requests", "controls"].includes(key)) ||
        value.version !== 1 || !value.records || typeof value.records !== "object" || Array.isArray(value.records) ||
        !value.requests || typeof value.requests !== "object" || Array.isArray(value.requests) ||
        value.controls !== undefined && (!value.controls || typeof value.controls !== "object" || Array.isArray(value.controls))) return false;
    for (const [key, record] of Object.entries(value.records)) {
      if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key) || !record || typeof record !== "object" || Array.isArray(record) ||
          Object.keys(record).some((field) => !["project", "skill", "taskId", "requestId", "requestIds", "status", "generation", "controlDirectory", "ownerPid", "heartbeatAt", "result", "unknownReason"].includes(field)) ||
          typeof record.project !== "string" || !isAbsolute(record.project) || typeof record.skill !== "string" || !SKILL.test(record.skill) ||
          typeof record.taskId !== "string" || !TASK.test(record.taskId) ||
          typeof record.requestId !== "string" || !REQUEST.test(record.requestId) || !Array.isArray(record.requestIds) || !record.requestIds.length ||
          record.requestIds.some((id) => typeof id !== "string" || !REQUEST.test(id)) ||
          !["reserved", "available", "unknown", "tracking", "terminal"].includes(record.status) || typeof record.generation !== "string" || !/^[a-f0-9]{32}$/.test(record.generation) ||
          record.ownerPid !== undefined && (!Number.isInteger(record.ownerPid) || record.ownerPid < 1) || record.heartbeatAt !== undefined && !Number.isFinite(record.heartbeatAt) ||
          record.result !== undefined && (!record.result || typeof record.result !== "object" || Array.isArray(record.result) || Object.keys(record.result).some((key) => !["status", "summary", "at"].includes(key)) || !["succeeded", "failed", "stopped"].includes(record.result.status) || typeof record.result.summary !== "string" || !Number.isFinite(record.result.at)) ||
          record.unknownReason !== undefined && typeof record.unknownReason !== "string" ||
          record.controlDirectory !== undefined && (typeof record.controlDirectory !== "string" || !/^control-[A-Za-z0-9._:-]{1,128}$/.test(record.controlDirectory))) return false;
      if (new Set(record.requestIds).size !== record.requestIds.length || record.requestIds.some((id) =>
        !Object.hasOwn(value.requests, id) || value.requests[id] !== key)) return false;
      const expected = createHash("sha256").update(`${record.project}\0${record.skill}\0${record.taskId}`).digest("hex");
      if (key !== expected || record.requestId !== record.requestIds[0]) return false;
    }
    for (const [id, key] of Object.entries(value.requests)) if (typeof id !== "string" || !REQUEST.test(id) || typeof key !== "string" ||
        !Object.hasOwn(value.records, key) || !Array.isArray(value.records[key].requestIds) || !value.records[key].requestIds.includes(id)) return false;
    for (const [id, control] of Object.entries(value.controls ?? {})) if (!REQUEST.test(id) || !control || typeof control !== "object" || Array.isArray(control) ||
        Object.keys(control).some((field) => !["project", "skill", "taskId", "generation", "controlDirectory", "status", "ownerPid", "heartbeatAt", "result", "unknownReason"].includes(field)) ||
        typeof control.project !== "string" || !isAbsolute(control.project) || typeof control.skill !== "string" || !SKILL.test(control.skill) ||
        typeof control.taskId !== "string" || !TASK.test(control.taskId) || typeof control.generation !== "string" || !/^[a-f0-9]{32}$/.test(control.generation) ||
        typeof control.controlDirectory !== "string" || !/^control-[A-Za-z0-9._:-]{1,128}$/.test(control.controlDirectory) ||
        control.status !== undefined && !["tracking", "unknown", "terminal"].includes(control.status) ||
        control.ownerPid !== undefined && (!Number.isInteger(control.ownerPid) || control.ownerPid < 1) ||
        control.heartbeatAt !== undefined && !Number.isFinite(control.heartbeatAt) ||
        control.result !== undefined && (!control.result || typeof control.result !== "object" || Array.isArray(control.result) || Object.keys(control.result).some((key) => !["status", "summary", "at"].includes(key)) || !["succeeded", "failed", "stopped"].includes(control.result.status) || typeof control.result.summary !== "string" || !Number.isFinite(control.result.at)) ||
        control.unknownReason !== undefined && typeof control.unknownReason !== "string") return false;
    return true;
  }

  async function readLedger() {
    try {
      const info = await lstat(ledger);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077) !== 0) return null;
      const value = JSON.parse(await readFile(ledger, "utf8"));
      return validLedger(value) ? value : null;
    } catch (error) { return error.code === "ENOENT" ? { version: 1, records: {}, requests: {} } : null; }
  }

  async function writeLedger(value) {
    const path = join(root, `.jobs-${randomBytes(12).toString("hex")}.tmp`);
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
      await handle.close(); handle = null;
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077) !== 0) return false;
      await rename(path, ledger);
      return true;
    } catch { return false; }
    finally { await handle?.close().catch(() => {}); await rm(path, { force: true }).catch(() => {}); }
  }

  async function withLedger(input, update, optionalKeys = []) {
    if (!validInput(input, optionalKeys)) return { kind: "blocked", reason: "依頼 ID、作業ツリー、手順またはタスクを確認できません" };
    const cwd = await realpath(input.cwd).catch(() => null);
    let project = null;
    try {
      if (!cwd) return { kind: "blocked", reason: "安全な実行時領域または作業ツリーを確認できません" };
      project = await resolveWorktreeRoot(cwd);
      if (typeof project !== "string" || !isAbsolute(project)) return { kind: "blocked", reason: "安全な実行時領域または作業ツリーを確認できません" };
      project = await realpath(project);
      const requestedProject = await realpath(input.project);
      if (requestedProject !== project || !inside(project, cwd) || !await prepare(project)) return { kind: "blocked", reason: "安全な実行時領域または作業ツリーを確認できません" };
    }
    catch { return { kind: "blocked", reason: "安全な実行時領域または作業ツリーを確認できません" }; }
    let handle;
    for (let attempt = 0; attempt < 10000 && !handle; attempt += 1) {
      try { handle = await open(lock, "wx", 0o600); }
      catch (error) {
        if (error.code !== "EEXIST") return { kind: "blocked", reason: "依頼記録を排他できません" };
        await new Promise((resolveNext) => setImmediate(resolveNext));
      }
    }
    if (!handle) return { kind: "blocked", reason: "依頼記録を排他できません" };
    try {
      const lockInfo = await lstat(lock);
      if (!lockInfo.isFile() || lockInfo.isSymbolicLink() || lockInfo.uid !== process.getuid?.() || lockInfo.nlink !== 1 || (lockInfo.mode & 0o077) !== 0) return { kind: "blocked", reason: "依頼記録の排他状態が不正です" };
      const current = await readLedger();
      if (!current) return { kind: "blocked", reason: "既存の依頼記録が破損しているため起動できません" };
      const workKey = createHash("sha256").update(`${project}\0${input.skill}\0${input.taskId}`).digest("hex");
      const hasRequest = Object.hasOwn(current.requests, input.requestId);
      const mappedKey = hasRequest ? current.requests[input.requestId] : undefined;
      if (hasRequest && mappedKey !== workKey) return { kind: "blocked", reason: "依頼 ID が別の作業に結び付いています" };
      const existing = Object.hasOwn(current.records, workKey) ? current.records[workKey] : undefined;
      const result = update(current, workKey, existing, project);
      if (result.next && !await writeLedger(result.next)) return { kind: "blocked", reason: "依頼記録を書き込めないため起動できません" };
      return result.value;
    } catch { return { kind: "blocked", reason: "依頼記録を安全に更新できません" }; }
    finally { await handle.close().catch(() => {}); await rm(lock, { force: true }).catch(() => {}); }
  }

  async function reserve(input) {
    return withLedger(input, (current, workKey, existing, project) => {
      if (Object.hasOwn(current.controls ?? {}, input.requestId))
        return { next: null, value: { kind: "blocked", reason: "依頼 ID は既存の読み取り専用制御先に結び付いています" } };
      if (existing?.status === "terminal") {
        const requestIds = existing.requestIds.includes(input.requestId) ? existing.requestIds : [...existing.requestIds, input.requestId];
        const requests = Object.assign(Object.create(null), current.requests, { [input.requestId]: workKey });
        const records = Object.assign(Object.create(null), current.records, { [workKey]: { ...existing, requestIds } });
        const next = requestIds.length === existing.requestIds.length && Object.hasOwn(current.requests, input.requestId)
          ? null : { ...current, records, requests };
        return { next, value: { kind: "existing", status: "terminal", result: existing.result } };
      }
      if (existing?.status === "tracking") existing = undefined;
      if (existing?.status === "available" && existing.requestId === input.requestId) {
        const record = { ...existing, status: "reserved" };
        const records = Object.assign(Object.create(null), current.records, { [workKey]: record });
        return { next: { ...current, records }, value: { kind: "created", record } };
      }
      if (existing) {
        const requestIds = existing.requestIds.includes(input.requestId) ? existing.requestIds : [...existing.requestIds, input.requestId];
        const requests = Object.assign(Object.create(null), current.requests, { [input.requestId]: workKey });
        const records = Object.assign(Object.create(null), current.records);
        records[workKey] = { ...existing, requestIds };
        const next = requestIds.length === existing.requestIds.length && Object.hasOwn(current.requests, input.requestId) && current.requests[input.requestId] === workKey ? null : {
          ...current, records, requests,
        };
        return { next, value: existing.status === "unknown"
          ? { kind: "blocked", reason: "終了を確認できません。確認または停止してから再実行してください" }
          : { kind: "existing", record: { ...existing, requestIds } } };
      }
      const generation = randomBytes(16).toString("hex");
      const record = { project, skill: input.skill, taskId: input.taskId, requestId: input.requestId,
        requestIds: [input.requestId], status: "reserved", generation, controlDirectory: `control-${generation}` };
      const requests = Object.assign(Object.create(null), current.requests, { [input.requestId]: workKey });
      const records = Object.assign(Object.create(null), current.records);
      records[workKey] = record;
      const next = { ...current, records, requests };
      return { next, value: { kind: "created", record } };
    });
  }

  async function markUnknown(input) {
    if (input?.reason !== undefined && typeof input.reason !== "string") return false;
    const result = await withLedger(input, (current, workKey, existing, project) => {
      const reason = typeof input.reason === "string" ? input.reason.slice(0, 200) : "終了を確認できません。確認または停止してから再実行してください";
      if (existing && existing.status !== "terminal" && existing.requestIds.includes(input.requestId)) {
        const records = Object.assign(Object.create(null), current.records, { [workKey]: { ...existing, status: "unknown", unknownReason: reason } });
        return { next: { ...current, records }, value: true };
      }
      const control = current.controls?.[input.requestId];
      if (control && control.status !== "terminal" && control.project === project && control.skill === input.skill && control.taskId === input.taskId) {
        const controls = Object.assign(Object.create(null), current.controls, { [input.requestId]: { ...control, status: "unknown", unknownReason: reason } });
        return { next: { ...current, controls }, value: true };
      }
      return { next: null, value: false };
    }, ["reason"]);
    return result === true;
  }

  async function updateOwner(input, update, operationKeys) {
    const result = await withLedger(input, (current, workKey, existing, project) => {
      if (existing && existing.requestIds.includes(input.requestId) && existing.project === project &&
          existing.skill === input.skill && existing.taskId === input.taskId && existing.generation === input.generation) {
        if (existing.status === "terminal") return { next: null, value: false };
        const record = update(existing);
        const records = Object.assign(Object.create(null), current.records, { [workKey]: record });
        return { next: { ...current, records }, value: true };
      }
      const controls = Object.assign(Object.create(null), current.controls);
      const control = controls[input.requestId];
      if (!control || control.project !== project || control.skill !== input.skill || control.taskId !== input.taskId ||
          control.generation !== input.generation || control.status === "terminal") return { next: null, value: false };
      const record = update({ ...control, status: control.status ?? "tracking" });
      controls[input.requestId] = record;
      return { next: { ...current, controls }, value: true };
    }, ["generation", ...operationKeys]);
    return result === true;
  }
  async function recordOwner(input) {
    if (!input || Object.keys(input).some((key) => ![...BASE_INPUT_KEYS, "generation", "pid", "now"].includes(key)) || !Number.isInteger(input.pid) || input.pid < 1 || !Number.isFinite(input.now) || typeof input.generation !== "string" || !/^[a-f0-9]{32}$/.test(input.generation)) return false;
    return updateOwner(input, (record) => ({ ...record, ownerPid: input.pid, heartbeatAt: input.now }), ["pid", "now"]);
  }
  async function heartbeat(input) {
    if (!input || Object.keys(input).some((key) => ![...BASE_INPUT_KEYS, "generation", "now"].includes(key)) || !Number.isFinite(input.now) || typeof input.generation !== "string" || !/^[a-f0-9]{32}$/.test(input.generation)) return false;
    return updateOwner(input, (record) => ({ ...record, heartbeatAt: input.now }), ["now"]);
  }
  async function recordTerminal(input) {
    if (!input || Object.keys(input).some((key) => ![...BASE_INPUT_KEYS, "generation", "status", "summary", "now"].includes(key)) || typeof input.generation !== "string" || !/^[a-f0-9]{32}$/.test(input.generation) || !new Set(["succeeded", "failed", "stopped"]).has(input.status) || typeof input.summary !== "string" || !Number.isFinite(input.now)) return false;
    return updateOwner(input, (record) => ({ ...record, status: "terminal", result: { status: input.status, summary: input.summary.slice(0, 500), at: input.now }, unknownReason: undefined }), ["status", "summary", "now"]);
  }
  async function inspectOwner(input) {
    if (!input || Object.keys(input).some((key) => ![...BASE_INPUT_KEYS, "generation", "now", "heartbeatTtlMs", "isAlive"].includes(key)) || typeof input.generation !== "string" || !/^[a-f0-9]{32}$/.test(input.generation) || !Number.isFinite(input.now) || !Number.isFinite(input.heartbeatTtlMs) || input.heartbeatTtlMs < 0 || typeof input.isAlive !== "function") return { kind: "unknown", reason: "所有者を確認できません" };
    const found = await withLedger(input, (current, key, record, project) => {
      const control = current.controls?.[input.requestId];
      const match = record?.generation === input.generation ? record
        : control?.generation === input.generation && control.project === project && control.skill === input.skill && control.taskId === input.taskId ? control : null;
      return { next: null, value: match };
    }, ["generation", "now", "heartbeatTtlMs", "isAlive"]);
    if (!found) return { kind: "unknown", reason: "所有者を確認できません" };
    if (found.status === "terminal") return { kind: "terminal", result: found.result };
    let alive = false;
    try { alive = await input.isAlive(found.ownerPid) === true; } catch {}
    if (!alive || !Number.isFinite(found.heartbeatAt) || input.now - found.heartbeatAt > input.heartbeatTtlMs)
      return { kind: "lost", reason: "制御所有者を確認できません。終了を確認できません。確認または停止してから再実行してください" };
    return { kind: "alive" };
  }

  /** 読み取り専用ジョブの制御先を保存する。書き込み予約の重複判定には使わない。 */
  async function track(input) {
    return withLedger(input, (current, workKey, existing, project) => {
      if (existing?.requestIds?.includes(input.requestId) || Object.hasOwn(current.requests, input.requestId))
        return { next: null, value: { kind: "blocked", reason: "依頼 ID は稼働中の書き込み予約に結び付いています" } };
      const prior = Object.hasOwn(current.controls ?? {}, input.requestId) ? current.controls[input.requestId] : undefined;
      if (prior && (prior.project !== project || prior.skill !== input.skill || prior.taskId !== input.taskId))
        return { next: null, value: { kind: "blocked", reason: "依頼 ID が別の作業に結び付いています" } };
      if (prior?.status === "terminal") return { next: null, value: { kind: "existing", status: "terminal", result: prior.result } };
      if (prior) return { next: null, value: { kind: "existing", record: prior } };
      const generation = randomBytes(16).toString("hex");
      const record = { project, skill: input.skill, taskId: input.taskId, generation, controlDirectory: `control-${generation}`, status: "tracking" };
      const controls = Object.assign(Object.create(null), current.controls, { [input.requestId]: record });
      return { next: { ...current, controls }, value: { kind: "tracked", record } };
    });
  }

  async function release(input) {
    const result = await withLedger(input, (current, workKey, existing) => {
      if (!existing || !["reserved", "available"].includes(existing.status) || !existing.requestIds.includes(input.requestId)) return { next: null, value: false };
      const requestIds = existing.requestIds.filter((id) => id !== input.requestId);
      const requests = Object.assign(Object.create(null), current.requests);
      delete requests[input.requestId];
      const records = Object.assign(Object.create(null), current.records);
      if (!requestIds.length) delete records[workKey];
      else if (existing.requestId === input.requestId) records[workKey] = { ...existing, requestId: requestIds[0], requestIds, status: "available" };
      else records[workKey] = { ...existing, requestIds };
      return { next: { ...current, records, requests }, value: true };
    });
    return result === true;
  }

  async function resolveControlTarget(input) {
    return withLedger(input, (current, workKey, existing, project) => {
      const control = Object.hasOwn(current.controls ?? {}, input.requestId) ? current.controls[input.requestId] : undefined;
      if (control && control.project === project && control.skill === input.skill && control.taskId === input.taskId && control.status === "terminal")
        return { next: null, value: { kind: "terminal", result: control.result } };
      if (control && control.project === project && control.skill === input.skill && control.taskId === input.taskId)
        return { next: null, value: { generation: control.generation, controlDirectory: control.controlDirectory } };
      if (existing?.status === "terminal" && existing.requestIds.includes(input.requestId))
        return { next: null, value: { kind: "terminal", result: existing.result } };
      if (!existing || !existing.requestIds.includes(input.requestId) || !existing.controlDirectory) return { next: null, value: null };
      return { next: null, value: { generation: existing.generation, controlDirectory: existing.controlDirectory } };
    });
  }

  async function releaseTrack(input) {
    const result = await withLedger(input, (current) => {
      const control = Object.hasOwn(current.controls ?? {}, input.requestId) ? current.controls[input.requestId] : undefined;
      if (!control || control.generation !== input.generation || control.project !== input.project || control.skill !== input.skill || control.taskId !== input.taskId)
        return { next: null, value: false };
      const controls = Object.assign(Object.create(null), current.controls);
      delete controls[input.requestId];
      return { next: { ...current, controls }, value: true };
    }, ["generation"]);
    return result === true;
  }

  return Object.freeze({ reserve, release, markUnknown, track, releaseTrack, resolveControlTarget, recordOwner, heartbeat, recordTerminal, inspectOwner });
}

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
