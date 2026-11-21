import { resolveNative, resolveRole } from "./role-policy.mjs";

const TOP_KEYS = new Set(["settings", "role", "host", "candidates", "native", "options"]);
const CANDIDATE_KEYS = new Set(["saved", "capability", "models"]);
const SAVED_KEYS = new Set(["family", "scope", "registrationName", "registrationId", "models"]);
const CAP_KEYS = new Set(["kind", "harness", "tier", "models"]);
const MODEL_KEYS = new Set(["id", "accepted"]);
const ACCEPTED_KEYS = new Set(["access", "effort"]);

function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function onlyKeys(value, allowed) { return record(value) && Object.keys(value).every((key) => allowed.has(key)); }
function identifier(value) { return typeof value === "string" && value.trim().length > 0 && value === value.trim(); }
function unavailable(reasons) { return { kind: "unavailable", reasons: [...new Set(reasons)] }; }

function validCandidate(candidate) {
  if (!onlyKeys(candidate, CANDIDATE_KEYS) || !onlyKeys(candidate.saved, SAVED_KEYS) || !onlyKeys(candidate.capability, CAP_KEYS)) return false;
  const saved = candidate.saved;
  const capability = candidate.capability;
  return identifier(saved.family) &&
    typeof saved.scope === "string" && ["project", "user"].includes(saved.scope) &&
    identifier(saved.registrationName) && identifier(saved.registrationId) &&
    (saved.models === undefined || record(saved.models) && Object.entries(saved.models).every(([role, config]) =>
      ["manufacture", "review", "design", "research", "debug"].includes(role) && onlyKeys(config, new Set(["fixed", "compatibleIds"])) && Object.keys(config).length === 1 &&
      (identifier(config.fixed) || Array.isArray(config.compatibleIds) && config.compatibleIds.every(identifier) && new Set(config.compatibleIds).size === config.compatibleIds.length))) &&
    capability.kind === "agent" && identifier(capability.harness) &&
    ["local", "cloud"].includes(capability.tier) && Array.isArray(capability.models) &&
    capability.models.every((model) => onlyKeys(model, MODEL_KEYS) && identifier(model.id) &&
      Array.isArray(model.accepted) && model.accepted.every((item) => onlyKeys(item, ACCEPTED_KEYS) &&
        ["read-only", "workspace-write"].includes(item.access) && ["off", "medium", "high"].includes(item.effort))) &&
    Array.isArray(candidate.models) && candidate.models.every(identifier);
}

/** 役割ポリシーと最新の公開能力に照らし、順序どおりに委任先を選ぶ。 */
export function selectDelegate(input) {
  if (!onlyKeys(input, TOP_KEYS) || !record(input.settings) ||
      typeof input.role !== "string" || !["manufacture", "review", "design", "research", "debug"].includes(input.role) ||
      !identifier(input.host) || !Array.isArray(input.candidates) ||
      !input.candidates.every(validCandidate) || !record(input.native) ||
      Object.keys(input.native).some((key) => !["client", "available"].includes(key)) ||
      !identifier(input.native.client) || typeof input.native.available !== "boolean" ||
      input.options !== undefined && (!record(input.options) || Object.keys(input.options).some((key) => key !== "readOnly"))) {
    return unavailable(["委任先の選択条件が不正です"]);
  }
  const roleResult = resolveRole(input.settings, input.role, input.options);
  if (!roleResult.ok) return unavailable(["役割条件を解決できません"]);
  const policy = roleResult.value;
  const reasons = [];
  for (const tier of ["local", "cloud"]) {
    for (const candidate of input.candidates) {
      const { saved, capability } = candidate;
      if (capability.tier !== tier) continue;
      if (tier === "cloud" && capability.harness === input.host) {
        reasons.push(`${saved.registrationName}: 指揮役と同じ系統のクラウド候補です`);
        continue;
      }
      const configured = saved.models?.[input.role];
      if (configured !== undefined && (!onlyKeys(configured, new Set(["fixed", "compatibleIds"])) ||
          Object.keys(configured).length !== 1 ||
          configured.fixed !== undefined && !identifier(configured.fixed) ||
          configured.compatibleIds !== undefined && (!Array.isArray(configured.compatibleIds) || configured.compatibleIds.some((id) => !identifier(id))))) {
        reasons.push(`${saved.registrationName}: 役割モデル設定が不正です`);
        continue;
      }
      if (tier === "local" && policy.localModelIds.length === 0) {
        reasons.push(`${saved.registrationName}: 役割に適合するローカルモデルがありません`);
        continue;
      }
      const published = candidate.models;
      const codexNative = capability.harness === "codex"
        ? resolveNative(input.settings, "codex", input.role, input.options)
        : null;
      const ids = tier === "local"
        ? configured?.fixed
          ? policy.localModelIds.includes(configured.fixed) ? [configured.fixed] : []
          : policy.localModelIds
        : configured?.fixed ? [configured.fixed]
          : [...(codexNative?.ok ? [codexNative.value.modelId] : []), ...(configured?.compatibleIds ?? [])];
      const chosen = ids.find((id) => published.includes(id) && capability.models.some((m) => m.id === id &&
        m.accepted.some((accepted) => accepted.access === policy.access && accepted.effort === policy.effort)));
      if (chosen) return { kind: "mcp", tier, candidate: {
        family: saved.family, scope: saved.scope, registrationName: saved.registrationName, registrationId: saved.registrationId,
      }, model: chosen, access: policy.access, effort: policy.effort };
      reasons.push(`${saved.registrationName}: 公開モデルに役割条件を満たす候補がありません`);
    }
  }
  const supportedNative = ["claude", "codex"].includes(input.native.client);
  const native = input.native.available && supportedNative && input.native.client === input.host
    ? resolveNative(input.settings, input.native.client, input.role, input.options) : null;
  if (native?.ok) {
    const value = native.value;
    if (identifier(value.client) && identifier(value.agentName) && identifier(value.modelId) &&
        ["read-only", "workspace-write"].includes(value.access) && ["medium", "high"].includes(value.effort)) {
      return { kind: "native", client: value.client, agentName: value.agentName, model: value.modelId, access: value.access, effort: value.effort };
    }
    reasons.push("ネイティブの役割条件が不正な識別子を含むため利用できません");
  }
  if (native && !native.ok) reasons.push("ネイティブの役割条件を満たせません");
  if (!input.native.available) reasons.push("ネイティブサブエージェントを起動できません");
  else if (!supportedNative || input.native.client !== input.host) reasons.push("利用可能なネイティブサブエージェントがありません");
  return unavailable(reasons.length ? reasons : ["適格な委任先がありません"]);
}
