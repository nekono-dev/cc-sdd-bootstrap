// 共有の定数が設計の値どおりであることの確認
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEPLOY_DIR,
  OWNED_MARKER,
  CONFIG_PATH,
  LEDGER_PATH,
} from "../lib/catalog.mjs";

test("DEPLOY_DIR は配置先のディレクトリ", () => {
  assert.equal(DEPLOY_DIR, ".agent-hooks/cc-sdd-bootstrap");
});

test("OWNED_MARKER は一式のフックの見分けの文字列", () => {
  assert.equal(OWNED_MARKER, "/.agent-hooks/cc-sdd-bootstrap/");
});

test("CONFIG_PATH は設定ファイルの名前", () => {
  assert.equal(CONFIG_PATH, ".cc-sdd-bootstrap.json");
});

test("LEDGER_PATH は配置の記録の道筋で、配置先の下にある", () => {
  assert.equal(LEDGER_PATH, ".agent-hooks/cc-sdd-bootstrap/installed.json");
  assert.ok(LEDGER_PATH.startsWith(`${DEPLOY_DIR}/`));
});
