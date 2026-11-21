// 委任セットアップの純粋な候補整理と順序検証。
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Registry と能力確認の結果を、利用者に示す状態別の許可リストへ変換する。 */
export function buildDelegationSetup(input) {
  if (!isObject(input) || Object.keys(input).some((key) => !["registrations", "verified", "planned", "removing"].includes(key)) ||
      !Array.isArray(input.registrations) || !isObject(input.verified) || !Array.isArray(input.planned) ||
      input.removing !== undefined && !Array.isArray(input.removing)) {
    return { ok: false, reason: "委任候補の探査結果の形式が不正です", groups: { eligible: [], planned: [], removing: [], pending: [], unavailable: [] } };
  }
  const groups = { eligible: [], planned: [], removing: [], pending: [], unavailable: [] };
  for (const registration of input.registrations) {
    if (!isObject(registration) || Object.keys(registration).some((key) => !["host", "name", "family", "scope", "enabled", "approved", "trusted", "transportType", "transportFingerprint", "registrationId", "error", "status", "reason"].includes(key)) ||
        typeof registration.host !== "string" || !registration.host.trim() ||
        typeof registration.name !== "string" || !registration.name.trim() || typeof registration.status !== "string" ||
        !["project", "user", null, undefined].includes(registration.scope) ||
        (registration.family !== undefined && registration.family !== null && typeof registration.family !== "string") ||
        ["enabled", "approved", "trusted"].some((key) => registration[key] !== undefined && registration[key] !== null && typeof registration[key] !== "boolean") ||
        ["transportType", "transportFingerprint", "error"].some((key) => registration[key] !== undefined && registration[key] !== null && typeof registration[key] !== "string") ||
        (registration.registrationId !== undefined && registration.registrationId !== null && (typeof registration.registrationId !== "string" || !registration.registrationId.trim())) ||
        (registration.reason !== undefined && registration.reason !== null && typeof registration.reason !== "string")) continue;
    const base = { host: registration.host, registrationName: registration.name, scope: registration.scope ?? null,
      registrationId: typeof registration.registrationId === "string" && registration.registrationId ? registration.registrationId : null };
    if (registration.status === "eligible") {
      const capability = base.registrationId ? input.verified[base.registrationId] : null;
      const models = Array.isArray(capability?.models) ? capability.models.filter((model) => isObject(model) && Object.keys(model).every((key) => key === "id") && typeof model.id === "string" && model.id.trim()).map(({ id }) => ({ id })) : null;
      if (isObject(capability) && Object.keys(capability).every((key) => ["kind", "harness", "tier", "models"].includes(key)) && capability.kind === "agent" && typeof capability.harness === "string" && capability.harness.trim() &&
          ["local", "cloud"].includes(capability.tier) && models && models.length === capability.models.length) {
        groups.eligible.push({ ...base, family: capability.harness, tier: capability.tier, host: base.host, models });
      } else groups.unavailable.push({ ...base, status: "unknown", reason: "エージェント能力を確認できません" });
    } else if (registration.status === "pending") groups.pending.push({ ...base, status: "pending", reason: typeof registration.reason === "string" ? registration.reason : "承認待ち" });
    else groups.unavailable.push({ ...base, status: registration.status === "disabled" ? "disabled" : "unknown",
      reason: typeof registration.reason === "string" ? registration.reason : "委任候補として利用できません" });
  }
  for (const item of input.planned) {
    if (!isObject(item) || typeof item.host !== "string" || !item.host || typeof item.name !== "string" || !item.name) continue;
    groups.planned.push({ host: item.host, registrationName: item.name, status: "planned" });
  }
  for (const item of input.removing ?? []) {
    if (!isObject(item) || Object.keys(item).some((key) => !["host", "name"].includes(key)) ||
        typeof item.host !== "string" || !item.host.trim() || typeof item.name !== "string" || !item.name.trim()) continue;
    groups.removing.push({ host: item.host, registrationName: item.name, status: "removal-planned" });
  }
  return { ok: true, groups };
}

/** 明示された段内順序を検証し、他のホスト・段・項目はそのまま保持する。 */
export function applyDelegationOrder(input) {
  if (!isObject(input) || Object.keys(input).some((key) => !["delegation", "host", "tier", "order", "candidates", "models"].includes(key)) ||
      !isObject(input.delegation) || typeof input.host !== "string" || !input.host || !["local", "cloud"].includes(input.tier) ||
      !Array.isArray(input.order) || !input.order.every((id) => typeof id === "string" && id.trim()) || !Array.isArray(input.candidates) ||
      input.models !== undefined && !isObject(input.models)) {
    return { ok: false, reason: "委任順序の指定が不正です" };
  }
  const currentHost = input.delegation[input.host];
  if (currentHost !== undefined && !isObject(currentHost)) return { ok: false, reason: "保存済み委任設定の形式が不正です" };
  const currentStage = currentHost?.[input.tier];
  if (currentStage !== undefined && (!Array.isArray(currentStage) || currentStage.some((item) => !isObject(item) || Object.keys(item).some((key) => !["family", "scope", "registrationName", "registrationId", "models"].includes(key))))) {
    return { ok: false, reason: "保存済み委任設定の形式が不正です" };
  }
  const candidateKey = (candidate) => JSON.stringify([input.host, candidate.scope, candidate.registrationName, candidate.registrationId]);
  const candidates = new Map();
  const candidatesById = new Map();
  const candidateKeyBySelection = new Map();
  for (const candidate of input.candidates) {
    if (!isObject(candidate) || Object.keys(candidate).some((key) => !["family", "scope", "registrationName", "registrationId", "tier", "host", "models"].includes(key)) ||
        typeof candidate.family !== "string" || !candidate.family.trim() || !["project", "user"].includes(candidate.scope) ||
        typeof candidate.registrationName !== "string" || !candidate.registrationName.trim() || typeof candidate.registrationId !== "string" || !candidate.registrationId.trim() ||
        (candidate.tier !== undefined && !["local", "cloud"].includes(candidate.tier)) || (candidate.host !== undefined && (typeof candidate.host !== "string" || !candidate.host.trim())) ||
        (candidate.models !== undefined && (!Array.isArray(candidate.models) && !isObject(candidate.models) || Array.isArray(candidate.models) && candidate.models.some((model) => !isObject(model) || Object.keys(model).length !== 1 || typeof model.id !== "string" || !model.id.trim())))) return { ok: false, reason: "委任候補の形式が不正です" };
    const key = candidateKey(candidate);
    if (candidates.has(key)) return { ok: false, reason: "同一の委任候補が重複しています" };
    candidates.set(key, candidate);
    candidateKeyBySelection.set(`${candidate.registrationName}:${candidate.registrationId}`, candidate);
    const sameId = candidatesById.get(candidate.registrationId) ?? [];
    sameId.push(candidate);
    candidatesById.set(candidate.registrationId, sameId);
  }
  const selectedCandidates = new Map();
  for (const selection of input.order) {
    const sameId = candidatesById.get(selection);
    const candidate = candidateKeyBySelection.get(selection) ?? (sameId?.length === 1 ? sameId[0] : null);
    if (!candidate) return { ok: false, reason: sameId?.length > 1 ? "登録 ID が複数の登録名で使われています。登録名:登録 ID で指定してください" : "指定された委任候補が見つからないか識別が曖昧です" };
    selectedCandidates.set(selection, candidate);
  }
  if (input.models && Object.keys(input.models).some((id) => !selectedCandidates.has(id))) return { ok: false, reason: "選択していない委任候補のモデルは指定できません" };
  if (input.models && Object.values(input.models).some((roles) => !isObject(roles) || Object.keys(roles).some((role) => !/^[a-z][a-z0-9_-]*$/.test(role)))) return { ok: false, reason: "委任モデル指定の形式が不正です" };
  if (input.models && Object.values(input.models).some((roles) => Object.values(roles).some((model) => !isObject(model) || Object.keys(model).length !== 1 ||
      (Object.hasOwn(model, "fixed") ? typeof model.fixed !== "string" || !model.fixed.trim() : !Object.hasOwn(model, "compatibleIds") || !Array.isArray(model.compatibleIds) || model.compatibleIds.some((entry) => typeof entry !== "string" || !entry.trim()) || new Set(model.compatibleIds).size !== model.compatibleIds.length)))) return { ok: false, reason: "委任モデル指定の形式が不正です" };
  if (new Set(input.order).size !== input.order.length) return { ok: false, reason: "指定された委任候補が見つからないか重複しています" };
  const delegation = structuredClone(input.delegation);
  const hostValue = isObject(delegation[input.host]) ? delegation[input.host] : {};
  const previousStage = hostValue[input.tier];
  hostValue[input.tier] = input.order.map((id) => {
    const candidate = selectedCandidates.get(id);
    const previous = (previousStage ?? []).find((item) => isObject(item) && item.registrationId === candidate.registrationId && item.registrationName === candidate.registrationName && item.scope === candidate.scope && item.family === candidate.family);
    const modelSettings = input.models?.[id] === undefined ? (previous?.models ?? {}) : { ...(previous?.models ?? {}), ...input.models[id] };
    if (!isObject(modelSettings) || Object.entries(modelSettings).some(([role, model]) => !/^[a-z][a-z0-9_-]*$/.test(role) || !isObject(model) || Object.keys(model).length !== 1 ||
      (Object.hasOwn(model, "fixed") ? typeof model.fixed !== "string" || !model.fixed.trim() : !Object.hasOwn(model, "compatibleIds") || !Array.isArray(model.compatibleIds) || model.compatibleIds.some((entry) => typeof entry !== "string" || !entry.trim()) || new Set(model.compatibleIds).size !== model.compatibleIds.length))) return null;
    return { family: candidate.family, scope: candidate.scope, registrationName: candidate.registrationName,
      registrationId: candidate.registrationId, models: structuredClone(modelSettings) };
  });
  if (hostValue[input.tier].some((item) => item === null)) return { ok: false, reason: "委任モデル指定が公開モデル一覧と一致しません" };
  delegation[input.host] = hostValue;
  return { ok: true, delegation };
}
