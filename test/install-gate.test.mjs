import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pendingInstallFailures, installBlockReason, decideUserPromptSubmit } from "../.agent-hooks/cc-sdd-bootstrap/install-gate.mjs";

const GATE = path.resolve(import.meta.dirname, "../.agent-hooks/cc-sdd-bootstrap/install-gate.mjs");
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  const dir = path.join(root, ".agent-hooks", "cc-sdd-bootstrap");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(GATE, path.join(dir, "install-gate.mjs"));
  return { root, script: path.join(dir, "install-gate.mjs"), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const RECORD = ".cache/cc-sdd-install.failed";
function writeRecord(root, text) {
  fs.mkdirSync(path.join(root, ".cache"), { recursive: true });
  fs.writeFileSync(path.join(root, RECORD), text);
}
const run = (script, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

test("記録が無ければ止めず、一覧も空になる", () => {
  const { root, cleanup } = makeRepo();
  try {
    assert.equal(decideUserPromptSubmit(root), null);
    assert.deepEqual(pendingInstallFailures(root), []);
  } finally {
    cleanup();
  }
});

test("記録があれば止め、理由に記録の中身・名前・再試行のコマンドを含める", () => {
  const { root, cleanup } = makeRepo();
  writeRecord(root, "理由ABC");
  try {
    const res = decideUserPromptSubmit(root);
    assert.equal(res.decision, "block");
    assert.equal(res.hookSpecificOutput.suppressOriginalPrompt, true);
    assert.match(res.reason, /理由ABC/);
    assert.match(res.reason, /cc-sdd/);
    assert.match(res.reason, /node \.agent-hooks\/cc-sdd-bootstrap\/install-cc-sdd\.mjs/);
  } finally {
    cleanup();
  }
});

test("記録の中身は 2000 文字までに切る", () => {
  const { root, cleanup } = makeRepo();
  writeRecord(root, "x".repeat(3000));
  try {
    const [item] = pendingInstallFailures(root);
    assert.ok(item.detail.length <= 2000);
  } finally {
    cleanup();
  }
});

test("記録を読めなくても対象は 1 件返し、読めなかった旨を詳細にする", () => {
  const { root, cleanup } = makeRepo();
  fs.mkdirSync(path.join(root, RECORD), { recursive: true });
  try {
    const list = pendingInstallFailures(root);
    assert.equal(list.length, 1);
    assert.equal(list[0].detail, "（記録を読めませんでした）");
  } finally {
    cleanup();
  }
});

test("複数の対象は名前・詳細・再試行のコマンドをすべて並べる", () => {
  const failures = [
    { name: "a", record: "r1", retry: "cmd-a", detail: "詳細A" },
    { name: "b", record: "r2", retry: "cmd-b", detail: "詳細B" },
  ];
  const reason = installBlockReason(failures);
  for (const f of failures) {
    assert.ok(reason.includes(f.name));
    assert.ok(reason.includes(f.detail));
    assert.ok(reason.includes(f.retry));
  }
});

test("スクリプトは記録があれば判定の JSON を出し、無ければ何も出さない（どちらも終了コード 0）", () => {
  const withRecord = makeRepo();
  writeRecord(withRecord.root, "x");
  const without = makeRepo();
  try {
    const blocked = run(withRecord.script, "user-prompt-submit");
    assert.equal(blocked.status, 0);
    assert.equal(JSON.parse(blocked.stdout).decision, "block");
    const passed = run(without.script, "user-prompt-submit");
    assert.equal(passed.status, 0);
    assert.equal(passed.stdout.trim(), "");
  } finally {
    withRecord.cleanup();
    without.cleanup();
  }
});

test("未知の引数では標準エラーに出して通す（終了コード 0・標準出力は空）", () => {
  const { script, cleanup } = makeRepo();
  try {
    const res = run(script, "foo");
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "");
    assert.match(res.stderr, /install-gate:/);
  } finally {
    cleanup();
  }
});
