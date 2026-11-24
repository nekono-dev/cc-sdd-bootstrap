import test from "node:test";
import assert from "node:assert/strict";
import { findBlock, upsertBlock, removeBlock, replaceBlock, GITIGNORE_MARKERS } from "../lib/blocks.mjs";
import { AGENT_SECTION_MARKERS } from "../lib/catalog.mjs";

test("目印の区画を追加・更新・取り外しできる", () => {
  const text = upsertBlock({ text: "# ignore\n", markers: GITIGNORE_MARKERS, beginLine: GITIGNORE_MARKERS.begin, endLine: GITIGNORE_MARKERS.end, body: "*.tmp", file: ".gitignore" });
  assert.match(text.text, /# ignore\n\n# >>> cc-sdd-bootstrap\n\*\.tmp/);
  const updated = upsertBlock({ text: text.text, markers: GITIGNORE_MARKERS, beginLine: GITIGNORE_MARKERS.begin, endLine: GITIGNORE_MARKERS.end, body: "*.log", file: ".gitignore" });
  assert.match(updated.text, /\*\.log/);
  assert.equal(removeBlock(updated.text, GITIGNORE_MARKERS, ".gitignore"), "# ignore\n");
});

test("区画の目印が壊れていると対象名つきで返す", () => {
  assert.equal(findBlock("<!-- cc-sdd-bootstrap:end -->\n", AGENT_SECTION_MARKERS, "CLAUDE.md").file, "CLAUDE.md");
});

for (const [name, markers] of [[".gitignore", GITIGNORE_MARKERS], ["運用文書", AGENT_SECTION_MARKERS]]) {
  test("区画処理: " + name + " の再適用・置き換え・取り外しで外側と CRLF を保つ", () => {
    const prefix = "先頭\r\n";
    const suffix = "末尾\r\n";
    const once = replaceBlock(prefix + suffix, markers, "本文", name);
    assert.equal(typeof once, "string");
    assert.ok(once.startsWith(prefix));
    assert.ok(once.includes(prefix + suffix));
    assert.ok(!/(^|[^\r])\n/.test(once));
    assert.equal(once.split(markers.begin).length - 1, 1);
    assert.equal(replaceBlock(once, markers, "本文", name), once);
    const changed = replaceBlock(once, markers, "変更後", name);
    assert.ok(changed.includes("変更後"));
    assert.ok(changed.startsWith(prefix));
    assert.ok(changed.includes(prefix + suffix));
    assert.equal(removeBlock(changed, markers, name), prefix + suffix);
  });

  test("区画処理: " + name + " の片方だけ・逆順・複数組は詳細つきエラー", () => {
    const invalid = [
      markers.begin + "\n",
      markers.end + "\n",
      markers.end + "\n" + markers.begin + "\n",
      markers.begin + "\n" + markers.end + "\n" + markers.begin + "\n" + markers.end + "\n",
    ];
    for (const text of invalid) {
      for (const result of [findBlock(text, markers, name), replaceBlock(text, markers, "本文", name), removeBlock(text, markers, name)]) {
        assert.equal(result.code, "MARKERS_BROKEN");
        assert.equal(result.file, name);
        assert.ok(result.detail);
      }
    }
  });
}
