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
  assert.deepEqual(baseFields.map((f) => f.path), [
    "ccSdd.version",
    "ccSdd.lang",
    "codex.trustHooks",
    "workflow.branchGate",
    "workflow.prAfterValidate",
    "workflow.baseBranches",
  ]);
  const text = readFileSync(new URL("../.agent-hooks/cc-sdd-bootstrap/config-schema.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(text, /^\s*import\s/m);
  assert.doesNotMatch(text, /\bimport\s*\(/);
});

test("lib の configFields は基本の項目に役割表の項目をつなぐ", () => {
  assert.deepEqual(viaLib.configFields.map((f) => f.path), [
    "ccSdd.version",
    "ccSdd.lang",
    "codex.trustHooks",
    "workflow.branchGate",
    "workflow.prAfterValidate",
    "workflow.baseBranches",
    "subagents",
  ]);
  assert.strictEqual(viaLib.configFields.at(-1), subagentsField);
});

test("codex.trustHooks は真偽値・既定 true の項目で、flag と question を持たない", () => {
  const field = baseFields.find((f) => f.path === "codex.trustHooks");
  assert.ok(field, "codex.trustHooks の項目が無い");
  assert.strictEqual(field.kind, "boolean");
  assert.strictEqual(field.defaultValue, true);
  assert.strictEqual("flag" in field, false);
  assert.strictEqual("question" in field, false);
});

test("codex.trustHooks は true・false を受け付け、それ以外は日本語の理由を返す", () => {
  const field = baseFields.find((f) => f.path === "codex.trustHooks");
  assert.strictEqual(field.validate(true), null);
  assert.strictEqual(field.validate(false), null);
  for (const value of ["true", "false", 1, 0, null, undefined, {}]) {
    assert.strictEqual(field.validate(value), "true か false で指定してください", `value: ${String(value)}`);
  }
});

test("lib の configFields に codex.trustHooks がつながる", () => {
  assert.ok(viaLib.configFields.some((f) => f.path === "codex.trustHooks"));
});

test("workflow.branchGate・workflow.prAfterValidate は真偽値・既定 true で、flag・question・notice を持たない", () => {
  for (const path of ["workflow.branchGate", "workflow.prAfterValidate"]) {
    const field = baseFields.find((f) => f.path === path);
    assert.ok(field, `${path} の項目が無い`);
    assert.strictEqual(field.kind, "boolean", path);
    assert.strictEqual(field.defaultValue, true, path);
    for (const key of ["flag", "question", "notice"]) {
      assert.strictEqual(key in field, false, `${path} に ${key} がある`);
    }
    assert.strictEqual(field.validate(true), null, path);
    assert.strictEqual(field.validate(false), null, path);
    for (const value of ["true", 1, null, {}]) {
      assert.strictEqual(field.validate(value), "true か false で指定してください", `${path}: ${String(value)}`);
    }
  }
});

test("workflow.baseBranches は文字列・既定 main,master,develop で、flag・question・notice を持たない", () => {
  const field = baseFields.find((f) => f.path === "workflow.baseBranches");
  assert.ok(field, "workflow.baseBranches の項目が無い");
  assert.strictEqual(field.kind, "string");
  assert.strictEqual(field.defaultValue, "main,master,develop");
  for (const key of ["flag", "question", "notice"]) {
    assert.strictEqual(key in field, false, `workflow.baseBranches に ${key} がある`);
  }
});

test("workflow.baseBranches は正しい一覧を受け付け、不正な値を日本語の理由で拒否する", () => {
  const field = baseFields.find((f) => f.path === "workflow.baseBranches");
  for (const value of ["main", "main,master,develop", "release/1.0,trunk", "dev_x,feature/a-b"]) {
    assert.strictEqual(field.validate(value), null, `受け付けるべき値: ${value}`);
  }
  const rejected = {
    "": "空",
    " ": "空白だけ",
    "main,": "末尾のカンマで空の要素",
    ",main": "先頭のカンマで空の要素",
    "main,,develop": "途中の空の要素",
    "main, develop": "空白入り",
    "main\tdevelop": "タブ入り",
    "main\u0007": "制御文字入り",
    "main\u0085next": "C1 制御文字（NEL）入り",
    "main\u009fx": "C1 制御文字（APC）入り",
    "-main": "先頭が -",
    "main,-x": "要素の先頭が -",
  };
  for (const [value, label] of Object.entries(rejected)) {
    const reason = field.validate(value);
    assert.equal(typeof reason, "string", `${label} が拒否されない: ${JSON.stringify(value)}`);
    assert.notEqual(reason, "", label);
  }
  assert.equal(typeof field.validate(["main"]), "string", "配列は拒否する");
  assert.equal(typeof field.validate(1), "string", "数値は拒否する");
});
