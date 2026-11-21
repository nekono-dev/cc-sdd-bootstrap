import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { verifyNativeAgentDefinition } from "./native-agent-definitions.mjs";

const exec = promisify(execFile);
const ROLE_NAMES = Object.freeze({ manufacture: "cc_sdd_manufacture", review: "cc_sdd_review", design: "cc_sdd_design", research: "cc_sdd_research", debug: "cc_sdd_debug" });
const TOOLS = new Set(["spawn_agent", "collaborationspawn_agent"]);

/** Codex の信頼済みフックと現在ターン transcript から起動証拠を組み立てる。 */
export function createCodexNativeAgentAdapter(isolation = null) {
  function resolvePolicyModel(modelId) { return typeof modelId === "string" && modelId.trim() === modelId && modelId ? modelId : null; }

  function normalizeLaunch({ toolName, toolInput }) {
    if (!TOOLS.has(toolName) || !record(toolInput)) return { ok: false, reason: "Codex の対応する起動ツールを確認できません" };
    const agentName = toolInput.agent_type;
    if (typeof agentName !== "string" || ![...Object.values(ROLE_NAMES), "cc_sdd_design_read_only"].includes(agentName)) return { ok: false, reason: "予約済みの Codex 役割定義を指定してください" };
    const modern = toolInput.fork_turns;
    const legacy = toolInput.fork_context;
    if ((modern !== undefined && modern !== "none") || (legacy !== undefined && legacy !== false) || (modern !== undefined && legacy !== undefined && (modern !== "none" || legacy !== false))) return { ok: false, reason: "履歴継承は許可されません。fork_turns: none を指定してください" };
    if (modern === undefined && legacy !== false) return { ok: false, reason: "履歴継承を無効にする指定がありません" };
    return { ok: true, value: { toolName, agentName, toolInput, ...(toolInput.model === undefined ? {} : { requestedModel: toolInput.model }), ...(toolInput.reasoning_effort === undefined ? {} : { requestedEffort: toolInput.reasoning_effort }) } };
  }

  async function collectEvidence({ context, policy, settings, launch, hostEvent }) {
    const normalized = normalizeLaunch({ toolName: launch?.toolName, toolInput: launch?.toolInput });
    if (!normalized.ok) throw new Error(normalized.reason);
    launch = { ...normalized.value, ...launch };
    const hook = hostEvent ?? context?.hookProof;
    if (!record(context) || !record(policy) || !record(settings) || !record(launch) || !record(hook) || hook.trusted !== true || hook.source !== "host" ||
        !safeString(context.turnId) || (hostEvent != null ? hook.turnId !== context.turnId : (hook.turnId && hook.turnId !== context.turnId)) ||
        !safeString(hook.model) || !safeString(hook.transcriptPath) ||
        (hostEvent != null && (!TOOLS.has(hook.toolName) || !record(hook.toolInput) || hook.toolName !== launch.toolName || !same(hook.toolInput, launch.toolInput)))) throw new Error("Codex の現在ターンのホスト証拠");
    const expectedName = policy.role === "design" && policy.access === "read-only" ? "cc_sdd_design_read_only" : ROLE_NAMES[policy.role];
    if (launch.agentName !== policy.agentName || expectedName !== launch.agentName) throw new Error("予約済み役割");
    const requestedModel = launch.requestedModel;
    if (requestedModel !== undefined && requestedModel !== policy.modelId) throw new Error("指定モデルが管理定義と一致しません");
    if (launch.requestedEffort !== undefined && launch.requestedEffort !== policy.effort) throw new Error("指定推論量が管理定義と一致しません");
    const definitionPath = `.codex/agents/${policy.agentName}.toml`;
    const definition = await readFile(join(context.project, definitionPath), "utf8").catch(() => null);
    if (definition === null || !verifyNativeAgentDefinition(settings, "codex", definitionPath, definition)) throw new Error("管理された Codex 定義が設定と一致しません");
    const turns = await readTranscript(hook.transcriptPath);
    const matches = turns.filter((item) => item?.type === "turn_context" && item?.payload?.turn_id === hook.turnId);
    const unique = [...new Map(matches.map(item => [JSON.stringify(item.payload), item])).values()];
    if (unique.length !== 1) throw new Error("現在ターンの権限記録が欠落または重複しています");
    const turn = unique[0].payload;
    if (turn.model !== hook.model) throw new Error("現在ターンのモデル証拠が矛盾しています");
    let projectPath, cwdPath;
    try { [projectPath, cwdPath] = await Promise.all([realpath(context.project), realpath(turn.cwd)]); } catch { throw new Error("現在ターンの作業先を確認できません"); }
    if (projectPath !== cwdPath) {
      try {
        const { stdout } = await exec("git", ["-C", cwdPath, "rev-parse", "--show-toplevel"]);
        cwdPath = await realpath(stdout.trimEnd());
      } catch { throw new Error("現在ターンの作業先を確認できません"); }
      if (projectPath !== cwdPath) throw new Error("現在ターンの作業先がプロジェクトと一致しません");
    }
    const access = policy.access;
    if (!verifyPermission(turn, context.project, access)) throw new Error("Codex の実効権限を確認できません");
    if (access === "workspace-write" && isolation) await verifyPrivateWriteProof({ isolation, context, hook, turn });
    return { role: policy.role, client: "codex", agentName: launch.agentName, definitionVerified: true,
      parentModelId: turn.model, childModelId: policy.modelId, effort: policy.effort, access, historyInherited: false };
  }
  return Object.freeze({ normalizeLaunch, collectEvidence, resolvePolicyModel, requiresCodexHookProof: true });
}

async function verifyPrivateWriteProof({ isolation, context, hook, turn }) {
  if (turn.approval_policy !== "never") throw new Error("workspace-write の承認ポリシーを確認できません");
  if (!safeString(isolation.runtimeRoot) || !safeString(isolation.tempRoot)) throw new Error("隔離設定を確認できません");
  let runtimeRoot, project, transcript, tempRoot;
  try { [runtimeRoot, project, transcript, tempRoot] = await Promise.all([realpath(isolation.runtimeRoot), realpath(context.project), realpath(hook.transcriptPath), realpath(isolation.tempRoot)]); }
  catch { throw new Error("隔離領域またはホスト transcript を確認できません"); }
  const info = await lstat(runtimeRoot).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("私有 runtimeRoot を確認できません");
  const writeRoots = [];
  for (const entry of turn.permission_profile.file_system.entries) {
    if (entry?.access !== "write") continue;
    const path = entry.path;
    if (path?.type === "path") writeRoots.push(await realpath(path.value));
    else if (path?.type === "special" && path.value?.kind === "slash_tmp") writeRoots.push(await realpath("/tmp"));
    else if (path?.type === "special" && path.value?.kind === "tmpdir") writeRoots.push(tempRoot);
  }
  if (!writeRoots.some(root => root === project)) throw new Error("プロジェクト書き込み範囲を確認できません");
  if (writeRoots.some(root => contains(root, runtimeRoot) || contains(root, transcript))) throw new Error("書き込み可能範囲に私有証拠が含まれています");
}
function contains(root, target) { const rel = relative(root, target); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)); }

async function readTranscript(path) {
  if (!safeString(path) || !path.startsWith("/")) throw new Error("transcript path");
  const text = await readFile(path, "utf8");
  const rows = [];
  for (const line of text.split(/\r?\n/)) if (line.trim()) { try { rows.push(JSON.parse(line)); } catch { /* 不正行は証拠として数えない */ } }
  return rows;
}

function verifyPermission(turn, project, access) {
  const profile = turn.permission_profile;
  if (!record(profile) || profile.type !== "managed" || profile.file_system?.type !== "restricted" || !Array.isArray(profile.file_system.entries) || profile.file_system.entries.length === 0) return false;
  const sandbox = turn.sandbox_policy;
  if (!record(sandbox) || !["read-only", "workspace-write"].includes(sandbox.type)) return false;
  if (access === "read-only") {
    return sandbox.type === "read-only" && turn.approval_policy === "never" &&
      profile.file_system.entries.length === 1 && isRootRead(profile.file_system.entries[0]);
  }
  if (access !== "workspace-write" || sandbox.type !== "workspace-write") return false;
  if (!Array.isArray(sandbox.writable_roots)) return false;
  const root = project.replace(/\/$/, "");
  if (sandbox.writable_roots.some(path => typeof path !== "string" || !path.startsWith("/") || path.includes("\\") || path.split("/").some(part => part === "." || part === "..") || path.replace(/\/$/, "") !== path || path !== root)) return false;
  let projectWrite = 0, sawSlashTmp = false, sawTmpdir = false;
  for (const entry of profile.file_system.entries) {
    if (!record(entry) || !record(entry.path) || !["read", "write"].includes(entry.access)) return false;
    if (entry.path.type === "special") {
      const kind = entry.path.value?.kind;
      if (kind === "root" && entry.access === "read") continue;
      if (kind === "slash_tmp" && entry.access === "write") { sawSlashTmp = true; continue; }
      if (kind === "tmpdir" && entry.access === "write") { sawTmpdir = true; continue; }
      return false;
    }
    if (entry.path.type !== "path" || typeof entry.path.value !== "string" || !entry.path.value.startsWith("/") || entry.path.value.includes("\\") || entry.path.value.split("/").some(part => part === "." || part === "..") || entry.path.value.replace(/\/$/, "") !== entry.path.value) return false;
    const path = entry.path.value;
    if (entry.access === "write") { if (path !== root) return false; projectWrite++; }
    else if (path !== root && !root.startsWith(`${path}/`) && !path.startsWith(`${root}/`)) continue;
  }
  if (sandbox.exclude_slash_tmp !== undefined && typeof sandbox.exclude_slash_tmp !== "boolean") return false;
  if (sandbox.exclude_tmpdir_env_var !== undefined && typeof sandbox.exclude_tmpdir_env_var !== "boolean") return false;
  if (sawSlashTmp !== (sandbox.exclude_slash_tmp === false) || sawTmpdir !== (sandbox.exclude_tmpdir_env_var === false)) return false;
  return projectWrite === 1 && sandbox.writable_roots.length === 1;
}
function isRootRead(entry) { return record(entry) && entry.access === "read" && record(entry.path) && entry.path.type === "special" && entry.path.value?.kind === "root"; }
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeString(value) { return typeof value === "string" && value.length > 0 && value.trim() === value; }
function same(a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } }
