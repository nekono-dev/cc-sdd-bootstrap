// 新しい設定処理の単体試験
import { test } from "node:test";
import assert from "node:assert/strict";
import { configFields } from "../lib/config-schema.mjs";
import {
  parseConfigNew,
  validateConfigNew,
  fillDefaultsNew,
  serializeConfigNew,
} from "../lib/config.mjs";

test("新しい設定処理: format だけを必須にし、欠けた項目を補う", () => {
  const parsed = parseConfigNew('{"format":1,"extra":{"keep":true},"ccSdd":{"version":"3.2.0"}}');
  assert.equal(parsed.ok, true);
  assert.equal(validateConfigNew(parsed.config, configFields), null);
  const filled = fillDefaultsNew(parsed.config, configFields);
  assert.deepEqual(filled.filled, ["ccSdd.lang", "ccSdd.keepTemplates", "codex.enabled", "models"]);
  assert.equal(filled.config.ccSdd.version, "3.2.0");
  assert.deepEqual(filled.config.extra, { keep: true });
  assert.equal(serializeConfigNew(filled.config).endsWith("\n"), true);
});

test("新しい設定処理: 不正値と format 欠落をファイル・項目・理由つきで返す", () => {
  const invalid = parseConfigNew('{"format":1,"ccSdd":{"version":"bad"}}');
  const error = validateConfigNew(invalid.config, configFields, "project.json");
  assert.equal(error.code, "CONFIG_INVALID");
  assert.equal(error.file, "project.json");
  assert.match(error.messages[0], /^ccSdd\.version: /);

  const missing = parseConfigNew("{}");
  const formatError = validateConfigNew(missing.config, configFields);
  assert.equal(formatError.code, "CONFIG_INVALID");
  assert.match(formatError.file, /\.cc-sdd-bootstrap\.json/);
  assert.match(formatError.messages[0], /^format: /);
});

test("新しい設定処理: 読めない文字列のエラーにファイル名を付ける", () => {
  const result = parseConfigNew("{", "project.json");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CONFIG_UNREADABLE");
  assert.equal(result.error.file, "project.json");
  assert.match(result.error.messages[0], /理由|JSON/);
});

test("新しい設定処理: 項目定義が受け入れる map キーを保持する", () => {
  const parsed = parseConfigNew('{"format":1,"models":{"constructor":"gpt-5"}}');
  assert.equal(parsed.ok, true);
  assert.equal(validateConfigNew(parsed.config, configFields), null);
  const filled = fillDefaultsNew(parsed.config, configFields);
  assert.equal(Object.hasOwn(filled.config.models, "constructor"), true);
  assert.equal(filled.config.models.constructor, "gpt-5");
});
