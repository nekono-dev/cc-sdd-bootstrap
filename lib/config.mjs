// 設定ファイルの解釈・検証・補い・値の決定・書き出し（純粋。ファイルの入出力はしない）。
import { CONFIG_FORMAT, formatProblem } from "./config-schema.mjs";

/**
 * @typedef {import("./config-schema.mjs").ConfigField} ConfigField
 * @typedef {import("./config-schema.mjs").ConfigValue} ConfigValue
 * @typedef {{ format: number } & Record<string, unknown>} ConfigObject
 * @typedef {{ code: "CONFIG_UNREADABLE" | "CONFIG_INVALID", messages: string[] }} ConfigError
 * @typedef {{ code: "CONFIG_UNREADABLE" | "CONFIG_INVALID", file: string, messages: string[] }} ConfigError
 */

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** 道筋（"a.b"）で値を読む。無ければ undefined */
function getPath(obj, path) {
  let cur = obj;
  for (const key of path.split(".")) {
    if (!isObject(cur) || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** 危険なキー（prototype を書き換えうるもの） */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** 安全に代入する（__proto__ などでも自分のキーとして入る） */
function safeAssign(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** 道筋の途中（先頭側）に、あるのに普通のオブジェクトでない値があれば、その道筋を返す */
function findBlockedPrefix(obj, path) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isObject(cur) || !Object.hasOwn(cur, keys[i])) return null;
    cur = cur[keys[i]];
    if (!isObject(cur)) return keys.slice(0, i + 1).join(".");
  }
  return null;
}

/** 道筋で値を書く（途中のオブジェクトは作る） */
function setPath(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    if (!Object.hasOwn(cur, key)) safeAssign(cur, key, {});
    cur = cur[key];
  }
  safeAssign(cur, keys.at(-1), value);
}

/** format の確認。問題があれば「項目: 理由」の文、無ければ null（規則は配置物と共有する） */
function checkFormat(config) {
  return formatProblem(config.format);
}

/** 設定ファイルの既定の名前 */
const DEFAULT_CONFIG_FILE = ".cc-sdd-bootstrap.json";

/** 設定を読み取る。 */
export function parseConfig(text, file = DEFAULT_CONFIG_FILE) {
  let data;
  try { data = JSON.parse(text); }
  catch (e) { return { ok: false, error: { code: "CONFIG_UNREADABLE", file, messages: [`設定ファイルを JSON として読めません（${e.message}）`] } }; }
  if (!isObject(data)) return { ok: false, error: { code: "CONFIG_INVALID", file, messages: ["設定ファイル: 最上位はオブジェクトで指定してください"] } };
  return { ok: true, config: data };
}

/** 設定に含まれる今回必要な項目を調べる。 */
export function validateConfig(config, fields, file = DEFAULT_CONFIG_FILE) {
  const messages = [];
  const formatReason = formatProblem(config.format);
  if (formatReason) messages.push(formatReason);
  for (const field of fields) {
    const blocked = findBlockedPrefix(config, field.path);
    if (blocked) { messages.push(`${blocked}: オブジェクトで指定してください`); continue; }
    const value = getPath(config, field.path);
    if (value === undefined) continue;
    const reason = field.validate(value);
    if (reason) messages.push(`${field.path}: ${reason}`);
  }
  return messages.length ? { code: "CONFIG_INVALID", file, messages } : null;
}

/** 欠けた項目を既定値で補い、入力済みの値は保つ。 */
export function fillDefaults(config, fields) {
  const out = structuredClone(config);
  const filled = [];
  for (const field of fields) {
    if (findBlockedPrefix(out, field.path)) continue;
    const current = getPath(out, field.path);
    if (current === undefined) {
      setPath(out, field.path, structuredClone(field.defaultValue));
      filled.push(field.path);
    } else if (field.kind === "map" && isObject(current) && isObject(field.defaultValue)) {
      for (const [key, value] of Object.entries(field.defaultValue)) {
        if (!UNSAFE_KEYS.has(key) && !Object.hasOwn(current, key)) { safeAssign(current, key, value); filled.push(`${field.path}.${key}`); }
      }
    }
  }
  return { config: out, filled };
}

/** 設定を改行付き JSON にする。 */
export function serializeConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}
