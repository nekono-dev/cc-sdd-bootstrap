import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDelegationModels, runCli } from "../lib/cli.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function sink() {
  const chunks = [];
  return { write: (value) => { chunks.push(String(value)); return true; }, text: () => chunks.join("") };
}

test("表示候補キーで指定したモデルが同じキーで返る", () => {
  const candidates = [{ registrationName: "agent", registrationId: "reg-1" }];
  const result = parseDelegationModels({ line: "agent:reg-1:review=m1", candidates });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, { "agent:reg-1": { review: { fixed: "m1" } } });
});

test("CLI 統合で表示候補キーのモデル指定を設定へ保存する", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sdd-delegation-model-key-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".git"));
  const stdout = sink(), stderr = sink();
  const result = await runCli(["init", "--clients", "claude"], {
    cwd: root, packageRoot: path.resolve("."), interactive: false, stdout, stderr,
    listRegistrations: async () => [{ host: "claude", name: "agent", scope: "project", registrationId: "reg-1", status: "eligible" }],
    verifyRegistration: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [{ id: "m1" }] }),
    delegationSelection: [{ host: "claude", tier: "local", order: ["agent:reg-1"], models: { "agent:reg-1": { review: { fixed: "m1" } } } }],
  });
  assert.equal(result, 0, stderr.text());
  const saved = JSON.parse(fs.readFileSync(path.join(root, ".cc-sdd-bootstrap.json"), "utf8"));
  assert.deepEqual(saved.delegation.claude.local[0], {
    family: "pi", scope: "project", registrationName: "agent", registrationId: "reg-1", models: { review: { fixed: "m1" } },
  });
});

test("Codex MCP を初回登録した後の無効化更新は削除予定と表示する", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sdd-delegation-removal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".git"));
  const invoke = async (args) => {
    const stdout = sink(), stderr = sink();
    const code = await runCli(args, { cwd: root, packageRoot: path.resolve("."), interactive: false, stdout, stderr,
      listRegistrations: async () => [], verifyRegistration: async () => null });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  };
  assert.equal((await invoke(["init", "--clients", "claude", "--codex", "yes"])).code, 0);
  assert.ok(fs.existsSync(path.join(root, ".mcp.json")), "管理対象登録が初回導入で作られる");
  const settingsPath = path.join(root, ".cc-sdd-bootstrap.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  settings.codex.enabled = false;
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  const updated = await invoke(["update"]);
  assert.equal(updated.code, 0, updated.stderr);
  assert.match(updated.stdout, /cc-sdd-codex \(削除予定\)/);
  assert.doesNotMatch(updated.stdout, /cc-sdd-codex.*追加予定|追加予定.*cc-sdd-codex/);
});

test("登録 ID だけのモデル指定も登録名:登録 ID の正式キーで返し、曖昧な ID は拒否する", () => {
  const candidates = [{ registrationName: "agent", registrationId: "reg-1" }];
  const bare = parseDelegationModels({ line: "reg-1:review=m1", candidates });
  assert.equal(bare.ok, true);
  assert.deepEqual(bare.models, { "agent:reg-1": { review: { fixed: "m1" } } });
  const ambiguous = parseDelegationModels({ line: "reg-1:review=m1", candidates: [...candidates, { registrationName: "alias", registrationId: "reg-1" }] });
  assert.equal(ambiguous.ok, false, "同じ登録 ID が複数の登録名にある場合は登録名:登録 ID で指定させる");
});
