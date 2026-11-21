#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createKiroDelegationContext } from "./kiro-delegation-context.mjs";
import { createClaudeObservationStore } from "./claude-observation-store.mjs";
import { createClaudeNativeAgentAdapter } from "./claude-native-agent-adapter.mjs";
import { createCodexNativeAgentAdapter } from "./codex-native-agent-adapter.mjs";

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const valid = value => typeof value === "string" && value.trim().length > 0;
const entry = /^node \.agent-hooks\/cc-sdd-bootstrap\/kiro-delegation-context\.mjs (enter|preflight) (kiro-[a-z0-9][a-z0-9-]*)(?: ([A-Za-z0-9_-]{1,65536}))?$(?![\s\S])/;
const scriptPath = fileURLToPath(import.meta.url);
const denied = reason => ({ action: "deny", reason });
const passthrough = { action: "pass-through" };

function parseEntry(command) {
  if (typeof command !== "string") return null;
  const match = entry.exec(command);
  if (!match) return null;
  const [, operation, skill, payload] = match;
  return { operation, skill, payload };
}

function nativeTool(client, name) {
  return client === "claude" ? name === "Agent" : ["spawn_agent", "collaborationspawn_agent"].includes(name);
}

/** ホストのフック入力を内部イベントに変換する。信頼属性は常にこの入口が付与する。 */
export function normalizeHostEvent(client, eventName, input) {
  if (!record(input) || !valid(input.cwd) || !valid(input.session_id) || !["claude", "codex"].includes(client)) return null;
  if (client === "codex" && Object.hasOwn(input, "agent_id") && !valid(input.agent_id)) return null;
  const sessionId = client === "codex" && valid(input.agent_id)
    ? `codex-agent:${Buffer.from(JSON.stringify([input.session_id, input.agent_id])).toString("base64url")}`
    : input.session_id;
  const common = { trusted: true, source: "host", cwd: input.cwd, sessionId,
    ...(valid(input.turn_id) ? { turnId: input.turn_id } : {}),
    ...(valid(input.prompt_id) ? { promptId: input.prompt_id } : {}) };
  if (eventName === "UserPromptSubmit") {
    if (client === "codex" && !valid(common.turnId)) return null;
    return { ...common, prompt: typeof input.prompt === "string" ? input.prompt : "" };
  }
  if (client === "claude" && eventName === "SessionStart") return { ...common, model: input.model };
  if (client === "claude" && ["PreModelSwitch", "PostModelSwitch"].includes(eventName)) {
    return { ...common, event: eventName, from_model: input.from_model, to_model: input.to_model, switch_id: input.switch_id };
  }
  if (eventName === "Stop" || eventName === "SessionEnd" || eventName === "TurnEnd") return common;
  if (eventName !== "PreToolUse" && eventName !== "PostToolUse") return null;
  const toolName = input.tool_name;
  const toolInput = record(input.tool_input) ? input.tool_input : {};
  const toolUseId = input.tool_use_id;
  if (!valid(toolName) || !valid(toolUseId)) return null;
  if (eventName === "PostToolUse") {
    if (client !== "claude" || toolName !== "Read" || input.tool_response?.error || !valid(toolInput.file_path) || !toolInput.file_path.startsWith("/")) return null;
    return { ...common, success: true, toolName, toolUseId, filePath: toolInput.file_path };
  }
  const command = /^(Bash|shell)$/i.test(toolName) ? toolInput.command : undefined;
  return { ...common, toolName, toolUseId, toolInput, ...(typeof command === "string" ? { command } : {}),
    ...(valid(input.model) ? { model: input.model } : {}),
    ...(valid(input.transcript_path) ? { transcriptPath: input.transcript_path } : {}) };
}

/** 正規化イベントを既存のターン状態・アダプター API へルーティングする。 */
export async function routeHostEvent({ client, eventName, input, context, observationAdapter, observationContext, project }) {
  const event = normalizeHostEvent(client, eventName, input);
  if (!event) {
    if (["UserPromptSubmit", "PreModelSwitch"].includes(eventName) ||
        (eventName === "PreToolUse" && (nativeTool(client, input?.tool_name) || parseEntry(input?.tool_input?.command)))) {
      return denied("ホストから必要な委任イベントの情報を取得できません");
    }
    return passthrough;
  }
  if (project) event.cwd = project;
  if (eventName === "UserPromptSubmit") return { action: await context.beginTurn(event) ? "continue" : "deny", reason: "ターン状態を安全に記録できません" };
  if (["Stop", "SessionEnd", "TurnEnd"].includes(eventName)) {
    await context.endTurn(event);
    return passthrough;
  }
  if (eventName === "SessionStart" && client === "claude") {
    const ok = await observationAdapter?.observe({ ...observationContext(event), event: eventName, model: event.model });
    return { action: ok ? "continue" : "deny", reason: "Claude のセッションモデルを確認できません" };
  }
  if (["PreModelSwitch", "PostModelSwitch"].includes(eventName)) {
    const ok = await observationAdapter?.observe({ ...observationContext(event), event: eventName,
      from_model: event.from_model, to_model: event.to_model, switch_id: event.switch_id });
    return { action: ok ? "continue" : "deny", reason: "モデル切り替え状態を確認できません" };
  }
  if (eventName === "PostToolUse") return { action: await context.successfulSkillRead(event) ? "continue" : "pass-through" };
  if (parseEntry(event.command)) return prepareEntry(context, event, event.toolInput);
  if (!nativeTool(client, event.toolName)) return passthrough;
  const result = await context.trustedNativePreToolUse(event);
  return result?.action === "allow" ? { action: "continue" } : result;
}

async function prepareEntry(context, event, toolInput) {
  const { operation, skill, payload } = parseEntry(event.command);
  if ((operation === "enter") === Boolean(payload)) return denied("管理入口の引数が不正です");
  let request;
  if (payload) {
    try {
      const bytes = Buffer.from(payload, "base64url");
      if (bytes.toString("base64url") !== payload) throw new Error("base64url");
      request = JSON.parse(bytes.toString("utf8"));
      if (!record(request)) throw new Error("request");
    } catch { return denied("事前確認の依頼を読み取れません"); }
  }
  const command = `node .agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs enter ${skill}`;
  const prepared = await context.trustedPreToolUse({ ...event, command });
  if (!prepared) return denied("現在のターンに管理入口を結び付けられません");
  const reference = { cwd: event.cwd, reference: prepared.reference, skill };
  let value;
  if (operation === "enter") {
    if (!await context.handleEntryArgv(["enter", skill, "--reference", prepared.reference], reference)) return denied("作業コンテキストを確認できません");
    value = { ok: true, skill };
  } else {
    const bound = await context.bindEntryReference(reference);
    if (!bound) return denied("事前確認の作業コンテキストを取得できません");
    const result = await bound.issueStandaloneNative(request);
    if (!result.ok) return { ...denied(result.error.reason), alternatives: result.error.alternatives };
    const { requestId, agentName } = result.value;
    value = { ok: true, requestId, agentName };
  }
  const receipt = Buffer.from(JSON.stringify(value)).toString("base64url");
  const quoted = "'" + scriptPath.replaceAll("'", "'\"'\"'") + "'";
  return { action: "rewrite", updatedInput: { ...toolInput, command: `node ${quoted} receipt ${receipt}` } };
}

export async function runtimeFor(client, project) {
  const userHome = await realpath(userInfo().homedir);
  const cache = join(userHome, ".cache");
  const runtimeRoot = join(cache, "cc-sdd-model-policy");
  const writableRoots = [...new Set(await Promise.all([project, "/tmp", tmpdir()].map(path => realpath(path))))];
  for (const root of writableRoots) {
    for (const path of [relative(root, runtimeRoot), relative(runtimeRoot, root)]) {
      if (!path || (path !== ".." && !path.startsWith("../") && !isAbsolute(path))) throw new Error("private runtime");
    }
  }
  await mkdir(cache, { recursive: true, mode: 0o700 });
  if (await realpath(cache) !== cache) throw new Error("private runtime");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const info = await lstat(runtimeRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("private runtime");
  const observationAdapter = client === "claude" ? createClaudeNativeAgentAdapter({
    store: createClaudeObservationStore({ root: join(runtimeRoot, "claude-models") }),
    requirePrivateWriteProof: true,
  }) : null;
  return {
    context: createKiroDelegationContext({
      client, runtimeRoot, writableRoots,
      skillsRoot: join(project, client === "claude" ? ".claude/skills" : ".agents/skills"),
      nativeAdapter: observationAdapter ?? createCodexNativeAgentAdapter({ runtimeRoot, tempRoot: tmpdir() }),
    }),
    observationAdapter,
    observationContext: ({ sessionId }) => ({ project, sessionId }),
  };
}

function writeHostResponse(client, eventName, result) {
  if (client === "codex" && eventName === "Stop") {
    console.log("{}");
    return;
  }
  if (result.action === "rewrite") {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse",
      ...(client === "codex" ? { permissionDecision: "allow" } : {}), updatedInput: result.updatedInput } }));
    return;
  }
  if (result.action !== "deny") return;
  const alternatives = result.alternatives?.map(item => item.modelId).filter(valid);
  const reason = `${result.reason}。管理された委任入口を確認してください${alternatives?.length ? `。別設定: ${alternatives.join(", ")}` : ""}`;
  if (eventName === "PreToolUse") {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName,
      permissionDecision: "deny", permissionDecisionReason: reason } }));
  } else if (eventName === "UserPromptSubmit" || eventName === "PreModelSwitch") {
    console.log(JSON.stringify({ decision: "block", reason }));
  }
}

async function main() {
  const [client, selector] = process.argv.slice(2);
  if (client === "receipt") {
    if (process.argv.length !== 4 || !/^[A-Za-z0-9_-]{1,1024}$/.test(selector)) process.exitCode = 2;
    else console.log(Buffer.from(selector, "base64url").toString("utf8"));
    return;
  }
  const eventName = selector?.split("-").map(part => part[0]?.toUpperCase() + part.slice(1)).join("");
  try {
    let text = "";
    for await (const chunk of process.stdin) {
      text += chunk;
      if (text.length > 2 ** 20) throw new Error("host input");
    }
    const input = JSON.parse(text);
    if (eventName === "PreToolUse" && !nativeTool(client, input.tool_name) && !parseEntry(input.tool_input?.command)) return;
    if (!["claude", "codex"].includes(client) || input.hook_event_name !== eventName) throw new Error("host event");
    const project = await realpath(join(dirname(scriptPath), "../.."));
    const hostRoot = execFileSync("git", ["-C", input.cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd();
    if (await realpath(hostRoot) !== project) throw new Error("worktree");
    const runtime = await runtimeFor(client, project);
    writeHostResponse(client, eventName, await routeHostEvent({ ...runtime, client, project, eventName, input }));
  } catch {
    writeHostResponse(client, eventName, denied("管理フックの作業先またはホスト情報を確認できません"));
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
