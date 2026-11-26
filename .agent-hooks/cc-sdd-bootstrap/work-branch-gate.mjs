// 作業前のブランチ確保のフックの入口。標準入力の JSON・設定・git・状態を扱い、判定は work-branch-gate-rules.mjs に任せる。
// 失敗はすべて標準エラーに 1 行で書き、出力せず終了コード 0 で通す（作業を止めない）。
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configFields } from "./config-schema.mjs";
import {
  classifyPrompt,
  classifyToolCall,
  decidePreToolUse,
  isBaseBranch,
  messageGuidance,
  parseBaseBranches,
  workDirOf,
} from "./work-branch-gate-rules.mjs";

// 配置先は .agent-hooks/cc-sdd-bootstrap/ なので、2 つ上が導入先の根
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_FILE = path.join(root, ".cc-sdd-bootstrap.json");
const GIT_TIMEOUT_MS = 3000;

/** 引数（イベントと作業ツール）を検査する */
function argumentsOf(argv) {
  const event = argv[0];
  const toolIndex = argv.indexOf("--tool");
  const tool = toolIndex >= 0 ? argv[toolIndex + 1] : null;
  if (!new Set(["user-prompt-submit", "pre-tool-use"]).has(event)) {
    throw new Error("フックの種類を判定できません。");
  }
  if (tool !== "claude" && tool !== "codex") throw new Error("作業ツールを判定できません。");
  return { event, tool };
}

/** 標準入力の JSON を読む。session_id が無い入力は判定できないので失敗にする */
async function readInput() {
  let raw = "";
  for await (const part of process.stdin) raw += part;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("入力の JSON を読み取れません。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("入力の JSON を読み取れません。");
  if (typeof value.session_id !== "string" || !value.session_id) throw new Error("session_id がありません。");
  return value;
}

/**
 * 設定の workflow を取り出す。項目が無ければ空（既定値を使う）。
 * オブジェクト以外（null・配列・文字列・数値）は項目の形が不正なので失敗にする（要件 1.6 により通す）。
 */
function workflowOf(config) {
  if (!Object.hasOwn(config, "workflow")) return {};
  const workflow = config.workflow;
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new Error("設定の項目 workflow が不正です: オブジェクトで指定してください");
  }
  return workflow;
}

/** 項目の値を取り出す。書かれていなければ既定値、不正なら失敗にする（通す） */
function settingOf(workflow, key) {
  const dotted = `workflow.${key}`;
  const field = configFields.find((item) => item.path === dotted);
  if (!field) throw new Error(`設定の項目 ${dotted} を定義できません。`);
  const value = workflow[key];
  if (value === undefined) return field.defaultValue;
  const problem = field.validate(value);
  if (problem !== null) throw new Error(`設定の項目 ${dotted} が不正です: ${problem}`);
  return value;
}

/**
 * 設定ファイルを読む。ファイルが無ければ既定値（有効）、読めない・JSON が不正なら失敗にする。
 * @returns {Promise<{ branchGate: boolean, bases: string[] }>}
 */
async function readSettings() {
  let config = {};
  let raw = null;
  try {
    raw = await fs.readFile(CONFIG_FILE, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("設定ファイルを読めません。");
  }
  if (raw !== null) {
    try {
      config = JSON.parse(raw);
    } catch {
      throw new Error("設定ファイルを読めません。JSON の形を確かめてください。");
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("設定ファイルを読めません。");
  }
  const workflow = workflowOf(config);
  return {
    branchGate: settingOf(workflow, "branchGate"),
    bases: parseBaseBranches(settingOf(workflow, "baseBranches")),
  };
}

/** 作業の状態の置き場所。OS の一時ディレクトリの下で、根とセッションの組ごとに分ける（リポジトリの中には作らない） */
function stateFile(sessionId) {
  const key = createHash("sha256").update(`${root}\0${sessionId}`).digest("hex");
  return path.join(os.tmpdir(), "cc-sdd-bootstrap-work-branch", `${key}.json`);
}

function emptyState() {
  return { turn: null, validated: null, location: null };
}

/** 状態の形を確かめる。turn の形が違えば失敗にする */
function isState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const turn = value.turn;
  if (turn === null) return true;
  return typeof turn === "object" && !Array.isArray(turn)
    && typeof turn.skill === "string" && turn.skill !== ""
    && Number.isInteger(turn.denials) && turn.denials >= 0
    && typeof turn.switchTried === "boolean"
    && (value.location === undefined || value.location === null || typeof value.location === "string");
}

async function loadState(file) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw new Error("状態ファイルを読めません。");
  }
  if (!isState(value)) throw new Error("状態ファイルの形が正しくありません。");
  // 作業場所を持たない古い形の状態は、場所なしとして扱う
  return { ...value, location: value.location ?? null };
}

/** 一時ファイルに書いてから置き換える（途中で壊れた状態を残さない） */
async function saveState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    throw new Error(`状態ファイルを保存できません: ${error.message}`);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** 判定に使う作業場所。入力の cwd が無ければ、フックを動かした場所 */
function cwdOf(input) {
  return typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
}

/**
 * git を引数の配列で起動する（シェルを経由しない）。失敗・timeout は null。
 * @returns {string | null} 標準出力の末尾の空白を除いた値
 */
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

/** 現在のブランチ。ブランチなし（detached HEAD）は空文字、判定できなければ null */
function currentBranch(cwd) {
  return git(cwd, ["branch", "--show-current"]);
}

/**
 * 候補の場所を順に試し、最初に現在のブランチを求められた場所とブランチを返す（3.13）。
 * 存在しない場所・git の外（git が失敗）は次の候補へ進む。候補が全部だめなら null。
 * @param {Array<string | null | undefined>} candidates - 作業場所の候補（優先順）
 * @returns {{ branch: string, cwd: string } | null}
 */
function branchAt(candidates) {
  for (const dir of candidates) {
    if (typeof dir !== "string" || dir === "") continue;
    const branch = currentBranch(dir);
    if (branch !== null) return { branch, cwd: dir };
  }
  return null;
}

/** origin の既定ブランチ名。無ければ null */
function originDefaultOf(cwd) {
  const name = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (name === null) return null;
  return name.startsWith("origin/") ? name.slice("origin/".length) : null;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** 対象の入力を受けたときに作業の状態を作り、基底ブランチなら案内を追加の文脈で返す */
async function userPromptSubmit(input, settings) {
  const target = classifyPrompt(input.prompt);
  if (!target) return;
  const file = stateFile(input.session_id);
  const state = await loadState(file);
  state.turn = { skill: target.skill, denials: 0, switchTried: false };
  await saveState(file, state);

  // 操作の入力が無いので、直近の作業場所（location）→ 入力の cwd の順に判定する
  const found = branchAt([state.location, cwdOf(input)]);
  if (found === null || !isBaseBranch(found.branch, settings.bases, originDefaultOf(found.cwd))) return;
  output({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: messageGuidance(target.skill, found.branch) } });
}

/**
 * 操作の前の処理。作業の操作で作業場所を求められたら、状態の location に記録する（turn が無くても記録する。読み取りでは記録しない）。
 * 作業の状態があるときだけ判断し、拒否なら理由を返す。拒否の回数と作業場所は保存してから返す。
 */
async function preToolUse(input, settings, tool) {
  if (typeof input.tool_name !== "string" || !input.tool_name.trim()) throw new Error("ツール名を判定できません。");
  if (!input.tool_input || typeof input.tool_input !== "object" || Array.isArray(input.tool_input)) {
    throw new Error("ツールへの入力を判定できません。");
  }
  const file = stateFile(input.session_id);
  const state = await loadState(file);

  const call = { toolName: input.tool_name, toolInput: input.tool_input };
  const cwd = cwdOf(input);
  // 作業の操作だけ作業場所を求め、ブランチを調べる（読み取りや切り替えは判定に使わない）
  const kind = classifyToolCall(call.toolName, call.toolInput);
  const dir = kind === "work" ? workDirOf(tool, call.toolName, call.toolInput, cwd) : null;
  const previous = state.location;
  let changed = false;
  if (dir !== null && dir !== previous) {
    state.location = dir;
    changed = true;
  }

  if (state.turn !== null) {
    // 候補: ① この操作の作業場所 ② 直近の作業場所 ③ 入力の cwd
    const found = kind === "work" ? branchAt([dir, previous, cwd]) : null;
    const facts = {
      branch: found === null ? null : found.branch,
      bases: settings.bases,
      originDefault: found === null ? null : originDefaultOf(found.cwd),
    };
    const decision = decidePreToolUse(state.turn, call, facts);
    if (JSON.stringify(decision.turn) !== JSON.stringify(state.turn)) {
      state.turn = decision.turn;
      changed = true;
    }
    if (changed) await saveState(file, state);
    if (!decision.allow) {
      output({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason } });
    }
    return;
  }
  if (changed) await saveState(file, state);
}

async function run() {
  const { event, tool } = argumentsOf(process.argv.slice(2));
  const input = await readInput();
  const settings = await readSettings();
  if (!settings.branchGate) return;
  if (event === "user-prompt-submit") {
    await userPromptSubmit(input, settings);
  } else {
    await preToolUse(input, settings, tool);
  }
}

run().catch((error) => {
  const detail = error.message || "詳細のないエラーです。";
  process.stderr.write(`work-branch-gate: フックの処理に失敗しました。詳細: ${detail}\n`);
  process.exitCode = 0;
});
