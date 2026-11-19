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

const EXTRA = new Set([".cc-sdd-bootstrap.json", ".agent-hooks/cc-sdd-bootstrap/installed.json", ".claude/settings.json", ".gitignore", "CLAUDE.md"]);
/** 配置物の扱いだけを見るため、設定・記録・settings・区画の変更と作り直しの注記を除く */
function filesOnly(i) {
  const plan = makePlan(i);
  return {
    ...plan,
    changes: plan.changes.filter((c) => !EXTRA.has(c.path)),
    notices: plan.notices.filter((n) => !n.includes("作り直した")),
  };
}

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
  const plan = filesOnly(input({ files: { [C]: null, [P]: null } }));
  assert.deepEqual(plan.blocks, []);
  assert.deepEqual(plan.changes, [
    { action: "write", path: C, content: B("new-c"), executable: true },
    { action: "write", path: P, content: B("new-p"), executable: false },
  ]);
});

test("同じ内容なら変更なし。固有の部分は存在すれば残す", () => {
  const plan = filesOnly(
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
  const plan = filesOnly(
    input({
      operation: "update",
      files: { [C]: B("old-c"), [P]: B("p") },
      ledger: ledgerText([{ path: C, kind: "common", content: B("old-c") }]),
    }),
  );
  assert.deepEqual(plan.changes, [{ action: "write", path: C, content: B("new-c"), executable: true }]);
});

test("書き換えられた共通部分は中止の理由になる", () => {
  const plan = filesOnly(
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
  const plan = filesOnly(
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
  const plan = filesOnly(
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
  const blocked = filesOnly(input(base));
  assert.deepEqual(blocked.changes, []);
  assert.deepEqual(blocked.blocks.map((b) => [b.kind, b.path]), [["modified", old]]);
  const forced = filesOnly(input({ ...base, force: true }));
  assert.deepEqual(forced.blocks, []);
  assert.deepEqual(forced.changes, [{ action: "delete", path: old }]);
});

test("カタログから外れて既に無いファイルは何もしない", () => {
  const old = `${D}/old.txt`;
  const plan = filesOnly(
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
  const plan = filesOnly(
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
  const blocked = filesOnly(input({ files }));
  assert.deepEqual(blocked.blocks.map((b) => [b.kind, b.path]), [["modified", C]]);
  assert.deepEqual(blocked.changes, []);
  const forced = filesOnly(input({ files, force: true }));
  assert.deepEqual(forced.blocks, []);
  assert.deepEqual(forced.changes, [{ action: "write", path: C, content: B("new-c"), executable: true, note: "overwritten" }]);
});

test("固有の部分は無ければ書く", () => {
  const plan = filesOnly(input({ operation: "update", files: { [C]: B("new-c"), [P]: null } }));
  assert.deepEqual(plan.changes, [{ action: "write", path: P, content: B("new-p"), executable: false }]);
});

test("カタログと記録の外の道筋には触れない", () => {
  const other = "README.md";
  const plan = filesOnly(input({ files: { [C]: null, [P]: null, [other]: B("x") } }));
  assert.ok(plan.changes.every((c) => c.path === C || c.path === P));
});

test("実際のカタログでも初めての配置で全ファイルを書く", () => {
  const packageFiles = Object.fromEntries(realCatalog.files.map((f) => [f.path, B(`content of ${f.path}`)]));
  const files = Object.fromEntries(realCatalog.files.map((f) => [f.path, null]));
  const plan = filesOnly(input({ catalog: realCatalog, packageFiles, files }));
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
    const plan = filesOnly(input({ operation: "update", force, files, ledger: ledgerText(placed) }));
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
  const clean = filesOnly(input({ ...base, files: { [C]: B("new-c"), [P]: B("p"), [old]: B("o") } }));
  assert.deepEqual(clean.changes, [{ action: "delete", path: old }]);
  for (const force of [false, true]) {
    const kept = filesOnly(input({ ...base, force, files: { [C]: B("new-c"), [P]: B("p"), [old]: B("edited") } }));
    assert.deepEqual(kept.changes, []);
    assert.deepEqual(kept.blocks, []);
    assert.equal(kept.notices.length, 1);
    assert.ok(kept.notices[0].includes(old));
  }
});

// ---- 3.2 導入と更新の統合の計算 ----
import { sha256, parseLedger } from "../lib/ledger.mjs";
import { CONFIG_PATH, LEDGER_PATH } from "../lib/catalog.mjs";
import { GITIGNORE_BEGIN_LINE, CLAUDE_MD_BEGIN_LINE } from "../lib/plan.mjs";

const hookCmd = `node "$CLAUDE_PROJECT_DIR"/${D}/x.mjs`;
const fullCatalog = {
  files: fakeCatalog.files,
  hooks: [{ event: "SessionStart", command: hookCmd }],
  gitignore: [".cache/", "foo"],
  claudeSections: [{ id: "a", body: "# A\n@a.md\n" }, { id: "b", body: "B" }],
};
const cfg = { format: 1, a: 1 };
const fullInput = (o = {}) => {
  const i = input({ catalog: fullCatalog, files: { [C]: null, [P]: null }, ...o });
  i.config = cfg;
  return i;
};
/** 計画の結果を状態に反映して次の入力にする */
function applyPlan(i, plan) {
  const snap = { ...i.snapshot, files: { ...i.snapshot.files } };
  const keyOf = { [CONFIG_PATH]: "config", [LEDGER_PATH]: "ledger", ".claude/settings.json": "settings", ".gitignore": "gitignore", "CLAUDE.md": "claudeMd" };
  for (const c of plan.changes) {
    const v = c.action === "write" ? c.content : null;
    if (keyOf[c.path]) snap[keyOf[c.path]] = v === null ? null : v.toString("utf8");
    else snap.files[c.path] = v;
  }
  return { ...i, operation: "update", snapshot: snap };
}

test("初回: 配置物・設定・記録・settings・.gitignore・CLAUDE.md を順に書く", () => {
  const plan = makePlan(fullInput());
  assert.deepEqual(plan.blocks, []);
  assert.deepEqual(plan.changes.map((c) => c.path), [C, P, CONFIG_PATH, LEDGER_PATH, ".claude/settings.json", ".gitignore", "CLAUDE.md"]);
  const by = Object.fromEntries(plan.changes.map((c) => [c.path, c.content.toString()]));
  assert.equal(by[CONFIG_PATH], '{\n  "format": 1,\n  "a": 1\n}\n');
  assert.equal(by[".gitignore"], `${GITIGNORE_BEGIN_LINE}\n.cache/\nfoo\n# <<< cc-sdd-bootstrap\n`);
  assert.equal(by["CLAUDE.md"], `${CLAUDE_MD_BEGIN_LINE}\n# A\n@a.md\n\nB\n<!-- cc-sdd-bootstrap:end -->\n`);
  assert.equal(JSON.parse(by[".claude/settings.json"]).hooks.SessionStart[0].hooks[0].command, hookCmd);
});

test("結果を状態に戻すと変更なし（冪等）。初回に注記も出ない", () => {
  const i = fullInput();
  const plan = makePlan(i);
  assert.deepEqual(plan.notices, []);
  const again = makePlan(applyPlan(i, plan));
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.blocks, []);
});

test("記録はカタログのファイルだけを正しい sha で載せる", () => {
  const plan = makePlan(fullInput());
  const led = parseLedger(plan.changes.find((c) => c.path === LEDGER_PATH).content.toString());
  assert.deepEqual(Object.keys(led.files).sort(), [C, P]);
  assert.equal(led.files[C].sha256, sha256(B("new-c")));
  assert.equal(led.files[P].kind, "project");
});

test("残した固有の部分は前の記録の sha を引き継ぎ、記録に無ければ載せない", () => {
  const i = fullInput({
    operation: "update",
    files: { [C]: B("new-c"), [P]: B("mine") },
    ledger: ledgerText([{ path: C, kind: "common", content: B("new-c") }, { path: P, kind: "project", content: B("old-p") }]),
  });
  const led1 = parseLedger(makePlan(i).changes.find((c) => c.path === LEDGER_PATH)?.content.toString() ?? i.snapshot.ledger);
  assert.equal(led1.files[P].sha256, sha256(B("old-p")));
  const j = fullInput({ operation: "update", files: { [C]: B("new-c"), [P]: B("mine") }, ledger: ledgerText([{ path: C, kind: "common", content: B("new-c") }]) });
  const led2 = parseLedger(makePlan(j).changes.find((c) => c.path === LEDGER_PATH)?.content.toString() ?? j.snapshot.ledger);
  assert.deepEqual(Object.keys(led2.files), [C]);
});

test("利用者の内容は settings・.gitignore・CLAUDE.md で保たれる", () => {
  const i = fullInput();
  i.snapshot.settings = JSON.stringify({ model: "x" });
  i.snapshot.gitignore = "node_modules\n";
  i.snapshot.claudeMd = "# 私の\n";
  const by = Object.fromEntries(makePlan(i).changes.map((c) => [c.path, c.content?.toString()]));
  assert.equal(JSON.parse(by[".claude/settings.json"]).model, "x");
  assert.ok(by[".gitignore"].startsWith("node_modules\n\n"));
  assert.ok(by["CLAUDE.md"].startsWith("# 私の\n\n"));
});

test("目印の破損と settings の読めなさを同時に集める", () => {
  const i = fullInput();
  i.snapshot.settings = "{";
  i.snapshot.gitignore = "# >>> cc-sdd-bootstrap\n";
  i.snapshot.claudeMd = "<!-- cc-sdd-bootstrap:end -->\n";
  const plan = makePlan(i);
  assert.deepEqual(plan.blocks.map((b) => [b.kind, b.path]), [["settings", ".claude/settings.json"], ["markers", ".gitignore"], ["markers", "CLAUDE.md"]]);
  assert.ok(!plan.changes.some((c) => [".gitignore", "CLAUDE.md", ".claude/settings.json"].includes(c.path)));
});

test("update で管理区画が無ければ作り直して知らせる", () => {
  const i = fullInput();
  const applied = applyPlan(i, makePlan(i));
  applied.snapshot.claudeMd = "# 私の\n";
  applied.snapshot.gitignore = "x\n";
  const plan = makePlan(applied);
  assert.equal(plan.notices.length, 2);
  assert.ok(plan.notices.every((n) => n.includes("管理区画")));
});

test("settings が空になる場合は削除する", () => {
  const i = fullInput({ catalog: { ...fullCatalog, hooks: [] } });
  i.snapshot.settings = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCmd.replace("x.mjs", "x.mjs") }] }] } });
  const plan = makePlan(i);
  assert.deepEqual(plan.changes.find((c) => c.path === ".claude/settings.json"), { action: "delete", path: ".claude/settings.json" });
});

// ---- 3.3 取り除きの計画 ----
/** 取り除きの入力。init の結果を状態にしたものを土台にする */
function installed(o = {}) {
  const i = fullInput();
  i.snapshot.settings = '{\n  "model": "x"\n}\n';
  i.snapshot.gitignore = "node_modules\n";
  i.snapshot.claudeMd = "# 私の\n";
  const applied = applyPlan(i, makePlan(i));
  return { ...applied, operation: "uninstall", config: null, force: false, ...o };
}
const uninstallPlan = (i) => makePlan(i);

test("取り除き: init の結果から元の settings・.gitignore・CLAUDE.md に戻り、設定・記録・配置物を削除する", () => {
  const i = installed();
  const plan = uninstallPlan(i);
  assert.deepEqual(plan.blocks, []);
  const next = applyPlan(i, plan).snapshot;
  assert.equal(next.settings, '{\n  "model": "x"\n}\n');
  assert.equal(next.gitignore, "node_modules\n");
  assert.equal(next.claudeMd, "# 私の\n");
  assert.equal(next.config, null);
  assert.equal(next.ledger, null);
  assert.equal(next.files[C], null);
  assert.equal(next.files[P], null);
  assert.deepEqual(plan.pruneDirs, [D, ".agent-hooks"]);
  assert.deepEqual(plan.notices, []);
});

test("取り除き: 書き換えられた共通部分は中止の理由、force なら削除", () => {
  const i = installed();
  i.snapshot.files[C] = B("edited");
  const plan = uninstallPlan(i);
  assert.deepEqual(plan.blocks.map((b) => [b.kind, b.path]), [["modified", C]]);
  assert.ok(!plan.changes.some((c) => c.path === C));
  const forced = uninstallPlan({ ...i, force: true });
  assert.deepEqual(forced.blocks, []);
  assert.ok(forced.changes.some((c) => c.action === "delete" && c.path === C));
});

test("取り除き: 書き換えられた固有の部分は残して知らせる（force でも）", () => {
  for (const force of [false, true]) {
    const i = installed({ force });
    i.snapshot.files[P] = B("mine");
    const plan = uninstallPlan(i);
    assert.deepEqual(plan.blocks, []);
    assert.ok(!plan.changes.some((c) => c.path === P));
    assert.ok(plan.notices.some((n) => n.includes(P) && n.includes("残した")));
  }
});

test("取り除き: 記録だけにある共通部分も、書き換えが無ければ削除する", () => {
  const X = `${D}/old.txt`;
  const i = installed();
  i.snapshot.ledger = ledgerText([{ path: C, kind: "common", content: B("new-c") }, { path: P, kind: "project", content: B("new-p") }, { path: X, kind: "common", content: B("old") }]);
  i.snapshot.files[X] = B("old");
  assert.ok(uninstallPlan(i).changes.some((c) => c.action === "delete" && c.path === X));
  i.snapshot.files[X] = B("edited");
  assert.deepEqual(uninstallPlan(i).blocks.map((b) => b.path), [X]);
});

test("取り除き: 管理区画の外の記録の道筋は無視して知らせる（.kiro や kiro のスキルにも触れない）", () => {
  const bad = [".kiro/steering/product.md", ".claude/skills/kiro-impl/SKILL.md", "../x", "/etc/passwd"];
  const i = installed();
  i.snapshot.ledger = ledgerText([{ path: C, kind: "common", content: B("new-c") }, ...bad.map((p) => ({ path: p, kind: "common", content: B("a") }))]);
  for (const p of bad) i.snapshot.files[p] = B("a");
  i.snapshot.files[".kiro/settings/x"] = B("a");
  const plan = uninstallPlan(i);
  for (const p of bad) assert.ok(!plan.changes.some((c) => c.path === p));
  assert.ok(!plan.changes.some((c) => c.path.startsWith(".kiro/") || c.path.includes("kiro-")));
  assert.ok(plan.notices.some((n) => n.includes("管理区画") && n.includes(".kiro/steering/product.md")));
  assert.deepEqual(plan.blocks, []);
});

test("取り除き: 除外が外れて現れる道筋を知らせる", () => {
  const i = installed();
  i.snapshot.ignoredPresent = [".claude/skills/kiro-impl", ".kiro/settings"];
  const plan = uninstallPlan(i);
  const n = plan.notices.find((x) => x.includes(".gitignore"));
  assert.ok(n.includes("未追跡") && n.includes("コミットせず"));
  assert.ok(n.includes(".claude/skills/kiro-impl") && n.includes(".kiro/settings"));
  assert.ok(!plan.changes.some((c) => c.path.includes("kiro")));
});

test("取り除き: 目印の破損と settings の読めなさを集める", () => {
  const i = installed();
  i.snapshot.settings = "{";
  i.snapshot.gitignore = "# >>> cc-sdd-bootstrap\n";
  i.snapshot.claudeMd = "<!-- cc-sdd-bootstrap:end -->\n";
  const plan = uninstallPlan(i);
  assert.deepEqual(plan.blocks.map((b) => [b.kind, b.path]), [["settings", ".claude/settings.json"], ["markers", ".gitignore"], ["markers", "CLAUDE.md"]]);
  assert.ok(!plan.changes.some((c) => [".gitignore", "CLAUDE.md", ".claude/settings.json"].includes(c.path)));
});

test("取り除き: 一式の区画しか無いファイルは削除する", () => {
  const i = fullInput();
  const applied = applyPlan(i, makePlan(i));
  const u = { ...applied, operation: "uninstall", config: null, force: false };
  const plan = uninstallPlan(u);
  for (const p of [".claude/settings.json", ".gitignore", "CLAUDE.md"]) {
    assert.deepEqual(plan.changes.find((c) => c.path === p), { action: "delete", path: p });
  }
});

test("取り除き: 何も入っていない対象では変更なし", () => {
  const i = input({ operation: "uninstall" });
  const plan = uninstallPlan(i);
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.blocks, []);
});
