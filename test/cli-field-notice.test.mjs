import { formatSuccess } from "../lib/cli.mjs";
import { configFields } from "../lib/config-schema.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const notice = configFields.find((f) => f.path === "ccSdd.keepTemplates").notice;
const on = { format: 1, ccSdd: { keepTemplates: true } };
const off = { format: 1, ccSdd: { keepTemplates: false } };

test("init で保持を選ぶと、お知らせに項目の文が出る", () => {
  const out = formatSuccess({ operation: "init", plan: { changes: [], notices: [] }, config: on });
  assert.ok(out.includes(`お知らせ:\n  ${notice}`));
});

test("update でも、保持を選んでいれば項目の文が出る", () => {
  const out = formatSuccess({ operation: "update", plan: { changes: [{ action: "write", path: "a.txt", existed: false }], notices: [] }, config: on });
  assert.ok(out.includes(`お知らせ:\n  ${notice}`));
});

test("保持を選んでいなければ、お知らせの節も MIT の文も出ない", () => {
  const out = formatSuccess({ operation: "init", plan: { changes: [], notices: [] }, config: off });
  assert.ok(!out.includes("MIT"));
  assert.ok(!out.includes("お知らせ:"));
});

test("設定が null でも例外を投げず、お知らせの節は出ない", () => {
  const out = formatSuccess({ operation: "init", plan: { changes: [], notices: [] }, config: null });
  assert.ok(!out.includes("お知らせ:"));
});

test("uninstall では項目の文を出さない", () => {
  const out = formatSuccess({ operation: "uninstall", plan: { changes: [], notices: [] }, config: on });
  assert.ok(!out.includes(notice));
});

test("計画の注記を先に、項目の文を後ろに並べる", () => {
  const out = formatSuccess({ operation: "update", plan: { changes: [], notices: ["先の注記"] }, config: on });
  assert.ok(out.includes(`お知らせ:\n  先の注記\n  ${notice}`));
});

test("変更が無くても、保持を選んでいれば項目の文が出る", () => {
  const out = formatSuccess({ operation: "init", plan: { changes: [], notices: [] }, config: on });
  assert.ok(out.includes(`お知らせ:\n  ${notice}`));
});
