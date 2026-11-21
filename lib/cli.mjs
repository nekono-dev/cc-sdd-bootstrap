// コマンドの処理の本体。引数の解析と使い方の表示を持つ。
// （操作の実行・対話・出力の整形は後のタスクで同じファイルに足していく）
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { configFields } from "./config-schema.mjs";
import { catalog, CONFIG_PATH, DEPLOY_DIR, LEDGER_PATH } from "./catalog.mjs";
import { generateNativeAgentDefinitions } from "../.agent-hooks/cc-sdd-bootstrap/native-agent-definitions.mjs";
import { parseConfig, validateConfig, findUnknownKeys, fillDefaults, resolveValues } from "./config.mjs";
import { parseLedger, sha256 } from "./ledger.mjs";
import { makePlan, isNativeAgentPath } from "./plan.mjs";
import { isGitRoot, readSnapshot, readPackageFiles, readConfigState, readPackageVersion, applyPlan, allIgnoreLines } from "./target.mjs";
import path from "node:path";
import { applyDelegationOrder } from "./delegation-setup.mjs";
import { buildDelegationSetup } from "./delegation-setup.mjs";
import { listRegistrations as registryListRegistrations } from "../.agent-hooks/cc-sdd-bootstrap/delegation-registry.mjs";
import { readTransport as registryReadTransport } from "../.agent-hooks/cc-sdd-bootstrap/delegation-registry.mjs";
import { connectStdioRegistration, createCodexAdapter, createPiAdapter } from "../.agent-hooks/cc-sdd-bootstrap/delegation-mcp.mjs";
import { validateDelegation } from "../.agent-hooks/cc-sdd-bootstrap/config-schema.mjs";
import { planCodexMcpRegistration } from "./delegation-registration.mjs";

/** @typedef {import("./config-schema.mjs").ConfigField} ConfigField */
/** @typedef {import("./config-schema.mjs").ConfigValue} ConfigValue */

/**
 * 引数の解析結果。
 * @typedef {{ kind: "help" }
 *   | { kind: "usage-error", message: string }
 *   | { kind: "run", operation: "init" | "update" | "uninstall", given: Record<string, ConfigValue>, force: boolean, delegationOrder: string[] }} ParsedArgs
 */

const OPERATIONS = ["init", "update", "uninstall"];
/** 設定の指定を受け付ける操作 */
const CONFIG_OPERATIONS = ["init", "update"];
/** 対応の役割名として使えない名前（オブジェクトの土台を書き換えられないように） */
const FORBIDDEN_ROLES = ["__proto__", "constructor", "prototype"];

/**
 * 使い方の文章を設定の定義から作る。
 * @param {ConfigField[]} [fields]
 * @returns {string}
 */
export function buildUsage(fields = configFields) {
  const lines = [
    "使い方: cc-sdd-bootstrap <操作> [オプション]",
    "",
    "操作:",
    "  init        cc-sdd の運用一式をこのリポジトリへ導入する",
    "  update      導入済みの一式を最新にする",
    "  uninstall   導入した一式を取り除く",
    "",
    "オプション（3 つの操作すべて）:",
    "  --force     内容の違う同名のファイルがあっても置き換える",
    "  -h, --help  この使い方を表示する",
    "",
    "設定のオプション（init と update だけ）:",
  ];
  lines.push("  --delegation-order <host>:<local|cloud>=<候補キー,...>");
  lines.push("      委任候補の順序を明示する。候補キーは登録 ID または 登録名:登録 ID。値を空にすると順序を空にする");
  for (const f of fields) {
    lines.push(`  ${flagSyntax(f)}`);
    lines.push(`      ${f.question}（既定値: ${describeDefault(f)}）`);
  }
  const declaredFlags = new Set(fields.map((f) => f.flag));
  if (declaredFlags.has("clients") && declaredFlags.has("codex")) {
    lines.push("  --clients は導入対象、--codex は Claude Code から Codex への MCP 委任の指定です。");
  }
  return lines.join("\n") + "\n";
}

const pathList = (items) => items.length ? items.map((item) => `  ${item.path}${item.note === "restored" ? "（作り直した）" : item.note === "overwritten" ? "（上書きした）" : item.note === "permission-restored" ? "（実行権限を戻した）" : ""}`).join("\n") : "  なし";
export function formatSuccess({ operation, plan, defaulted = [], filled = [], unknown = [], config = null, agentsOverrideExists = false }) {
  const lines = plan.changes.length ? [`${operation} が完了しました。`, "作成", pathList(plan.changes.filter((c) => c.action === "write" && !c.existed)), "更新", pathList(plan.changes.filter((c) => c.action === "write" && c.existed)), "削除", pathList(plan.changes.filter((c) => c.action === "delete"))] : ["変更はありません。"];
  const valueAt = (key) => key.split(".").reduce((v, k) => v?.[k], config);
  if (operation === "init" || operation === "update") {
    lines.push(`導入対象: ${valueAt("clients") ?? "不明"}`);
    if (valueAt("clients") === "codex" || valueAt("clients") === "both") {
      lines.push("Codex で使うにはプロジェクトを信頼し、/hooks で登録を確認して承認してください。");
      if (agentsOverrideExists) lines.push("AGENTS.override.md があるため既存の上書き指示を尊重します。Codex で導入手順を確認するときは AGENTS.md の cc-sdd-bootstrap 管理区画を参照してください。");
    }
  }
  for (const [label, keys] of [["既定値を使った項目", defaulted], ["補った項目", filled]]) if (keys.length) lines.push(`${label}:`, ...keys.map((key) => `  ${key}: ${JSON.stringify(valueAt(key))}`));
  if (unknown.length) lines.push("警告: 設定に知らない項目があります。", ...unknown.map((key) => `  ${key}`));
  // 計画の注記に続けて、値が真の項目のお知らせ（init・update のとき）を示す
  const notices = [...plan.notices, ...((operation === "init" || operation === "update") ? configFields.filter((f) => f.notice && valueAt(f.path) === true).map((f) => f.notice) : [])];
  if (notices.length) lines.push("お知らせ:", ...notices.map((n) => `  ${n}`));
  if (operation === "init") lines.push("設定ファイルと配置したファイルをコミットしてください。", "cc-sdd 本体は次の Claude Code セッションの開始時に導入されます。", "版を固定するには npx github:nekono-dev/cc-sdd-bootstrap#<タグ> を使えます。");
  return lines.join("\n") + "\n";
}
export function formatAbort(blocks, operation, sourceCatalog = catalog) {
  return blocks.map((b) => {
    if (b.kind === "modified") {
      const deletes = operation === "uninstall" || !sourceCatalog.files.some((file) => file.path === b.path);
      return `書き換えられたファイル: ${b.path}${b.detail && b.detail !== b.path ? `（${b.detail}）` : ""}\n--force を付けて再実行すると${deletes ? "削除" : "上書き"}します。`;
    }
    if (b.kind === "markers") return `${b.detail}\n${b.path} の目印の行を直してから再実行してください。`;
    return `${b.detail}\n${b.path} が読めません。内容を直してから再実行してください。`;
  }).join("\n") + "\n";
}
export function formatConfigError(error) {
  const prefix = error.code === "CONFIG_UNREADABLE" ? `${CONFIG_PATH} を JSON として読めません。` : `${CONFIG_PATH} に問題があります。`;
  const reasons = error.messages.map((message) => `  ${message.replace(/^設定ファイル:\s*/, "")}`).join("\n");
  return `${prefix}\n${reasons}\nファイルを直してから再実行してください。\n`;
}
export function formatApplyFailure(result, operation = "init", configExisted = false) {
  const retry = operation === "uninstall" ? "uninstall" :
    configExisted || result.done.some((change) => change.path === CONFIG_PATH) ? "update" : "init";
  return [
    `済んだもの:\n${pathList(result.done)}`,
    `失敗したもの: ${result.failed.change.path}（${result.failed.message}）`,
    `未処理のもの:\n${pathList(result.pending)}`,
    `失敗した道筋の権限またはファイルの種類を確認して直してください（例: ディレクトリが必要な場所に通常ファイルがある場合）。`,
    `直したあと、${retry} をもう一度実行してください。`,
  ].join("\n") + "\n";
}
export function formatReadFailure(error) {
  const pathHint = error && typeof error === "object" && error.path ? `（${error.path}）` : "";
  const reason = error instanceof Error ? error.message : String(error);
  return `処理を続けられませんでした${pathHint}: ${reason}\n確認して直してから、同じ操作をもう一度実行してください\n`;
}

/** @param {ConfigField} f */
function flagSyntax(f) {
  if (f.kind === "boolean") return `--${f.flag} yes|no`;
  if (f.kind === "map") return `--${f.flag} <役割>=<モデル>（繰り返し指定できる）`;
  if (f.kind === "enum" && f.choices) return `--${f.flag} <${f.choices.join("|")}>`;
  return `--${f.flag} <値>`;
}

/** @param {ConfigField} f */
function describeDefault(f) {
  if (f.kind === "boolean") return f.defaultValue ? "yes" : "no";
  if (f.kind === "map") {
    const entries = Object.entries(/** @type {Record<string, string>} */ (f.defaultValue));
    return entries.length === 0 ? "なし" : entries.map(([k, v]) => `${k}=${v}`).join(", ");
  }
  return String(f.defaultValue);
}

/**
 * 引数を解析する。
 * @param {string[]} argv
 * @param {ConfigField[]} fields
 * @returns {ParsedArgs}
 */
export function parseCliArgs(argv, fields) {
  const endIdx = argv.indexOf("--");
  const head = endIdx === -1 ? argv : argv.slice(0, endIdx);
  if (head.includes("--help") || head.includes("-h")) return { kind: "help" };

  /** @type {Record<string, any>} */
  const options = { help: { type: "boolean", short: "h" }, force: { type: "boolean" }, "delegation-order": { type: "string", multiple: true } };
  for (const f of fields) {
    options[f.flag] = f.kind === "map" ? { type: "string", multiple: true } : { type: "string" };
  }

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, strict: true, allowPositionals: true });
  } catch (err) {
    return { kind: "usage-error", message: describeParseError(err) };
  }

  const { values, positionals } = parsed;
  if (positionals.length === 0) return { kind: "help" };
  const operation = positionals[0];
  if (!OPERATIONS.includes(operation)) {
    return { kind: "usage-error", message: `未知の操作です: ${operation}（init・update・uninstall のどれかを指定してください）` };
  }
  if (positionals.length > 1) {
    return { kind: "usage-error", message: `余分な引数があります: ${positionals.slice(1).join(" ")}` };
  }
  if (values["delegation-order"] !== undefined && !CONFIG_OPERATIONS.includes(operation)) {
    return { kind: "usage-error", message: `--delegation-order は init と update だけで指定できます` };
  }
  const delegationOrder = values["delegation-order"] ?? [];
  for (const value of delegationOrder) {
    if (typeof value !== "string" || !/^[a-z][a-z0-9_-]*:(?:local|cloud)=.*$/.test(value)) {
      return { kind: "usage-error", message: `--delegation-order は host:local|cloud=登録ID,... の形で指定してください（指定された値: ${value}）` };
    }
    const ids = value.slice(value.indexOf("=") + 1);
    if (ids && (ids.split(",").some((id) => !id) || new Set(ids.split(",")).size !== ids.split(",").length)) {
      return { kind: "usage-error", message: `--delegation-order の登録IDは空・重複にできません（指定された値: ${value}）` };
    }
  }

  /** @type {Record<string, ConfigValue>} */
  const given = {};
  for (const f of fields) {
    const raw = values[f.flag];
    if (raw === undefined) continue;
    if (!CONFIG_OPERATIONS.includes(operation)) {
      return { kind: "usage-error", message: `--${f.flag} は ${operation} では指定できません（init と update だけで指定できます）` };
    }
    if (f.kind === "boolean") {
      const b = parseBool(/** @type {string} */ (raw));
      if (b === null) {
        return { kind: "usage-error", message: `--${f.flag} には yes・no・true・false のどれかを指定してください（指定された値: ${raw}）` };
      }
      given[f.path] = b;
    } else if (f.kind === "map") {
      const map = parseMapEntries(f.flag, /** @type {string[]} */ (raw));
      if (typeof map === "string") return { kind: "usage-error", message: map };
      given[f.path] = map;
    } else {
      given[f.path] = /** @type {string} */ (raw);
    }
  }
  return { kind: "run", operation: /** @type {any} */ (operation), given, force: Boolean(values.force), delegationOrder };
}

/**
 * yes/no/true/false（大文字小文字は区別しない）を真偽にする。
 * @param {string} s
 * @returns {boolean | null}
 */
function parseBool(s) {
  const v = s.toLowerCase();
  if (v === "yes" || v === "true") return true;
  if (v === "no" || v === "false") return false;
  return null;
}

/**
 * 対話の真偽の答え（y・n も受け付ける）を真偽にする。解釈できなければ undefined。
 * @param {string} s
 * @returns {boolean | undefined}
 */
function parseAnswerBool(s) {
  const v = s.toLowerCase();
  if (v === "y") return true;
  if (v === "n") return false;
  return parseBool(s) ?? undefined;
}

/**
 * 「役割=モデル」の繰り返しを対応にする。誤りなら日本語の理由の文字列を返す。
 * @param {string} flag
 * @param {string[]} entries
 * @returns {Record<string, string> | string}
 */
function parseMapEntries(flag, entries) {
  /** @type {Record<string, string>} */
  const map = Object.create(null);
  for (const entry of entries) {
    const i = entry.indexOf("=");
    if (i === -1) return `--${flag} は「役割=モデル」の形で指定してください（指定された値: ${entry}）`;
    const role = entry.slice(0, i);
    const model = entry.slice(i + 1);
    if (role === "" || model === "") {
      return `--${flag} は役割もモデルも空にできません（指定された値: ${entry}）`;
    }
    if (FORBIDDEN_ROLES.includes(role)) return `--${flag} の役割名に ${role} は使えません`;
    map[role] = model;
  }
  return { ...map };
}

/** 表示した候補キーを使うモデル指定を、段内順序と同じキーで対応付ける。 */
export function parseDelegationModels(input) {
  const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isObject(input) || Object.keys(input).some((key) => !["line", "candidates"].includes(key)) ||
      typeof input.line !== "string" || !Array.isArray(input.candidates) || input.candidates.some((item) => !isObject(item) ||
        Object.keys(item).some((key) => !["registrationName", "registrationId", "host", "tier", "family", "scope", "models"].includes(key)) ||
        typeof item.registrationName !== "string" || !item.registrationName.trim() || typeof item.registrationId !== "string" || !item.registrationId.trim())) {
    return { ok: false, reason: "モデル指定の形式が不正です" };
  }
  const models = {};
  if (!input.line.trim()) return { ok: true, models };
  // 登録 ID だけの指定は、同じ ID の候補が一つしか無いときだけ受け付ける。
  // 結果のキーは常に「登録名:登録 ID」の正式キーにし、段内順序のキーと一致させる。
  const idCount = new Map();
  for (const item of input.candidates) idCount.set(item.registrationId, (idCount.get(item.registrationId) ?? 0) + 1);
  const candidateKeys = input.candidates.flatMap((item) => {
    const canonical = `${item.registrationName}:${item.registrationId}`;
    return [
      { key: canonical, canonical },
      ...(idCount.get(item.registrationId) === 1 ? [{ key: item.registrationId, canonical }] : []),
    ];
  }).sort((a, b) => b.key.length - a.key.length);
  for (const raw of input.line.split(";")) {
    const entry = raw.trim();
    const candidate = candidateKeys.find(({ key }) => entry.startsWith(`${key}:`));
    const match = candidate && entry.slice(candidate.key.length + 1).match(/^([a-z][a-z0-9_-]*)(=|~)(.+)$/);
    if (!match || !match[3].trim()) return { ok: false, reason: "モデル指定の形式が不正です" };
    models[candidate.canonical] ??= {};
    if (Object.hasOwn(models[candidate.canonical], match[1])) return { ok: false, reason: "同じ役割に固定モデルと互換モデルを重ねて指定できません" };
    const modelValue = match[3].trim();
    if (match[2] === "~" && modelValue.split(",").some((id) => !id.trim())) return { ok: false, reason: "モデル指定の形式が不正です" };
    models[candidate.canonical][match[1]] = match[2] === "=" ? { fixed: modelValue } : { compatibleIds: modelValue.split(",").map((id) => id.trim()) };
  }
  return { ok: true, models };
}

/** 探査の候補の状態を、利用者に示す日本語の表示名にする。内部の状態名は出さない。 */
function describeDelegationStatus(item) {
  if (item.status === "removal-planned") return "削除予定";
  if (item.status === "planned") return "追加予定";
  if (item.status === "pending") return "承認待ち";
  if (item.status === "disabled") return "無効";
  if (item.status === "unknown") return "利用不可";
  return `${item.tier === "local" ? "ローカル" : "クラウド"}・${item.family}`;
}

/** 入力された候補キー（登録 ID だけ・登録名:登録 ID）を、表示と同じ「登録名:登録 ID」へ揃える。曖昧・不明なら入力のまま返す。 */
function canonicalCandidateKey(entry, candidates) {
  const exact = candidates.find((item) => entry === `${item.registrationName}:${item.registrationId}`);
  if (exact) return `${exact.registrationName}:${exact.registrationId}`;
  const sameId = candidates.filter((item) => item.registrationId === entry);
  return sameId.length === 1 ? `${sameId[0].registrationName}:${sameId[0].registrationId}` : entry;
}

/** 探査の候補と保存済みの候補を、登録名・登録 ID・scope の組で重複を除いて合わせる。探査の値を優先する。 */
function mergeDelegationCandidates(probed, saved) {
  const merged = new Map();
  for (const item of [...probed, ...saved]) {
    const identity = JSON.stringify([item.scope, item.registrationName, item.registrationId]);
    if (!merged.has(identity)) merged.set(identity, item);
  }
  return [...merged.values()];
}

/**
 * parseArgs の例外を日本語の理由にする。
 * @param {any} err
 * @returns {string}
 */
function describeParseError(err) {
  const msg = String(err && err.message);
  switch (err && err.code) {
    case "ERR_PARSE_ARGS_UNKNOWN_OPTION": {
      const m = msg.match(/Unknown option '([^']+)'/);
      return `未知のオプションです: ${m ? m[1] : msg}`;
    }
    case "ERR_PARSE_ARGS_INVALID_OPTION_VALUE": {
      const m = msg.match(/Option '([^']+)/);
      return `オプションに値が必要です: ${m ? m[1].replace(/ <value>$/, "") : msg}`;
    }
    default:
      return `引数を解釈できません: ${msg}`;
  }
}

/**
 * 対話に使う入出力。
 * @typedef {object} CliIo
 * @property {NodeJS.ReadableStream} stdin
 * @property {{ write(s: string): unknown }} stdout
 * @property {{ write(s: string): unknown }} stderr
 * @property {boolean} interactive 入力と出力の両方が端末か
 */

/**
 * 設定の道筋（"a.b"）で入れ子の値を取り出す。無ければ undefined。
 * @param {any} obj
 * @param {string} path
 */
function lookup(obj, path) {
  let cur = obj;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * 対話で項目を尋ね、答えを道筋ごとにまとめて返す（端末かどうかは呼び出し側が決める）。
 * 引数で渡された項目（given にある道筋）は尋ねない。既定値は既存の設定（base）を優先する。
 * @param {CliIo} io
 * @param {ConfigField[]} fields
 * @param {Record<string, any>} base 既存の設定
 * @param {Record<string, ConfigValue>} given 引数で渡された値
 * @returns {Promise<Record<string, ConfigValue>>}
 */
export async function promptValues(io, fields, base, given) {
  const rl = createInterface({ input: io.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  /** 1 行読む。入力が尽きたら null */
  const readLine = async () => {
    const r = await lines.next();
    return r.done ? null : String(r.value).trim();
  };
  /**
   * 1 つの値を、正しくなるまで尋ねる。
   * @param {string} label
   * @param {string} shown 既定値の表示
   * @param {(input: string) => unknown} convert 空でない入力を値にする（変換できなければ undefined）
   * @param {unknown} dflt
   * @param {(v: unknown) => string | null} check
   * @param {string} badForm 変換できないときの理由
   */
  const ask = async (label, shown, convert, dflt, check, badForm) => {
    for (;;) {
      io.stdout.write(`${label} [${shown}]: `);
      const input = await readLine();
      io.stdout.write("\n");
      const eof = input === null;
      let value = dflt;
      if (!eof && input !== "") {
        value = convert(input);
        if (value === undefined) {
          io.stdout.write(`${badForm}\n`);
          continue;
        }
      }
      const reason = check(value);
      if (reason === null) return value;
      if (eof) {
        throw new Error(`入力が終わりました。「${label}」の既定値が正しくないため決められません: ${reason}`);
      }
      io.stdout.write(`${reason}\n`);
    }
  };

  /** @type {Record<string, ConfigValue>} */
  const out = {};
  try {
    for (const f of fields) {
      if (Object.hasOwn(given, f.path)) continue;
      const existing = lookup(base, f.path);
      if (f.kind === "map") {
        const keys = f.mapKeys ?? [];
        if (keys.length === 0) continue;
        const baseMap = existing && typeof existing === "object" ? existing : {};
        const defMap = /** @type {Record<string, string>} */ (f.defaultValue);
        /** @type {Record<string, string>} */
        const map = {};
        for (const key of keys) {
          const dflt = Object.hasOwn(baseMap, key) ? baseMap[key] : Object.hasOwn(defMap, key) ? defMap[key] : "";
          map[key] = /** @type {string} */ (await ask(
            `${f.question}: ${key}`, dflt, (s) => s, dflt,
            (v) => f.validate({ [key]: v }), "",
          ));
        }
        out[f.path] = map;
      } else if (f.kind === "boolean") {
        const dflt = typeof existing === "boolean" ? existing : Boolean(f.defaultValue);
        out[f.path] = /** @type {boolean} */ (await ask(
          f.question, dflt ? "yes" : "no", parseAnswerBool, dflt, (v) => f.validate(v),
          "yes・no・true・false のどれかで答えてください",
        ));
      } else {
        const dflt = typeof existing === "string" ? existing : String(f.defaultValue);
        out[f.path] = /** @type {string} */ (await ask(
          f.question, dflt, (s) => s, dflt, (v) => f.validate(v), "",
        ));
      }
    }
  } finally {
    rl.close();
  }
  return out;
}

/**
 * コマンドの処理。終了コードを返す。
 * @param {string[]} argv
 * @param {{ stdout: { write(s: string): unknown }, stderr: { write(s: string): unknown } }} io
 * @returns {Promise<number>}
 */
export async function runCli(argv, io) {
  const parsed = parseCliArgs(argv, configFields);
  if (parsed.kind === "help") {
    io.stdout.write(buildUsage(configFields));
    return 0;
  }
  if (parsed.kind === "usage-error") {
    io.stderr.write(`${parsed.message}\n\n${buildUsage(configFields)}`);
    return 2;
  }
  try {
    return await runOperation(parsed, io);
  } catch (error) {
    io.stderr.write(formatReadFailure(error));
    return 1;
  }
}

/** 操作の結果を短い日本語で知らせる。後から出力を整えやすいよう種類ごとに分ける。 */
function writeOperationMessage(io, kind, message) {
  (kind === "error" ? io.stderr : io.stdout).write(`${message}\n`);
}

/** git ルート確認から計画の適用までを行う。 */
async function runOperation(parsed, io) {
  const { operation, given, force, delegationOrder = [] } = parsed;
  const root = io.cwd ?? process.cwd();
  if (!isGitRoot(root)) {
    writeOperationMessage(io, "error", "git リポジトリの最上位で実行してください。");
    return 1;
  }
  const configState = readConfigState(root);
  const configExists = configState.kind !== "missing";
  if (operation === "init" && configExists) {
    writeOperationMessage(io, "info", "すでに導入されています。更新には update を使ってください。");
    return 0;
  }
  if (operation !== "init" && !configExists) {
    writeOperationMessage(io, "error", `まだ導入されていません。先に init を実行してください。`);
    return 1;
  }
  if (operation !== "init" && configState.kind !== "file") {
    writeOperationMessage(io, "error", `設定ファイル ${CONFIG_PATH} が読めません。ファイルに直してから再実行してください。`);
    return 1;
  }

  const ledgerOnlySnapshot = readSnapshot(root, [CONFIG_PATH, LEDGER_PATH], allIgnoreLines(catalog.gitignore));
  const ledger = parseLedger(ledgerOnlySnapshot.ledger);
  let selectedDefinitions = [];
  let selectedClients = [];
  const catalogPaths = catalog.files.map((file) => file.path);
  const recordedPaths = Object.keys(ledger?.files ?? {}).filter((entry) =>
    (entry.startsWith(`${DEPLOY_DIR}/`) || isNativeAgentPath(entry)) && !entry.split(/[\\/]/).some((part) => part === ".." || part === "."),
  );
  let config = null;
  let filled = [];
  let unknown = [];
  let defaulted = [];
  if (operation !== "uninstall") {
    let base = null;
    let prompted = {};
    if (operation === "update") {
      const parsedConfig = parseConfig(ledgerOnlySnapshot.config);
      if (!parsedConfig.ok) {
        io.stderr.write(formatConfigError(parsedConfig.error));
        return 1;
      }
      const validation = validateConfig(parsedConfig.config, configFields);
      if (validation) {
        io.stderr.write(formatConfigError(validation));
        return 1;
      }
      unknown = findUnknownKeys(parsedConfig.config, configFields);
      const defaults = fillDefaults(parsedConfig.config, configFields);
      base = defaults.config;
      filled = defaults.filled;
    } else if (io.interactive) {
      try {
        prompted = await promptValues(io, configFields, {}, given);
      } catch (error) {
        writeOperationMessage(io, "error", error instanceof Error ? error.message : String(error));
        return 1;
      }
    }
    const resolved = resolveValues({ base, given, prompted, fields: configFields });
    const validation = validateConfig(resolved.config, configFields);
    if (validation) {
      io.stderr.write(formatConfigError(validation));
      return 1;
    }
    config = resolved.config;
    // 実際の登録を読み取り、能力確認済み候補だけを設定画面へ渡す。
    const registry = io.listRegistrations ?? registryListRegistrations;
    const hosts = config.clients === "both" ? ["claude", "codex"] : [config.clients];
    const registrations = [];
    for (const host of hosts) {
      const rows = await registry(host, { cwd: root });
      for (const row of rows) registrations.push({ host, name: row.name, scope: row.scope, registrationId: row.registrationId, status: row.status, reason: row.reason });
    }
    const ownedHashes = ledger?.registrations?.codexMcp?.allowedHashes ?? (ledger?.registrations?.codexMcp?.sha256 ? [ledger.registrations.codexMcp.sha256] : []);
    const registrationSnapshot = readSnapshot(root, [".mcp.json"], allIgnoreLines(catalog.gitignore));
    let managedRegistrationId = null;
    try {
      const parsed = JSON.parse(registrationSnapshot.mcpJson);
      const entry = parsed?.mcpServers?.["cc-sdd-codex"];
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
        if (ownedHashes.includes(sha256(Buffer.from(JSON.stringify(canonical(entry)))))) managedRegistrationId = registrations.find((item) => item.host === "claude" && item.scope === "project" && item.name === "cc-sdd-codex")?.registrationId ?? null;
      }
    } catch { /* 壊れた設定は管理対象として扱わない */ }
    const registrationPlan = planCodexMcpRegistration({ enabled: (config.clients === "claude" || config.clients === "both") && config.codex?.enabled === true,
      currentText: registrationSnapshot.mcpJson ?? null, ownedHash: ledger?.registrations?.codexMcp?.sha256,
      ownedHashes: ledger?.registrations?.codexMcp?.allowedHashes });
    const planned = (config.clients === "claude" || config.clients === "both") && config.codex?.enabled === true &&
      registrationPlan.changes.some((change) => change.path === ".mcp.json" && change.action === "write") && registrationPlan.blocks.length === 0
      ? [{ host: "claude", name: "cc-sdd-codex" }] : [];
    const removing = !(config.clients === "claude" || config.clients === "both") || config.codex?.enabled !== true
        ? (registrationPlan.changes.some((change) => change.path === ".mcp.json") && registrationPlan.blocks.length === 0
        ? [{ host: "claude", name: "cc-sdd-codex" }] : []) : [];
    const verified = {};
    const verifyRegistration = io.verifyRegistration ?? (async (row, options) => {
      if (!(row.host === "claude" && ["project", "user"].includes(row.scope)) && !(row.host === "codex" && ["project", "user"].includes(row.scope))) return null;
      const registryInput = { host: row.host, name: row.name, scope: row.scope, registrationId: row.registrationId, status: row.status };
      const connection = await connectStdioRegistration({ registration: registryInput, saved: { family: "pending", scope: row.scope, registrationName: row.name, registrationId: row.registrationId }, verifiedFamily: "pending",
        readTransport: (registration) => registryReadTransport(registration, options), resolveRegistration: async (registration) => {
          const refreshed = await registryListRegistrations(registration.host, options);
          const current = refreshed.find((candidate) => candidate.name === registration.name && candidate.scope === registration.scope && candidate.registrationId === registration.registrationId);
          return current ? { host: current.host, name: current.name, scope: current.scope, registrationId: current.registrationId, status: current.status, transportFingerprint: current.transportFingerprint } : null;
        } });
      try {
        const adapter = connection.serverInfo?.name === "pi-agent" ? await createPiAdapter(connection) : connection.serverInfo?.name === "cc-sdd-codex" ? await createCodexAdapter(connection) : null;
        if (!adapter) { connection.close(); return null; }
        const capability = await adapter.capabilities();
        const models = await adapter.models();
        return { kind: "agent", harness: capability.harness, tier: capability.tier, models: models.map((id) => ({ id })) };
      } catch { return null; }
      finally { try { connection.close(); } catch { /* 接続の終了済み */ } }
    });
    {
      for (const row of registrations.filter((item) => item.status === "eligible")) {
        let capability = null;
        try { capability = await verifyRegistration(row, { cwd: root }); } catch { /* 確認できない登録は利用不可で表示する */ }
        if (capability) verified[row.registrationId] = capability;
      }
    }
    const setup = buildDelegationSetup({ registrations, verified, planned, removing });
    if (setup.ok) {
      // 管理対象 Codex MCP は初回承認後、明示順がまだ無い場合にクラウド段へ引き継ぐ。
      if (config.codex?.enabled) {
        const managed = setup.groups.eligible.find((item) => item.host === "claude" && item.registrationName === "cc-sdd-codex" && item.scope === "project" && item.registrationId === managedRegistrationId && item.family === "codex" && item.tier === "cloud");
        const savedCloud = config.delegation?.claude?.cloud;
        if (managed && savedCloud === undefined) {
          const inherited = applyDelegationOrder({ delegation: config.delegation ?? {}, host: "claude", tier: "cloud", order: [managed.registrationId], candidates: [managed] });
          if (inherited.ok) config.delegation = inherited.delegation;
        }
      }
      const summary = [...setup.groups.eligible, ...setup.groups.planned, ...setup.groups.removing, ...setup.groups.pending, ...setup.groups.unavailable].map((item) => {
        const label = describeDelegationStatus(item);
        const reason = typeof item.reason === "string" && item.reason !== label ? `: ${item.reason}` : "";
        return `${item.host}/${item.registrationName} (${label}${reason})`;
      }).join("\n");
      if (summary) io.stdout.write(`委任候補の探査結果:\n${summary}\n`);
      // 非対話更新は保存済み選択を保持する。対話で新規選択するには明示的な選択入力を使う。
      let requested = io.delegationSelection;
      if (!requested && io.interactive && setup.groups.eligible.length) {
        io.stdout.write("委任候補キー（登録名:登録ID）を local/cloud ごとにカンマ区切りで入力してください（空欄で現在の順序を保持、'-' で空にします）。モデルは 登録名:登録ID:役割=固定ID または 登録名:登録ID:役割~互換ID1,互換ID2 をセミコロン区切りで入力できます（同じ役割に両方は指定できません）:\n");
        const rl = createInterface({ input: io.stdin, terminal: false });
        const lines = rl[Symbol.asyncIterator]();
        const readLine = async () => { const item = await lines.next(); return item.done ? null : String(item.value); };
        try {
          requested = [];
          for (const host of hosts) for (const tier of ["local", "cloud"]) {
            const available = setup.groups.eligible.filter((item) => item.host === host && item.tier === tier);
            io.stdout.write(`${host} ${tier}: ${available.length ? available.map((item) => `${item.registrationName}:${item.registrationId}`).join(" ") : "(候補なし)"}\n順序: `);
            const line = await readLine();
            if (line === null) { io.stderr.write("委任設定の入力が EOF で終了しました\n"); return 1; }
            {
              // 前後の空白を除き、登録 ID だけの指定も表示と同じ「登録名:登録 ID」のキーへ揃える。
              const order = line.trim() === "-" || line.trim() === "none" ? [] : line.trim() ? line.trim().split(",").map((entry) => canonicalCandidateKey(entry.trim(), available)) : null;
              if (order === null) continue;
              if (order.length) {
              io.stdout.write("モデル指定（例: 登録名:登録ID:review=固定ID または 登録名:登録ID:review~互換ID1,互換ID2、空欄で保持）: ");
              const modelLine = await readLine();
              if (modelLine === null) { io.stderr.write("委任設定の入力が EOF で終了しました\n"); return 1; }
              const parsedModels = parseDelegationModels({ line: modelLine, candidates: available });
              if (!parsedModels.ok) { io.stderr.write(`${parsedModels.reason}\n`); return 1; }
              requested.push({ host, tier, order, models: parsedModels.models });
              } else requested.push({ host, tier, order });
            }
          }
        } finally { rl.close(); }
      }
      if (requested && Array.isArray(requested)) {
        for (const selection of requested) {
          if (!selection || typeof selection.host !== "string" || !["local", "cloud"].includes(selection.tier) || !Array.isArray(selection.order)) continue;
          const eligible = setup.groups.eligible.filter((item) => item.host === selection.host && item.tier === selection.tier);
          const result = applyDelegationOrder({ delegation: config.delegation ?? {}, host: selection.host, tier: selection.tier, order: selection.order, candidates: eligible, ...(selection.models === undefined ? {} : { models: selection.models }) });
          if (!result.ok) { io.stderr.write(`${result.reason}\n`); return 1; }
          config.delegation = result.delegation;
        }
      }
    }
    for (const value of delegationOrder) {
      const separator = value.indexOf("=");
      const key = value.slice(0, separator);
      const colon = key.lastIndexOf(":");
      const host = key.slice(0, colon), tier = key.slice(colon + 1);
      // 探査で今回適格になった候補と、保存済みの候補を合わせて順序の対象にする。
      const probed = setup.groups.eligible.filter((item) => item.host === host && item.tier === tier && ["project", "user"].includes(item.scope));
      const candidates = mergeDelegationCandidates(probed, config.delegation?.[host]?.[tier] ?? []);
      try {
        const result = applyDelegationOrder({ delegation: config.delegation ?? {}, host, tier,
          order: value.slice(separator + 1) ? value.slice(separator + 1).split(",") : [], candidates });
        if (!result.ok) { io.stderr.write(`${result.reason}\n`); return 1; }
        config.delegation = result.delegation;
      } catch (error) {
        io.stderr.write(`${CONFIG_PATH} の委任順序を適用できません: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    if (config.delegation !== undefined) {
      const delegationError = validateDelegation(config.delegation);
      if (delegationError) { io.stderr.write(`${CONFIG_PATH} の委任設定が不正です: ${delegationError}\n`); return 1; }
    }
    defaulted = resolved.defaulted;
    selectedClients = config.clients === "both" ? ["claude", "codex"] : [config.clients];
    selectedDefinitions = selectedClients.flatMap((client) => generateNativeAgentDefinitions(config, client).map((definition) => ({ ...definition, client })));
  }
  const nativeFiles = operation === "uninstall"
    ? recordedPaths.filter((entry) => entry.startsWith(".claude/agents/") || entry.startsWith(".codex/agents/")).map((entry) => ({ path: entry, kind: "common", executable: false, client: entry.startsWith(".claude/") ? "claude" : "codex" }))
    : selectedDefinitions.map(({ relativePath, client }) => ({ path: relativePath, kind: "common", executable: false, client }));
  const activeCatalog = { ...catalog, files: [...catalog.files, ...nativeFiles] };
  const paths = [...new Set([...catalogPaths, ...nativeFiles.map((file) => file.path), ...recordedPaths])];
  const snapshot = readSnapshot(root, paths, allIgnoreLines(catalog.gitignore), [...new Set([...nativeFiles.map((file) => file.path), ...recordedPaths.filter(isNativeAgentPath)])]);

  if (operation === "uninstall") {
    const parsedConfig = parseConfig(snapshot.config);
    const configError = !parsedConfig.ok
      ? parsedConfig.error
      : validateConfig(parsedConfig.config, configFields);
    if (configError) {
      const reason = configError.code === "CONFIG_UNREADABLE"
        ? "JSON として読めません"
        : configError.messages.join("、");
      io.stderr.write(`${CONFIG_PATH} に問題がありますが、設定の値を使わずに取り除きを続けます。${reason}\n`);
    }
  }

  const packageRoot = io.packageRoot ?? path.resolve(".");
  const packageFiles = { ...readPackageFiles(packageRoot, catalog), ...Object.fromEntries(selectedDefinitions.map((definition) => [definition.relativePath, Buffer.from(definition.content)])) };
  const bootstrapVersion = readPackageVersion(packageRoot);
  const plan = makePlan({ operation, config, snapshot, catalog: activeCatalog, packageFiles, bootstrapVersion, force });
  if (plan.blocks.length) {
    io.stderr.write(formatAbort(plan.blocks, operation));
    return 1;
  }
  const names = { [CONFIG_PATH]: snapshot.config, [LEDGER_PATH]: snapshot.ledger, ".claude/settings.json": snapshot.settings, ".mcp.json": snapshot.mcpJson, ".gitignore": snapshot.gitignore, "CLAUDE.md": snapshot.claudeMd };
  const displayPlan = { ...plan, changes: plan.changes.map((c) => ({ ...c, existed: c.action === "write" && (names[c.path] != null || snapshot.files[c.path] != null) })) };
  const warnings = unknown;
  if (warnings.length) io.stderr.write(`警告: 設定に知らない項目があります。\n${warnings.map((k) => `  ${k}`).join("\n")}\n`);
  if (!plan.changes.length) {
    io.stdout.write(formatSuccess({ operation, plan: displayPlan, defaulted: defaulted ?? [], filled, config, agentsOverrideExists: snapshot.agentsOverrideExists }));
    return 0;
  }
  const result = applyPlan(root, plan);
  if (!result.ok) {
    io.stderr.write(formatApplyFailure(result, operation, configExists));
    return 1;
  }
  io.stdout.write(formatSuccess({ operation, plan: displayPlan, defaulted: defaulted ?? [], filled, config, unknown: [], agentsOverrideExists: snapshot.agentsOverrideExists }));
  return 0;
}
