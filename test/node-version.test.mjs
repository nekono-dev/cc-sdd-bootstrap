import { test } from "node:test";
import assert from "node:assert/strict";
import { decideNodeSupported, REQUIRED_NODE_MAJOR } from "../lib/node-version.mjs";

test("必要な版は 22", () => {
  assert.equal(REQUIRED_NODE_MAJOR, 22);
});

test("22 以上は対応している", () => {
  for (const v of ["22.0.0", "22.16.0", "23.1.2", "30.0.0"]) {
    assert.equal(decideNodeSupported(v).supported, true, v);
  }
});

test("22 未満は対応していない", () => {
  for (const v of ["21.9.9", "20.11.1", "18.0.0", "9.0.0"]) {
    const r = decideNodeSupported(v);
    assert.equal(r.supported, false, v);
    assert.equal(r.required, 22);
  }
});

test("先頭の数が 2 桁のとき文字の比較にならない（9 < 22）", () => {
  assert.equal(decideNodeSupported("9.11.2").supported, false);
  assert.equal(decideNodeSupported("100.0.0").supported, true);
});

test("読み取れない版は対応していない扱い", () => {
  for (const v of ["", "abc", undefined, null]) {
    assert.equal(decideNodeSupported(v).supported, false, String(v));
  }
});
