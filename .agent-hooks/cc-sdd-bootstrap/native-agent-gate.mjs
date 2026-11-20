/**
 * 正規化済みの信頼できる証拠だけで、予約済みネイティブ起動を判定する。
 * @param {Readonly<{role:string, client:string, agentName:string, modelId:string, effort:string, access:string}>} policy
 * @param {unknown} evidence
 */
export function decideNativeAgentGate(policy, evidence) {
  if (!validPolicy(policy) || !record(evidence)) return deny("insufficient-evidence", []);

  const required = ["role", "client", "agentName", "definitionVerified", "parentModelId", "childModelId", "effort", "access", "historyInherited"];
  if (required.some((key) => !Object.hasOwn(evidence, key)) ||
      typeof evidence.parentModelId !== "string" || !evidence.parentModelId ||
      typeof evidence.childModelId !== "string" || !evidence.childModelId ||
      !canonicalId(evidence.parentModelId) || !canonicalId(evidence.childModelId) ||
      typeof evidence.definitionVerified !== "boolean" || typeof evidence.historyInherited !== "boolean") {
    return deny("insufficient-evidence", []);
  }

  if (!validRole(evidence.role) || !validClient(evidence.client) ||
      typeof evidence.agentName !== "string" || evidence.agentName.trim() === "" ||
      !validEffort(evidence.effort) || !validAccess(evidence.access)) {
    return deny("insufficient-evidence", []);
  }

  if (evidence.role !== policy.role || evidence.client !== policy.client || evidence.agentName !== policy.agentName ||
      !validAgentName(evidence.role, evidence.client, evidence.agentName, evidence.access) || evidence.definitionVerified !== true) {
    return deny("definition-mismatch", []);
  }
  if (evidence.historyInherited) return deny("history-inherited", verifiedAlternatives(policy, evidence));
  if (evidence.childModelId === evidence.parentModelId) return deny("same-model", verifiedAlternatives(policy, evidence));
  if (evidence.childModelId !== policy.modelId) return deny("model-mismatch", verifiedAlternatives(policy, evidence));
  if (evidence.effort !== policy.effort) return deny("effort-mismatch", []);
  if (evidence.access !== policy.access) return deny("access-mismatch", []);
  return { allowed: true, reason: null, alternatives: [] };
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ROLES = new Set(["manufacture", "review", "design", "research", "debug"]);
const CLIENTS = new Set(["claude", "codex"]);
const EFFORTS = new Set(["medium", "high"]);
const ACCESSES = new Set(["read-only", "workspace-write"]);

/** @param {unknown} value */
function validRole(value) { return typeof value === "string" && ROLES.has(value); }
/** @param {unknown} value */
function validClient(value) { return typeof value === "string" && CLIENTS.has(value); }
/** @param {unknown} value */
function validEffort(value) { return typeof value === "string" && EFFORTS.has(value); }
/** @param {unknown} value */
function validAccess(value) { return typeof value === "string" && ACCESSES.has(value); }
/** @param {unknown} value */
function canonicalId(value) { return typeof value === "string" && value.trim() !== "" && value === value.trim(); }

/** @param {unknown} policy */
function validPolicy(policy) {
  if (!record(policy)) return false;
  const required = ["role", "client", "agentName", "modelId", "effort", "access"];
  if (required.some((key) => !Object.hasOwn(policy, key))) return false;
  return validRole(policy.role) && validClient(policy.client) && validEffort(policy.effort) &&
    validAccess(policy.access) && canonicalId(policy.modelId) &&
    validAgentName(policy.role, policy.client, policy.agentName, policy.access) &&
    compatibleAccess(policy.role, policy.access);
}

/** @param {unknown} role @param {unknown} client @param {unknown} name @param {unknown} access */
function validAgentName(role, client, name, access) {
  if (!validRole(role) || !validClient(client) || !validAccess(access) || typeof name !== "string") return false;
  const prefix = client === "claude" ? "cc-sdd-" : "cc_sdd_";
  const suffix = role === "design" && access === "read-only"
    ? client === "claude" ? "-read-only" : "_read_only"
    : "";
  return name === `${prefix}${role}${suffix}`;
}

/** @param {unknown} role @param {unknown} access */
function compatibleAccess(role, access) {
  if (!validRole(role) || !validAccess(access)) return false;
  if (role === "manufacture") return access === "workspace-write";
  if (role === "design") return true;
  return access === "read-only";
}

/** @param {string} reason @param {readonly unknown[]} alternatives */
function deny(reason, alternatives) {
  return { allowed: false, reason, alternatives };
}

/** @param {Record<string, any>} policy @param {Record<string, any>} evidence */
function verifiedAlternatives(policy, evidence) {
  if (!Array.isArray(evidence.alternatives)) return [];
  return evidence.alternatives.filter((candidate) => record(candidate) &&
    ["verified", "role", "client", "agentName", "effort", "access", "modelId"].every((key) => Object.hasOwn(candidate, key)) &&
    candidate.verified === true && candidate.role === policy.role &&
    candidate.client === policy.client && candidate.agentName === policy.agentName &&
    candidate.effort === policy.effort && candidate.access === policy.access &&
    canonicalId(candidate.modelId) && candidate.modelId !== evidence.parentModelId);
}
