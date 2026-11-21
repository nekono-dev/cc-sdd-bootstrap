import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runCli } from "../lib/cli.mjs";

// 委任セットアップの CLI 経路（管理対象 Codex MCP の引き継ぎ・対話入力・--delegation-order・状態表示）を、
// 注入した登録探査と能力確認だけで確かめる。実プロセスや外部接続は使わない。

function sink() {
  const chunks = [];
  return { write: (value) => { chunks.push(String(value)); return true; }, text: () => chunks.join("") };
}

function project(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

/** 実行ごとに出力を新しく作る。extra で探査の注入を差し替える。 */
function runner(root, base = {}) {
  return async (args, extra = {}) => {
    const stdout = sink(), stderr = sink();
    const code = await runCli(args, { cwd: root, packageRoot: path.resolve("."), interactive: false, stdout, stderr, ...base, ...extra });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  };
}

const settingsPath = (root) => path.join(root, ".cc-sdd-bootstrap.json");
const readSettings = (root) => JSON.parse(fs.readFileSync(settingsPath(root), "utf8"));
const writeSettings = (root, settings) => fs.writeFileSync(settingsPath(root), `${JSON.stringify(settings, null, 2)}\n`);

/** 対話入力の行を流す擬似の標準入力 */
function stdinLines(lines) {
  const stdin = new PassThrough();
  stdin.end(lines.map((line) => `${line}\n`).join(""));
  return stdin;
}

const managedRow = { host: "claude", name: "cc-sdd-codex", scope: "project", registrationId: "mcp-1", status: "eligible" };
const managedCapability = { kind: "agent", harness: "codex", tier: "cloud", models: [{ id: "gpt-x" }] };

test("承認後の update で管理対象 Codex MCP をクラウド段へ引き継ぎ、保存済みの順序は変えない", async (t) => {
  const root = project(t, "cc-sdd-flow-inherit-");
  let rows = [];
  const run = runner(root, {
    listRegistrations: async () => rows,
    verifyRegistration: async (row) => (row.name === "cc-sdd-codex" ? managedCapability : null),
  });
  assert.equal((await run(["init", "--clients", "claude", "--codex", "yes"])).code, 0);
  assert.ok(fs.existsSync(path.join(root, ".mcp.json")), "管理対象の登録が初回導入で作られる");

  rows = [managedRow];
  const adopted = await run(["update"]);
  assert.equal(adopted.code, 0, adopted.stderr);
  assert.deepEqual(readSettings(root).delegation.claude.cloud, [
    { family: "codex", scope: "project", registrationName: "cc-sdd-codex", registrationId: "mcp-1", models: {} },
  ], "承認後の update で cc-sdd-codex がクラウド段へ入る");

  for (const saved of [[], [{ family: "pi", scope: "project", registrationName: "other", registrationId: "other-1", models: {} }]]) {
    const settings = readSettings(root);
    settings.delegation = { claude: { cloud: saved } };
    writeSettings(root, settings);
    const result = await run(["update"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(readSettings(root).delegation.claude.cloud, saved, "保存済みの段内順（空配列を含む）は引き継ぎで変えない");
  }
});

test("管理記録と一致しない同名の登録はクラウド段へ引き継がない", async (t) => {
  const root = project(t, "cc-sdd-flow-hash-");
  const run = runner(root, {
    listRegistrations: async () => [managedRow],
    verifyRegistration: async () => managedCapability,
  });
  assert.equal((await run(["init", "--clients", "claude", "--codex", "yes"])).code, 0);
  const mcpPath = path.join(root, ".mcp.json");
  const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  mcp.mcpServers["cc-sdd-codex"].args = ["利用者が差し替えた引数"];
  fs.writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);

  const before = fs.readFileSync(settingsPath(root), "utf8");
  const result = await run(["update"]);
  // 利用者が書き換えた同名の登録は上書きせず止まり、委任候補としても採用しない
  assert.equal(result.code, 1, "記録と一致しない同名の登録は上書きせず止める");
  assert.match(result.stderr, /利用者が登録しているため上書きしません/);
  assert.equal(fs.readFileSync(settingsPath(root), "utf8"), before, "設定は書き換えない");
  assert.equal(readSettings(root).delegation, undefined, "同名でもクラウド段へ採用しない");
});

test("対話の委任設定は順序とモデルを保存し、空欄で保持・'-' で空にし、入力の終わりは失敗にする", async (t) => {
  const root = project(t, "cc-sdd-flow-interactive-");
  const rows = [
    { host: "claude", name: "alpha", scope: "project", registrationId: "reg-1", status: "eligible" },
    { host: "claude", name: "beta", scope: "project", registrationId: "reg-2", status: "eligible" },
    { host: "claude", name: "gamma", scope: "project", registrationId: "reg-3", status: "eligible" },
  ];
  const capabilities = {
    "reg-1": { kind: "agent", harness: "pi", tier: "local", models: [{ id: "m1" }] },
    "reg-2": { kind: "agent", harness: "codex", tier: "cloud", models: [{ id: "m2" }] },
    "reg-3": { kind: "agent", harness: "codex", tier: "cloud", models: [{ id: "m2" }, { id: "m3" }] },
  };
  const run = runner(root, { listRegistrations: async () => rows, verifyRegistration: async (row) => capabilities[row.registrationId] });
  assert.equal((await run(["init", "--clients", "claude"])).code, 0);

  const interactive = (lines) => run(["update"], { interactive: true, stdin: stdinLines(lines) });

  // 候補キーの表記（登録 ID だけ・前後の空白）の違いを吸収し、モデル指定と同じキーで保存する
  const first = await interactive(["reg-1", "reg-1:review=m1", " reg-3 , beta:reg-2 ", "reg-3:review~m2,m3"]);
  assert.equal(first.code, 0, first.stderr);
  const saved = readSettings(root).delegation.claude;
  assert.deepEqual(saved.local, [{ family: "pi", scope: "project", registrationName: "alpha", registrationId: "reg-1", models: { review: { fixed: "m1" } } }]);
  assert.deepEqual(saved.cloud, [
    { family: "codex", scope: "project", registrationName: "gamma", registrationId: "reg-3", models: { review: { compatibleIds: ["m2", "m3"] } } },
    { family: "codex", scope: "project", registrationName: "beta", registrationId: "reg-2", models: {} },
  ]);

  const kept = await interactive(["", "", "", ""]);
  assert.equal(kept.code, 0, kept.stderr);
  assert.deepEqual(readSettings(root).delegation.claude, saved, "空欄は現在の順序とモデルを保持する");

  const cleared = await interactive(["-", ""]);
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.deepEqual(readSettings(root).delegation.claude.local, [], "'-' は段の順序を空にする");
  assert.deepEqual(readSettings(root).delegation.claude.cloud, saved.cloud, "空欄の段は変えない");

  const before = fs.readFileSync(settingsPath(root), "utf8");
  const truncated = await interactive(["reg-1"]);
  assert.equal(truncated.code, 1, "入力が途中で終わったら失敗にする");
  assert.match(truncated.stderr, /EOF/);
  assert.equal(fs.readFileSync(settingsPath(root), "utf8"), before, "失敗時は設定を書き換えない");
});

test("--delegation-order は探査で適格になった候補と保存済みの候補を合わせて順序を適用する", async (t) => {
  const root = project(t, "cc-sdd-flow-order-");
  const beta = { host: "claude", name: "beta", scope: "project", registrationId: "reg-2", status: "eligible" };
  const gamma = { host: "claude", name: "gamma", scope: "project", registrationId: "reg-3", status: "eligible" };
  const cloud = { kind: "agent", harness: "codex", tier: "cloud", models: [{ id: "m2" }] };
  const run = runner(root, { verifyRegistration: async () => cloud });
  const initial = await run(["init", "--clients", "claude"], { listRegistrations: async () => [beta], delegationSelection: [{ host: "claude", tier: "cloud", order: ["reg-2"] }] });
  assert.equal(initial.code, 0, initial.stderr);
  assert.deepEqual(readSettings(root).delegation.claude.cloud.map((item) => item.registrationId), ["reg-2"], "前提: beta だけが保存されている");

  // gamma は今回新しく適格になった候補、beta は保存済みの候補（今回は探査されない）
  const ordered = await run(["update", "--delegation-order", "claude:cloud=reg-3,beta:reg-2"], { listRegistrations: async () => [gamma] });
  assert.equal(ordered.code, 0, ordered.stderr);
  assert.deepEqual(readSettings(root).delegation.claude.cloud.map((item) => item.registrationName), ["gamma", "beta"]);

  const duplicated = await run(["update", "--delegation-order", "claude:cloud=reg-2,reg-3"], { listRegistrations: async () => [beta, gamma] });
  assert.equal(duplicated.code, 0, duplicated.stderr, "探査と保存の両方にある候補は重複として拒否しない");
  assert.deepEqual(readSettings(root).delegation.claude.cloud.map((item) => item.registrationName), ["beta", "gamma"]);
});

test("探査結果の状態は日本語で示し、内部の状態名を出さない", async (t) => {
  const root = project(t, "cc-sdd-flow-status-");
  const rows = [
    { host: "claude", name: "ready", scope: "project", registrationId: "r1", status: "eligible" },
    { host: "claude", name: "waiting", scope: "project", registrationId: "r2", status: "pending", reason: "承認待ち" },
    { host: "claude", name: "off", scope: "project", registrationId: "r3", status: "disabled" },
    { host: "claude", name: "broken", scope: "project", registrationId: "r4", status: "unknown" },
  ];
  const run = runner(root, { listRegistrations: async () => rows, verifyRegistration: async () => ({ kind: "agent", harness: "pi", tier: "local", models: [] }) });
  const result = await run(["init", "--clients", "claude", "--codex", "yes"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /cc-sdd-codex \(追加予定\)/);
  assert.match(result.stdout, /waiting \(承認待ち\)/);
  assert.match(result.stdout, /off \(無効/);
  assert.match(result.stdout, /broken \(利用不可/);
  assert.match(result.stdout, /ready \(ローカル・pi\)/);
  assert.doesNotMatch(result.stdout, /\b(planned|pending|disabled|unknown|removal-planned)\b/);
});
