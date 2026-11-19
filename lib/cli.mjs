// コマンドの処理の本体。引数の解析と使い方の表示を持つ。
// （操作の実行・対話・出力の整形は後のタスクで同じファイルに足していく）
import { parseArgs } from "node:util";
import { configFields } from "./config-schema.mjs";

/** @typedef {import("./config-schema.mjs").ConfigField} ConfigField */
/** @typedef {import("./config-schema.mjs").ConfigValue} ConfigValue */

/**
 * 引数の解析結果。
 * @typedef {{ kind: "help" }
 *   | { kind: "usage-error", message: string }
 *   | { kind: "run", operation: "init" | "update" | "uninstall", given: Record<string, ConfigValue>, force: boolean }} ParsedArgs
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
  for (const f of fields) {
    lines.push(`  ${flagSyntax(f)}`);
    lines.push(`      ${f.question}（既定値: ${describeDefault(f)}）`);
  }
  return lines.join("\n") + "\n";
}

/** @param {ConfigField} f */
function flagSyntax(f) {
  if (f.kind === "boolean") return `--${f.flag} yes|no`;
  if (f.kind === "map") return `--${f.flag} <役割>=<モデル>（繰り返し指定できる）`;
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
  const options = { help: { type: "boolean", short: "h" }, force: { type: "boolean" } };
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
  return { kind: "run", operation: /** @type {any} */ (operation), given, force: Boolean(values.force) };
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
  io.stderr.write(`${parsed.operation} の実行はまだ接続されていません。\n`);
  return 1;
}
