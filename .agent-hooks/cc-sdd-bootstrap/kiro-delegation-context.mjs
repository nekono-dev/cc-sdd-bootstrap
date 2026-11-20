import { randomBytes, createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveNative } from "./role-policy.mjs";
import { decideNativeAgentGate } from "./native-agent-gate.mjs";
import { configFields } from "./config-schema.mjs";
import { generateNativeAgentDefinitions } from "./native-agent-definitions.mjs";
import { readInstallConfig } from "./install-rules.mjs";

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
  const nativeAdapter = options.nativeAdapter;

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
    catch { return null; }
    try {
      const lockInfo = await lstat(loc.lock);
      if (!lockInfo.isFile() || lockInfo.isSymbolicLink() || lockInfo.uid !== process.getuid?.() || lockInfo.nlink !== 1 || (lockInfo.mode & 0o077) !== 0) return null;
      const old = await readState(loc);
      const next = await update(old);
      if (next === null) return null;
      if (next === old) return old;
      const temp = join(loc.dir, `.state-${randomBytes(12).toString("hex")}.tmp`);
      const file = await open(temp, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
      const tempInfo = await lstat(temp);
      if (!tempInfo.isFile() || tempInfo.nlink !== 1 || tempInfo.uid !== process.getuid?.() || (tempInfo.mode & 0o077) !== 0) { await rm(temp, { force: true }); return null; }
      await rename(temp, loc.state);
      return next;
    } catch { return null; }
    finally {
      await handle.close().catch(() => {});
      await rm(loc.lock, { force: true }).catch(() => {});
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
      return { project: loc.project, client: options.client, sessionId, generation, turnId, promptId, ended: false, active: Boolean(skill), skill, references: {}, usedToolUseIds: [], nativePreflights: {}, usedNativeRequestIds: [], usedNativeToolUseIds: [] };
    }));
  }

  async function endTurn({ trusted, source, cwd, sessionId, turnId = null, promptId = null }) {
    if (trusted !== true || source !== "host") return false;
    if (options.client === "codex" && !validId(turnId)) return false;
    const loc = await location(cwd, sessionId);
    if (!loc) return false;
    return Boolean(await mutate(loc, (old) => {
      if (!old || (turnId && old.turnId !== turnId) || (promptId && old.promptId && old.promptId !== promptId)) return null;
      return { ...old, active: false, ended: true, references: {}, nativePreflights: {} };
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

  async function bindEntryReference({ cwd, reference, skill }) {
    const consumed = await consumeReference({ cwd, reference, skill });
    if (!consumed) return null;
    const bound = Object.freeze({
      issueStandaloneNative: (request) => issueNative(consumed, request, true),
      issueSelectedNative: (request) => issueNative(consumed, request, false),
    });
    return bound;
  }

  async function issueNative(context, request, standalone) {
    let failureAlternatives = [];
    const denied = (reason) => ({ ok: false, error: { code: "NATIVE_PREFLIGHT_DENIED", reason, alternatives: failureAlternatives } });
    let failure = "現在のターンまたはネイティブ起動条件を確認できません";
    if (!record(request) || Object.keys(request).some((key) => !["requestId", "role", "readOnly", "toolName", "toolInput"].includes(key)) ||
        !validId(request.requestId) || DANGEROUS_KEYS.has(request.requestId) || !ROLE_IDS.has(request.role) || (request.readOnly !== undefined && typeof request.readOnly !== "boolean") || typeof request.toolName !== "string" || !record(request.toolInput) || typeof nativeAdapter?.normalizeLaunch !== "function" || typeof nativeAdapter?.collectEvidence !== "function") return denied("ネイティブ起動を正規化できません");
    const loc = await location(context.project, context.sessionId);
    if (!loc) return denied("作業コンテキストを確認できません");
    let normalized;
    try { normalized = await nativeAdapter.normalizeLaunch({ client: context.client, toolName: request.toolName, toolInput: request.toolInput }); } catch { return denied("起動引数を正規化できません"); }
    if (!normalized?.ok || !record(normalized.value) || typeof normalized.value.agentName !== "string" || typeof normalized.value.toolName !== "string") return denied(normalized?.reason ?? "起動引数が不正です");
    try { normalized = { ...normalized, value: { ...normalized.value, argsFingerprint: argsFingerprint(context.client, normalized.value.toolName, normalized.value.agentName, request.toolInput) } }; }
    catch (error) { return denied(`${request.role} の起動引数を正規化できません: ${error.message}`); }
    const updated = await mutate(loc, async (old) => {
      if (!old || old.ended || !old.active || old.project !== context.project || old.client !== context.client || old.sessionId !== context.sessionId || old.turnId !== context.turnId || old.generation !== context.generation || old.skill !== context.skill || old.usedNativeRequestIds?.includes(request.requestId)) return null;
      let settings;
      try { settings = await readProjectSettings(context.project, context.client); } catch (error) { failure = `${request.role} の設定を確認できません: ${error.message}。設定と管理された委任入口を確認してください`; return null; }
      const result = resolveNative(settings, context.client, request.role, { readOnly: request.readOnly === true });
      if (!result.ok || result.value.agentName !== normalized.value.agentName) { failure = result.error?.reason ?? "指定された役割定義が設定と一致しません"; return null; }
      let evidence;
      try { evidence = await nativeAdapter.collectEvidence({ context, policy: result.value, settings, launch: normalized.value, hostEvent: null }); } catch (error) { failure = `${request.role} のモデル・推論量・権限を確認できません: ${error.message}。ホストの承認と構成を確認してください`; return null; }
      const gatePolicy = nativeGatePolicy(nativeAdapter, result.value);
      if (!gatePolicy) { failure = `${request.role} のモデルを確認できません`; return null; }
      const verdict = decideNativeAgentGate(gatePolicy, evidence);
      if (!verdict.allowed) { failure = gateFailure(verdict, result.value); failureAlternatives = verdict.alternatives ?? []; return null; }
      if (standalone) {
        const install = await verifyStandaloneInstall(context.project, context.client, settings, normalized.value.agentName);
        if (!install.ok) { failure = install.reason; return null; }
      }
      const preflights = old.nativePreflights ?? {};
      if (Object.values(preflights).some((item) => item.toolName === normalized.value.toolName && item.agentName === normalized.value.agentName && item.argsFingerprint === normalized.value.argsFingerprint)) return null;
      preflights[request.requestId] = { ...context, requestId: request.requestId, role: request.role, readOnly: request.readOnly === true, agentName: normalized.value.agentName, toolName: normalized.value.toolName, argsFingerprint: normalized.value.argsFingerprint };
      return { ...old, nativePreflights: preflights, usedNativeRequestIds: [...(old.usedNativeRequestIds ?? []), request.requestId] };
    });
    if (!updated) return denied(failure);
    return { ok: true, value: { requestId: request.requestId, agentName: normalized.value.agentName, toolName: normalized.value.toolName, toolInput: request.toolInput, argsFingerprint: normalized.value.argsFingerprint } };
  }

  async function trustedNativePreToolUse(event) {
    if (!isTrustedEvent(event) || !validId(event.toolUseId) || !record(event.toolInput)) return { action: "deny", reason: "ネイティブ起動のホスト証拠が不足しています", alternatives: [] };
    const loc = await location(event.cwd, event.sessionId);
    if (!loc) return { action: "deny", reason: "現在の作業コンテキストを確認できません", alternatives: [] };
    let passThrough = false;
    let refusal = { reason: "事前確認記録がない、期限切れ、または起動条件が変わりました", alternatives: [] };
    const result = await mutate(loc, async (old) => {
      if (!old || old.ended || (old.client === "codex" && (!validId(event.turnId) || event.turnId !== old.turnId)) ||
          (old.client === "claude" && ((event.promptId || old.promptId) ? (!validId(event.promptId) || event.promptId !== old.promptId) : (event.generation !== undefined && event.generation !== old.generation)))) return null;
      if (!old.active) { if (old.active === false) passThrough = true; return old; }
      let launch;
      try { launch = await nativeAdapter?.normalizeLaunch({ client: old.client, toolName: event.toolName, toolInput: event.toolInput }); } catch { return null; }
      if (!launch?.ok) { refusal.reason = launch?.reason ?? refusal.reason; return null; }
      if (!record(launch.value) || typeof launch.value.agentName !== "string" || typeof launch.value.toolName !== "string") return null;
      try { launch = { ...launch, value: { ...launch.value, argsFingerprint: argsFingerprint(old.client, launch.value.toolName, launch.value.agentName, event.toolInput) } }; }
      catch (error) { refusal = { reason: `指定役割の起動引数を正規化できません: ${error.message}。管理された委任入口を確認してください`, alternatives: [] }; return null; }
      const matches = Object.entries(old.nativePreflights ?? {}).filter(([, item]) => item.toolName === launch.value.toolName && item.agentName === launch.value.agentName && item.argsFingerprint === launch.value.argsFingerprint && item.project === old.project && item.sessionId === old.sessionId && item.turnId === old.turnId && item.generation === old.generation);
      if (matches.length !== 1 || old.usedNativeToolUseIds?.includes(event.toolUseId)) { refusal.reason = "一致する一回限りの事前確認記録がありません"; return null; }
      const [requestId, item] = matches[0];
      let settings;
      try { settings = await readProjectSettings(old.project, old.client); } catch (error) { refusal = { reason: `${item.role} の設定を確認できません: ${error.message}。設定と管理された委任入口を確認してください`, alternatives: [] }; return null; }
      const policy = resolveNative(settings, old.client, item.role, { readOnly: item.readOnly });
      if (!policy.ok) { refusal.reason = policy.error.reason; return null; }
      let evidence;
      try { evidence = await nativeAdapter.collectEvidence({ context: item, policy: policy.value, settings, launch: launch.value, hostEvent: event }); } catch (error) { refusal = { reason: `${item.role} のモデル・推論量・権限を確認できません: ${error.message}。ホストの承認と構成を確認してください`, alternatives: [] }; return null; }
      const gatePolicy = nativeGatePolicy(nativeAdapter, policy.value);
      if (!gatePolicy) { refusal = { reason: `${item.role} のモデルを確認できません`, alternatives: [] }; return null; }
      const verdict = decideNativeAgentGate(gatePolicy, evidence);
      if (!verdict.allowed) { refusal = { reason: gateFailure(verdict, policy.value), alternatives: verdict.alternatives ?? [] }; return null; }
      const pending = { ...old.nativePreflights }; delete pending[requestId];
      return { ...old, nativePreflights: pending, usedNativeToolUseIds: [...(old.usedNativeToolUseIds ?? []), event.toolUseId] };
    });
    if (!result) return { action: "deny", ...refusal };
    if (passThrough) return { action: "pass-through" };
    return { action: "allow" };
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

  return Object.freeze({ beginTurn, endTurn, trustedPreToolUse, consumeReference, bindEntryReference, trustedNativePreToolUse, successfulSkillRead, handleEntryArgv, current });
}

const ROLE_IDS = new Set(["manufacture", "review", "design", "research", "debug"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }

function validId(value) { return typeof value === "string" && value.length > 0 && value.length <= 512; }
function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || seen.has(value)) throw new TypeError("JSON 起動引数が不正です");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) throw new TypeError("疎配列の起動引数は使えません");
    result = `[${value.map((entry) => canonicalJson(entry, seen)).join(",")}]`;
  }
  else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("JSON 起動引数が不正です");
    result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(",")}}`;
  }
  seen.delete(value);
  return result;
}
function argsFingerprint(client, toolName, agentName, toolInput) {
  return createHash("sha256").update(canonicalJson({ client, toolName, agentName, toolInput })).digest("hex");
}
function gateFailure(verdict, policy) {
  const role = policy.role ?? "指定役割";
  const alternatives = (verdict.alternatives ?? []).map((item) => item.agentName ?? item.modelId ?? String(item)).join("、");
  return `${role} のネイティブ起動を拒否しました（${verdict.reason ?? "適用条件を確認できません"}）${alternatives ? `。代替: ${alternatives}` : "。管理された委任入口または設定済みの別モデルを確認してください"}`;
}
async function verifyStandaloneInstall(project, client, settings, agentName) {
  const fail = (reason) => ({ ok: false, reason });
  try {
    const root = resolve(project);
    async function safeRead(path) {
      const absolute = resolve(root, path);
      if (!inside(absolute, root) || absolute === root) return null;
      let cursor = absolute;
      const ancestors = [];
      while (inside(cursor, root)) {
        ancestors.push(cursor);
        if (cursor === root) break;
        cursor = resolve(cursor, "..");
      }
      for (const part of ancestors.reverse()) {
        const info = await lstat(part);
        if (info.isSymbolicLink()) return null;
        if (part !== absolute && !info.isDirectory()) return null;
      }
      const info = await lstat(absolute);
      if (!info.isFile() || info.nlink !== 1) return null;
      return await readFile(absolute);
    }
    const configBytes = await safeRead(".cc-sdd-bootstrap.json");
    const ledgerBytes = await safeRead(".agent-hooks/cc-sdd-bootstrap/installed.json");
    if (!configBytes || !ledgerBytes) return fail("単独導入の設定または配置台帳を確認できません");
    const configResult = readInstallConfig(configBytes.toString("utf8"));
    if (!configResult.ok) return fail(`導入設定を確認できません: ${configResult.reason}`);
    const rawConfig = JSON.parse(configBytes.toString("utf8"));
    const normalized = { ...rawConfig };
    for (const field of configFields) {
      const parts = field.path.split(".");
      let cursor = normalized;
      for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
      const key = parts.at(-1);
      if (cursor[key] === undefined) cursor[key] = structuredClone(field.defaultValue);
    }
    const rawLedger = JSON.parse(ledgerBytes.toString("utf8"));
    if (!record(rawLedger) || rawLedger.format !== 1 || typeof rawLedger.bootstrapVersion !== "string" || !record(rawLedger.files)) return fail("配置台帳の形式が不正です");
    const clients = Object.hasOwn(rawLedger, "clients") ? rawLedger.clients : "claude";
    if (!["claude", "codex", "both"].includes(clients) || (clients !== "both" && clients !== client) || normalized.clients !== clients) return fail("設定と配置台帳が現在のクライアントについて一致しません");
    const files = rawLedger.files;
    for (const [path, entry] of Object.entries(files)) {
      if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".." || DANGEROUS_KEYS.has(part)) || DANGEROUS_KEYS.has(path) || !record(entry) || !["common", "project"].includes(entry.kind) || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) return fail("配置台帳に不正な道筋または指紋があります");
    }
    const required = [".agent-hooks/cc-sdd-bootstrap/config-schema.mjs", ".agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs", ".agent-hooks/cc-sdd-bootstrap/install-gate.mjs", ".agent-hooks/cc-sdd-bootstrap/install-rules.mjs"];
    for (const path of required) {
      const entry = files[path];
      const bytes = await safeRead(path);
      if (!entry || entry.kind !== "common" || !/^[0-9a-f]{64}$/.test(entry.sha256) || !bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) return fail(`管理ファイル ${path} の配置証明を確認できません`);
    }
    if (!(normalized.clients === client || normalized.clients === "both")) return fail(`${client} が導入設定の対象クライアントに含まれていません`);
    const generated = normalized.clients === "both"
      ? [...generateNativeAgentDefinitions(normalized, "claude"), ...generateNativeAgentDefinitions(normalized, "codex")]
      : generateNativeAgentDefinitions(normalized, client);
    for (const [path, entry] of Object.entries(files)) {
      if (path === ".agent-hooks/cc-sdd-bootstrap/installed.json") continue;
      const isDefinition = /^\.(?:claude\/agents\/cc-sdd-|codex\/agents\/cc_sdd_)/.test(path);
      if (isDefinition) {
        const expected = generated.find((definition) => definition.relativePath === path);
        const bytes = await safeRead(path);
        if (!expected || !bytes || bytes.toString("utf8") !== expected.content || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) return fail(`ネイティブ定義 ${path} が現在設定と一致しません`);
      } else if (path.startsWith(".agent-hooks/cc-sdd-bootstrap/") && /(?:native-agent|role-policy|kiro-delegation)/.test(path)) {
        const bytes = await safeRead(path);
        if (!bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) return fail(`現在のポリシー配置 ${path} が台帳と一致しません`);
      }
    }
    const marker = ".agent-hooks/cc-sdd-bootstrap/delegate.mjs";
    if (Object.hasOwn(files, marker)) return fail("外部委任の配置を検出したため単独発行できません");
    try {
      const markerPath = resolve(root, marker);
      for (const parent of [root, resolve(root, ".agent-hooks"), resolve(root, ".agent-hooks/cc-sdd-bootstrap")]) {
        const info = await lstat(parent);
        if (info.isSymbolicLink() || !info.isDirectory()) return fail("外部委任マーカーの親道筋を検証できません");
      }
      await lstat(markerPath);
      return fail("外部委任の実体を検出したため単独発行できません");
    } catch (error) {
      if (error.code !== "ENOENT") return fail("外部委任マーカーを検証できません");
      try { await lstat(resolve(root, ".agent-hooks/cc-sdd-bootstrap")); }
      catch { return fail("外部委任マーカーの安全な親を確認できません"); }
    }
    const selected = generated.find((definition) => definition.relativePath.endsWith(`${agentName}.${client === "codex" ? "toml" : "md"}`));
    if (!selected) return fail(`${client} の予約された役割定義 ${agentName} を設定から確認できません`);
    for (const definition of [selected]) {
      const bytes = await safeRead(definition.relativePath);
      if (!bytes || bytes.toString("utf8") !== definition.content) return fail(`ネイティブ定義 ${definition.relativePath} が現在設定と一致しません`);
    }
    return { ok: true };
  } catch {
    return fail("単独導入の設定・台帳・管理ファイルを安全に検証できません");
  }
}
async function readProjectSettings(project, client) {
  const root = resolve(project);
  const target = resolve(root, ".cc-sdd-bootstrap.json");
  if (!inside(target, root)) throw new Error("unsafe settings path");
  const chain = [];
  for (let cursor = target; inside(cursor, root); cursor = resolve(cursor, "..")) {
    chain.push(cursor);
    if (cursor === root) break;
  }
  for (const path of chain.reverse()) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (path !== target && path !== root && !info.isDirectory())) throw new Error("unsafe settings path");
  }
  const info = await lstat(target);
  if (!info.isFile() || info.nlink !== 1) throw new Error("unsafe settings file");
  const contents = await readFile(target, "utf8");
  const validated = readInstallConfig(contents);
  if (!validated.ok) throw new Error(validated.reason);
  const raw = JSON.parse(contents);
  if (!record(raw) || raw.format !== 1) throw new Error("invalid settings file");
  for (const parent of ["ccSdd", "codex", "subagents", "models"]) if (Object.hasOwn(raw, parent) && !record(raw[parent])) throw new Error(`invalid ${parent}`);
  const config = { ...raw };
  for (const field of configFields) {
    const parts = field.path.split(".");
    let cursor = config;
    for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
    const key = parts.at(-1);
    if (cursor[key] === undefined) cursor[key] = structuredClone(field.defaultValue);
    if (field.validate(cursor[key])) throw new Error(`invalid ${field.path}`);
  }
  if (config.clients !== "both" && config.clients !== client) throw new Error("現在のクライアントは設定対象外です");
  return config;
}
function isTrustedEvent(event) {
  return Boolean(event && typeof event === "object" && event.trusted === true && event.source === "host" &&
    typeof event.cwd === "string" && typeof event.sessionId === "string" && typeof event.toolName === "string");
}
function inside(candidate, parent) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
function overlaps(a, b) { return inside(a, b) || inside(b, a); }
function nativeGatePolicy(adapter, policy) {
  if (typeof adapter?.resolvePolicyModel !== "function") return policy;
  let modelId;
  try { modelId = adapter.resolvePolicyModel(policy.modelId); } catch { return null; }
  return typeof modelId === "string" && modelId ? { ...policy, modelId } : null;
}
