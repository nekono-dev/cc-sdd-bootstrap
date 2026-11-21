import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRegistration, listRegistrations, fingerprintTransport, runReadOnlyCli, requestCodexConfig } from "../.agent-hooks/cc-sdd-bootstrap/delegation-registry.mjs";
// 新しく公開する関数は、未実装のときに個別のテストだけが赤になるよう名前空間で読む。
import * as registry from "../.agent-hooks/cc-sdd-bootstrap/delegation-registry.mjs";

const entry = (overrides = {}) => ({ host: "pi", name: "worker", family: "pi", scope: "project", enabled: true,
  approved: true, trusted: true, transport: { type: "stdio", command: "node", args: ["server.mjs"], cwd: "/repo", env: { TOKEN: "secret" } }, ...overrides });
const identity = (e) => ({ family: e.family, scope: e.scope, registrationName: e.name, registrationId: fingerprintTransport(e.transport) });

// 実行を差し込む fake。呼び出し（コマンド・引数・cwd）を記録し、応答を返す。
const fakeRun = (table) => {
  const calls = [];
  const run = async (executable, args, cwd) => {
    calls.push({ executable, args, cwd });
    const key = [executable, ...args].join(" ");
    if (!(key in table)) throw new Error(`想定外の呼び出し: ${key}`);
    const value = table[key];
    if (value instanceof Error) throw value;
    return value;
  };
  return { run, calls };
};

const claudeDetail = ({ status = "✓ Connected", scope = "Project config (shared via .mcp.json)", command = "node", args = "server.mjs", env = "TOKEN=secret" } = {}) =>
  [`worker:`, `  Scope: ${scope}`, `  Status: ${status}`, `  Type: stdio`, `  Command: ${command}`, `  Args: ${args}`, `  Environment:`, `    ${env}`].join("\n");

test("承認・信頼済みの同一登録だけを解決し、秘密値を診断に含めない", () => {
  const e = entry();
  const result = resolveRegistration(e, identity(e), { verifiedFamily: "pi" });
  assert.equal(result.status, "eligible");
  assert.equal(result.transportFingerprint, fingerprintTransport(e.transport));
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes("server.mjs"), false);
});

test("eligible の分類・再解決結果に秘密値を含まない transportFingerprint を付ける", () => {
  const e = entry();
  const classified = registry.classifyRegistration(e);
  const resolved = resolveRegistration(e, identity(e), { verifiedFamily: "pi" });
  assert.equal(classified.transportFingerprint, fingerprintTransport(e.transport));
  assert.equal(resolved.transportFingerprint, fingerprintTransport(e.transport));
  assert.equal(JSON.stringify(resolved).includes("secret"), false);
});

test("Claude の承認済み user 登録は検証可能な接続指紋を持つ", async () => {
  const fake = fakeRun({ "claude mcp list": "worker: x\n", "claude mcp get worker": claudeDetail({ scope: "User config (available in all your projects)" }) });
  const result = (await listRegistrations("claude", { cwd: "/repo", run: fake.run }))[0];
  assert.equal(result.scope, "user");
  assert.equal(result.status, "eligible");
  assert.equal(result.transportFingerprint, fingerprintTransport({ type: "stdio", command: "node", args: ["server.mjs"], env: { TOKEN: "secret" } }));
});

test("系統は確認済みで一致するときだけ登録を解決する", () => {
  const e = entry();
  assert.equal(resolveRegistration(e, identity(e), { verifiedFamily: "pi" }).status, "eligible");
  const missing = resolveRegistration(e, identity(e));
  assert.equal(missing.status, "unknown");
  assert.match(missing.reason, /系統/);
  const mismatch = resolveRegistration(e, identity(e), { verifiedFamily: "codex" });
  assert.equal(mismatch.status, "unknown");
  assert.match(mismatch.reason, /系統/);
});

test("トランスポート指紋は環境変数名だけを使う", () => {
  const a = entry().transport;
  const valueChanged = { ...a, env: { TOKEN: "other-secret" } };
  const nameChanged = { ...a, env: { OTHER: "secret" } };
  assert.equal(fingerprintTransport(a), fingerprintTransport(valueChanged));
  assert.notEqual(fingerprintTransport(a), fingerprintTransport(nameChanged));
  assert.equal(fingerprintTransport(a).includes("secret"), false);
});

test("Claude: Environment は名前だけを指紋に含め、不明な行は unknown にする", async () => {
  const read = async (env) => {
    const fake = fakeRun({ "claude mcp list": "worker: x\n", "claude mcp get worker": claudeDetail({ env }) });
    return (await listRegistrations("claude", { cwd: "/repo", run: fake.run }))[0];
  };
  const a = await read("TOKEN=one");
  const same = await read("TOKEN: two");
  const other = await read("OTHER=one");
  assert.equal(a.registrationId, same.registrationId);
  assert.notEqual(a.registrationId, other.registrationId);
  const malformed = await read("not a key value");
  assert.equal(malformed.status, "unknown");
  assert.match(malformed.reason, /識別情報/);
});

test("未対応ホストは条件が揃っていても unknown", () => {
  const source = { ...entry(), host: "other", registrationId: "id" };
  assert.equal(registry.classifyRegistration(source).status, "unknown");
  assert.equal(resolveRegistration(source, identity(source), { verifiedFamily: "pi" }).status, "unknown");
});

test("公開結果の reason に生のエラー文字列を含めない", async () => {
  const secret = "/private/path SECRET_ARGUMENT";
  const classified = registry.classifyRegistration({ ...entry(), error: secret });
  assert.equal(JSON.stringify(classified).includes(secret), false);
  assert.equal(JSON.stringify(classified).includes(secret), false);
});

test("承認待ち、無効、信頼不明、差し替えを利用不可として区別する", () => {
  const e = entry();
  assert.equal(resolveRegistration(entry({ approved: false }), identity(e), { verifiedFamily: "pi" }).status, "pending");
  assert.equal(resolveRegistration(entry({ enabled: false }), identity(e), { verifiedFamily: "pi" }).status, "disabled");
  assert.equal(resolveRegistration(entry({ trusted: null }), identity(e), { verifiedFamily: "pi" }).status, "unknown");
  assert.equal(resolveRegistration(entry({ transport: { type: "stdio", command: "evil" } }), identity(e), { verifiedFamily: "pi" }).status, "unknown");
});

test("未知ホスト、未知トランスポート、保存なしは推測しない", async () => {
  assert.equal(resolveRegistration(entry({ transport: { type: "http", url: "https://host" } }), null).status, "unknown");
  assert.equal(resolveRegistration(entry(), null).status, "unknown");
  const result = await listRegistrations("unknown", { cwd: "/repo" });
  assert.equal(result[0].status, "unknown");
  assert.equal(result[0].reason.includes("未対応"), true);
});

test("保存済みの識別情報と違う（名前・設定元・指紋・系統）場合は差し替えとして拒否する", () => {
  const e = entry();
  const saved = identity(e);
  assert.equal(resolveRegistration(e, { ...saved, scope: "user" }, { verifiedFamily: "pi" }).status, "unknown");
  assert.equal(resolveRegistration(e, { ...saved, registrationName: "other" }, { verifiedFamily: "pi" }).status, "unknown");
  assert.equal(resolveRegistration(e, { ...saved, registrationId: "0".repeat(64) }, { verifiedFamily: "pi" }).status, "unknown");
  assert.equal(resolveRegistration(e, { ...saved, family: "codex" }, { verifiedFamily: "pi" }).status, "unknown");
  assert.match(resolveRegistration(e, { ...saved, registrationId: "0".repeat(64) }, { verifiedFamily: "pi" }).reason, /セットアップ/);
});

test("Claude: 承認待ちは pending、接続確認済みのプロジェクト登録は承認済みとして解決する", async () => {
  const pending = fakeRun({ "claude mcp list": "worker: node server.mjs - ⏸ Pending approval\n", "claude mcp get worker": claudeDetail({ status: "⏸ Pending approval" }) });
  const [p] = await listRegistrations("claude", { cwd: "/repo", run: pending.run });
  assert.equal(p.status, "pending");

  const ok = fakeRun({ "claude mcp list": "worker: node server.mjs - ✓ Connected\n", "claude mcp get worker": claudeDetail() });
  const [listed] = await listRegistrations("claude", { cwd: "/repo", run: ok.run });
  assert.equal(listed.status, "eligible");
  assert.equal(listed.scope, "project");
  assert.equal(JSON.stringify(listed).includes("secret"), false);
  const again = await listRegistrations("claude", { cwd: "/repo", run: ok.run });
  const resolved = resolveRegistration(listed, { family: "claude", scope: "project", registrationName: "worker", registrationId: again[0].registrationId }, { verifiedFamily: "claude" });
  assert.equal(resolved.status, "eligible");
});

test("管理対象 Codex MCP の実際の引用 Args 表示を登録解決し、能力確認へ接続できる", async () => {
  const args = '-c "repo_root=\\\"$(git rev-parse --show-toplevel)\\\" && exec node \\\"$repo_root/.agent-hooks/cc-sdd-bootstrap/codex-agent-mcp.mjs\\\""';
  const fake = fakeRun({ "claude mcp list": "cc-sdd-codex: sh -c\n", "claude mcp get cc-sdd-codex": claudeDetail({ command: "sh", args }) });
  const [listed] = await listRegistrations("claude", { cwd: "/repo", run: fake.run });
  assert.equal(listed.status, "eligible");
  assert.equal(listed.transportFingerprint, fingerprintTransport({ type: "stdio", command: "sh", args: ["-c", 'repo_root="$(git rev-parse --show-toplevel)" && exec node "$repo_root/.agent-hooks/cc-sdd-bootstrap/codex-agent-mcp.mjs"'], env: { TOKEN: "secret" } }));
  const saved = { family: "codex", scope: "project", registrationName: "cc-sdd-codex", registrationId: listed.registrationId };
  assert.equal(resolveRegistration(listed, saved, { verifiedFamily: "codex" }).status, "eligible");
});

test("Claude: 接続状態が変わっても同一登録と扱い、引数が変われば差し替えとして拒否する", async () => {
  const before = fakeRun({ "claude mcp list": "worker: x\n", "claude mcp get worker": claudeDetail({ status: "✓ Connected" }) });
  const [a] = await listRegistrations("claude", { cwd: "/repo", run: before.run });
  const failed = fakeRun({ "claude mcp list": "worker: x\n", "claude mcp get worker": claudeDetail({ status: "✗ Failed to connect" }) });
  const [b] = await listRegistrations("claude", { cwd: "/repo", run: failed.run });
  assert.equal(a.registrationId, b.registrationId);
  const changed = fakeRun({ "claude mcp list": "worker: x\n", "claude mcp get worker": claudeDetail({ args: "evil.mjs" }) });
  const [c] = await listRegistrations("claude", { cwd: "/repo", run: changed.run });
  assert.notEqual(c.registrationId, a.registrationId);
  const saved = { family: "claude", scope: "project", registrationName: "worker", registrationId: a.registrationId };
  assert.equal(resolveRegistration(c, saved, { verifiedFamily: "claude" }).status, "unknown");
});

test("Claude: Environment の生値は識別値にも診断にも含めない", async () => {
  const read = async (value) => {
    const fake = fakeRun({ "claude mcp list": "worker: x\n", "claude mcp get worker": claudeDetail({ env: `TOKEN=${value}` }) });
    return (await listRegistrations("claude", { cwd: "/repo", run: fake.run }))[0];
  };
  const a = await read("secret-one");
  const b = await read("secret-two");
  assert.equal(a.registrationId, b.registrationId);
  assert.equal(JSON.stringify([a, b]).includes("secret-one"), false);
  assert.equal(JSON.stringify([a, b]).includes("secret-two"), false);
});

test("Claude: cwd が異なると同じ登録内容でも識別値が異なり、cwd は結果に出さない", async () => {
  const read = async (cwd) => {
    const fake = fakeRun({ "claude mcp list": "worker: x\n", "claude mcp get worker": claudeDetail() });
    return (await listRegistrations("claude", { cwd, run: fake.run }))[0];
  };
  const a = await read(process.cwd());
  const b = await read(tmpdir());
  assert.notEqual(a.registrationId, b.registrationId);
  assert.equal(JSON.stringify([a, b]).includes(process.cwd()), false);
  assert.equal(JSON.stringify([a, b]).includes(tmpdir()), false);
});

test("Claude: 未知の Status 表記や接続を確認できない表記は承認・信頼を付けず unknown に閉じる", async () => {
  for (const status of ["⚠ Unknown state", "✗ Failed to connect", "Not connected", "Something new"]) {
    const fake = fakeRun({ "claude mcp list": "worker: x\n", "claude mcp get worker": claudeDetail({ status }) });
    const [r] = await listRegistrations("claude", { cwd: "/repo", run: fake.run });
    assert.equal(r.status, "unknown", status);
    assert.notEqual(r.approved, true, status);
    assert.notEqual(r.trusted, true, status);
  }
});

test("Claude: ローカル設定元・状態行のない結果・取得失敗は利用しない", async () => {
  const local = fakeRun({ "claude mcp list": "worker: x\n", "claude mcp get worker": claudeDetail({ scope: "Local config (private to you in this project)" }) });
  assert.equal((await listRegistrations("claude", { cwd: "/repo", run: local.run }))[0].status, "unknown");
  const noStatus = fakeRun({ "claude mcp list": "worker: x\n", "claude mcp get worker": "worker:\n  Scope: Project config (shared via .mcp.json)\n" });
  assert.equal((await listRegistrations("claude", { cwd: "/repo", run: noStatus.run }))[0].status, "unknown");
  const failing = fakeRun({ "claude mcp list": "worker: x\n", "claude mcp get worker": new Error("timeout") });
  assert.equal((await listRegistrations("claude", { cwd: "/repo", run: failing.run }))[0].status, "unknown");
});

// Codex の検証用の共通データ。pi-agent は有効、off は無効の登録。
const codexList = JSON.stringify([
  { name: "pi-agent", enabled: true, disabled_reason: null, transport: { type: "stdio", command: "pi", args: ["x"], env: { KEY: "rawsecret" } } },
  { name: "off", enabled: false, disabled_reason: { reason: "x" }, transport: { type: "stdio", command: "y" } },
]);
const codexConfig = { mcp_servers: { "pi-agent": { command: "pi", args: ["x"], env: { KEY: "rawsecret" } }, off: { command: "y" } } };
const userName = { type: "user", file: "/home/u/.codex/config.toml" };
const projectName = { type: "project", dotCodexFolder: "/repo/.codex" };
const userLayer = { name: userName, disabledReason: null, config: {} };
const projectLayer = (disabledReason = null) => ({ name: projectName, disabledReason, config: {} });
// 登録のすべての項目（pi-agent の 3 項目と off の 1 項目）に同じ設定元を付ける。
const codexOrigins = (name) => ({
  "mcp_servers.pi-agent.command": { name, version: "1" },
  "mcp_servers.pi-agent.args": { name, version: "1" },
  "mcp_servers.pi-agent.env.KEY": { name, version: "1" },
  "mcp_servers.off.command": { name, version: "1" },
});
const codexResult = ({ config = codexConfig, origins = codexOrigins(userName), layers = [userLayer] } = {}) => ({ config, origins, layers });
const fakeAppServer = (result) => async () => result;
const failingAppServer = async () => { throw new Error("読み取りに失敗"); };

test("Codex: user 層の登録は、項目の設定元が揃えば eligible、環境値は出力しない", async () => {
  const { run } = fakeRun({ "codex mcp list --json": codexList });
  const result = await listRegistrations("codex", { cwd: "/repo", run, appServer: fakeAppServer(codexResult()) });
  assert.equal(result[0].status, "eligible");
  assert.equal(result[0].scope, "user");
  assert.equal(result[1].status, "disabled");
  assert.equal(JSON.stringify(result).includes("rawsecret"), false);
  assert.equal(result[0].registrationId.includes("rawsecret"), false);
});

test("Codex: 信頼済みの project 層の登録は eligible", async () => {
  const { run } = fakeRun({ "codex mcp list --json": codexList });
  const appServer = fakeAppServer(codexResult({ origins: codexOrigins(projectName), layers: [projectLayer(null)] }));
  const result = await listRegistrations("codex", { cwd: "/repo", run, appServer });
  assert.equal(result[0].status, "eligible");
  assert.equal(result[0].scope, "project");
});

test("Codex: 未信頼の project 層は disabled ではなく unknown とし、生の理由を出さない", async () => {
  const { run } = fakeRun({ "codex mcp list --json": codexList });
  const appServer = fakeAppServer(codexResult({ origins: codexOrigins(projectName), layers: [projectLayer({ reason: "RAW_DISABLED_VALUE" })] }));
  const result = await listRegistrations("codex", { cwd: "/repo", run, appServer });
  assert.equal(result[0].status, "unknown");
  assert.match(result[0].reason, /未信頼/);
  assert.equal(JSON.stringify(result).includes("RAW_DISABLED_VALUE"), false);
  assert.equal(result[1].status, "disabled");
});

test("Codex: 項目ごとに設定元が混在、または欠落すると unknown", async () => {
  const { run } = fakeRun({ "codex mcp list --json": codexList });
  const mixed = { ...codexOrigins(userName), "mcp_servers.pi-agent.args": { name: projectName, version: "1" } };
  const [a] = await listRegistrations("codex", { cwd: "/repo", run, appServer: fakeAppServer(codexResult({ origins: mixed, layers: [userLayer, projectLayer(null)] })) });
  assert.equal(a.status, "unknown");
  const { "mcp_servers.pi-agent.args": _omitted, ...missingOrigins } = codexOrigins(userName);
  const [b] = await listRegistrations("codex", { cwd: "/repo", run, appServer: fakeAppServer(codexResult({ origins: missingOrigins })) });
  assert.equal(b.status, "unknown");
});

test("Codex: 設定の層が見つからない project 層は unknown", async () => {
  const { run } = fakeRun({ "codex mcp list --json": codexList });
  const result = await listRegistrations("codex", { cwd: "/repo", run, appServer: fakeAppServer(codexResult({ origins: codexOrigins(projectName), layers: [userLayer] })) });
  assert.equal(result[0].status, "unknown");
});

test("Codex: config/read の失敗・形が違う応答は unknown、無効は disabled のまま", async () => {
  const { run } = fakeRun({ "codex mcp list --json": codexList });
  const failed = await listRegistrations("codex", { cwd: "/repo", run, appServer: failingAppServer });
  assert.equal(failed[0].status, "unknown");
  assert.equal(failed[1].status, "disabled");
  assert.equal(JSON.stringify(failed).includes("rawsecret"), false);
  const malformed = await listRegistrations("codex", { cwd: "/repo", run, appServer: fakeAppServer({ config: codexConfig }) });
  assert.equal(malformed[0].status, "unknown");
  assert.equal(malformed[1].status, "disabled");
});

test("Codex: 登録の一覧に名前が無いときは設定を照合できず unknown", async () => {
  const { run } = fakeRun({ "codex mcp list --json": codexList });
  const result = await listRegistrations("codex", { cwd: "/repo", run, appServer: fakeAppServer(codexResult({ config: { mcp_servers: {} } })) });
  assert.equal(result[0].status, "unknown");
});

test("Codex: 実際の子プロセスとの会話で通知を読み飛ばし、時間切れは unknown に閉じる", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-appserver-"));
  try {
    const exe = await fakeCodexExecutable(dir, "ok.mjs", codexResult());
    const hang = await fakeCodexExecutable(dir, "hang.mjs", codexResult(), { hang: true });
    const ok = fakeRun({ [`${exe} mcp list --json`]: codexList });
    // 子プロセスの cwd に実在するディレクトリを渡す（存在しない cwd は起動失敗になる）。
    const [pi] = await listRegistrations("codex", { cwd: dir, run: ok.run, binaries: { codex: exe } });
    assert.equal(pi.status, "eligible");
    const slow = fakeRun({ [`${hang} mcp list --json`]: codexList });
    const [timeout] = await listRegistrations("codex", { cwd: dir, run: slow.run, binaries: { codex: hang }, appServerTimeoutMs: 300 });
    assert.equal(timeout.status, "unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// app-server の偽物。初期化・config/read に応答し、通知を 1 行混ぜる。hang のときは応答しない。
async function fakeCodexExecutable(dir, name, result, { hang = false } = {}) {
  const file = join(dir, name);
  const script = `#!${process.execPath}
import { createInterface } from "node:readline";
const hang = ${hang};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  if (hang) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: 1, result: { userAgent: "fake" } });
  if (message.id === 2) {
    send({ method: "config/warning", params: {} });
    send({ id: 2, result: ${JSON.stringify(result)} });
  }
});
`;
  await writeFile(file, script);
  await chmod(file, 0o755);
  return file;
}

test("Codex: 既定の app-server 起動に失敗しても unknown に閉じ、実行パスを出さない", async () => {
  const { run } = fakeRun({ [`${process.execPath} mcp list --json`]: codexList });
  const result = await listRegistrations("codex", { cwd: process.cwd(), run, binaries: { codex: process.execPath } });
  assert.equal(result[0].status, "unknown");
  assert.equal(JSON.stringify(result).includes(process.execPath), false);
});

test("Pi: 設定元と信頼を確認できない登録は利用せず、無効は disabled と区別する", async () => {
  const json = JSON.stringify({ servers: [{ name: "pi-agent", enabled: true, transport: { type: "stdio", command: "pi" } }, { name: "old", enabled: false }] });
  const { run } = fakeRun({ "pi mcp list --json": json });
  const result = await listRegistrations("pi", { cwd: "/repo", run });
  assert.equal(result[0].status, "unknown");
  assert.equal(result[1].status, "disabled");
});

test("入口は作業ディレクトリを渡す。ネストしたディレクトリでは識別値だけが変わる（呼び出し側はルートを渡す）", async () => {
  const table = { "claude mcp list": "worker: x\n", "claude mcp get worker": claudeDetail() };
  const root = fakeRun(table);
  const nested = fakeRun(table);
  const a = await listRegistrations("claude", { cwd: "/repo", run: root.run });
  const b = await listRegistrations("claude", { cwd: "/repo/nested dir", run: nested.run });
  assert.equal(nested.calls[0].cwd, "/repo/nested dir");
  const strip = (list) => list.map(({ registrationId, ...rest }) => rest);
  assert.deepEqual(strip(a), strip(b));
  // 設定元が違うと同一登録と扱わないため、識別値は cwd ごとに別になる。
  assert.notEqual(a[0].registrationId, b[0].registrationId);
});

test("既定の実行は実在するバイナリをシェルなしで起動し、失敗は unknown に閉じる", async () => {
  const result = await listRegistrations("codex", { cwd: process.cwd(), binaries: { codex: process.execPath } });
  assert.equal(result.length, 1);
  assert.equal(result[0].status, "unknown");
  assert.equal(JSON.stringify(result).includes(process.execPath), false);
});

// ---- 以下: Codex の照合、子プロセスの後始末、受信量の上限 ----

/** 本文つきの偽の実行ファイルを作る（先頭に node の shebang を付ける）。 */
async function fakeScript(dir, name, body) {
  const file = join(dir, name);
  await writeFile(file, `#!${process.execPath}\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

/** pid が消えたことを確かめる。消えるまで短く待ち、残れば失敗にする。 */
async function assertProcessGone(pid) {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail(`子プロセス ${pid} が終了していません`);
}

test("Codex: 一覧の接続内容と config/read の内容が食い違う同名の登録は unknown とし、値を出さない", async () => {
  const { run } = fakeRun({ "codex mcp list --json": codexList });
  const servers = (override) => ({ mcp_servers: { ...codexConfig.mcp_servers, "pi-agent": { ...codexConfig.mcp_servers["pi-agent"], ...override } } });
  const cases = [
    { command: "evil" },
    { args: ["y"] },
    { env: { KEY: "other" } },
  ];
  for (const override of cases) {
    const config = servers(override);
    const [a] = await listRegistrations("codex", { cwd: "/repo", run, appServer: fakeAppServer(codexResult({ config })) });
    assert.equal(a.status, "unknown", JSON.stringify(Object.keys(override)));
    assert.match(a.reason, /一致しない/);
    assert.equal(JSON.stringify(a).includes("evil"), false);
    assert.equal(JSON.stringify(a).includes("rawsecret"), false);
  }
});

test("Codex: command の設定元が欠けると unknown とする", async () => {
  const { run } = fakeRun({ "codex mcp list --json": codexList });
  const { "mcp_servers.pi-agent.command": _omitted, ...origins } = codexOrigins(userName);
  const [a] = await listRegistrations("codex", { cwd: "/repo", run, appServer: fakeAppServer(codexResult({ origins })) });
  assert.equal(a.status, "unknown");
});

test("Codex: config/read の enabled を一覧と照合し、省略時だけ一覧値を使う", async () => {
  const { run } = fakeRun({ "codex mcp list --json": codexList });
  const config = (enabled) => ({ ...codexConfig, mcp_servers: { ...codexConfig.mcp_servers, "pi-agent": { ...codexConfig.mcp_servers["pi-agent"], ...(enabled === undefined ? {} : { enabled }) } } });
  const get = async (value) => (await listRegistrations("codex", { cwd: "/repo", run, appServer: fakeAppServer(codexResult({ config: value })) }))[0];
  assert.equal((await get(config(false))).status, "disabled");
  assert.equal((await get(config(true))).status, "eligible");
  const disabledListed = JSON.stringify([{ name: "pi-agent", enabled: false, transport: { type: "stdio", command: "pi", args: ["x"], env: { KEY: "rawsecret" } } }]);
  const listedRun = fakeRun({ "codex mcp list --json": disabledListed });
  const mismatch = await listRegistrations("codex", { cwd: "/repo", run: listedRun.run, appServer: fakeAppServer(codexResult({ config: config(true) })) });
  // 一覧が無効なら、設定が有効でも使えない側（disabled）のまま返す。
  assert.equal(mismatch[0].status, "disabled");
});

test("Codex: env_vars の名前を設定と照合する", async () => {
  const list = JSON.stringify([{ name: "pi-agent", enabled: true, transport: { type: "stdio", command: "pi", args: ["x"], env_vars: ["KEY"] } }]);
  const config = { mcp_servers: { "pi-agent": { command: "pi", args: ["x"], env_vars: ["OTHER"] } } };
  const origins = { "mcp_servers.pi-agent.command": { name: userName }, "mcp_servers.pi-agent.args": { name: userName }, "mcp_servers.pi-agent.env_vars": { name: userName } };
  const { run } = fakeRun({ "codex mcp list --json": list });
  const [result] = await listRegistrations("codex", { cwd: "/repo", run, appServer: fakeAppServer(codexResult({ config, origins })) });
  assert.equal(result.status, "unknown");
  assert.match(result.reason, /一致しない/);
  assert.equal(JSON.stringify(result).includes("OTHER"), false);
});

test("Codex: 設定元パスが異なると登録識別値も異なる", async () => {
  const { run } = fakeRun({ "codex mcp list --json": codexList });
  const a = await listRegistrations("codex", { cwd: "/repo", run, appServer: fakeAppServer(codexResult({ origins: codexOrigins(userName) })) });
  const otherPath = { ...userName, file: "/other/config.toml" };
  const b = await listRegistrations("codex", { cwd: "/repo", run, appServer: fakeAppServer(codexResult({ origins: codexOrigins(otherPath) })) });
  assert.notEqual(a[0].registrationId, b[0].registrationId);
  assert.equal(JSON.stringify(a).includes(userName.file), false);
});

test("Codex: 同じ種類の設定元でも項目の経路との組み合わせが変わると識別値が変わる", async () => {
  const { run } = fakeRun({ "codex mcp list --json": codexList });
  const sourceA = { ...userName, file: "/home/u/a.toml" };
  const sourceB = { ...userName, file: "/home/u/b.toml" };
  const origins = codexOrigins(sourceA);
  origins["mcp_servers.pi-agent.args"] = { name: sourceB, version: "1" };
  const swapped = { ...origins,
    "mcp_servers.pi-agent.command": origins["mcp_servers.pi-agent.args"],
    "mcp_servers.pi-agent.args": origins["mcp_servers.pi-agent.command"],
  };
  const a = await listRegistrations("codex", { cwd: process.cwd(), run, appServer: fakeAppServer(codexResult({ origins })) });
  const b = await listRegistrations("codex", { cwd: process.cwd(), run, appServer: fakeAppServer(codexResult({ origins: swapped })) });
  assert.notEqual(a[0].registrationId, b[0].registrationId);
});

test("Codex: cwd が異なると識別値だけが変わり、cwd は結果に出さない", async () => {
  const { run } = fakeRun({ "codex mcp list --json": codexList });
  const read = (cwd) => listRegistrations("codex", { cwd, run, appServer: fakeAppServer(codexResult()) });
  const a = await read(process.cwd());
  const b = await read(tmpdir());
  assert.notEqual(a[0].registrationId, b[0].registrationId);
  const strip = (list) => list.map(({ registrationId, ...rest }) => rest);
  assert.deepEqual(strip(a), strip(b));
  assert.equal(JSON.stringify([a, b]).includes(process.cwd()), false);
  assert.equal(JSON.stringify([a, b]).includes(tmpdir()), false);
});

test("spawn 起動失敗は固定文言にし、実行ファイル名を公開しない", async () => {
  const executable = "missing-secret-executable";
  for (const operation of [runReadOnlyCli(executable, [], process.cwd()), requestCodexConfig({ executable, cwd: process.cwd() })]) {
    await assert.rejects(operation, (error) => {
      assert.equal(error.cause, undefined);
      assert.equal(JSON.stringify({ message: error.message }).includes(executable), false);
      return true;
    });
  }
});

test("spawn が同期例外を投げても固定文言だけを返す", async () => {
  const executable = "bad\0executable";
  for (const [operation, expected] of [
    [runReadOnlyCli(executable, [], process.cwd()), "登録情報を取得できませんでした"],
    [requestCodexConfig({ executable, cwd: process.cwd() }), "Codex の設定を取得できなかったため利用しません"],
  ]) {
    await assert.rejects(operation, (error) => {
      assert.equal(error.cause, undefined);
      assert.equal(error.message, expected);
      assert.equal(JSON.stringify({ message: error.message }).includes(JSON.stringify(executable)), false);
      return true;
    });
  }
});

test("Codex: url だけの登録は stdio と認めず、一覧が stdio と言っても unknown とする", async () => {
  const list = JSON.stringify([{ name: "remote", enabled: true, disabled_reason: null, transport: { type: "stdio", command: "x" } }]);
  const config = { mcp_servers: { remote: { url: "https://example.invalid/mcp" } } };
  const origins = { "mcp_servers.remote.url": { name: userName, version: "1" } };
  const { run } = fakeRun({ "codex mcp list --json": list });
  const [a] = await listRegistrations("codex", { cwd: "/repo", run, appServer: fakeAppServer(codexResult({ config, origins })) });
  assert.equal(a.status, "unknown");
  assert.equal(JSON.stringify(a).includes("example.invalid"), false);
});

test("CLI の出力が受信量の上限を超えたら読み取りを止め、例外にする", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-limit-"));
  try {
    const big = await fakeScript(dir, "big.mjs", `process.stdout.write("x".repeat(200000));`);
    await assert.rejects(registry.runReadOnlyCli(big, [], dir, { maxBytes: 1024, timeoutMs: 5000 }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("app-server の受信量が上限を超えたら unknown に閉じ、子プロセスを止める", async () => {
  const dir = await mkdtemp(join(tmpdir(), "appserver-limit-"));
  try {
    const big = await fakeScript(dir, "big-app.mjs", `import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", () => process.stdout.write("x".repeat(5000) + "\\n"));`);
    const started = Date.now();
    await assert.rejects(registry.requestCodexConfig({ executable: big, cwd: dir, timeoutMs: 5000, maxBytes: 1024 }));
    // 時間切れ（5 秒）を待たず、受信量の上限で止まったことを確かめる。
    assert.ok(Date.now() - started < 3000, "受信量の上限で止まっていない");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI の時間切れは SIGTERM を無視する子も SIGKILL で止め、Promise を必ず返す", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-timeout-"));
  try {
    const pidFile = join(dir, "pid");
    const hang = await fakeScript(dir, "hang-cli.mjs", `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);`);
    const started = Date.now();
    await assert.rejects(registry.runReadOnlyCli(hang, [], dir, { timeoutMs: 300 }));
    assert.ok(Date.now() - started < 3000, "時間切れ後に Promise が返っていない");
    await assertProcessGone(Number((await readFile(pidFile, "utf8")).trim()));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("app-server の時間切れで、偽の子プロセスの pid が消えることを確かめる", async () => {
  const dir = await mkdtemp(join(tmpdir(), "appserver-pid-"));
  try {
    const pidFile = join(dir, "pid");
    const hang = await fakeScript(dir, "hang-app.mjs", `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);`);
    await assert.rejects(registry.requestCodexConfig({ executable: hang, cwd: dir, timeoutMs: 1000 }));
    await assertProcessGone(Number((await readFile(pidFile, "utf8")).trim()));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI と app-server の時間切れで孫プロセスも終了する", async () => {
  const dir = await mkdtemp(join(tmpdir(), "process-tree-"));
  try {
    const grandchildFile = join(dir, "grandchild-pid");
    const childBody = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(grandchildFile)}, String(grandchild.pid));
setInterval(() => {}, 1000);`;
    const cli = await fakeScript(dir, "tree-cli.mjs", childBody);
    await assert.rejects(registry.runReadOnlyCli(cli, [], dir, { timeoutMs: 300 }));
    await assertProcessGone(Number((await readFile(grandchildFile, "utf8")).trim()));
    await rm(grandchildFile, { force: true });
    const app = await fakeScript(dir, "tree-app.mjs", `import { createInterface } from "node:readline";
${childBody}
createInterface({ input: process.stdin }).on("line", () => {});`);
    await assert.rejects(registry.requestCodexConfig({ executable: app, cwd: dir, timeoutMs: 300 }));
    await assertProcessGone(Number((await readFile(grandchildFile, "utf8")).trim()));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex: 設定元の実体（file / dotCodexFolder）が無い設定元は unknown", async () => {
  const { run } = fakeRun({ "codex mcp list --json": codexList });
  for (const bare of [{ type: "user" }, { type: "project" }]) {
    const origins = codexOrigins(bare);
    const [result] = await listRegistrations("codex", { cwd: "/repo", run, appServer: fakeAppServer(codexResult({ origins, layers: [userLayer, projectLayer(null)] })) });
    assert.equal(result.status, "unknown");
  }
});

test("空の args と env は未指定と同じ transport 指紋になる", () => {
  const fromClaude = { type: "stdio", command: "node" };
  const fromProjectConfig = { type: "stdio", command: "node", args: [], env: {} };
  assert.equal(fingerprintTransport(fromProjectConfig), fingerprintTransport(fromClaude));
});
