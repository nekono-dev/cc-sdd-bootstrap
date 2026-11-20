/** @typedef {"manufacture" | "review" | "design" | "research" | "debug"} RoleId */
/** @typedef {"claude" | "codex"} NativeClient */
/** @typedef {"read-only" | "workspace-write"} Access */
/** @typedef {"medium" | "high"} Effort */
/** @typedef {Readonly<{role: RoleId, access: Access, effort: Effort, localModelIds: readonly string[]}>} RolePolicy */
/** @typedef {RolePolicy & Readonly<{client: NativeClient, modelId: string, agentName: string}>} NativePolicy */
/** @typedef {Readonly<{code: "UNKNOWN_ROLE" | "INVALID_SETTING" | "UNSUPPORTED_ACCESS", reason: string}>} RoleError */
/** @template T @typedef {{ok: true, value: T} | {ok: false, error: RoleError}} Result */

const ROLE_IDS = /** @type {const} */ (["manufacture", "review", "design", "research", "debug"]);
const CLIENT_IDS = /** @type {const} */ (["claude", "codex"]);
const CLIENT_SETTING = { claude: "claudeModels", codex: "codexModels" };
const DEFAULT_MODELS = {
  claude: { manufacture: "haiku", review: "sonnet", design: "sonnet", research: "sonnet", debug: "sonnet" },
  codex: { manufacture: "gpt-6-luna", review: "gpt-6.1-sol", design: "gpt-6.1-sol", research: "gpt-6.1-sol", debug: "gpt-6.1-sol" },
};

/** @param {RoleError["code"]} code @param {string} reason */
function failure(code, reason) {
  return { ok: false, error: { code, reason } };
}

/** @param {unknown} settings @returns {settings is Record<string, unknown>} */
function isSettings(settings) {
  return typeof settings === "object" && settings !== null && !Array.isArray(settings);
}

/** @param {Record<string, unknown>} object @param {string} key */
function ownValue(object, key) {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/** @param {unknown} value @param {string} name @returns {string | null} */
function mapProblem(value, name) {
  if (value === undefined) return null;
  if (!isSettings(value)) return `${name} は役割名と文字列の対応（オブジェクト）で指定してください`;
  for (const role of Object.getOwnPropertyNames(value)) {
    const entry = value[role];
    if (typeof entry !== "string" || entry.trim() === "") return `${name}.${role} は空でない文字列で指定してください`;
  }
  return null;
}

/** @param {unknown} settings @param {RoleId} role @param {{readOnly?: boolean}} [options] @returns {Result<RolePolicy>} */
export function resolveRole(settings, role, options = {}) {
  if (!ROLE_IDS.includes(role)) return failure("UNKNOWN_ROLE", `未対応の役割です: ${String(role)}`);
  if (!isSettings(settings)) return failure("INVALID_SETTING", "設定はオブジェクトで指定してください");
  if (!isSettings(options) || Object.hasOwn(options, "readOnly") && typeof options.readOnly !== "boolean") {
    return failure("INVALID_SETTING", "options.readOnly は boolean で指定してください");
  }
  const configuredSubagents = ownValue(settings, "subagents");
  const subagents = configuredSubagents === undefined ? {} : configuredSubagents;
  if (!isSettings(subagents)) return failure("INVALID_SETTING", "subagents はオブジェクトで指定してください");
  for (const name of ["claudeModels", "codexModels", "efforts", "localModels"]) {
    const problem = mapProblem(ownValue(subagents, name), `subagents.${name}`);
    if (problem) return failure("INVALID_SETTING", problem);
  }
  const configuredEfforts = ownValue(subagents, "efforts");
  if (configuredEfforts) {
    for (const key of Object.getOwnPropertyNames(configuredEfforts)) {
      const effort = configuredEfforts[key];
      if (effort !== "medium" && effort !== "high") {
        return failure("INVALID_SETTING", `subagents.efforts.${key} は medium または high で指定してください`);
      }
    }
  }
  const models = ownValue(settings, "models");
  const modelsProblem = mapProblem(models, "models");
  if (modelsProblem) return failure("INVALID_SETTING", modelsProblem);

  const readOnly = Object.hasOwn(options, "readOnly") && options.readOnly === true;
  const access = role === "manufacture" || role === "design" && !readOnly
    ? "workspace-write"
    : "read-only";
  if (role === "manufacture" && readOnly) {
    return failure("UNSUPPORTED_ACCESS", "manufacture 役割には workspace-write が必要です");
  }
  const defaultEffort = role === "design" ? "high" : "medium";
  const efforts = ownValue(subagents, "efforts");
  const localModels = ownValue(subagents, "localModels");
  return {
    ok: true,
    value: {
      role,
      access,
      effort: Object.hasOwn(efforts ?? {}, role) ? efforts[role] : defaultEffort,
      // 役割への適合を確認できた既定候補はないため、明示値だけを完全一致で返す。
      localModelIds: Object.hasOwn(localModels ?? {}, role)
        ? [localModels[role]]
        : [],
    },
  };
}

/** @param {unknown} modelId @param {NativeClient} client @returns {string | null} */
function otherClientFor(modelId, client) {
  if (typeof modelId !== "string") return null;
  const id = modelId;
  if (client === "claude" && ["gpt-6-luna", "gpt-6.1-sol"].includes(id)) return "Codex";
  if (client === "codex" && ["haiku", "sonnet"].includes(id)) return "Claude Code";
  return null;
}

/** @param {unknown} settings @param {NativeClient} client @param {RoleId} role @param {{readOnly?: boolean}} [options] @returns {Result<NativePolicy>} */
export function resolveNative(settings, client, role, options = {}) {
  if (!CLIENT_IDS.includes(client)) return failure("INVALID_SETTING", `未対応のクライアントです: ${String(client)}`);
  const roleResult = resolveRole(settings, role, options);
  if (!roleResult.ok) return roleResult;
  const subagents = ownValue(settings, "subagents") ?? {};
  const clientMap = ownValue(subagents, CLIENT_SETTING[client]);
  let modelId;
  if (clientMap && Object.hasOwn(clientMap, role)) {
    modelId = clientMap[role];
  } else if (ownValue(settings, "models") && Object.hasOwn(ownValue(settings, "models"), role)) {
    modelId = ownValue(settings, "models")[role];
    const otherClient = otherClientFor(modelId, client);
    if (otherClient) {
      return failure("INVALID_SETTING", `models.${role} の値 ${modelId} は ${otherClient} 向けと判断できるため、${client} の役割モデルとして使用できません`);
    }
  } else {
    modelId = DEFAULT_MODELS[client][role];
  }
  const suffix = role === "design" && Object.hasOwn(options, "readOnly") && options.readOnly === true ? (client === "claude" ? "-read-only" : "_read_only") : "";
  return {
    ok: true,
    value: {
      ...roleResult.value,
      client,
      modelId,
      agentName: `${client === "claude" ? "cc-sdd-" : "cc_sdd_"}${role}${suffix}`,
    },
  };
}
