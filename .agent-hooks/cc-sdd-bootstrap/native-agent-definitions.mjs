import { resolveNative } from "./role-policy.mjs";

const ROLES = Object.freeze(["manufacture", "review", "design", "research", "debug"]);

/** @typedef {Readonly<{relativePath: string, content: string}>} NativeAgentDefinition */

/** @param {string} value */
function quoted(value) {
  // TOML の基本文字列で文字として許可されない DEL は Unicode エスケープにする。
  return JSON.stringify(value).replaceAll("\u007f", "\\u007f");
}

/** @param {import("./role-policy.mjs").RolePolicy["role"]} role @param {boolean} readOnly */
function instruction(role, readOnly) {
  const access = readOnly ? "read-only" : "workspace-write";
  return `cc-sdd の ${role} 役割を実行してください。必要権限: ${access}。依頼された役割の範囲を守ってください。`;
}

/** @param {import("./role-policy.mjs").NativePolicy} policy @returns {NativeAgentDefinition} */
function render(policy) {
  const readOnly = policy.access === "read-only";
  const stem = policy.agentName;
  if (policy.client === "claude") {
    const frontmatter = [
      "---",
      `name: ${policy.agentName}`,
      `description: ${quoted(instruction(policy.role, readOnly))}`,
      `model: ${quoted(policy.modelId)}`,
      `effort: ${quoted(policy.effort)}`,
      ...(readOnly ? ["tools: Read, Glob, Grep"] : []),
      "---",
      "",
      instruction(policy.role, readOnly),
      "",
    ].join("\n");
    return { relativePath: `.claude/agents/${stem}.md`, content: frontmatter };
  }

  if (!policy.modelId.isWellFormed()) {
    const clientName = policy.client === "codex" ? "Codex" : "Claude Code";
    throw new TypeError(`${clientName} の ${policy.role} 役割の model は不正な Unicode を含められません`);
  }

  const content = [
    `name = ${quoted(policy.agentName)}`,
    `description = ${quoted(instruction(policy.role, readOnly))}`,
    `model = ${quoted(policy.modelId)}`,
    `model_reasoning_effort = ${quoted(policy.effort)}`,
    `developer_instructions = ${quoted(instruction(policy.role, readOnly))}`,
    "",
  ].join("\n");
  return { relativePath: `.codex/agents/${stem}.toml`, content };
}

/**
 * 予約されたネイティブ定義を設定から純粋かつ決定的に生成する。
 * @param {unknown} settings
 * @param {"claude" | "codex"} client
 * @returns {readonly NativeAgentDefinition[]}
 */
export function generateNativeAgentDefinitions(settings, client) {
  if (client !== "claude" && client !== "codex") throw new TypeError("client は claude または codex で指定してください");
  const definitions = [];
  for (const role of ROLES) {
    const result = resolveNative(settings, client, role);
    if (!result.ok) throw new TypeError(result.error.reason);
    definitions.push(render(result.value));
    if (role === "design") {
      const readOnlyDesign = resolveNative(settings, client, role, { readOnly: true });
      if (!readOnlyDesign.ok) throw new TypeError(readOnlyDesign.error.reason);
      definitions.push(render(readOnlyDesign.value));
    }
  }
  return Object.freeze(definitions.map((definition) => Object.freeze(definition)));
}

/**
 * 予約パスと実ファイル内容が現在の設定から生成される定義と完全一致するか調べる。
 * @param {unknown} settings
 * @param {"claude" | "codex"} client
 * @param {string} relativePath
 * @param {unknown} actualContent
 */
export function verifyNativeAgentDefinition(settings, client, relativePath, actualContent) {
  if (typeof relativePath !== "string" || typeof actualContent !== "string") return false;
  try {
    return generateNativeAgentDefinitions(settings, client).some((definition) =>
      definition.relativePath === relativePath && definition.content === actualContent);
  } catch {
    return false;
  }
}
