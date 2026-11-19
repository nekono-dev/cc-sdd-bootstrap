import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allIgnoreLines, readSnapshot } from "../lib/target.mjs";

test("allIgnoreLines は打ち消し行を除外する", () => {
  const input = [
    ".a/",
    { line: ".b/", when: { path: "x", equals: true } },
    "!.c/",
    { line: "!.d/", when: { path: "x", equals: false } },
    "/.e/"
  ];
  const result = allIgnoreLines(input);
  assert.deepEqual(result, [".a/", ".b/", "/.e/"]);
});

test("allIgnoreLines は空配列を返す", () => {
  const result = allIgnoreLines([]);
  assert.deepEqual(result, []);
});

test("readSnapshot は allIgnoreLines の結果でフィルタリングできる", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ign-"));
  try {
    const files = [
      path.join(".kiro", "settings", "cc-sdd-guide.md"),
      path.join(".kiro", "settings", "templates", "a.md"),
      path.join(".cache", "cc-sdd-install.failed")
    ];
    for (const f of files) {
      const full = path.join(dir, f);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "x");
    }
    const lines = [
      ".claude/skills/kiro-*/",
      { line: ".kiro/settings/", when: { path: "ccSdd.keepTemplates", equals: false } },
      { line: ".kiro/settings/*", when: { path: "ccSdd.keepTemplates", equals: true } },
      { line: "!.kiro/settings/templates/", when: { path: "ccSdd.keepTemplates", equals: true } },
      "/.cache/"
    ];
    const filtered = allIgnoreLines(lines);
    const snapshot = readSnapshot(dir, [], filtered);
    assert.deepEqual(snapshot.ignoredPresent, [
      ".cache",
      ".kiro/settings",
      ".kiro/settings/cc-sdd-guide.md",
      ".kiro/settings/templates"
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
