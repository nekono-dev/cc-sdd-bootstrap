// 目印の行で囲んだ区画の作成・置き換え・削除（純粋。入出力をしない）
// .gitignore と CLAUDE.md の「この区画は cc-sdd-bootstrap が管理する」部分に使う。

/**
 * 目印の定義。行の先頭がこの文字列で始まる行を目印の行とみなす（行末の CR は無視する）。
 * @typedef {{ begin: string, end: string }} Markers
 */

/**
 * 目印が壊れていることを表すエラー（例外ではなく戻り値で返す）。
 * @typedef {{ code: "MARKERS_BROKEN", file: string, detail: string }} BlockError
 */

/** CLAUDE.md 用の目印（HTML のコメント） */
export const CLAUDE_MD_MARKERS = {
  begin: "<!-- cc-sdd-bootstrap:begin",
  end: "<!-- cc-sdd-bootstrap:end",
};

/** .gitignore 用の目印 */
export const GITIGNORE_MARKERS = {
  begin: "# >>> cc-sdd-bootstrap",
  end: "# <<< cc-sdd-bootstrap",
};

/**
 * 文章を行に分ける。各行は、行頭の位置・中身（改行と行末の CR を除く）・中身の終わりの位置・次の行頭の位置を持つ。
 * 末尾の改行の後ろの空の行は行に数えない。
 * @param {string} text
 */
function splitLines(text) {
  const lines = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const next = nl === -1 ? text.length : nl + 1;
    let contentEnd = nl === -1 ? text.length : nl;
    if (nl !== -1 && contentEnd > pos && text[contentEnd - 1] === "\r") contentEnd -= 1;
    lines.push({ start: pos, content: text.slice(pos, contentEnd), contentEnd, next });
    pos = next;
  }
  return lines;
}

/**
 * 改行の種類を決める。最初の改行が CRLF なら CRLF、それ以外（改行が無い場合を含む）は LF。
 * @param {string} text
 */
function detectEol(text) {
  const nl = text.indexOf("\n");
  return nl > 0 && text[nl - 1] === "\r" ? "\r\n" : "\n";
}

/** 目印の行の位置を調べる。壊れていれば BlockError。 */
function locate(text, markers, file) {
  const lines = splitLines(text);
  const begins = [];
  const ends = [];
  lines.forEach((l, i) => {
    if (l.content.startsWith(markers.begin)) begins.push(i);
    if (l.content.startsWith(markers.end)) ends.push(i);
  });
  if (begins.length === 0 && ends.length === 0) return { found: false, lines };
  const broken = (detail) => ({ code: "MARKERS_BROKEN", file, detail });
  if (begins.length > 1 || ends.length > 1) {
    return broken(
      `目印の行が 2 組以上あります（開始 ${begins.length} 行・終了 ${ends.length} 行）。区画を 1 組だけにしてください。`,
    );
  }
  if (begins.length === 0) return broken(`終了の目印（${markers.end}）だけがあり、開始の目印がありません。`);
  if (ends.length === 0) return broken(`開始の目印（${markers.begin}）だけがあり、終了の目印がありません。`);
  if (ends[0] < begins[0]) return broken("終了の目印が開始の目印より前にあります。順序を直してください。");
  return { found: true, start: begins[0], end: ends[0], lines };
}

/**
 * 区画を探す。start・end は 0 始まりの行番号（開始・終了の目印の行。両端を含む）。
 * @param {string} text
 * @param {Markers} markers
 * @param {string} [file] エラーに入れるファイル名（省略時は空文字）
 * @returns {{ found: false } | { found: true, start: number, end: number } | BlockError}
 */
export function findBlock(text, markers, file = "") {
  const r = locate(text, markers, file);
  if (r.code) return r;
  return r.found ? { found: true, start: r.start, end: r.end } : { found: false };
}

/**
 * 区画を作る、または中身を置き換える。区画の外は 1 文字も変えない。
 * 追加する行の改行は、元の文章の最初の改行に合わせる（CRLF なら CRLF、それ以外は LF）。
 * 区画が無いときは、末尾に空行を 1 つ挟んで足す（末尾に改行が無ければ先に補う。空の文章には空行を挟まない）。
 * 区画があるときは、開始の行から終了の行の中身までを置き換え、終了の行の改行（無いことを含む）は元のまま残す。
 * @param {{ text: string | null, markers: Markers, beginLine: string, endLine: string, body: string, file: string }} input
 * @returns {{ text: string, created: boolean } | BlockError}
 */
export function upsertBlock({ text, markers, beginLine, endLine, body, file }) {
  const bodyLines = body === "" ? [] : body.replace(/\r?\n$/, "").split(/\r?\n/);
  const blockLines = [beginLine, ...bodyLines, endLine];
  if (text === null) {
    return { text: blockLines.join("\n") + "\n", created: true };
  }
  const eol = detectEol(text);
  const joined = blockLines.join(eol);
  const r = locate(text, markers, file);
  if (r.code) return r;
  if (r.found) {
    const from = r.lines[r.start].start;
    const to = r.lines[r.end].contentEnd;
    return { text: text.slice(0, from) + joined + text.slice(to), created: false };
  }
  let head = text;
  if (head !== "" && !head.endsWith("\n")) head += eol;
  const blank = head === "" ? "" : eol;
  return { text: head + blank + joined + eol, created: true };
}

/**
 * 区画と、区画の直前の空行 1 つ（upsertBlock が足したもの）を取り除く。区画の外は変えない。
 * 区画が無ければそのまま返す（removed: false）。
 * 注: 元の文章の末尾に改行が無かった場合、upsert で補われた改行は戻らない。
 * @param {{ text: string, markers: Markers, file: string }} input
 * @returns {{ text: string, removed: boolean } | BlockError}
 */
export function removeBlock({ text, markers, file }) {
  const r = locate(text, markers, file);
  if (r.code) return r;
  if (!r.found) return { text, removed: false };
  let first = r.start;
  if (first > 0 && r.lines[first - 1].content === "") first -= 1;
  return { text: text.slice(0, r.lines[first].start) + text.slice(r.lines[r.end].next), removed: true };
}
