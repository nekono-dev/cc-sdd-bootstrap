// 導入の版と指紋の記録（純粋な処理）。
// ファイル・git・環境変数を読まず、入力から結果だけを計算する。
// 導入コマンド（lib/）はこのファイルを読み込んでよいが、配置物どうしは互いを読み込まない。
import { createHash } from "node:crypto";

/** 記録ファイルの場所（導入先のリポジトリのルートからの相対パス） */
export const RECORD_PATH = ".agent-hooks/cc-sdd-bootstrap/install-record.json";

/** 配布元のリポジトリ */
export const DISTRIBUTION_REPO = "https://github.com/nekono-dev/cc-sdd-bootstrap";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

/**
 * 内容の指紋（SHA-256 の 16 進）を返す。
 * @param {Buffer | string} content
 * @returns {string}
 */
export function fingerprint(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 記録の JSON 文字列を作る。同じ入力からは必ず同じ文字列になる。
 * キーは昇順、インデント 2、末尾は改行 1 つ。
 * @param {{ source: { commit: string | null, ref: string | null }, files: Record<string, Buffer | string> }} input
 * @returns {string}
 */
export function buildRecord({ source, files }) {
  // JSON.stringify は整数形式のキーを数値順に並べ替え、`__proto__` を落とすため、files は手で書き出す（キーは文字列の昇順）
  const entries = Object.keys(files).sort().map((path) => `    ${JSON.stringify(path)}: ${JSON.stringify(fingerprint(files[path]))}`);
  const filesText = entries.length === 0 ? "{}" : `{\n${entries.join(",\n")}\n  }`;
  const sourceText = JSON.stringify({ commit: source.commit, ref: source.ref }, null, 2).replace(/\n/g, "\n  ");
  return `{\n  "files": ${filesText},\n  "format": 1,\n  "source": ${sourceText}\n}\n`;
}

/**
 * 記録の文字列を分類する。
 * - null（ファイルが無い）→ missing
 * - 壊れた JSON・format が 1 でない・files の値が 64 桁の 16 進でない・source の形が違う → broken
 * - 正常 → ok（記録の本体を返す）
 * @param {string | null} text
 * @returns {{ state: "missing" } | { state: "broken" } | { state: "ok", record: object }}
 */
export function parseRecord(text) {
  if (text === null) {
    return { state: "missing" };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: "broken" };
  }
  if (!isPlainObject(value) || value.format !== 1) {
    return { state: "broken" };
  }
  if (!isPlainObject(value.files)) {
    return { state: "broken" };
  }
  for (const hash of Object.values(value.files)) {
    if (typeof hash !== "string" || !HEX64.test(hash)) {
      return { state: "broken" };
    }
  }
  const source = value.source;
  if (!isPlainObject(source)) {
    return { state: "broken" };
  }
  if (!(source.commit === null || (typeof source.commit === "string" && HEX40.test(source.commit)))) {
    return { state: "broken" };
  }
  if (!(source.ref === null || typeof source.ref === "string")) {
    return { state: "broken" };
  }
  return { state: "ok", record: value };
}

/**
 * 記録のファイルと、実際のファイルの指紋を照合する。
 * actual は相対パス → 指紋（無ければ null）。記録に無い actual のファイルは判定しない。
 * @param {{ files: Record<string, string> }} record
 * @param {Record<string, string | null>} actual
 * @returns {{ missing: string[], changed: string[] }} どちらもパスのキー昇順
 */
export function inspectFiles(record, actual) {
  const missing = [];
  const changed = [];
  for (const path of Object.keys(record.files).sort()) {
    const current = actual[path];
    if (current === undefined || current === null) {
      missing.push(path);
    } else if (current !== record.files[path]) {
      changed.push(path);
    }
  }
  return { missing, changed };
}

/** 値が普通のオブジェクト（配列・null でない）か */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
