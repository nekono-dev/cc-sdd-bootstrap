// 設定ファイルの解釈・検証・補い・値の決定・書き出し（純粋。ファイルの入出力はしない）。
import { CONFIG_FORMAT, formatProblem } from "./config-schema.mjs";

/**
 * @typedef {import("./config-schema.mjs").ConfigField} ConfigField
 * @typedef {import("./config-schema.mjs").ConfigValue} ConfigValue
 * @typedef {{ format: number } & Record<string, unknown>} ConfigObject
 * @typedef {{ code: "CONFIG_UNREADABLE" | "CONFIG_INVALID", messages: string[] }} ConfigError
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

/**
 * 設定ファイルの文字列を読む。
 * @param {string} text
 * @returns {{ ok: true, config: ConfigObject } | { ok: false, error: ConfigError }}
 */
export function parseConfig(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: { code: "CONFIG_UNREADABLE", messages: [`設定ファイル: JSON として読めません（${e.message}）`] },
    };
  }
  if (!isObject(data)) {
    return {
      ok: false,
      error: { code: "CONFIG_INVALID", messages: ["設定ファイル: 最上位はオブジェクトで書いてください"] },
    };
  }
  const reason = checkFormat(data);
  if (reason) return { ok: false, error: { code: "CONFIG_INVALID", messages: [reason] } };
  return { ok: true, config: /** @type {ConfigObject} */ (data) };
}

/**
 * 項目ごとの検証。ある項目だけ調べる（無い項目は fillDefaults が補う）。
 * @param {ConfigObject} config
 * @param {ConfigField[]} fields
 * @returns {ConfigError | null}
 */
export function validateConfig(config, fields) {
  const messages = [];
  const formatReason = checkFormat(config);
  if (formatReason) messages.push(formatReason);
  for (const f of fields) {
    const blocked = findBlockedPrefix(config, f.path);
    if (blocked) {
      messages.push(`${blocked}: オブジェクトで指定してください`);
      continue;
    }
    const value = getPath(config, f.path);
    if (value === undefined) continue;
    const reason = f.validate(value);
    if (reason) messages.push(`${f.path}: ${reason}`);
    else if (f.kind === "map" && Object.keys(value).some((k) => UNSAFE_KEYS.has(k))) {
      messages.push(`${f.path}: キーに ${[...UNSAFE_KEYS].join("・")} は使えません`);
    }
  }
  return messages.length > 0 ? { code: "CONFIG_INVALID", messages } : null;
}

/**
 * 知らない項目（葉の道筋）を返す。map の項目の下のキーと format は数えない。
 * @param {ConfigObject} config
 * @param {ConfigField[]} fields
 * @returns {string[]}
 */
export function findUnknownKeys(config, fields) {
  const leaves = new Set(fields.map((f) => f.path));
  const prefixes = new Set();
  for (const f of fields) {
    const parts = f.path.split(".");
    for (let i = 1; i < parts.length; i++) prefixes.add(parts.slice(0, i).join("."));
  }
  const unknown = [];
  const walk = (obj, prefix) => {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!prefix && key === "format") continue;
      if (leaves.has(path)) continue;
      if (isObject(value) && (prefixes.has(path) || !leaves.has(path))) {
        if (!prefixes.has(path) && Object.keys(value).length === 0) unknown.push(path);
        else walk(value, path);
      } else {
        unknown.push(path);
      }
    }
  };
  walk(config, "");
  return unknown;
}

/**
 * 無い項目を既定値で補う。map は無いキーだけを補う。既存の値は変えない。
 * @param {ConfigObject} config
 * @param {ConfigField[]} fields
 * @returns {{ config: ConfigObject, filled: string[] }}
 */
export function fillDefaults(config, fields) {
  const out = structuredClone(config);
  const filled = [];
  for (const f of fields) {
    if (findBlockedPrefix(out, f.path)) continue;
    const current = getPath(out, f.path);
    if (current === undefined) {
      setPath(out, f.path, structuredClone(f.defaultValue));
      filled.push(f.path);
    } else if (f.kind === "map" && isObject(current) && isObject(f.defaultValue)) {
      for (const [k, v] of Object.entries(f.defaultValue)) {
        if (!UNSAFE_KEYS.has(k) && !Object.hasOwn(current, k)) {
          safeAssign(current, k, v);
          filled.push(`${f.path}.${k}`);
        }
      }
    }
  }
  return { config: out, filled };
}

/**
 * 最終の設定を決める。優先順位は 引数 > 対話の答え > 既存の値 > 既定値。
 * map はキーごとに重ねる。
 * @param {{ base: ConfigObject | null, given: Record<string, ConfigValue>, prompted: Record<string, ConfigValue>, fields: ConfigField[] }} input
 * @returns {{ config: ConfigObject, defaulted: string[] }}
 */
export function resolveValues({ base, given, prompted, fields }) {
  /** @type {ConfigObject} */
  const config = base ? structuredClone(base) : { format: CONFIG_FORMAT };
  const defaulted = [];
  for (const f of fields) {
    if (findBlockedPrefix(config, f.path)) continue;
    const existing = getPath(config, f.path);
    if (f.kind === "map" && existing !== undefined && !isObject(existing)) continue;
    const layers = [given[f.path], prompted[f.path]];
    if (f.kind === "map") {
      const merged = {};
      for (const [k, v] of Object.entries(isObject(existing) ? existing : {})) safeAssign(merged, k, v);
      let anyGiven = existing !== undefined;
      for (const layer of layers.toReversed()) {
        if (isObject(layer)) {
          for (const [k, v] of Object.entries(layer)) {
            if (!UNSAFE_KEYS.has(k)) safeAssign(merged, k, v);
          }
          anyGiven = true;
        }
      }
      if (!anyGiven) defaulted.push(f.path);
      for (const [k, v] of Object.entries(isObject(f.defaultValue) ? f.defaultValue : {})) {
        if (!UNSAFE_KEYS.has(k) && !Object.hasOwn(merged, k)) {
          safeAssign(merged, k, v);
          if (anyGiven) defaulted.push(`${f.path}.${k}`);
        }
      }
      setPath(config, f.path, merged);
    } else {
      const chosen = layers.find((v) => v !== undefined) ?? existing;
      if (chosen === undefined) {
        defaulted.push(f.path);
        setPath(config, f.path, structuredClone(f.defaultValue));
      } else {
        setPath(config, f.path, chosen);
      }
    }
  }
  return { config, defaulted };
}

/**
 * 設定を 2 文字の字下げで書き出す（末尾に改行）。
 * @param {ConfigObject} config
 * @returns {string}
 */
export function serializeConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}
