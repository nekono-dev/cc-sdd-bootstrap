import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGitignoreLines } from "../lib/plan.mjs";
const lines = [
  ".claude/skills/kiro-*/",
  { line: ".kiro/settings/", when: { path: "ccSdd.keepTemplates", equals: false } },
  { line: ".kiro/settings/*", when: { path: "ccSdd.keepTemplates", equals: true } },
  { line: "!.kiro/settings/templates/", when: { path: "ccSdd.keepTemplates", equals: true } },
  "/.cache/",
];
const OFF = [".claude/skills/kiro-*/", ".kiro/settings/", "/.cache/"];
const ON = [".claude/skills/kiro-*/", ".kiro/settings/*", "!.kiro/settings/templates/", "/.cache/"];

test("文字列だけの配列は config が null でもそのまま返る", () => {
  const input = [".a/", ".b/"];
  assert.deepEqual(resolveGitignoreLines(input, null), [".a/", ".b/"]);
});

test("keepTemplates が false の設定では保持しない側の行になる", () => {
  assert.deepEqual(resolveGitignoreLines(lines, { format: 1, ccSdd: { keepTemplates: false } }), OFF);
});

test("keepTemplates が true の設定では保持する側の行になる", () => {
  assert.deepEqual(resolveGitignoreLines(lines, { format: 1, ccSdd: { keepTemplates: true } }), ON);
});

test("設定が null のときは既定値（false）で判定する", () => {
  assert.deepEqual(resolveGitignoreLines(lines, null), OFF);
});

test("設定に keepTemplates が無いときは既定値（false）で判定する", () => {
  assert.deepEqual(resolveGitignoreLines(lines, { format: 1, ccSdd: { version: "3.1.0" } }), OFF);
});

test("型が違う値（文字列 \"true\"）は一致せず、無条件の行だけが残る", () => {
  assert.deepEqual(
    resolveGitignoreLines(lines, { format: 1, ccSdd: { keepTemplates: "true" } }),
    [".claude/skills/kiro-*/", "/.cache/"],
  );
});
