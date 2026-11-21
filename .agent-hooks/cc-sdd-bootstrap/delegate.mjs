#!/usr/bin/env node
// cc-sdd の管理された委任入口。ホストが発行した呼び出し参照を消費し、
// 登録の再探査、候補選択、一時プロセスでの起動・状態確認・停止を行う。
// 結果は機械可読の JSON を 1 行で返す。指示本文は診断や結果に出さない。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDelegationJobStore } from "./delegation-job-store.mjs";
import { requestControl, resolveControlTarget } from "./delegation-job-control.mjs";
import { listRegistrations, resolveRegistration } from "./delegation-registry.mjs";
import { selectDelegate } from "./delegation-select.mjs";
import { resolveRole } from "./role-policy.mjs";
import { readProjectSettings } from "./kiro-delegation-context.mjs";
import { runtimeFor } from "./subagent-model-policy-hook.mjs";

const OPS = new Set(["start", "status", "stop"]);
const ROLES = new Set(["manufacture", "review", "design", "research", "debug"]);
const SKILL = /^kiro-[a-z0-9][a-z0-9-]*$/;
const TASK = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,127}$/;
const REFERENCE = /^[A-Za-z0-9_-]{16,512}$/;
const TERMINAL = new Set(["succeeded", "failed", "stopped"]);
const START_FLAGS = ["--skill", "--task-id", "--request-id", "--role", "--work-dir", "--instruction-file", "--reference", "--read-only"];
const CONTROL_FLAGS = ["--skill", "--task-id", "--request-id", "--work-dir", "--reference"];
const MAX_INSTRUCTION_BYTES = 64 * 1024;
const MAX_LINE_CHARS = 64 * 1024;
const WORKER_PATH = fileURLToPath(new URL("./delegation-job-worker.mjs", import.meta.url));
const DEFAULT_START_WAIT_MS = 120_000;
const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;
const UNKNOWN = Object.freeze({ kind: "unknown" });
const START_REASON = "ジョブを開始しました。状態は status で確認してください";
const UNKNOWN_REASON = "起動結果を確認できません。終了を確認するまで同じ作業を別の候補で起動しません。status で状態を確認してください";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value) => typeof value === "string" && value.trim() !== "" && value === value.trim();
const unavailable = (reasons) => ({ kind: "unavailable", reasons: [...new Set(reasons)] });
const inside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * 引数を許可リストで検証する。未知のフラグ・重複・不正な値は null を返す。
 * 指示本文はファイル経由でのみ受け取り、引数に載せない。
 */
export function parseDelegateArgs(argv) {
  if (!Array.isArray(argv) || !OPS.has(argv[0])) return null;
  const op = argv[0];
  const allowed = new Set(op === "start" ? START_FLAGS : CONTROL_FLAGS);
  const values = new Map();
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (typeof flag !== "string" || !allowed.has(flag) || values.has(flag)) return null;
    if (flag === "--read-only") { values.set(flag, true); continue; }
    const value = argv[index + 1];
    if (typeof value !== "string" || value === "" || value.startsWith("--")) return null;
    values.set(flag, value);
    index++;
  }
  const required = op === "start" ? START_FLAGS.filter((flag) => flag !== "--read-only") : CONTROL_FLAGS;
  if (required.some((flag) => !values.has(flag))) return null;
  const input = {
    op, skill: values.get("--skill"), taskId: values.get("--task-id"), requestId: values.get("--request-id"),
    role: values.get("--role"), workDir: values.get("--work-dir"), instructionFile: values.get("--instruction-file"),
    reference: values.get("--reference"), readOnly: values.get("--read-only") === true,
  };
  if (!SKILL.test(input.skill) || !TASK.test(input.taskId) || !REQUEST.test(input.requestId) || !REFERENCE.test(input.reference)) return null;
  if (op === "start" && !ROLES.has(input.role)) return null;
  return input;
}

function validSaved(entry) {
  return record(entry) && identifier(entry.family) && ["project", "user"].includes(entry.scope) &&
    identifier(entry.registrationName) && identifier(entry.registrationId) && (entry.models === undefined || record(entry.models));
}

/** 一時プロセスの応答一行を、委任側の結果へ許可リストで変換する。 */
function parseWorkerLine(line) {
  let value;
  try { value = JSON.parse(line); } catch { return UNKNOWN; }
  if (!record(value)) return UNKNOWN;
  if (value.kind === "started" && record(value.job)) return { kind: "started" };
  if (value.kind === "pending" && identifier(value.requestId) && typeof value.reason === "string") return { kind: "pending", requestId: value.requestId, reason: value.reason };
  if (value.kind === "terminal" && record(value.result) && TERMINAL.has(value.result.status) && typeof value.result.summary === "string") {
    return { kind: "terminal", result: { status: value.result.status, summary: value.result.summary } };
  }
  if (value.kind === "unavailable" && Array.isArray(value.reasons) && value.reasons.every((item) => typeof item === "string")) return { kind: "unavailable", reasons: [...value.reasons] };
  // 書き込みの記録が排他・未確定で止まった。起動していないが、別候補やネイティブへ進んではならない。
  if (value.kind === "blocked" && Array.isArray(value.reasons) && value.reasons.length > 0 && value.reasons.every((item) => typeof item === "string")) return { kind: "blocked", reasons: [...value.reasons] };
  return UNKNOWN;
}

/** 依頼ごとの一時プロセスを起動する。親が終了しても処理中の依頼のために生存する。 */
function defaultSpawnWorker(project) {
  return spawn(process.execPath, [WORKER_PATH], { cwd: project, detached: true, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: false });
}

async function defaultReadInstruction(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > MAX_INSTRUCTION_BYTES) throw new Error("指示ファイルを読めません");
  return readFile(path, "utf8");
}

/**
 * 管理入口を作る。contexts はクライアントごとの作業コンテキスト（参照の消費と事前確認の発行）、
 * runtimeBase は利用者限定の実行時領域。その他の依存は既定の実装を使い、テストでは差し替える。
 */
export function createDelegate(deps) {
  if (!record(deps) || !identifier(deps.runtimeBase) || !isAbsolute(deps.runtimeBase) || !Array.isArray(deps.contexts) ||
      deps.contexts.length === 0 || !deps.contexts.every((entry) => record(entry) && ["claude", "codex"].includes(entry.client) && record(entry.context) && typeof entry.context.bindEntryReference === "function")) {
    return Object.freeze({ run: async () => unavailable(["管理入口の設定が不正です"]) });
  }
  const runtimeBase = resolve(deps.runtimeBase);
  const spawnWorker = deps.spawnWorker ?? defaultSpawnWorker;
  const listRegistrationsFor = deps.listRegistrations ?? listRegistrations;
  const readSettings = deps.readSettings ?? readProjectSettings;
  const readInstruction = deps.readInstruction ?? defaultReadInstruction;
  const startWaitMs = deps.startWaitMs ?? DEFAULT_START_WAIT_MS;
  const controlTimeoutMs = deps.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;

  const runtimeRootOf = (project) => join(runtimeBase, "cc-sdd-bootstrap", createHash("sha256").update(project).digest("hex").slice(0, 24));
  const storeFor = (project) => createDelegationJobStore({
    root: runtimeRootOf(project), writableRoots: [project],
    ...(deps.resolveWorktreeRoot ? { resolveWorktreeRoot: deps.resolveWorktreeRoot } : {}),
  });

  async function bind(input, project) {
    for (const { client, context } of deps.contexts) {
      const bound = await context.bindEntryReference({ cwd: project, reference: input.reference, skill: input.skill }).catch(() => null);
      if (bound) return { client, bound };
    }
    return null;
  }

  /** 保存済みの候補を、ホストの現在の登録と照合する。候補の順序は local、cloud の保存順。 */
  async function eligibleCandidates(client, project, settings) {
    const saved = settings.delegation?.[client];
    const entries = [
      ...(Array.isArray(saved?.local) ? saved.local : []).map((entry) => [entry, "local"]),
      ...(Array.isArray(saved?.cloud) ? saved.cloud : []).map((entry) => [entry, "cloud"]),
    ];
    if (entries.length === 0) return { candidates: [], reasons: ["保存済みの委任候補がありません"] };
    const observed = await listRegistrationsFor(client, { cwd: project }).catch(() => []);
    const candidates = [];
    const reasons = [];
    for (const [entry, tier] of entries) {
      if (!validSaved(entry)) { reasons.push("保存済みの委任候補の形式が不正です"); continue; }
      const source = Array.isArray(observed) ? observed.find((item) => item?.name === entry.registrationName && item?.scope === entry.scope) : undefined;
      if (!source) { reasons.push(`${entry.registrationName}: 登録が見つかりません`); continue; }
      const verdict = resolveRegistration(source, entry, { verifiedFamily: entry.family });
      if (verdict.status !== "eligible") { reasons.push(`${entry.registrationName}: ${verdict.reason}`); continue; }
      candidates.push({
        registration: { host: client, scope: entry.scope, registrationName: entry.registrationName, registrationId: entry.registrationId },
        saved: { family: entry.family, scope: entry.scope, registrationName: entry.registrationName, registrationId: entry.registrationId,
          ...(entry.models === undefined ? {} : { models: entry.models }) },
        verifiedFamily: entry.family,
        tier,
      });
    }
    return { candidates, reasons };
  }

  /** 候補一件を一時プロセスに渡し、起動結果の一行を待つ。応答が無い・壊れている場合は unknown で返す。 */
  function dispatch(request) {
    return new Promise((resolveOutcome) => {
      let child;
      try { child = spawnWorker(request.project); }
      catch { resolveOutcome(unavailable(["一時プロセスを起動できません"])); return; }
      let settled = false;
      let buffer = "";
      let timer;
      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout?.removeAllListeners?.("data");
        try { child.stdout?.destroy?.(); } catch { /* 閉じ済み */ }
        try { child.unref?.(); } catch { /* 解放不要 */ }
        resolveOutcome(outcome);
      };
      timer = setTimeout(() => settle(UNKNOWN), startWaitMs);
      child.stdin?.on?.("error", () => {});
      child.stdout.setEncoding?.("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > MAX_LINE_CHARS) { settle(UNKNOWN); return; }
        const index = buffer.indexOf("\n");
        if (index >= 0) settle(parseWorkerLine(buffer.slice(0, index)));
      });
      child.stdout.on("end", () => settle(UNKNOWN));
      child.stdout.on("error", () => settle(UNKNOWN));
      child.on?.("error", () => settle(UNKNOWN));
      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
  }

  async function start(input, { project, workDir, instruction, client, bound }) {
    let settings;
    try { settings = await readSettings(project, client); }
    catch { return unavailable(["委任設定を確認できません。設定と管理された委任入口を確認してください"]); }
    const readOnly = input.readOnly;
    const policy = resolveRole(settings, input.role, { readOnly });
    if (!policy.ok) return unavailable([policy.error.reason]);
    const base = {
      requestId: input.requestId, project, cwd: workDir, role: input.role, instruction, skill: input.skill, taskId: input.taskId,
      access: policy.value.access, host: client, settings, native: { client, available: false },
      ...(readOnly ? { readOnly: true } : {}),
    };
    const { candidates, reasons: preReasons } = await eligibleCandidates(client, project, settings);
    const reasons = [...preReasons];
    // 書き込みは、候補の有無にかかわらず、同じ作業の先行記録を先に確かめる。終了未確認なら何も起動しない。
    if (policy.value.access !== "read-only") {
      const prior = await storeFor(project).inspectWork({ requestId: input.requestId, project, cwd: workDir, skill: input.skill, taskId: input.taskId })
        .catch(() => ({ kind: "blocked", reason: "依頼記録を確認できません。終了を確認するまで同じ作業を起動しません" }));
      if (prior.kind === "terminal") {
        const summary = typeof prior.result?.summary === "string" ? prior.result.summary : null;
        return summary === null ? unavailable(["既存の終端記録を検証できません。同じ書き込み作業は再起動しません"]) : { kind: "completed", result: summary };
      }
      if (prior.kind === "blocked") return unavailable([prior.reason]);
    }
    for (const candidate of candidates) {
      const outcome = await dispatch({ ...base, candidates: [candidate] });
      if (outcome.kind === "unavailable") { reasons.push(...outcome.reasons); continue; }
      if (outcome.kind === "blocked") return unavailable([...reasons, ...outcome.reasons]);
      if (outcome.kind === "started") return { kind: "pending", requestId: input.requestId, reason: START_REASON };
      if (outcome.kind === "terminal") return { kind: "completed", result: outcome.result.summary };
      if (outcome.kind === "pending") return { kind: "pending", requestId: outcome.requestId, reason: outcome.reason };
      return { kind: "pending", requestId: input.requestId, reason: UNKNOWN_REASON };
    }
    // 適格な外部候補が無いときだけネイティブへ移る。事前確認はこの経路でのみ発行する。
    const selection = selectDelegate({ settings, role: input.role, host: client, candidates: [], native: { client, available: true },
      options: readOnly ? { readOnly: true } : undefined });
    if (selection.kind !== "native") return unavailable([...reasons, ...selection.reasons]);
    const toolName = client === "claude" ? "Agent" : "spawn_agent";
    const toolInput = client === "claude" ? { subagent_type: selection.agentName } : { agent_type: selection.agentName, fork_turns: "none" };
    const issued = await bound.issueSelectedNative({ requestId: input.requestId, role: input.role, readOnly, toolName, toolInput });
    if (!issued?.ok) return unavailable([...reasons, issued?.error?.reason ?? "ネイティブ起動を確認できません"]);
    return { kind: "native", agentName: selection.agentName, toolName, toolInput, requestId: input.requestId,
      reason: "適格な外部候補がないため、ネイティブの役割定義を使います" };
  }

  /** 既存の依頼に対する状態確認・停止。新しいジョブは起動せず、依頼の所有者へ届ける。 */
  async function control(input, { project, workDir }) {
    const target = await resolveControlTarget({ store: storeFor(project), requestId: input.requestId, project, cwd: workDir, skill: input.skill, taskId: input.taskId });
    if (target.kind === "terminal") return { kind: "status", op: input.op, requestId: input.requestId, status: target.result.status, output: target.result.summary };
    if (target.kind === "unavailable") return unavailable([target.reason]);
    const response = await requestControl({ root: runtimeRootOf(project), requestId: input.requestId, generation: target.generation,
      controlDirectory: target.controlDirectory, kind: input.op, timeoutMs: controlTimeoutMs });
    if (response.kind === "unavailable") return unavailable([response.reason]);
    if (response.kind === "unknown") return { kind: "status", op: input.op, requestId: input.requestId, status: "unknown", reason: response.reason };
    return { kind: "status", op: input.op, requestId: input.requestId, status: response.status,
      ...(response.reason === undefined ? {} : { reason: response.reason }), ...(response.output === undefined ? {} : { output: response.output }) };
  }

  async function run(argv, processContext) {
    const input = parseDelegateArgs(argv);
    if (!input) return unavailable(["管理入口の引数が不正です"]);
    const project = await realpath(processContext?.cwd ?? "").catch(() => null);
    if (!project) return unavailable(["作業先を確認できません"]);
    const workDir = await realpath(resolve(project, input.workDir)).catch(() => null);
    if (!workDir || !inside(workDir, project)) return unavailable(["作業先が管理対象の作業範囲にありません"]);
    let instruction = null;
    if (input.op === "start") {
      instruction = await readInstruction(resolve(project, input.instructionFile)).catch(() => null);
      // ワーカーの入力は前後に空白を許さないため、指示は前後を整えてから渡す。
      instruction = typeof instruction === "string" ? instruction.trim() : "";
      if (instruction === "") return unavailable(["指示ファイルを読めないか、指示が空です"]);
    }
    const bound = await bind(input, project);
    if (!bound) return unavailable(["呼び出し参照を確認できません。参照が無い、消費済み、管理外、または偽装された文脈です"]);
    if (input.op === "start") return start(input, { project, workDir, instruction, client: bound.client, bound: bound.bound });
    return control(input, { project, workDir });
  }

  return Object.freeze({ run });
}

/** 本番の依存（クライアントごとの作業コンテキスト）を組み立て、一回分の入口を実行する。 */
export async function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  try {
    const project = await realpath(cwd);
    const contexts = [];
    for (const client of ["claude", "codex"]) contexts.push({ client, context: (await runtimeFor(client, project)).context });
    const runtimeBase = process.env.XDG_RUNTIME_DIR || (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "");
    return await createDelegate({ contexts, runtimeBase }).run(argv, { cwd: project });
  } catch {
    return unavailable(["管理入口を初期化できません"]);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
