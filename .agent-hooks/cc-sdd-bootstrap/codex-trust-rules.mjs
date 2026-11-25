// 純粋な部品: Codex のフックの承認の記録（キーとハッシュ）を求める。
// 入出力は行わず、lib/ も import しない（導入コマンドの側の定数とは試験で一致を確かめる）。
// 計算式の出典: poc/codex-hook-trust/run.mjs の trustEntries（openai/codex の hook_hash に対応）。
import { createHash } from "node:crypto";

/** 自分のフックの印（lib/catalog.mjs の OWNED_MARKER と同じ値。試験で一致を確かめる） */
export const OWNED_MARKER = "/.agent-hooks/cc-sdd-bootstrap/";

/** Codex のイベント名（hooks.json の書き方）から、承認の記録に使うイベント名への対応 */
// Map にするのは、通常のオブジェクトだと toString・constructor・__proto__ などの継承プロパティを拾うため
const EVENT_LABELS = new Map([
  ["SessionStart", "session_start"],
  ["UserPromptSubmit", "user_prompt_submit"],
  ["PreToolUse", "pre_tool_use"],
  ["PostToolUse", "post_tool_use"],
  ["Stop", "stop"],
]);

/** 自分のフックで扱ってよい項目。これ以外の項目を持つと、計算式が確かめられないので除く */
const SUPPORTED_KEYS = new Set(["type", "command", "timeout"]);

/** timeout を省いたときの既定値（秒） */
const DEFAULT_TIMEOUT = 600;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 入力の項目を、自分のキーだけで読む（継承プロパティを拾わない） */
const ownValue = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);

/** オブジェクトのキーを辞書順に並べ直す（入れ子も同様）。ハッシュの入力を毎回同じ形にするため */
const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
};

/** 識別情報を sha256 で要約し、"sha256:" に続けて返す */
function hashOf(identity) {
  return "sha256:" + createHash("sha256").update(JSON.stringify(sortKeys(identity))).digest("hex");
}

/**
 * hooks.json の文章から、自分のフック（コマンドに印を含む command フック）の承認の記録を求める。
 * キーは `<hooksJsonPath>:<イベント名の小文字スネーク>:<グループ番号>:<フック番号>`。
 * 番号は利用者のフックも数える（0 から始まる添字）。
 * 扱えない項目を持つ自分のフック・表にないイベントの自分のフックは、理由つきで skipped に載せて除く。
 * @returns {{ ok: true, entries: { key: string, hash: string }[], skipped: string[] } | { ok: false, reason: string }}
 */
export function computeTrustEntries(hooksJsonText, hooksJsonPath) {
  let doc;
  try {
    doc = JSON.parse(hooksJsonText);
  } catch (error) {
    return { ok: false, reason: `hooks.json を JSON として読めない: ${error.message}` };
  }
  if (!isObject(doc)) return { ok: false, reason: "hooks.json の最上位がオブジェクトではない" };

  const docHooks = ownValue(doc, "hooks");
  const hooks = docHooks === undefined ? {} : docHooks;
  if (!isObject(hooks)) return { ok: false, reason: "hooks.json の hooks がオブジェクトではない" };

  // 形の確認: イベントごとにグループの配列、グループごとにフックの配列がある
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) return { ok: false, reason: `イベント ${event} の値が配列ではない` };
    for (const group of groups) {
      if (!isObject(group)) return { ok: false, reason: `イベント ${event} のグループがオブジェクトではない` };
      if (!Array.isArray(ownValue(group, "hooks"))) return { ok: false, reason: `イベント ${event} のグループの hooks が配列ではない` };
      for (const handler of group.hooks) {
        if (!isObject(handler)) return { ok: false, reason: `イベント ${event} のフックがオブジェクトではない` };
      }
    }
  }

  const entries = [];
  const skipped = [];

  for (const [event, groups] of Object.entries(hooks)) {
    groups.forEach((group, groupIndex) => {
      group.hooks.forEach((handler, handlerIndex) => {
        // 対象は、コマンドに印を含む type: command のフックだけ（利用者のフックは番号を数えるだけ）
        const handlerType = ownValue(handler, "type");
        const command = ownValue(handler, "command");
        const isOwned = handlerType === "command" && typeof command === "string" && command.includes(OWNED_MARKER);
        if (!isOwned) return;

        const where = `イベント ${event} のグループ ${groupIndex}・フック ${handlerIndex}`;
        const label = EVENT_LABELS.get(event);
        if (label === undefined) {
          skipped.push(`${where}: Codex の承認の表にないイベントのため除く`);
          return;
        }

        const extraKeys = Object.keys(handler).filter((k) => !SUPPORTED_KEYS.has(k));
        if (extraKeys.length > 0) {
          skipped.push(`${where}: 扱えない項目（${extraKeys.join("、")}）を持つため除く`);
          return;
        }

        const rawTimeout = ownValue(handler, "timeout") === undefined ? DEFAULT_TIMEOUT : handler.timeout;
        if (!Number.isInteger(rawTimeout)) {
          skipped.push(`${where}: timeout が整数ではないため除く`);
          return;
        }
        const timeout = Math.max(1, rawTimeout);

        // 識別情報: matcher は指定があるときだけ含める。async は false に固定する
        const identity = { event_name: label, hooks: [{ type: "command", command, timeout, async: false }] };
        const matcher = ownValue(group, "matcher");
        if (matcher !== undefined && matcher !== null) identity.matcher = matcher;

        entries.push({ key: `${hooksJsonPath}:${label}:${groupIndex}:${handlerIndex}`, hash: hashOf(identity) });
      });
    });
  }

  return { ok: true, entries, skipped };
}

// ---- config.toml の承認の記録の差分（タスク 2.2。解析と編集の内部関数は 2.3 も使う） ----
//
// 全 TOML の解析はしない。安全に編集できると確かめられた書式の部分集合だけを受け入れ、それ以外は本文を変えず ok: false を返す。
// 受け入れる書式:
// - 空行・コメントの行（行頭の空白可）
// - 見出し `[表]` または `[[配列の表]]`。キー列は裸のキー・基本文字列・リテラル文字列を `.` でつないだもの。行末は空白かコメントだけ
// - hooks に関係しない他の表の本体: キー・値の行。値は複数行にまたがってよい（配列やインライン表の中の行は見出しとみなさず、検証もしない）
// - 対象の表（`[hooks.state."<キー>"]` の正規の形）の本体: 裸のキーの 1 行の記録だけ。
//   許すキーは `trusted_hash`・`trusted_content_hash`・`enabled` の 3 つだけで、同じキーは 1 つだけ。
//   値の形は次のとおり（行末のコメントは任意）: `trusted_hash`・`trusted_content_hash` は、エスケープと改行を含まない二重引用符の文字列、`enabled` は `true` か `false`
// - 改行コードは本文の最初の改行（CRLF か LF。改行が無ければ LF）に統一する。追加・挿入・連結はその改行コードだけを使う
// - 末尾の改行の有無は入力と一致させる（入力が空文字列のときは、追加した表が改行で終わる）
//
// 拒否する書式（一覧にないものは拒否する）:
// - 複数行の文字列（""" と '''）を含む本文（行の境界を安全に判定できないため、本文全体）
// - 括弧・引用符が閉じていない本文、対応の取れない閉じ括弧（字句解析で本文の終わりまで判定する）
// - 見出しとして判定できない行、`[[hooks]]`、`[[hooks.state…]]`、`[hooks.state.…]` の正規でない形（`[hooks.state.'x']`・`[hooks.state."x".y]` など）
// - 最上位の hooks のキー、hooks.state に関わるキー（`[hooks]` や `[hooks.state]` の本体の state・state.x など）
// - 対象の表の本体で、上の 3 つ以外のキー・値、ドット付き・引用符付きのキー、同じキーの重複、複数行の値
// 他の表（projects など）の本体は、見出しと hooks に関わるキーだけを確かめ、値の中身は検証しない。

/** 記録のハッシュの形（sha256 の 16 進小文字 64 桁） */
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** 複数行の文字列の記号。含む本文は行の境界を安全に判定できないので扱わない */
const MULTILINE_STRING_MARKS = ['"""', "'''"];

/** 行の末尾の \r を除いた中身 */
const bareLine = (line) => (line.endsWith("\r") ? line.slice(0, -1) : line);

/** 空白だけ、またはコメントだけの行（本体の区切りとして読み飛ばす行） */
const isBlankLine = (content) => /^[ \t]*$/.test(content);
const isNeutralLine = (content) => isBlankLine(content) || /^[ \t]*#/.test(content);

/** 見出しの行の形（前の空白を除いて `[` で始まる）。文の先頭かどうかは字句解析の結果と合わせて判定する */
const isHeaderLine = (content) => content.trimStart().startsWith("[");

/** 対象の表の本体の記録の行: 裸のキー（[A-Za-z0-9_-]+）・`=`・値の残り */
const BARE_RECORD_PATTERN = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*=[ \t]*(.*)$/;

/**
 * 対象の表の本体で許すキーと、その値の形（1 行で完結し、行末のコメントだけを後ろに許す）。Map にするのは継承プロパティを拾わないため。
 * 空白は TOML の空白（空白とタブ）だけ。文字列は `"` と `\` と制御文字（CONTROL_CHAR_PATTERN）を含めない。
 */
const RECORD_VALUE_RULES = new Map([
  ["trusted_hash", /^"[^"\\\u0000-\u0008\u000A-\u001F\u007F]*"[ \t]*(#.*)?$/],
  ["trusted_content_hash", /^"[^"\\\u0000-\u0008\u000A-\u001F\u007F]*"[ \t]*(#.*)?$/],
  ["enabled", /^(?:true|false)[ \t]*(#.*)?$/],
]);

/**
 * TOML で許されない制御文字（U+0000〜U+0008・U+000A〜U+001F・U+007F）。タブ（U+0009）は許す。
 * 行の中身（末尾の \r を除いたもの）にこれがあれば、本文全体を安全に編集できないとして拒否する。
 */
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000A-\u001F\u007F]/;

/** trusted_hash の行の置き換え対象（裸のキー・二重引用符の値）。1 番目が行頭から `=` までの部分 */
const TRUSTED_LINE_PATTERN = /^([ \t]*trusted_hash[ \t]*=[ \t]*)"([^"\\]*)"/;

/**
 * 基本文字列として安全に表せないキー（制御文字・改行・単独のサロゲートを含む）。
 * JSON.stringify で作る見出しは TOML の基本文字列と同じ書式になるため、それ以外の文字だけを確かめる。
 */
const UNSAFE_KEY_PATTERN = /[\u0000-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** 裸のキー・基本文字列（TOML の定める escape だけ）・リテラル文字列のいずれかを、引用符を外した文字列にする。判定できなければ null */
function unquoteKeyPart(part) {
  if (/^[A-Za-z0-9_-]+$/.test(part)) return part;
  if (/^"(?:[^"\\\u0000-\u001f]|\\["\\btnfr]|\\u[0-9A-Fa-f]{4})*"$/.test(part)) return JSON.parse(part);
  if (/^'[^'\u0000-\u001f]*'$/.test(part)) return part.slice(1, -1);
  return null;
}

/**
 * ドットで区切ったキー列（`a . "b"` の形。ドットの前後の空白を許す）を、引用符を外した配列にする。
 * 引用符の閉じ忘れや判定できない書式は null を返す。
 */
function parseDottedKey(text) {
  const raws = [];
  let raw = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === '"') {
      raw += ch;
      if (ch === "\\") {
        raw += text[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        quote = null;
      }
    } else if (quote === "'") {
      raw += ch;
      if (ch === "'") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      raw += ch;
    } else if (ch === ".") {
      raws.push(raw.trim());
      raw = "";
    } else {
      raw += ch;
    }
  }
  if (quote !== null) return null;
  raws.push(raw.trim());
  const parts = raws.map(unquoteKeyPart);
  return parts.includes(null) ? null : parts;
}

/**
 * 見出しの行を解析する。`[` と `]`（配列の表なら `[[` と `]]`）の対応を確かめ、行末が空白かコメントだけであることも確かめる。
 * 戻り値: { parts: キー列, isArray: 配列の表か } ／ 判定できなければ null
 */
function parseHeader(content) {
  const s = content.trimStart();
  const isArray = s.startsWith("[[");
  const start = isArray ? 2 : 1;
  const close = isArray ? "]]" : "]";
  let quote = null;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (quote === '"') {
      if (ch === "\\") i++;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "]") {
      end = i;
      break;
    }
  }
  if (end === -1 || !s.startsWith(close, end)) return null;
  if (!/^\s*(#.*)?$/.test(s.slice(end + close.length))) return null;
  const parts = parseDottedKey(s.slice(start, end));
  return parts === null ? null : { parts, isArray };
}

/**
 * キー・値の行を、キー列（`=` より前）と値の残り（`=` より後ろ）に分ける。
 * 戻り値: { parts, value } ／ `=` が無い（コメントだけ・値の続きの行）なら undefined ／ 判定できなければ null
 */
function splitKeyValue(content) {
  let quote = null;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (quote === '"') {
      if (ch === "\\") i++;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return undefined;
    } else if (ch === "=") {
      const parts = parseDottedKey(content.slice(0, i));
      return parts === null ? null : { parts, value: content.slice(i + 1) };
    }
  }
  return quote === null ? undefined : null;
}

/** 行が見出しの前後の空白・コメントを除いて、指定の見出しと完全に一致するか（行末の空白とコメントは許す） */
function matchesHeader(content, head) {
  const trimmed = content.trimStart();
  return trimmed.startsWith(head) && /^\s*(#.*)?$/.test(trimmed.slice(head.length));
}

/**
 * 本文を行に分ける。各行は「中身（末尾の \r を含むことがある）」と「後ろの改行」の組。
 * 改行の無い最後の行は term が空文字列になる。改行コードは元のまま保ち、追加する行の改行は後で決める。
 */
function splitRecords(text) {
  const recs = [];
  let rest = text;
  while (rest !== "") {
    const i = rest.indexOf("\n");
    if (i === -1) {
      recs.push({ content: rest, term: "" });
      break;
    }
    recs.push({ content: rest.slice(0, i), term: "\n" });
    rest = rest.slice(i + 1);
  }
  return recs;
}

/** 本文の改行コードを決める: 最初の改行が CRLF なら CRLF、それ以外（改行が無い本文を含む）は LF */
function detectEol(text) {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

/**
 * 本文を 1 度の走査で字句解析し、行ごとに「文の先頭か」と「見出しか」を求める。
 * 基本文字列（\ の escape を含む）・リテラル文字列・行末のコメントを認識し、[ ] { } の深さを行をまたいで数える。
 * 文字列は行をまたがない（複数行の文字列は呼び出し側で先に拒否する）ので、引用符の状態は行ごとに判定する。
 * 文の先頭とは、深さが 0 の位置で始まる行のこと。配列やインライン表の続きの行は文の先頭ではないので、見出しとみなさない。
 * 戻り値: { statementStart, isHeader }。括弧・引用符が本文の終わりまで閉じていなければ { error }。
 * @param {string[]} contents 行の中身（末尾の \r を除いたもの）
 */
function analyzeLines(contents) {
  const statementStart = [];
  const isHeader = [];
  let depth = 0;
  for (const content of contents) {
    const start = depth === 0;
    statementStart.push(start);
    isHeader.push(start && isHeaderLine(content));
    let quote = null;
    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      if (quote === '"') {
        if (ch === "\\") i++;
        else if (ch === '"') quote = null;
      } else if (quote === "'") {
        if (ch === "'") quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "#") {
        break;
      } else if (ch === "[" || ch === "{") {
        depth++;
      } else if (ch === "]" || ch === "}") {
        depth--;
        if (depth < 0) return { error: `対応の取れない閉じ括弧があるため、安全に編集できない: ${content.trim()}` };
      }
    }
    if (quote !== null) return { error: `引用符が行の中で閉じていないため、安全に編集できない: ${content.trim()}` };
  }
  if (depth !== 0) return { error: "閉じていない括弧があるため、安全に編集できない" };
  return { statementStart, isHeader };
}

/** 見出しの次の見出しの行番号（無ければ行数）。表の本体の終わりを表す */
function nextHeaderIndex(isHeader, headerIndex) {
  for (let i = headerIndex + 1; i < isHeader.length; i++) {
    if (isHeader[i]) return i;
  }
  return isHeader.length;
}

/**
 * 対象の表（正規の見出し）の本体を確かめる。見出しの次の行から、次の見出しまでが対象。
 * 文の先頭の行は、裸のキーの 1 行の記録で、許すキーと値の形（RECORD_VALUE_RULES）だけを許す。
 * 値の続きの行・同じキーの重複を拒否する。問題があれば理由（日本語）を返し、無ければ null を返す。
 */
function findStateBodyProblem(contents, lex, headerIndex) {
  const end = nextHeaderIndex(lex.isHeader, headerIndex);
  const seen = new Set();
  for (let i = headerIndex + 1; i < end; i++) {
    const content = contents[i];
    if (isNeutralLine(content)) continue;
    if (!lex.statementStart[i]) return `対象の表の本体に値の続きの行があるため、安全に編集できない: ${content.trim()}`;
    const m = BARE_RECORD_PATTERN.exec(content);
    if (m === null) return `対象の表の本体が、裸のキーの 1 行の記録ではないため、安全に編集できない: ${content.trim()}`;
    const [, key, value] = m;
    const rule = RECORD_VALUE_RULES.get(key);
    if (rule === undefined) return `対象の表に扱わないキーがあるため、安全に編集できない: ${key}`;
    if (seen.has(key)) return `対象の表の本体に同じキーが複数あるため、安全に編集できない: ${key}`;
    seen.add(key);
    if (!rule.test(value)) return `対象の表の ${key} の値が想定外の書式のため、安全に編集できない`;
  }
  return null;
}

/** キーの見出し（完全一致。行末の空白とコメントは許す）の行番号を返す。文の先頭にある見出しだけを数える */
function findKeyHeaders(contents, lex, head) {
  const found = [];
  lex.isHeader.forEach((isHeader, i) => {
    if (isHeader && matchesHeader(contents[i], head)) found.push(i);
  });
  return found;
}

/** 見出しの表の中で、trusted_hash の行の番号を返す（本体は検査済みで、キーは許す裸のキーだけ） */
function findTrustedRows(contents, lex, headerIndex) {
  const end = nextHeaderIndex(lex.isHeader, headerIndex);
  const rows = [];
  for (let i = headerIndex + 1; i < end; i++) {
    const m = BARE_RECORD_PATTERN.exec(contents[i]);
    if (m !== null && m[1] === "trusted_hash") rows.push(i);
  }
  return rows;
}

/**
 * 本文全体が、上の部分集合の書式だけで書かれているかを確かめる。安全に編集できない書式があれば理由（日本語）を返し、無ければ null を返す。
 * - 対象の表の本体は findStateBodyProblem で確かめる。その中の行は、ここでは再度見ない
 * - hooks に関係しない他の表の中では、文の先頭のキー・値の行だけを見る（値の続きの行は検証しない）
 * - hooks.state に関わるキー（最上位・[hooks]・[hooks.state] の本体）は拒否する
 * - hooks の見出しは `[hooks]`・`[hooks.state]`・正規の対象の表・他のキーの `[hooks.X]` だけを許す。`[[hooks]]` と hooks.state の配列の表は拒否する
 * @param {string} configText
 * @param {string[]} contents 行の中身（末尾の \r を除いたもの）
 * @param {{ statementStart: boolean[], isHeader: boolean[] }} lex 字句解析の結果
 */
function findUnsafeForm(configText, contents, lex) {
  if (MULTILINE_STRING_MARKS.some((mark) => configText.includes(mark))) {
    return '複数行の文字列（""" または \'\'\'）があるため、安全に編集できない';
  }
  // 今いる表のキー列と、対象の表の本体かどうか（対象の表の本体は、見出しの時点で確かめ済み）
  let table = { path: [], canonicalState: false };

  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    if (isNeutralLine(content)) continue;

    if (lex.isHeader[i]) {
      const header = parseHeader(content);
      if (header === null) return `見出しとして判定できない行があるため、安全に編集できない: ${content.trim()}`;
      const { parts, isArray } = header;
      if (parts[0] === "hooks" && isArray && (parts.length === 1 || parts[1] === "state")) {
        return `配列の表（${content.trim()}）は hooks の設定と衝突するため、安全に編集できない`;
      }
      if (parts[0] === "hooks" && parts.length >= 3 && parts[1] === "state") {
        // hooks.state の下の表は、正規の形（引用符つきの単一キー）の対象の表だけを許す
        if (parts.length !== 3 || !matchesHeader(content, `[hooks.state.${JSON.stringify(parts[2])}]`)) {
          return `hooks.state の見出しが正規の形ではないため、安全に編集できない: ${content.trim()}`;
        }
        const problem = findStateBodyProblem(contents, lex, i);
        if (problem !== null) return problem;
        table = { path: parts, canonicalState: true };
        continue;
      }
      table = { path: parts, canonicalState: false };
      continue;
    }

    // 対象の表の本体は見出しの時点で確かめ済みなので、ここでは読み飛ばす
    if (table.canonicalState) continue;
    // 値の続きの行（複数行の配列・インライン表の中）は、他の表なら検証しない
    if (!lex.statementStart[i]) continue;

    const kv = splitKeyValue(content);
    if (kv === null) return `書式を判定できないため、安全に編集できない: ${content.trim()}`;
    if (kv === undefined) return `値の途中か判定できない行があるため、安全に編集できない: ${content.trim()}`;

    // 表の位置を足したキー列で、hooks の設定に関わるかを確かめる
    const full = [...table.path, ...kv.parts];
    if (full[0] === "hooks") {
      if (table.path.length === 0) return "最上位に hooks のキーがあるため、安全に編集できない";
      if (full[1] === "state") return `hooks.state に関わるキーがあるため、安全に編集できない: ${content.trim()}`;
    }
  }
  return null;
}

/** 記録の一覧の形を確かめる。問題があれば理由を返し、無ければ null を返す */
function findEntryProblem(entries) {
  if (!Array.isArray(entries)) return "記録の一覧が配列ではない";
  const seen = new Set();
  for (const entry of entries) {
    if (!isObject(entry) || typeof entry.key !== "string" || entry.key === "") {
      return "記録のキーが空でない文字列ではない";
    }
    if (UNSAFE_KEY_PATTERN.test(entry.key)) {
      return "記録のキーに制御文字・改行・単独のサロゲートがあり、表として安全に書けない";
    }
    if (typeof entry.hash !== "string" || !HASH_PATTERN.test(entry.hash)) {
      return `記録のハッシュの形式が想定外: ${String(entry.hash)}`;
    }
    if (seen.has(entry.key)) return `同じキーの記録が複数ある: ${entry.key}`;
    seen.add(entry.key);
  }
  return null;
}

/**
 * config.toml の本文に、承認の記録（`[hooks.state."<キー>"]` の表の trusted_hash）の差分を計算する。
 * mode は "write" だけを扱う（"remove" は 2.3 で足す）。
 * 表が無ければ末尾に追加し、trusted_hash が無ければ見出しの直後に足し、違う値なら値だけを置き換える。
 * コメント・他の表は変えない。改行コードは本文の最初の改行に統一し、末尾の改行の有無は入力と一致させる
 * （入力が空文字列のときだけ、追加した表が改行で終わる）。変更が無いときは入力と同じ文字列を返す。
 * 想定外の書式は本文を変えず ok: false を返す。
 * @param {string} configText
 * @param {TrustEntry[]} entries
 * @param {"write"} mode
 * @returns {{ ok: true, text: string, counts: TrustCounts } | { ok: false, reason: string }}
 */
export function planTrustEdit(configText, entries, mode) {
  if (mode !== "write") throw new TypeError(`未対応の mode です: ${String(mode)}`);
  const entryProblem = findEntryProblem(entries);
  if (entryProblem !== null) return { ok: false, reason: entryProblem };

  const recs = splitRecords(configText);
  const contents = recs.map((rec) => bareLine(rec.content));
  if (contents.some((content) => CONTROL_CHAR_PATTERN.test(content))) {
    return { ok: false, reason: "TOML で許されない制御文字（タブ以外）があるため、安全に編集できない" };
  }
  const lex = analyzeLines(contents);
  if (lex.error !== undefined) return { ok: false, reason: lex.error };
  const unsafe = findUnsafeForm(configText, contents, lex);
  if (unsafe !== null) return { ok: false, reason: unsafe };

  const eol = detectEol(configText);
  const hasTrailingNewline = configText === "" || configText.endsWith("\n");
  const counts = { added: 0, updated: 0, unchanged: 0, removed: 0 };
  // 行番号 → 置き換えた後の行の中身（trusted_hash の値だけを変える）
  const replaced = new Map();
  // 見出しの行番号 → その直後に足す行の中身（trusted_hash が無い表）
  const insertAfter = new Map();
  // 末尾に追加する表
  const blocks = [];

  for (const { key, hash } of entries) {
    const head = `[hooks.state.${JSON.stringify(key)}]`;
    const headers = findKeyHeaders(contents, lex, head);
    if (headers.length > 1) return { ok: false, reason: `同じキーの見出しが複数ある: ${key}` };

    if (headers.length === 0) {
      blocks.push({ head, hash });
      counts.added += 1;
      continue;
    }

    const headerIndex = headers[0];
    const rows = findTrustedRows(contents, lex, headerIndex);
    if (rows.length > 1) return { ok: false, reason: `trusted_hash の行が複数ある: ${key}` };

    if (rows.length === 0) {
      insertAfter.set(headerIndex, `trusted_hash = "${hash}"`);
      counts.updated += 1;
      continue;
    }

    const row = rows[0];
    const match = TRUSTED_LINE_PATTERN.exec(contents[row]);
    if (match === null) {
      return { ok: false, reason: `trusted_hash の書式が想定外（二重引用符の文字列ではない）: ${key}` };
    }
    if (match[2] === hash) {
      counts.unchanged += 1;
    } else {
      replaced.set(row, recs[row].content.replace(TRUSTED_LINE_PATTERN, (_, prefix) => `${prefix}"${hash}"`));
      counts.updated += 1;
    }
  }

  // 置き換えを反映した行の並び（改行は各行が持つ）
  const out = recs.map((rec, i) => ({ content: replaced.get(i) ?? rec.content, term: rec.term }));
  const rebuilt = [];
  out.forEach((rec, i) => {
    rebuilt.push(rec);
    if (!insertAfter.has(i)) return;
    // 見出しが改行の無い最後の行なら、その「改行なし」を足す行へ移し、見出しには改行を付ける
    const isLast = rec.term === "";
    if (isLast) rec.term = eol;
    rebuilt.push({ content: insertAfter.get(i), term: isLast ? "" : eol });
  });

  // 追加する行は、直前の行に改行が無ければ改行を付けてから続ける（改行コードは本文の eol だけ）
  const pushLine = (content) => {
    const last = rebuilt.at(-1);
    if (last !== undefined && last.term === "") last.term = eol;
    rebuilt.push({ content, term: eol });
  };
  for (const { head, hash } of blocks) {
    // 直前の行が空行でなければ、空行を 1 つ挟む（本文が空なら挟まない）
    const last = rebuilt.at(-1);
    if (last !== undefined && !isBlankLine(bareLine(last.content))) pushLine("");
    pushLine(head);
    pushLine(`trusted_hash = "${hash}"`);
  }

  // 末尾の改行の有無は入力と一致させる（変更が無いときも、入力と同じ末尾になる）
  if (!hasTrailingNewline && rebuilt.length > 0) rebuilt[rebuilt.length - 1].term = "";
  const text = rebuilt.map((rec) => rec.content + rec.term).join("");
  return { ok: true, text, counts };
}
