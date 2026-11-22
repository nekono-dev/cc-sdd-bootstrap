#!/usr/bin/env node
// 6.2 の障害再現。実ストア・実ワーカー・実 Pi adapter を使い、登録済みの pi-agent（stdio）に接続する。
// 障害は接続の包み（応答の欠落・接続断）と、実プロセスの所有者の終了で注入する。
// 費用は掛からない（ローカル Ollama）。一時作業ディレクトリは呼び出し側が作る。
// 実行: node poc/codex-delegation-live/faults.mjs <一時作業ディレクトリ>
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDelegationJobStore } from "../../.agent-hooks/cc-sdd-bootstrap/delegation-job-store.mjs";
import { createJobWorker } from "../../.agent-hooks/cc-sdd-bootstrap/delegation-job-worker.mjs";
import { createPiAdapter } from "../../.agent-hooks/cc-sdd-bootstrap/delegation-mcp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PI_COMMAND = ["/home/ubuntu/.local/share/ollama-mcp/venv/bin/python", "/home/ubuntu/.local/share/pi-agent/pi_mcp.py"];
const PI_STATE = "/home/ubuntu/.local/share/pi-agent/sessions";
const MODEL = process.env.PI_LIVE_MODEL ?? "leeplenty/forgotten-safeword:12b";
const REQUEST_TIMEOUT_MS = 3000;

/**
 * 登録済み pi-agent の stdio 接続。request は実サーバーへ送る。
 * fault: "none" は通常、"no-response" は pi_start を実サーバーへ送ったうえで応答を届けない、
 * "drop" は pi_start を送った直後にサーバーを終了させる（接続断）。
 */
class PiStdio {
  constructor(fault) {
    this.fault = fault;
    this.child = spawn(PI_COMMAND[0], PI_COMMAND.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const waiter = this.pending.get(message.id);
        if (waiter) { this.pending.delete(message.id); waiter.resolve(message); }
      }
    });
    this.child.on("exit", () => {
      this.closed = true;
      for (const [id, waiter] of this.pending) { this.pending.delete(id); waiter.reject(new Error("接続が閉じました")); }
    });
    this.tools = new Map();
    this.serverInfo = null;
  }

  send(method, params, notification = false) {
    const message = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
    if (notification) { this.child.stdin.write(`${JSON.stringify(message)}\n`); return null; }
    const id = ++this.nextId;
    message.id = id;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return response;
  }

  async init() {
    const init = await this.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cc-sdd-fault-probe", version: "1" } });
    this.serverInfo = init.result.serverInfo;
    this.send("notifications/initialized", undefined, true);
    const listed = await this.send("tools/list", {});
    this.tools = new Map(listed.result.tools.map((tool) => [tool.name, tool]));
    this.connectionId = this.serverInfo.name;
  }

  /** adapter の契約どおり、JSON-RPC の result を返す。エラー応答は例外にする。 */
  async request(method, params) {
    const isStart = method === "tools/call" && params?.name === "pi_start";
    if (isStart && this.fault === "no-response") {
      // 実サーバーには届けてジョブを起動させるが、呼び出し側へは応答を返さない。
      this.send(method, params).catch(() => {});
      return new Promise((_, reject) => setTimeout(() => reject(new Error("応答がありません（障害の再現）")), REQUEST_TIMEOUT_MS));
    }
    if (isStart && this.fault === "drop") {
      // 送信後にサーバーを終了させる。ジョブが既に動いたかは呼び出し側から分からない。
      const response = this.send(method, params);
      setImmediate(() => this.child.kill("SIGKILL"));
      const message = await response;
      if (message.error) throw new Error("Pi MCP がエラーを返しました");
      return message.result;
    }
    const message = await this.send(method, params);
    if (message.error) throw new Error("Pi MCP がエラーを返しました");
    if (method === "tools/call" && params?.name === "pi_capabilities") return this.capabilityContract(message.result);
    return message.result;
  }

  /**
   * 現行の pi_capabilities（execution・access_modes・thinking_levels）を、adapter が要求する契約
   * （tier・models[].accepted）へ写す。これは試験ハーネスだけの変換で、adapter 本体は変えていない。
   * 変換しない場合、実 Pi 登録は能力確認で必ず不適格になる（result.md に記録）。
   */
  async capabilityContract(result) {
    const text = result?.content?.find((item) => item.type === "text")?.text ?? "{}";
    const raw = JSON.parse(text);
    const modelsMessage = await this.send("tools/call", { name: "pi_models", arguments: {} });
    const ids = modelsMessage.result?.structuredContent?.result ?? [];
    const accepted = [];
    for (const access of raw.access_modes ?? []) for (const effort of raw.thinking_levels ?? []) accepted.push({ access, effort });
    const contract = { kind: raw.kind, harness: raw.harness, tier: raw.execution, models: ids.map((id) => ({ id, accepted })) };
    return { ...result, content: [{ type: "text", text: JSON.stringify(contract) }] };
  }

  close() {
    if (!this.closed) this.child.kill("SIGTERM");
  }
}

const opened = [];

/** 実ワーカーに、実 Pi adapter と指定の障害接続を結び付けて、起動 1 回分を行う。 */
function makeWorker({ store, fault }) {
  const connections = opened;
  return createJobWorker({
    store,
    now: Date.now,
    operationTimeoutMs: 15000,
    select: async () => ({ kind: "mcp", candidate: { id: "pi-agent" }, model: MODEL, access: "workspace-write", effort: "off" }),
    connect: async () => {
      const connection = new PiStdio(fault);
      connections.push(connection);
      await connection.init();
      const adapter = await createPiAdapter(connection);
      const close = adapter.close;
      adapter.close = async () => { connection.close(); };
      return adapter;
    },
  });
}

async function piStartsFor(cwd) {
  // pi_start は依頼ごとにセッション記録（meta.json）を 1 つ作る。作業先が一致する記録数を、起動回数とみなす。
  let count = 0;
  for (const name of await readdir(PI_STATE).catch(() => [])) {
    if (!name.endsWith(".meta.json")) continue;
    try {
      const meta = JSON.parse(await readFile(join(PI_STATE, name), "utf8"));
      if (meta.cwd === cwd) count++;
    } catch { /* 記録の途中書きは数えない */ }
  }
  return count;
}

async function scenario(name, base, fault, requests) {
  const project = join(base, `${name}-project`);
  const runtime = join(base, `${name}-runtime`);
  await mkdir(project, { recursive: true });
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const projectReal = await realpath(project);
  const store = createDelegationJobStore({ root: runtime, writableRoots: [projectReal], resolveWorktreeRoot: async () => projectReal });
  const results = [];
  for (const request of requests) {
    const worker = makeWorker({ store, fault: request.fault ?? fault });
    const outcome = await worker.start({
      requestId: request.requestId, project: projectReal, cwd: projectReal, role: "manufacture",
      instruction: "Create a file named out.txt in the current directory whose content is exactly PI-WRITE-OK. Use the write tool.",
      skill: "kiro-impl", taskId: request.taskId, access: "workspace-write",
    });
    results.push({ requestId: request.requestId, fault: request.fault ?? fault, outcome: { kind: outcome.kind, reasons: outcome.reasons ?? null, reason: outcome.reason ?? null } });
    // 障害後のジョブが書き込みを終えるまで待つ（実 Pi の書き込みは非同期に進む）。
    await new Promise((resolve) => setTimeout(resolve, 40000));
  }
  const files = (await readdir(projectReal)).sort();
  const outFile = files.includes("out.txt") ? (await readFile(join(projectReal, "out.txt"), "utf8")).trim() : null;
  return { scenario: name, starts_for_workdir: await piStartsFor(projectReal), files, out_txt: outFile, results };
}

/** 所有者喪失: 実プロセスを所有者として記録し、終了させたあとの制御先と再予約を確認する。 */
async function ownerLoss(base) {
  const project = join(base, "owner-project");
  const runtime = join(base, "owner-runtime");
  await mkdir(project, { recursive: true });
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const projectReal = await realpath(project);
  const store = createDelegationJobStore({ root: runtime, writableRoots: [projectReal], resolveWorktreeRoot: async () => projectReal });
  const base0 = { project: projectReal, cwd: projectReal, skill: "kiro-impl", taskId: "6.2-owner" };
  const reservation = await store.reserve({ requestId: "owner.loss:1", ...base0 });
  const owner = spawn("sleep", ["600"], { stdio: "ignore" });
  const recorded = await store.recordOwner({ requestId: "owner.loss:1", ...base0, generation: reservation.record.generation, pid: owner.pid, now: Date.now() });
  const alive = Boolean(recorded);
  owner.kill("SIGKILL");
  await new Promise((resolve) => owner.once("exit", resolve));
  const worker = createJobWorker({ store, now: Date.now, select: async () => ({ kind: "unavailable", reasons: ["未使用"] }), connect: async () => { throw new Error("接続してはいけない"); } });
  const target = await worker.controlTarget({ requestId: "owner.loss:1", ...base0 });
  const second = await store.reserve({ requestId: "owner.loss:2", ...base0 });
  return { scenario: "owner-loss", owner_recorded: alive, after_owner_exit_control_target: target, second_reserve: second.kind, second_reason: second.reason ?? null };
}

async function main() {
  const base = await realpath(process.argv[2]);
  const report = [];
  // 1. 応答欠落: ジョブは実際に起動するが呼び出し側は応答を受けない。別依頼 ID の再送と同じ依頼 ID の再送を試す。
  report.push(await scenario("no-response", base, "no-response", [
    { requestId: "no.response:1", taskId: "6.2-no-response" },
    { requestId: "no.response:2", taskId: "6.2-no-response" },
    { requestId: "no.response:1", taskId: "6.2-no-response" },
  ]));
  // 2. 接続断: 起動直後に Pi サーバーを終了させる。別依頼 ID で再送する。
  report.push(await scenario("connection-drop", base, "drop", [
    { requestId: "drop:1", taskId: "6.2-drop" },
    { requestId: "drop:2", taskId: "6.2-drop" },
  ]));
  // 3. 所有者喪失（実プロセス）
  report.push(await ownerLoss(base));
  console.log(JSON.stringify(report, null, 2));
  // 所有していた接続（pending の依頼を含む）を閉じる。閉じ忘れると stdio の子プロセスが残る。
  for (const connection of opened) connection.close();
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
