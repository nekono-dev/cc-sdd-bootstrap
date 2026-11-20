// 配置の記録の解釈・作成と、書き換えの判定の単体テスト
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLedger, buildLedger, serializeLedger, decideModified, sha256 } from "../lib/ledger.mjs";

const H1 = "a".repeat(64);
const valid = (over = {}) =>
  JSON.stringify({ format: 1, bootstrapVersion: "0.1.0", files: { "a/x": { kind: "common", sha256: H1 } }, ...over });

test("sha256 は 64 桁の 16 進", () => {
  assert.equal(sha256(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("parseLedger: 旧形式の記録は Claude Code の配置として読む", () => {
  const l = parseLedger(valid());
  assert.deepEqual(l, { format: 1, bootstrapVersion: "0.1.0", clients: "claude", files: { "a/x": { kind: "common", sha256: H1 } } });
});

test("parseLedger: 無い・壊れている・形が違うときは null", () => {
  assert.equal(parseLedger(null), null);
  assert.equal(parseLedger(""), null);
  assert.equal(parseLedger("{"), null);
  assert.equal(parseLedger("[]"), null);
  assert.equal(parseLedger("null"), null);
  assert.equal(parseLedger(valid({ format: 2 })), null);
  assert.equal(parseLedger(valid({ clients: "other" })), null);
  assert.equal(parseLedger(valid({ clients: null })), null);
  assert.equal(parseLedger(valid({ format: "1" })), null);
  assert.equal(parseLedger(valid({ bootstrapVersion: 1 })), null);
  assert.equal(parseLedger(valid({ files: [] })), null);
  assert.equal(parseLedger(valid({ files: null })), null);
  assert.equal(parseLedger(valid({ files: { a: { kind: "other", sha256: H1 } } })), null);
  assert.equal(parseLedger(valid({ files: { a: { kind: "common", sha256: "xyz" } } })), null);
  assert.equal(parseLedger(valid({ files: { a: { kind: "common", sha256: "A".repeat(64) } } })), null);
  assert.equal(parseLedger(valid({ files: { a: "str" } })), null);
});

test("parseLedger: __proto__ などのキーは通さない", () => {
  const text = `{"format":1,"bootstrapVersion":"1","files":{"__proto__":{"kind":"common","sha256":"${H1}"}}}`;
  assert.equal(parseLedger(text), null);
  assert.equal(({}).kind, undefined);
  const c = `{"format":1,"bootstrapVersion":"1","files":{"constructor":{"kind":"common","sha256":"${H1}"}}}`;
  assert.equal(parseLedger(c), null);
});

test("buildLedger: 道筋の順に並べ、種類と SHA-256 を持つ", () => {
  const l = buildLedger("0.1.0", [
    { path: "b", kind: "project", content: Buffer.from("B") },
    { path: "a", kind: "common", content: Buffer.from("A") },
  ]);
  assert.equal(l.format, 1);
  assert.equal(l.bootstrapVersion, "0.1.0");
  assert.deepEqual(Object.keys(l.files), ["a", "b"]);
  assert.deepEqual(l.files.a, { kind: "common", sha256: sha256(Buffer.from("A")) });
});

test("serializeLedger: 並びが違っても同じ配置なら同じ文字列（10.3）", () => {
  const p1 = { path: "a", kind: "common", content: Buffer.from("A") };
  const p2 = { path: "b", kind: "project", content: Buffer.from("B") };
  const s1 = serializeLedger(buildLedger("1", [p1, p2]));
  const s2 = serializeLedger(buildLedger("1", [p2, p1]));
  assert.equal(s1, s2);
  assert.ok(s1.endsWith("}\n"));
  assert.ok(s1.includes('\n  "format": 1'));
  assert.deepEqual(parseLedger(s1), buildLedger("1", [p1, p2]));
});

test("decideModified: 記録にあれば記録の SHA-256 と比べる", () => {
  const cur = Buffer.from("same");
  const ledger = buildLedger("1", [{ path: "a", kind: "common", content: cur }]);
  assert.equal(decideModified({ ledger, path: "a", current: cur, incoming: Buffer.from("new") }), false);
  assert.equal(decideModified({ ledger, path: "a", current: Buffer.from("edit"), incoming: Buffer.from("new") }), true);
  // 削除の対象でも記録との比較
  assert.equal(decideModified({ ledger, path: "a", current: cur, incoming: null }), false);
  assert.equal(decideModified({ ledger, path: "a", current: Buffer.from("edit"), incoming: null }), true);
});

test("decideModified: 記録に無ければ新しい版の内容と比べる", () => {
  const cur = Buffer.from("x");
  const inc = Buffer.from("x");
  for (const ledger of [null, buildLedger("1", [])]) {
    assert.equal(decideModified({ ledger, path: "a", current: cur, incoming: inc }), false);
    assert.equal(decideModified({ ledger, path: "a", current: cur, incoming: Buffer.from("y") }), true);
    // 削除の対象で記録が無い: 安全側
    assert.equal(decideModified({ ledger, path: "a", current: cur, incoming: null }), true);
  }
});

test("decideModified: Object.prototype のキー名の道筋を記録ありと誤認しない", () => {
  const ledger = buildLedger("1", []);
  assert.equal(
    decideModified({ ledger, path: "constructor", current: Buffer.from("x"), incoming: null }),
    true,
  );
});

test("配置した導入対象をハッシュとともに書いて読み戻す", () => {
  const content = Buffer.from("配置物");
  for (const clients of ["claude", "codex", "both"]) {
    const ledger = buildLedger("0.1.0", [{ path: "shared", kind: "common", content }], clients);
    assert.equal(ledger.clients, clients);
    assert.deepEqual(parseLedger(serializeLedger(ledger)), ledger);
    assert.equal(ledger.files.shared.sha256, sha256(content));
  }
});
