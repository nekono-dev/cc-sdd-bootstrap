import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(packageRoot, "bin/cc-sdd-bootstrap.mjs");
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-e2e-new-"));
  fs.mkdirSync(path.join(root, ".git"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(root, args) {
  return spawnSync(process.execPath, [entry, ...args], { cwd: root, encoding: "utf8" });
}

test("入口から init・変更なしの update・uninstall を実行できる", (t) => {
  const root = temporary(t);
  const initialized = run(root, ["init"]);
  if (initialized.error) { t.skip(`子プロセスを起動できません: ${initialized.error.code}`); return; }
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.ok(fs.existsSync(path.join(root, ".cc-sdd-bootstrap.json")));
  assert.ok(fs.existsSync(path.join(root, ".claude/settings.json")));
  assert.ok(fs.existsSync(path.join(root, ".codex/hooks.json")));
  const updated = run(root, ["update"]);
  if (updated.error) { t.skip(`子プロセスを起動できません: ${updated.error.code}`); return; }
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.stdout, /変更はありません/);
  const removed = run(root, ["uninstall"]);
  if (removed.error) { t.skip(`子プロセスを起動できません: ${removed.error.code}`); return; }
  assert.equal(removed.status, 0, removed.stderr);
  assert.ok(fs.existsSync(path.join(root, ".cc-sdd-bootstrap.json")));
});

test("未対応の指定は変更せず、問題と使い方を表示して失敗する", (t) => {
  const root = temporary(t);
  const result = run(root, ["init", "--force"]);
  if (result.error) { t.skip(`子プロセスを起動できません: ${result.error.code}`); return; }
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--force/);
  assert.match(result.stderr, /使い方/);
  assert.deepEqual(fs.readdirSync(root), [".git"]);
});
