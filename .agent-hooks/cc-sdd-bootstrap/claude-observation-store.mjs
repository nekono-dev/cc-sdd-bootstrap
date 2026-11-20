import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Claude のモデル観測をプロジェクト・セッション別に原子的に保管する。 */
export function createClaudeObservationStore({ root } = {}) {
  if (typeof root !== "string" || !root) throw new TypeError("観測ストアの保存先が必要です");
  const privateRoot = resolve(root);
  const keyFor = ({ project, sessionId }) => {
    if (typeof project !== "string" || typeof sessionId !== "string" || !sessionId) return null;
    return createHash("sha256").update(`${resolve(project)}\0${sessionId}`).digest("hex");
  };
  const fileFor = (key) => /^[a-f0-9]{64}$/.test(key) ? join(privateRoot, `${key}.json`) : null;
  const fenceFor = (key) => /^[a-f0-9]{64}$/.test(key) ? join(privateRoot, `${key}.fence`) : null;

  async function ensureRoot() {
    await mkdir(privateRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(privateRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.nlink < 2 || (info.mode & 0o077) !== 0) throw new Error("観測ストアの権限が不正です");
  }

  async function readFence(key) {
    const path = fenceFor(key);
    if (!path) return null;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077) !== 0) return null;
      const token = await readFile(path, "utf8");
      return /^[a-f0-9-]{36}$/.test(token) ? token : null;
    } catch { return null; }
  }

  async function atomicWrite(path, value, key) {
    const temporary = join(dirname(path), `.${key}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(typeof value === "string" ? value : JSON.stringify(value));
      await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, path);
    } finally { await handle?.close(); await rm(temporary, { force: true }); }
  }

  async function withLock(key, action) {
    const file = fileFor(key);
    if (!file) throw new TypeError("不正な観測キーです");
    await ensureRoot();
    const lock = `${file}.lock`;
    let handle;
    try {
      handle = await open(lock, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      return await action(file);
    } finally {
      await handle?.close();
      if (handle) await rm(lock, { force: true });
    }
  }

  async function readUnlocked(file) {
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077) !== 0) return null;
        const value = JSON.parse(await readFile(file, "utf8"));
        if (!value || !["pending", "confirmed"].includes(value.status) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || typeof value.fenceToken !== "string") return null;
        if (value.status === "confirmed" && typeof value.modelId !== "string") return null;
        return value;
      } catch { return null; }
  }

  async function write(key, value) {
    return withLock(key, async (file) => {
      await atomicWrite(file, value, key);
    });
  }

  async function invalidate(key) {
    return withLock(key, async (file) => { await rm(file, { force: true }); });
  }

  async function transact(key, transition) {
    return withLock(key, async (file) => {
      const current = await readUnlocked(file);
      const next = await transition(current);
      if (next === null) { await rm(file, { force: true }); return null; }
      if (next === undefined) return current;
      await atomicWrite(file, next, key);
      return next;
    });
  }

  async function invalidateAndWrite(key, makeValue) {
    const token = await invalidateFence(key);
    return withLock(key, async (file) => {
      const current = await readUnlocked(file);
      await rm(file, { force: true });
      const next = await makeValue(current, token);
      await atomicWrite(file, next, key);
      return next;
    });
  }

  async function invalidateFence(key) {
    const path = fenceFor(key);
    if (!path) throw new TypeError("不正な観測キーです");
    await ensureRoot();
    const token = randomUUID();
    await atomicWrite(path, token, key);
    return token;
  }

  async function read(key) {
    const before = await readFence(key);
    if (!before) return null;
    const value = await withLock(key, (file) => readUnlocked(file));
    const after = await readFence(key);
    return before === after && value?.fenceToken === before ? value : null;
  }

  return Object.freeze({ keyFor, read, write, invalidate, transact, invalidateAndWrite, invalidateFence, readFence, withLock });
}
