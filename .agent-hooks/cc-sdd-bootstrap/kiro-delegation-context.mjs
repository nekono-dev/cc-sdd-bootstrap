import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const SKILL = /^kiro-[a-z0-9][a-z0-9-]*$/;
const TOOL_NAME = /^(Bash|shell)$/i;
const ENTRY = /^node \.agent-hooks\/cc-sdd-bootstrap\/kiro-delegation-context\.mjs enter (kiro-[a-z0-9][a-z0-9-]*)$(?![\s\S])/;

/**
 * ホストアダプターから検証済みの作業範囲とイベントを受け取り、ターン状態を管理する。
 * writableRoots は委任先が書き込み可能な全ての既存ルートで、実パス検証済みであること。
 */
export function createKiroDelegationContext(options) {
  if (!options || !isAbsolute(options.runtimeRoot) || !isAbsolute(options.skillsRoot) ||
      !Array.isArray(options.writableRoots) || !options.writableRoots.length ||
      options.writableRoots.some((root) => typeof root !== "string" || !isAbsolute(root)) ||
      !["claude", "codex"].includes(options.client)) {
    throw new TypeError("実行時領域、全書き込みルート、導入済み手順の場所、クライアントが必要です");
  }
  const root = resolve(options.runtimeRoot);
  const skillRoot = resolve(options.skillsRoot);
  const writableRoots = options.writableRoots.map((writable) => resolve(writable));

  async function location(cwd, sessionId) {
    if (typeof cwd !== "string" || !isAbsolute(cwd) || typeof sessionId !== "string" || !sessionId.trim()) return null;
    const project = await realpath(cwd).catch(() => null);
    if (!project) return null;
    const key = Buffer.from(`${project}\0${options.client}\0${sessionId}`).toString("base64url");
    return { project, dir: join(root, key), state: join(root, key, "state.json"), lock: join(root, key, "lock") };
  }

  async function canonicalExisting(path) {
    const requested = resolve(path);
    let cursor = requested;
    let targetInfo = null;
    while (true) {
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink()) return null;
        const actual = await realpath(cursor).catch(() => null);
        if (!actual || actual !== cursor) return null;
        if (cursor === requested) targetInfo = info;
        return { path: requested, info: targetInfo };
      } catch (error) {
        if (error.code !== "ENOENT") return null;
        const parent = resolve(cursor, "..");
        if (parent === cursor) return null;
        cursor = parent;
      }
    }
  }

  async function verifyRoots() {
    const resolved = [];
    for (const writable of writableRoots) {
      const checked = await canonicalExisting(writable);
      if (!checked?.info?.isDirectory()) return null;
      resolved.push(checked.path);
    }
    const runtime = await canonicalExisting(root);
    if (!runtime || resolved.some((writable) => overlaps(root, writable))) return null;
    return runtime.path;
  }

  async function secureDir(dir) {
    const verifiedRoot = await verifyRoots();
    if (!verifiedRoot) throw new Error("実行時領域と委任先の書き込み範囲を検証できません");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const checked = await canonicalExisting(root);
    if (!checked?.info?.isDirectory()) throw new Error("実行時領域の祖先を検証できません");
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== process.getuid?.() || rootInfo.nlink < 2 || (rootInfo.mode & 0o077) !== 0) throw new Error("実行時領域が安全ではありません");
    await mkdir(dir, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.nlink < 2 || (info.mode & 0o077) !== 0) throw new Error("作業記録の領域が安全ではありません");
  }

  async function readState(loc) {
    try {
      const info = await lstat(loc.state);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077) !== 0) return null;
      const value = JSON.parse(await readFile(loc.state, "utf8"));
      return value?.project === loc.project && value?.client === options.client ? value : null;
    } catch { return null; }
  }

  async function mutate(loc, update) {
    try { await secureDir(loc.dir); } catch { return null; }
    let handle;
    try { handle = await open(loc.lock, "wx", 0o600); }
    catch (error) { if (error.code === "EEXIST") return null; throw error; }
    try {
      const lockInfo = await lstat(loc.lock);
      if (!lockInfo.isFile() || lockInfo.isSymbolicLink() || lockInfo.uid !== process.getuid?.() || lockInfo.nlink !== 1 || (lockInfo.mode & 0o077) !== 0) return null;
      const old = await readState(loc);
      const next = await update(old);
      if (next === null) return null;
      const temp = join(loc.dir, `.state-${randomBytes(12).toString("hex")}.tmp`);
      const file = await open(temp, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
      const tempInfo = await lstat(temp);
      if (!tempInfo.isFile() || tempInfo.nlink !== 1 || tempInfo.uid !== process.getuid?.() || (tempInfo.mode & 0o077) !== 0) { await rm(temp, { force: true }); return null; }
      await rename(temp, loc.state);
      return next;
    } finally {
      await handle.close();
      await rm(loc.lock, { force: true });
    }
  }

  async function canonicalSkill(skill) {
    if (!SKILL.test(skill)) return false;
    const expectedRoot = await realpath(skillRoot).catch(() => null);
    const file = await realpath(join(skillRoot, skill, "SKILL.md")).catch(() => null);
    if (!expectedRoot || !file || !inside(file, expectedRoot) || relative(expectedRoot, file) !== join(skill, "SKILL.md")) return false;
    try { const info = await lstat(file); return info.isFile() && !info.isSymbolicLink(); } catch { return false; }
  }

  /** 信頼済みホストのプロンプト開始。Codex では turn_id、Claude では prompt_id を照合する。 */
  async function beginTurn({ trusted, source, cwd, sessionId, turnId = null, promptId = null, prompt = "" }) {
    if (trusted !== true || source !== "host") return false;
    if (options.client === "codex" && (typeof turnId !== "string" || !turnId.trim())) return false;
    const loc = await location(cwd, sessionId);
    if (!loc) return false;
    const invocation = typeof prompt === "string" ? prompt.match(/^\s*(?:\/|\$)(kiro-[a-z0-9][a-z0-9-]*)(?=\s|$)/)?.[1] : null;
    const skill = invocation && await canonicalSkill(invocation) ? invocation : null;
    const generation = randomBytes(16).toString("hex");
    return Boolean(await mutate(loc, (old) => {
      if (old && ((turnId && old.turnId === turnId) || (!turnId && promptId && old.promptId === promptId))) return null;
      return { project: loc.project, client: options.client, sessionId, generation, turnId, promptId, ended: false, active: Boolean(skill), skill, references: {}, usedToolUseIds: [] };
    }));
  }

  async function endTurn({ trusted, source, cwd, sessionId, turnId = null, promptId = null }) {
    if (trusted !== true || source !== "host") return false;
    if (options.client === "codex" && !validId(turnId)) return false;
    const loc = await location(cwd, sessionId);
    if (!loc) return false;
    return Boolean(await mutate(loc, (old) => {
      if (!old || (turnId && old.turnId !== turnId) || (promptId && old.promptId && old.promptId !== promptId)) return null;
      return { ...old, active: false, ended: true, references: {} };
    }));
  }

  /** 正規導入済み手順の読み取り成功イベントで自然文ターンをアクティブ化する。 */
  async function successfulSkillRead({ trusted, source, success, toolName, cwd, sessionId, turnId, promptId, toolUseId, filePath }) {
    if (trusted !== true || source !== "host" || success !== true || toolName !== "Read" || !isAbsolute(filePath) || !toolUseId) return false;
    const expectedRoot = await realpath(skillRoot).catch(() => null);
    const actual = await realpath(filePath).catch(() => null);
    if (!expectedRoot || !actual || !inside(actual, expectedRoot)) return false;
    const segments = relative(expectedRoot, actual).split(sep);
    if (segments.length !== 2 || !SKILL.test(segments[0]) || segments[1] !== "SKILL.md") return false;
    const loc = await location(cwd, sessionId);
    if (!loc || (options.client === "codex" && !turnId)) return false;
    return Boolean(await mutate(loc, (old) => {
      if (!old || old.ended || (turnId && old.turnId !== turnId) || (promptId && old.promptId && old.promptId !== promptId) || old.usedToolUseIds.includes(toolUseId)) return null;
      return { ...old, active: true, skill: segments[0], promptId: old.promptId ?? promptId, usedToolUseIds: [...old.usedToolUseIds, toolUseId] };
    }));
  }

  /** ホストの PreToolUse が固定コマンドと呼び出し ID を確認して参照を発行する。 */
  async function trustedPreToolUse(event) {
    if (!isTrustedEvent(event) || !TOOL_NAME.test(event.toolName) || !validId(event.toolUseId)) return null;
    const match = ENTRY.exec(event.command ?? "");
    if (!match || !await canonicalSkill(match[1])) return null;
    const loc = await location(event.cwd, event.sessionId);
    if (!loc || (options.client === "codex" && !validId(event.turnId))) return null;
    let reference;
    const updated = await mutate(loc, (old) => {
      if (!old || old.ended || (event.turnId && old.turnId !== event.turnId) ||
          (event.promptId && old.promptId && old.promptId !== event.promptId) || old.usedToolUseIds.includes(event.toolUseId)) return null;
      if (old.active && old.skill !== match[1]) return null;
      if (old.skill && old.skill !== match[1]) return null;
      reference = randomBytes(32).toString("base64url");
      const generation = old.generation;
      const references = { ...old.references, [reference]: { toolUseId: event.toolUseId, generation, skill: match[1], command: event.command } };
      return { ...old, promptId: old.promptId ?? event.promptId ?? null,
        usedToolUseIds: [...old.usedToolUseIds, event.toolUseId], references };
    });
    if (!updated) return null;
    const command = `${event.command} --reference ${reference}`;
    return { reference, command, updatedInput: { command } };
  }

  /** 固定入口の argv とプロセス cwd で参照を一度だけ消費する。 */
  async function handleEntryArgv(argv, processContext) {
    if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== "enter" || !SKILL.test(argv[1]) || argv[2] !== "--reference" ||
        !processContext || typeof processContext.cwd !== "string") return null;
    const consumed = await consumeReference({ cwd: processContext.cwd, reference: argv[3], skill: argv[1] });
    return consumed ? { client: consumed.client, sessionId: consumed.sessionId, turnId: consumed.turnId, skill: consumed.skill, toolUseId: consumed.toolUseId } : null;
  }

  async function consumeReference({ cwd, reference, skill }) {
    if (typeof reference !== "string" || !SKILL.test(skill)) return null;
    const project = await realpath(cwd).catch(() => null);
    if (!project) return null;
    try { if (!await verifyRoots()) return null; } catch { return null; }
    for (const name of await readdir(root)) {
      const dir = join(root, name);
      try {
        const info = await lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) continue;
        const loc = { project, dir, state: join(dir, "state.json"), lock: join(dir, "lock") };
        const state = await readState(loc);
        const item = state?.references?.[reference];
        if (!item || state.project !== project || item.skill !== skill || item.command !== `node .agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs enter ${skill}`) continue;
        let consumed;
        const next = await mutate(loc, (old) => {
          const current = old?.references?.[reference];
          if (!old || old.ended || old.generation !== item.generation || !current || current.toolUseId !== item.toolUseId || current.skill !== skill || current.command !== item.command || (old.skill && old.skill !== skill)) return null;
          consumed = { project: old.project, client: old.client, sessionId: old.sessionId, turnId: old.turnId, generation: old.generation, skill: old.skill ?? skill, toolUseId: item.toolUseId };
          const references = { ...old.references };
          delete references[reference];
          return { ...old, active: true, skill: old.skill ?? skill, references };
        });
        if (next) return consumed;
      } catch { /* 別セッションや不正な記録は無視する */ }
    }
    return null;
  }

  async function current({ cwd, sessionId }) {
    const loc = await location(cwd, sessionId);
    if (!loc) return null;
    try {
      await secureDir(root);
      const info = await lstat(loc.dir);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return null;
      return await readState(loc);
    } catch { return null; }
  }

  return Object.freeze({ beginTurn, endTurn, trustedPreToolUse, consumeReference, successfulSkillRead, handleEntryArgv, current });
}

function validId(value) { return typeof value === "string" && value.length > 0 && value.length <= 512; }
function isTrustedEvent(event) {
  return Boolean(event && typeof event === "object" && event.trusted === true && event.source === "host" &&
    typeof event.cwd === "string" && typeof event.sessionId === "string" && typeof event.toolName === "string");
}
function inside(candidate, parent) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
function overlaps(a, b) { return inside(a, b) || inside(b, a); }
