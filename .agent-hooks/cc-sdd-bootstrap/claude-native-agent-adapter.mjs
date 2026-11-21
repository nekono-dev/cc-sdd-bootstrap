import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyNativeAgentDefinition } from "./native-agent-definitions.mjs";

const CANONICAL = /^claude-[a-z0-9-]+$/;

/** Claude Code の実イベント、管理定義、隔離ストアから起動証拠を組み立てる。 */
export function createClaudeNativeAgentAdapter({ store, aliases = {}, requirePrivateWriteProof = false, env = process.env } = {}) {
  if (!store || typeof store.keyFor !== "function" || typeof store.read !== "function" || typeof store.transact !== "function") throw new TypeError("原子的な Claude 観測ストアが必要です");
  const normalize = (value) => typeof value === "string" && (CANONICAL.test(value) ? value : (Object.hasOwn(aliases, value) && CANONICAL.test(aliases[value] ?? "") ? aliases[value] : null));
  const observationKey = (input) => store.keyFor({ project: input?.project ?? input?.cwd, sessionId: input?.sessionId });
  function resolvePolicyModel(modelId) { return normalize(modelId); }

  async function observe(input) {
    const key = observationKey(input);
    if (!key || typeof input.event !== "string") return false;
    try {
      if (input.event === "SessionStart") {
        const modelId = normalize(input.model);
        const fenceToken = await store.invalidateFence(key);
        if (!modelId) return false;
        await store.transact(key, (current) => ({ status: "confirmed", modelId, sequence: (current?.sequence ?? 0) + 1, fenceToken }));
        return true;
      }
      if (input.event === "PreModelSwitch") {
        const fromModelId = normalize(input.from_model), toModelId = normalize(input.to_model);
        if (!fromModelId || !toModelId) { await store.invalidateFence(key); return false; }
        const pending = await store.invalidateAndWrite(key, (current, fenceToken) => ({ status: "pending", fenceToken, sequence: (current?.sequence ?? 0) + 1,
          fromModelId, toModelId,
          ...(typeof input.switch_id === "string" ? { switchId: input.switch_id } : {}) }));
        return pending?.status === "pending";
      }
      if (input.event === "PostModelSwitch") {
        const modelId = normalize(input.to_model);
        const fromModelId = normalize(input.from_model);
        if (!modelId || !fromModelId) return false;
        const fenceToken = await store.readFence(key);
        if (!fenceToken) return false;
        let changed = false;
        await store.transact(key, (current) => {
          if (current?.status !== "pending" || current.fenceToken !== fenceToken || current.fromModelId !== fromModelId || current.toModelId !== modelId ||
              (current.switchId && input.switch_id !== current.switchId) ||
              (current.switchId && typeof input.switch_id !== "string")) return undefined;
          changed = true;
          return { status: "confirmed", modelId, sequence: current.sequence + 1, fenceToken };
        });
        return changed && (await store.read(key))?.status === "confirmed";
      }
      return false;
    } catch { return false; }
  }

  async function collectEvidence({ context, policy, settings, launch, hostEvent }) {
    const key = observationKey(context);
    if (!key || !settings || !launch || !policy || launch.agentName !== policy.agentName) throw new Error("セッションモデル");
    if (hostEvent !== null && (!hostEvent || typeof hostEvent.toolUseId !== "string" || !hostEvent.toolUseId ||
        (hostEvent.session_id && hostEvent.session_id !== context.sessionId) || hostEvent.toolInput?.subagent_type !== launch.agentName ||
        (hostEvent.toolInput?.model !== undefined && normalize(hostEvent.toolInput.model) !== normalize(launch.requestedModel)))) throw new Error("起動時指定");
    if (requirePrivateWriteProof && policy.access === "workspace-write") throw new Error("Claude の workspace-write に必要なホスト権限証拠がありません");
    const requestedModel = launch.requestedModel;
    const childModelId = requestedModel === undefined ? normalize(policy.modelId) : normalize(requestedModel);
    const effort = launch.requestedEffort ?? policy.effort;
    if (!childModelId || !CANONICAL.test(childModelId) || !["medium", "high"].includes(effort)) throw new Error("モデル・推論量");
    try {
      const path = join(context.project ?? context.cwd, ".claude", "agents", `${policy.agentName}.md`);
      const content = await readFile(path, "utf8");
      if (!verifyNativeAgentDefinition(settings, "claude", `.claude/agents/${policy.agentName}.md`, content)) throw new Error("管理定義");
      const parent = await store.read(key);
      if (parent?.status !== "confirmed" || !CANONICAL.test(parent.modelId)) throw new Error("セッションモデル");
      if (Object.hasOwn(env, "CLAUDE_CODE_EFFORT_LEVEL") && env.CLAUDE_CODE_EFFORT_LEVEL !== effort) throw new Error("環境推論量上書き");
      const forceModel = env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE;
      if (forceModel !== undefined && forceModel !== "0") {
        const forcedModel = env.CLAUDE_CODE_SUBAGENT_MODEL === undefined ? parent.modelId : normalize(env.CLAUDE_CODE_SUBAGENT_MODEL);
        if (forceModel !== "1" || !forcedModel || forcedModel !== childModelId) throw new Error("環境モデル上書き");
      }
      return { role: policy.role, client: "claude", agentName: launch.agentName, definitionVerified: true,
        parentModelId: parent.modelId, childModelId, effort, access: policy.access, historyInherited: false };
    } catch (error) { if (error instanceof Error && ["起動時指定", "モデル・推論量", "環境推論量上書き", "環境モデル上書き", "管理定義", "セッションモデル"].includes(error.message)) throw error; throw new Error("管理定義"); }
  }

  function normalizeLaunch({ toolName, toolInput }) {
    if (toolName !== "Agent" || !toolInput || typeof toolInput.subagent_type !== "string" || !toolInput.subagent_type.startsWith("cc-sdd-")) return { ok: false, reason: "管理対象の Claude 役割を指定してください" };
    if (toolInput.model !== undefined && !normalize(toolInput.model)) return { ok: false, reason: "指定モデルを確認できません" };
    if (toolInput.effort !== undefined && !["medium", "high"].includes(toolInput.effort)) return { ok: false, reason: "指定推論量を確認できません" };
    return { ok: true, value: { toolName, agentName: toolInput.subagent_type,
      ...(toolInput.model === undefined ? {} : { requestedModel: toolInput.model }),
      ...(toolInput.effort === undefined ? {} : { requestedEffort: toolInput.effort }) } };
  }
  return Object.freeze({ observe, collectEvidence, normalizeLaunch, resolvePolicyModel });
}
