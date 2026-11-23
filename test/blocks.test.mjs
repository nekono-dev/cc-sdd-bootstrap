// 目印の区画の処理（純粋）の単体テスト
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_MD_MARKERS,
  GITIGNORE_MARKERS,
  replaceBlock,
  findBlock,
  upsertBlock,
  removeBlock,
} from "../lib/blocks.mjs";
import { AGENT_SECTION_MARKERS } from "../lib/catalog.mjs";

const M = GITIGNORE_MARKERS;
const BEGIN = "# >>> cc-sdd-bootstrap（この区画は管理される）";
const END = "# <<< cc-sdd-bootstrap";
const up = (text, body = "a\nb", extra = {}) =>
  upsertBlock({ text, markers: M, beginLine: BEGIN, endLine: END, body, file: ".gitignore", ...extra });

test("目印の定数が設計の値どおり", () => {
  assert.deepEqual(CLAUDE_MD_MARKERS, {
    begin: "<!-- cc-sdd-bootstrap:begin",
    end: "<!-- cc-sdd-bootstrap:end",
  });
  assert.deepEqual(GITIGNORE_MARKERS, { begin: "# >>> cc-sdd-bootstrap", end: "# <<< cc-sdd-bootstrap" });
});

test("findBlock: 区画が無ければ found false", () => {
  assert.equal(findBlock("x\ny\n", M), null);
  assert.equal(findBlock("", M), null);
});

test("findBlock: 1 組なら行番号（0 始まり）で返す", () => {
  assert.deepEqual(findBlock(`x\n${BEGIN}\na\n${END}\ny\n`, M), { start: 1, end: 3 });
  assert.deepEqual(findBlock(`${BEGIN}\r\n${END}`, M), { start: 0, end: 1 });
});

test("findBlock: 壊れた目印は MARKERS_BROKEN（4 通り）", () => {
  const cases = {
    beginだけ: `${BEGIN}\na\n`,
    endだけ: `a\n${END}\n`,
    逆順: `${END}\n${BEGIN}\n`,
    二組: `${BEGIN}\n${END}\n${BEGIN}\n${END}\n`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const r = findBlock(text, M, ".gitignore");
    assert.equal(r.code, "MARKERS_BROKEN", name);
    assert.equal(r.file, ".gitignore", name);
    assert.ok(r.detail.length > 0, name);
  }
});

test("upsertBlock: text が null なら区画だけの新しい内容", () => {
  assert.deepEqual(up(null), { text: `${BEGIN}\na\nb\n${END}\n`, created: true });
});

test("upsertBlock: 区画が無ければ空行 1 つを挟んで末尾に足し、外は変えない", () => {
  const orig = "node_modules\n.env\n";
  const r = up(orig);
  assert.equal(r.created, true);
  assert.equal(r.text, `${orig}\n${BEGIN}\na\nb\n${END}\n`);
  assert.ok(r.text.startsWith(orig));
});

test("upsertBlock: 末尾に改行が無いファイルは改行を補ってから足す", () => {
  const r = up("a");
  assert.equal(r.text, `a\n\n${BEGIN}\na\nb\n${END}\n`);
});

test("upsertBlock: 空文字のファイルには空行を挟まない", () => {
  assert.equal(up("").text, `${BEGIN}\na\nb\n${END}\n`);
});

test("upsertBlock: 区画があれば中だけ置き換え、前後は 1 文字も変えない", () => {
  const pre = "top\n\n";
  const post = "\nbottom";
  const orig = `${pre}${BEGIN}\nold\n${END}${post}`;
  const r = up(orig, "new1\nnew2");
  assert.equal(r.created, false);
  assert.equal(r.text, `${pre}${BEGIN}\nnew1\nnew2\n${END}${post}`);
});

test("upsertBlock: 2 回続けても同じ内容（冪等）", () => {
  for (const orig of ["x\n", "x", "", "x\r\ny\r\n", null]) {
    const once = up(orig).text;
    const twice = up(once);
    assert.equal(twice.text, once);
    assert.equal(twice.created, false);
  }
});

test("upsertBlock: 壊れた目印は MARKERS_BROKEN で file を入れる", () => {
  const r = up(`${BEGIN}\n`);
  assert.equal(r.code, "MARKERS_BROKEN");
  assert.equal(r.file, ".gitignore");
});

test("upsertBlock: CRLF のファイルでは追加する行も CRLF", () => {
  const r = up("a\r\nb\r\n");
  assert.equal(r.text, `a\r\nb\r\n\r\n${BEGIN}\r\na\r\nb\r\n${END}\r\n`);
  assert.ok(!/[^\r]\n/.test(r.text));
  // 置き換えでも CRLF のまま、外は不変
  const r2 = up(r.text, "z");
  assert.equal(r2.text, `a\r\nb\r\n\r\n${BEGIN}\r\nz\r\n${END}\r\n`);
});

test("upsertBlock: LF のファイルでは LF のまま", () => {
  assert.ok(!up("a\nb\n").text.includes("\r"));
});

test("upsertBlock: CLAUDE.md 用の目印でも動く", () => {
  const cm = CLAUDE_MD_MARKERS;
  const b = "<!-- cc-sdd-bootstrap:begin 管理 -->";
  const e = "<!-- cc-sdd-bootstrap:end -->";
  const r = upsertBlock({ text: "# T\n", markers: cm, beginLine: b, endLine: e, body: "@x.md", file: "CLAUDE.md" });
  assert.equal(r.text, `# T\n\n${b}\n@x.md\n${e}\n`);
  assert.deepEqual(findBlock(r.text, cm), { start: 2, end: 4 });
});

test("removeBlock: 区画と直前の空行 1 つを取り除き、外は変えない", () => {
  const orig = "a\nb\n";
  const added = up(orig).text;
  assert.deepEqual(removeBlock({ text: added, markers: M, file: ".gitignore" }), { text: orig, removed: true });
});

test("removeBlock: 区画の後ろの内容は残る", () => {
  const r = removeBlock({ text: `a\n\n${BEGIN}\nx\n${END}\nz\n`, markers: M, file: "f" });
  assert.deepEqual(r, { text: "a\nz\n", removed: true });
});

test("removeBlock: 直前が空行でなければ空行は取らない", () => {
  const r = removeBlock({ text: `a\n${BEGIN}\nx\n${END}\n`, markers: M, file: "f" });
  assert.equal(r.text, "a\n");
});

test("removeBlock: 区画だけのファイルは空文字になる", () => {
  const r = removeBlock({ text: up(null).text, markers: M, file: "f" });
  assert.deepEqual(r, { text: "", removed: true });
});

test("removeBlock: 区画が無ければ removed false で同じ内容", () => {
  assert.deepEqual(removeBlock({ text: "a\n", markers: M, file: "f" }), { text: "a\n", removed: false });
});

test("removeBlock: 壊れた目印は MARKERS_BROKEN", () => {
  const r = removeBlock({ text: `${END}\n${BEGIN}\n`, markers: M, file: "f" });
  assert.equal(r.code, "MARKERS_BROKEN");
  assert.equal(r.file, "f");
});

test("往復: upsert → remove で元に戻る（LF・CRLF・空）", () => {
  for (const orig of ["a\nb\n", "a\r\nb\r\n", "", "\n", "a\n\n"]) {
    const r = removeBlock({ text: up(orig).text, markers: M, file: "f" });
    assert.equal(r.text, orig, JSON.stringify(orig));
  }
});

for (const [name, markers] of [[".gitignore", GITIGNORE_MARKERS], ["運用文書", AGENT_SECTION_MARKERS]]) {
  test(`新しい区画処理: ${name} の追加・置き換え・取り除きは外側を保ち、重複しない`, () => {
    const prefix = `先頭${name}\r\n`;
    const suffix = "末尾\r\n";
    const once = replaceBlock(prefix + suffix, markers, "本文", name);
    assert.equal(typeof once, "string");
    assert.ok(!/(^|[^\r])\n/.test(once));
    assert.ok(once.startsWith(prefix));
    assert.ok(once.includes(prefix + suffix));
    assert.equal((once.match(new RegExp(markers.begin, "g")) ?? []).length, 1);
    const twice = replaceBlock(once, markers, "本文", name);
    assert.equal(twice, once);
    const changed = replaceBlock(once, markers, "新しい本文", name);
    assert.ok(changed.includes("新しい本文"));
    assert.ok(changed.startsWith(prefix));
    assert.ok(changed.includes(prefix + suffix));
    assert.equal(removeBlock(changed, markers, name), prefix + suffix);
  });

  test(`新しい区画処理: ${name} の片方だけ・逆順・複数組をエラーにする`, () => {
    const invalid = [
      markers.begin + "\n",
      markers.end + "\n",
      `${markers.end}\n${markers.begin}\n`,
      `${markers.begin}\n${markers.end}\n${markers.begin}\n${markers.end}\n`,
    ];
    for (const text of invalid) {
      const found = findBlock(text, markers, name);
      assert.equal(found.code, "MARKERS_BROKEN");
      assert.equal(found.file, name);
      assert.ok(found.detail);
      const replaced = replaceBlock(text, markers, "本文", name);
      assert.equal(replaced.code, "MARKERS_BROKEN");
      const removed = removeBlock(text, markers, name);
      assert.equal(removed.code, "MARKERS_BROKEN");
    }
  });
}
