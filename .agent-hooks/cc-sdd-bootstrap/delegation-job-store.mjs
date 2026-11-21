import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const SKILL = /^kiro-[a-z0-9][a-z0-9-]*$/;
const TASK = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEYS = new Set(["requestId", "project", "cwd", "skill", "taskId"]);
const FACTORY_KEYS = new Set(["root", "writableRoots", "resolveWorktreeRoot"]);
const runFile = promisify(execFile);

/** 書き込み依頼を起動前に排他記録し、同じ作業の再送を既存記録へ束ねる。 */
export function createDelegationJobStore(options) {
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !FACTORY_KEYS.has(key)) ||
      typeof options.root !== "string" || !isAbsolute(options.root) || !Array.isArray(options.writableRoots) || !options.writableRoots.length ||
      options.writableRoots.some((path) => typeof path !== "string" || !isAbsolute(path)) ||
      (options.resolveWorktreeRoot !== undefined && typeof options.resolveWorktreeRoot !== "function")) {
    const blocked = async () => ({ kind: "blocked", reason: "実行時領域と書き込み可能な作業範囲が必要です" });
    return Object.freeze({ reserve: blocked, release: async () => false, markUnknown: async () => false });
  }
  const root = resolve(options.root);
  const writableRoots = options.writableRoots.map((path) => resolve(path));
  const ledger = join(root, "jobs.json");
  const lock = join(root, "jobs.lock");
  const resolveWorktreeRoot = options.resolveWorktreeRoot ?? (async (cwd) => {
    const { stdout } = await runFile("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
    return realpath(stdout.trim());
  });

  function validInput(input) {
    return input !== null && typeof input === "object" && !Array.isArray(input) &&
      Object.keys(input).every((key) => KEYS.has(key)) && Object.keys(input).length === KEYS.size &&
      typeof input.requestId === "string" && REQUEST.test(input.requestId) &&
      typeof input.project === "string" && isAbsolute(input.project) &&
      typeof input.cwd === "string" && isAbsolute(input.cwd) &&
      typeof input.skill === "string" && SKILL.test(input.skill) &&
      typeof input.taskId === "string" && TASK.test(input.taskId);
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
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["version", "records", "requests"].includes(key)) ||
        value.version !== 1 || !value.records || typeof value.records !== "object" || Array.isArray(value.records) ||
        !value.requests || typeof value.requests !== "object" || Array.isArray(value.requests)) return false;
    for (const [key, record] of Object.entries(value.records)) {
      if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key) || !record || typeof record !== "object" || Array.isArray(record) ||
          Object.keys(record).some((field) => !["project", "skill", "taskId", "requestId", "requestIds", "status", "generation"].includes(field)) ||
          typeof record.project !== "string" || !isAbsolute(record.project) || typeof record.skill !== "string" || !SKILL.test(record.skill) ||
          typeof record.taskId !== "string" || !TASK.test(record.taskId) ||
          typeof record.requestId !== "string" || !REQUEST.test(record.requestId) || !Array.isArray(record.requestIds) || !record.requestIds.length ||
          record.requestIds.some((id) => typeof id !== "string" || !REQUEST.test(id)) ||
          !["reserved", "available", "unknown"].includes(record.status) || typeof record.generation !== "string" || !/^[a-f0-9]{32}$/.test(record.generation)) return false;
      if (new Set(record.requestIds).size !== record.requestIds.length || record.requestIds.some((id) =>
        !Object.hasOwn(value.requests, id) || value.requests[id] !== key)) return false;
      const expected = createHash("sha256").update(`${record.project}\0${record.skill}\0${record.taskId}`).digest("hex");
      if (key !== expected || record.requestId !== record.requestIds[0]) return false;
    }
    for (const [id, key] of Object.entries(value.requests)) if (typeof id !== "string" || !REQUEST.test(id) || typeof key !== "string" ||
        !Object.hasOwn(value.records, key) || !Array.isArray(value.records[key].requestIds) || !value.records[key].requestIds.includes(id)) return false;
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

  async function withLedger(input, update) {
    if (!validInput(input)) return { kind: "blocked", reason: "依頼 ID、作業ツリー、手順またはタスクを確認できません" };
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
          ? { kind: "blocked", reason: "同じ書き込み作業の先行ジョブが未確定です", record: { ...existing, requestIds } }
          : { kind: "existing", record: { ...existing, requestIds } } };
      }
      const record = { project, skill: input.skill, taskId: input.taskId, requestId: input.requestId,
        requestIds: [input.requestId], status: "reserved", generation: randomBytes(16).toString("hex") };
      const requests = Object.assign(Object.create(null), current.requests, { [input.requestId]: workKey });
      const records = Object.assign(Object.create(null), current.records);
      records[workKey] = record;
      const next = { ...current, records, requests };
      return { next, value: { kind: "created", record } };
    });
  }

  async function markUnknown(input) {
    const result = await withLedger(input, (current, workKey, existing) => {
      if (!existing || !existing.requestIds.includes(input.requestId)) return { next: null, value: false };
      const record = { ...existing, status: "unknown" };
      const records = Object.assign(Object.create(null), current.records);
      records[workKey] = record;
      return { next: { ...current, records }, value: true };
    });
    return result === true;
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

  return Object.freeze({ reserve, release, markUnknown });
}

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
