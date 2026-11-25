import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_FORMAT, formatProblem } from "../.agent-hooks/cc-sdd-bootstrap/config-schema.mjs";
import { readFileSync } from "node:fs";
import { subagentsField } from "../.agent-hooks/cc-sdd-bootstrap/subagent-roles.mjs";
import { configFields as baseFields } from "../.agent-hooks/cc-sdd-bootstrap/config-schema.mjs";
import * as viaLib from "../lib/config-schema.mjs";

test("format が undefined の場合、適切なエラーメッセージを返す", () => {
  assert.strictEqual(
    formatProblem(undefined),
    "format: 形式の版がありません。cc-sdd-bootstrap の設定ファイルか確認してください"
  );
});

test("format が 0, -1, 1.5, '1', null, true の場合、整数チェックのエラーメッセージを返す", () => {
  const invalidValues = [0, -1, 1.5, "1", null, true];
  const expectedMessage = "format: 1 以上の整数で指定してください";

  for (const value of invalidValues) {
    assert.strictEqual(formatProblem(value), expectedMessage, `value: ${value}`);
  }
});

test("format が CONFIG_FORMAT の場合、null を返す", () => {
  assert.strictEqual(formatProblem(CONFIG_FORMAT), null);
});

test("format が CONFIG_FORMAT + 1 の場合、新しい形式のエラーメッセージを返す", () => {
  const nextVersion = CONFIG_FORMAT + 1;
  const expectedMessage = `format: この設定ファイルは新しい形式（${nextVersion}）で書かれています。cc-sdd-bootstrap を新しい版に上げてから実行してください`;
  assert.strictEqual(formatProblem(nextVersion), expectedMessage);
});

test("lib/config-schema.mjs 経由でも formatProblem が同一関数であること、および configFields の存在を確認", () => {
  assert.strictEqual(viaLib.formatProblem, formatProblem);
  assert.ok("configFields" in viaLib);
});

test("配置物の項目定義は導入に使う項目だけを持ち、何も読み込まない", () => {
  assert.deepEqual(baseFields.map((f) => f.path), ["ccSdd.version", "ccSdd.lang"]);
  const text = readFileSync(new URL("../.agent-hooks/cc-sdd-bootstrap/config-schema.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(text, /^\s*import\s/m);
  assert.doesNotMatch(text, /\bimport\s*\(/);
});

test("lib の configFields は基本の項目に役割表の項目をつなぐ", () => {
  assert.deepEqual(viaLib.configFields.map((f) => f.path), ["ccSdd.version", "ccSdd.lang", "subagents"]);
  assert.strictEqual(viaLib.configFields.at(-1), subagentsField);
});
