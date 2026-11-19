// 計画の計算（ファイルの扱い）の単体テスト
import { test } from "node:test";
import assert from "node:assert/strict";
import { makePlan } from "../lib/plan.mjs";
import { catalog as realCatalog } from "../lib/catalog.mjs";
import { buildLedger, serializeLedger } from "../lib/ledger.mjs";

const D = ".agent-hooks/cc-sdd-bootstrap";
const C = `${D}/c.txt`;
const P = `${D}/p.txt`;
const B = (s) => Buffer.from(s);

const fakeCatalog = {
  files: [
    { path: C, kind: "common", executable: true },
    { path: P, kind: "project", executable: false },
  ],
  hooks: [],
  gitignore: [],
  claudeSections: [],
};

/** 記録の文字列を作る */
const ledgerText = (placed) => serializeLedger(buildLedger("0.1.0", placed));

/** 入力を組み立てる */
function input({ operation = "init", files = {}, ledger = null, packageFiles, catalog = fakeCatalog, force = false } = {}) {
  return {
    operation,
    config: null,
    snapshot: { config: null, ledger, settings: null, gitignore: null, claudeMd: null, files, ignoredPresent: [] },
    catalog,
    packageFiles: packageFiles ?? { [C]: B("new-c"), [P]: B("new-p") },
    bootstrapVersion: "0.1.0",
    force,
  };
}

test("初めての配置: 全て書く（注記なし）", () => {
  const plan = makePlan(input({ files: { [C]: null, [P]: null } }));
  assert.deepEqual(plan.blocks, []);
  assert.deepEqual(plan.changes, [
    { action: "write", path: C, content: B("new-c"), executable: true },
    { action: "write", path: P, content: B("new-p"), executable: false },
  ]);
});

test("同じ内容なら変更なし。固有の部分は存在すれば残す", () => {
  const plan = makePlan(
    input({
      operation: "update",
      files: { [C]: B("new-c"), [P]: B("mine") },
      ledger: ledgerText([{ path: C, kind: "common", content: B("new-c") }, { path: P, kind: "project", content: B("old-p") }]),
    }),
  );
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.blocks, []);
});

test("書き換えていない共通部分は新しい版で置き換える", () => {
  const plan = makePlan(
    input({
      operation: "update",
      files: { [C]: B("old-c"), [P]: B("p") },
      ledger: ledgerText([{ path: C, kind: "common", content: B("old-c") }]),
    }),
  );
  assert.deepEqual(plan.changes, [{ action: "write", path: C, content: B("new-c"), executable: true }]);
});

test("書き換えられた共通部分は中止の理由になる", () => {
  const plan = makePlan(
    input({
      operation: "update",
      files: { [C]: B("edited"), [P]: B("p") },
      ledger: ledgerText([{ path: C, kind: "common", content: B("old-c") }]),
    }),
  );
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.blocks.length, 1);
  assert.equal(plan.blocks[0].kind, "modified");
  assert.equal(plan.blocks[0].path, C);
  assert.ok(plan.blocks[0].detail.length > 0);
});

test("--force なら書き換えられた共通部分も上書き（overwritten）", () => {
  const plan = makePlan(
    input({
      operation: "update",
      force: true,
      files: { [C]: B("edited"), [P]: B("p") },
      ledger: ledgerText([{ path: C, kind: "common", content: B("old-c") }]),
    }),
  );
  assert.deepEqual(plan.blocks, []);
  assert.deepEqual(plan.changes, [{ action: "write", path: C, content: B("new-c"), executable: true, note: "overwritten" }]);
});

test("カタログから外れた書き換えなしのファイルは削除", () => {
  const old = `${D}/old.txt`;
  const plan = makePlan(
    input({
      operation: "update",
      files: { [C]: B("new-c"), [P]: B("p"), [old]: B("o") },
      ledger: ledgerText([{ path: C, kind: "common", content: B("new-c") }, { path: old, kind: "common", content: B("o") }]),
    }),
  );
  assert.deepEqual(plan.changes, [{ action: "delete", path: old }]);
});

test("カタログから外れた書き換え済みのファイルは中止、force なら削除", () => {
  const old = `${D}/old.txt`;
  const base = {
    operation: "update",
    files: { [C]: B("new-c"), [P]: B("p"), [old]: B("edited") },
    ledger: ledgerText([{ path: C, kind: "common", content: B("new-c") }, { path: old, kind: "common", content: B("o") }]),
  };
  const blocked = makePlan(input(base));
  assert.deepEqual(blocked.changes, []);
  assert.deepEqual(blocked.blocks.map((b) => [b.kind, b.path]), [["modified", old]]);
  const forced = makePlan(input({ ...base, force: true }));
  assert.deepEqual(forced.blocks, []);
  assert.deepEqual(forced.changes, [{ action: "delete", path: old }]);
});

test("カタログから外れて既に無いファイルは何もしない", () => {
  const old = `${D}/old.txt`;
  const plan = makePlan(
    input({
      operation: "update",
      files: { [C]: B("new-c"), [P]: B("p"), [old]: null },
      ledger: ledgerText([{ path: old, kind: "common", content: B("o") }]),
    }),
  );
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.blocks, []);
});

test("記録にある共通部分が無ければ restored で書き直す", () => {
  const plan = makePlan(
    input({
      operation: "update",
      files: { [C]: null, [P]: B("p") },
      ledger: ledgerText([{ path: C, kind: "common", content: B("old-c") }]),
    }),
  );
  assert.deepEqual(plan.changes, [{ action: "write", path: C, content: B("new-c"), executable: true, note: "restored" }]);
});

test("記録が無く同名で内容の違うファイルがあれば中止、force なら書く", () => {
  const files = { [C]: B("someone else"), [P]: B("p") };
  const blocked = makePlan(input({ files }));
  assert.deepEqual(blocked.blocks.map((b) => [b.kind, b.path]), [["modified", C]]);
  assert.deepEqual(blocked.changes, []);
  const forced = makePlan(input({ files, force: true }));
  assert.deepEqual(forced.blocks, []);
  assert.deepEqual(forced.changes, [{ action: "write", path: C, content: B("new-c"), executable: true, note: "overwritten" }]);
});

test("固有の部分は無ければ書く", () => {
  const plan = makePlan(input({ operation: "update", files: { [C]: B("new-c"), [P]: null } }));
  assert.deepEqual(plan.changes, [{ action: "write", path: P, content: B("new-p"), executable: false }]);
});

test("カタログと記録の外の道筋には触れない", () => {
  const other = "README.md";
  const plan = makePlan(input({ files: { [C]: null, [P]: null, [other]: B("x") } }));
  assert.ok(plan.changes.every((c) => c.path === C || c.path === P));
});

test("実際のカタログでも初めての配置で全ファイルを書く", () => {
  const packageFiles = Object.fromEntries(realCatalog.files.map((f) => [f.path, B(`content of ${f.path}`)]));
  const files = Object.fromEntries(realCatalog.files.map((f) => [f.path, null]));
  const plan = makePlan(input({ catalog: realCatalog, packageFiles, files }));
  assert.deepEqual(plan.blocks, []);
  assert.deepEqual(
    plan.changes.map((c) => [c.action, c.path, c.executable]),
    realCatalog.files.map((f) => ["write", f.path, f.executable]),
  );
});

test("記録にある管理区画の外の道筋は、あっても削除も中止もせず知らせる（force でも）", () => {
  const outside = ["../outside.txt", "src/app.js", "/etc/passwd", `${D}/../escape.txt`, "x/.agent-hooks/cc-sdd-bootstrap/y"];
  const placed = [{ path: C, kind: "common", content: B("new-c") }, ...outside.map((p) => ({ path: p, kind: "common", content: B("o") }))];
  const files = { [C]: B("new-c"), [P]: B("p"), ...Object.fromEntries(outside.map((p) => [p, B("edited")])) };
  for (const force of [false, true]) {
    const plan = makePlan(input({ operation: "update", force, files, ledger: ledgerText(placed) }));
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(plan.blocks, []);
    assert.equal(plan.notices.length, 1);
    for (const p of outside) assert.ok(plan.notices[0].includes(p));
  }
});

test("カタログから外れた固有の部分: 書き換えなしは削除、書き換え済みは残して知らせる", () => {
  const old = `${D}/old-project.txt`;
  const base = {
    operation: "update",
    ledger: ledgerText([{ path: C, kind: "common", content: B("new-c") }, { path: old, kind: "project", content: B("o") }]),
  };
  const clean = makePlan(input({ ...base, files: { [C]: B("new-c"), [P]: B("p"), [old]: B("o") } }));
  assert.deepEqual(clean.changes, [{ action: "delete", path: old }]);
  for (const force of [false, true]) {
    const kept = makePlan(input({ ...base, force, files: { [C]: B("new-c"), [P]: B("p"), [old]: B("edited") } }));
    assert.deepEqual(kept.changes, []);
    assert.deepEqual(kept.blocks, []);
    assert.equal(kept.notices.length, 1);
    assert.ok(kept.notices[0].includes(old));
  }
});
