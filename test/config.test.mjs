// 設定処理の単体試験
import { test } from "node:test";
import assert from "node:assert/strict";
import { configFields } from "../lib/config-schema.mjs";
import {
  parseConfig,
  validateConfig,
  fillDefaults,
  serializeConfig,
} from "../lib/config.mjs";

test("設定処理: workflow の項目が無ければ既定値で補い、入力済みの値は保つ", () => {
  const parsed = parseConfig('{"format":1,"workflow":{"branchGate":false}}');
  assert.equal(validateConfig(parsed.config, configFields), null);
  const filled = fillDefaults(parsed.config, configFields);
  assert.equal(filled.config.workflow.branchGate, false);
  assert.equal(filled.config.workflow.prAfterValidate, true);
  assert.equal(filled.config.workflow.baseBranches, "main,master,develop");
  assert.ok(filled.filled.includes("workflow.prAfterValidate"));
  assert.ok(filled.filled.includes("workflow.baseBranches"));
  assert.ok(!filled.filled.includes("workflow.branchGate"));
});

test("設定処理: workflow.baseBranches の不正値は項目つきで拒否する", () => {
  const bad = parseConfig('{"format":1,"workflow":{"baseBranches":"main,,develop"}}');
  const error = validateConfig(bad.config, configFields);
  assert.equal(error.code, "CONFIG_INVALID");
  assert.match(error.messages[0], /^workflow\.baseBranches: /);
});

test("設定処理: format だけを必須にし、欠けた項目を補う", () => {
  const parsed = parseConfig('{"format":1,"extra":{"keep":true},"ccSdd":{"version":"3.2.0"}}');
  assert.equal(parsed.ok, true);
  assert.equal(validateConfig(parsed.config, configFields), null);
  const filled = fillDefaults(parsed.config, configFields);
  assert.deepEqual(filled.filled, [
    "ccSdd.lang",
    "codex.trustHooks",
    "workflow.branchGate",
    "workflow.prAfterValidate",
    "workflow.baseBranches",
    "subagents",
  ]);
  assert.equal(filled.config.ccSdd.version, "3.2.0");
  assert.deepEqual(filled.config.extra, { keep: true });
  assert.equal(serializeConfig(filled.config).endsWith("\n"), true);
});

test("設定処理: 不正値と format 欠落をファイル・項目・理由つきで返す", () => {
  const invalid = parseConfig('{"format":1,"ccSdd":{"version":"bad"}}');
  const error = validateConfig(invalid.config, configFields, "project.json");
  assert.equal(error.code, "CONFIG_INVALID");
  assert.equal(error.file, "project.json");
  assert.match(error.messages[0], /^ccSdd\.version: /);

  const missing = parseConfig("{}");
  const formatError = validateConfig(missing.config, configFields);
  assert.equal(formatError.code, "CONFIG_INVALID");
  assert.match(formatError.file, /\.cc-sdd-bootstrap\.json/);
  assert.match(formatError.messages[0], /^format: /);
});

test("設定処理: 読めない文字列のエラーにファイル名を付ける", () => {
  const result = parseConfig("{", "project.json");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CONFIG_UNREADABLE");
  assert.equal(result.error.file, "project.json");
  assert.match(result.error.messages[0], /理由|JSON/);
});

test("設定処理: 役割表の誤りを問題の項目つきで返し、旧項目（codex・models）は誤りにしない", () => {
  const bad = parseConfig('{"format":1,"subagents":{"maxModel":{"claude":"fable"}}}');
  const error = validateConfig(bad.config, configFields);
  assert.equal(error.code, "CONFIG_INVALID");
  assert.match(error.messages[0], /^subagents: .*subagents\.maxModel\.claude/);
  const old = parseConfig('{"format":1,"codex":{"enabled":true},"models":{"x":1}}');
  assert.equal(validateConfig(old.config, configFields), null);
  const filled = fillDefaults(old.config, configFields);
  // 旧項目の中身は保つ。項目 codex.trustHooks の既定値だけが補われる
  assert.deepEqual(filled.config.codex, { enabled: true, trustHooks: true });
  assert.deepEqual(filled.config.models, { x: 1 });
  assert.deepEqual(filled.config.subagents, {});
});
