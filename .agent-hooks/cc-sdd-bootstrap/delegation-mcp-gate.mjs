#!/usr/bin/env node
// cc-sdd の作業中に、確認済みのエージェント MCP の起動ツールを直接呼ぶことを拒否する PreToolUse フック。
// 判定（decideMcpGate）は外部入出力を持たない純粋な関数で、ホストの入力と作業コンテキストへの接続（handleMcpPreToolUse）と CLI を分けている。
// 配置先で動くため、インストーラ本体（lib/）は読み込まない。
import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 管理委任の有効状態。ホストごとに、直接起動の検出・拒否を実機で確認した経路だけ enabled を true にする。
 * 未確認の経路では拒否せず、理由を管理区画に示す。
 */
export const MANAGED_DELEGATION = Object.freeze({
  claude: Object.freeze({ enabled: false, reason: "Claude Code で PreToolUse による MCP 直接起動の拒否を実機で確認していないため、管理委任は無効です" }),
  codex: Object.freeze({ enabled: false, reason: "Codex で MCP 呼び出しを PreToolUse で検出・拒否できることを実機で確認していないため、管理委任は無効です" }),
});

/** 確認済みのエージェント MCP アダプターが公開する起動操作。Pi の pi_start と、Codex MCP の codex_start */
export const START_OPERATIONS = Object.freeze(["pi_start", "codex_start"]);

/** 管理入口の起動の書式。依頼 ID・役割・作業先・指示ファイル・参照を渡す */
export const DELEGATE_START = "node .agent-hooks/cc-sdd-bootstrap/delegate.mjs start --skill <kiro-手順名> --task-id <タスク> --request-id <依頼ID> --role <役割> --work-dir <作業先> --instruction-file <指示ファイル> --reference <参照>";

const CLIENTS = new Set(["claude", "codex"]);
const INPUT_KEYS = ["active", "client", "toolName"];
const PASS = Object.freeze({ action: "pass-through" });

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const deny = (reason) => ({ action: "deny", reason });

/**
 * MCP のツール名 `mcp__<サーバー>__<操作>` を分ける。サーバー名に `__` を含んでも、最後の `__` より後を操作名とする。
 * @returns {{ server: string, operation: string } | null}
 */
export function parseMcpToolName(toolName) {
  if (typeof toolName !== "string" || !toolName.startsWith("mcp__")) return null;
  const split = toolName.lastIndexOf("__");
  if (split <= 4) return null;
  const server = toolName.slice(5, split);
  const operation = toolName.slice(split + 2);
  if (server === "" || operation === "") return null;
  return { server, operation };
}

/** 確認済みの起動操作かどうか */
export function isStartTool(toolName) {
  const parsed = parseMcpToolName(toolName);
  return parsed !== null && START_OPERATIONS.includes(parsed.operation);
}

/** 入力は {client, toolName, active} だけを許可する。未知のキー・不正な型は拒否扱いにする。 */
function validInput(input) {
  if (!record(input)) return false;
  const keys = Object.keys(input);
  if (keys.length !== INPUT_KEYS.length || !INPUT_KEYS.every((key) => Object.hasOwn(input, key))) return false;
  return CLIENTS.has(input.client) && typeof input.toolName === "string" && input.toolName.trim() !== "" &&
    typeof input.active === "boolean";
}

/**
 * 直接起動を拒否するかを判定する。作業中（active）で、そのホストの管理委任が有効で、確認済みの起動操作のときだけ拒否する。
 * @param {{ client: "claude" | "codex", toolName: string, active: boolean }} input
 * @param {typeof MANAGED_DELEGATION} [managed]
 * @returns {{ action: "pass-through" } | { action: "deny", reason: string }}
 */
export function decideMcpGate(input, managed = MANAGED_DELEGATION) {
  if (!validInput(input)) return deny("MCP 呼び出しの情報を確認できないため、拒否します");
  if (!isStartTool(input.toolName) || !input.active) return PASS;
  if (managed?.[input.client]?.enabled !== true) return PASS;
  const { operation } = parseMcpToolName(input.toolName);
  return deny(`cc-sdd の作業中は、エージェント MCP の起動（${operation}）を直接呼べません。役割の確認・候補の順序・未確定の書き込みの保留を通すため、管理入口を使ってください: ${DELEGATE_START}。--reference には手順の開始時の enter で発行された参照を渡します`);
}

/**
 * 正規化済みのホストイベントと作業コンテキストから判定する。
 * 起動操作でホスト情報が無い、または作業の状態を確認できないときは拒否する。起動以外は作業状態を見ない。
 * @param {{ client: unknown, event: unknown, toolName: unknown, context: unknown, managed?: typeof MANAGED_DELEGATION }} options
 */
export async function handleMcpPreToolUse(options) {
  if (!record(options)) return deny("MCP 呼び出しの情報を確認できないため、拒否します");
  const { client, event, toolName, context, managed = MANAGED_DELEGATION } = options;
  if (!isStartTool(toolName)) return decideMcpGate({ client, toolName, active: false }, managed);
  if (managed?.[client]?.enabled !== true) return PASS;
  if (!record(event) || event.trusted !== true || event.source !== "host" ||
      typeof event.cwd !== "string" || typeof event.sessionId !== "string") {
    return deny("ホストから委任イベントの情報を取得できないため、MCP の起動を拒否します");
  }
  let state;
  try {
    state = await context?.current?.({ cwd: event.cwd, sessionId: event.sessionId });
  } catch {
    return deny("cc-sdd の作業状態を確認できないため、MCP の起動を拒否します");
  }
  const active = record(state) && state.active === true && state.ended !== true;
  return decideMcpGate({ client, toolName, active }, managed);
}

function writeDeny(reason) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}

async function main() {
  const [client, selector] = process.argv.slice(2);
  let toolName;
  try {
    if (!CLIENTS.has(client) || selector !== "pre-tool-use") throw new Error("argv");
    let text = "";
    for await (const chunk of process.stdin) {
      text += chunk;
      if (text.length > 2 ** 20) throw new Error("host input");
    }
    const input = JSON.parse(text);
    if (!record(input) || input.hook_event_name !== "PreToolUse") throw new Error("host event");
    toolName = input.tool_name;
    const scriptPath = fileURLToPath(import.meta.url);
    const project = await realpath(join(dirname(scriptPath), "../.."));
    const hostRoot = execFileSync("git", ["-C", input.cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd();
    if (await realpath(hostRoot) !== project) throw new Error("worktree");
    const { normalizeHostEvent, runtimeFor } = await import("./subagent-model-policy-hook.mjs");
    const runtime = await runtimeFor(client, project);
    const event = normalizeHostEvent(client, "PreToolUse", input);
    if (event) event.cwd = project;
    const decision = await handleMcpPreToolUse({ client, event, toolName, context: runtime.context });
    if (decision.action === "deny") writeDeny(decision.reason);
  } catch {
    // 管理委任が有効な経路では、確認できなかった起動を通さない。無効な経路や起動以外には影響させない。
    if (CLIENTS.has(client) && MANAGED_DELEGATION[client].enabled && isStartTool(toolName)) {
      writeDeny("cc-sdd の作業状態を確認できないため、MCP の起動を拒否します。管理入口を確認してください");
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
