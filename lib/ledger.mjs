// 配置の記録の解釈・作成と、書き換えの判定（純粋。ファイルの入出力はしない）。
// 記録の置き場（LEDGER_PATH）は catalog.mjs が持つ。ここでは扱わない。
import { createHash } from "node:crypto";
import { isClientSelection } from "./config-schema.mjs";

/**
 * @typedef {{ kind: "common" | "project", sha256: string }} LedgerEntry
 * @typedef {import("./config-schema.mjs").ClientSelection} ClientSelection
 * @typedef {{ format: 1, bootstrapVersion: string, clients: ClientSelection, files: Record<string, LedgerEntry> }} Ledger
 */

const LEDGER_FORMAT = 1;
const KINDS = new Set(["common", "project"]);
const SHA256_RE = /^[0-9a-f]{64}$/;
/** 危険なキー（prototype を書き換えうるもの） */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** 内容の SHA-256（16 進 64 桁） */
export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** 自分のキーとして安全に代入する */
function safeAssign(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * 記録の文字列を解釈する。無い・壊れている・形が違う・知らない版のときは null。
 * @param {string | null} text
 * @returns {Ledger | null}
 */
export function parseLedger(text) {
  if (typeof text !== "string") return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.format !== LEDGER_FORMAT) return null;
  if (typeof raw.bootstrapVersion !== "string" || !isObject(raw.files)) return null;
  // 導入対象を持たない旧記録は Claude Code に配置されたものとして扱う。
  const clients = Object.hasOwn(raw, "clients") ? raw.clients : "claude";
  if (!isClientSelection(clients)) return null;
  const files = {};
  for (const key of Object.keys(raw.files)) {
    if (UNSAFE_KEYS.has(key)) return null;
    const e = raw.files[key];
    if (!isObject(e) || !KINDS.has(e.kind) || typeof e.sha256 !== "string" || !SHA256_RE.test(e.sha256)) {
      return null;
    }
    safeAssign(files, key, { kind: e.kind, sha256: e.sha256 });
  }
  return { format: LEDGER_FORMAT, bootstrapVersion: raw.bootstrapVersion, clients, files };
}

/**
 * 配置したファイルから記録を作る。キーは道筋の順に並べる。
 * @param {string} version 導入コマンドの版
 * @param {Array<{ path: string, kind: "common" | "project", content: Buffer }>} placed
 * @param {ClientSelection} [clients="claude"] 適用した導入対象
 * @returns {Ledger}
 */
export function buildLedger(version, placed, clients = "claude") {
  const files = {};
  const sorted = [...placed].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const p of sorted) {
    safeAssign(files, p.path, { kind: p.kind, sha256: sha256(p.content) });
  }
  return { format: LEDGER_FORMAT, bootstrapVersion: version, clients, files };
}

/**
 * 記録の書き出し用の文字列（2 スペースの字下げ、末尾に改行）。同じ配置なら同じ文字列になる。
 * @param {Ledger} ledger
 * @returns {string}
 */
export function serializeLedger(ledger) {
  const files = {};
  for (const key of Object.keys(ledger.files).sort()) safeAssign(files, key, ledger.files[key]);
  return JSON.stringify({ format: ledger.format, bootstrapVersion: ledger.bootstrapVersion, clients: ledger.clients, files }, null, 2) + "\n";
}

/**
 * 利用者が書き換えたかの判定。
 * 記録にあれば記録との比較、無ければ新しい版の内容との比較。
 * 新しい版の内容が無く（削除の対象）記録も無いときは、安全側（書き換えあり）に倒す。
 * @param {{ ledger: Ledger | null, path: string, current: Buffer, incoming: Buffer | null }} input
 * @returns {boolean}
 */
export function decideModified({ ledger, path, current, incoming }) {
  if (ledger && Object.hasOwn(ledger.files, path)) {
    return sha256(current) !== ledger.files[path].sha256;
  }
  if (incoming === null) return true;
  return !current.equals(incoming);
}
