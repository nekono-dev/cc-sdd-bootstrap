import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

// 委任用の登録解決。ホストの読み取り専用 CLI から登録の状態を取り、
// 有効・承認待ち・無効・不明を区別する。MCP サーバーへの接続や起動はしない。

const HOSTS = new Set(["claude", "codex", "pi"]);
// 承認と信頼を証明できる設定元だけを受け付ける。
const SCOPES = new Set(["project", "user"]);
// この段階で接続してよい接続種別。リモートの URL は送信先が不明なため対象外。
const LAUNCHABLE = new Set(["stdio"]);
const CLI_TIMEOUT_MS = 5000;
const CLI_MAX_BUFFER = 1024 * 1024;
// Codex の app-server との会話の上限。時間と受信量を超えたら子プロセスを止める。
const APP_SERVER_TIMEOUT_MS = 5000;
const APP_SERVER_MAX_BYTES = 4 * 1024 * 1024;

// 診断文には、コマンド・引数・環境変数の値・登録の生の内容を含めない。
const REASON = {
  unsupportedHost: "未対応のホストです",
  readFailed: "登録情報を取得できませんでした",
  identity: "登録の識別情報を確認できません",
  scope: "登録の設定元を確認できないため利用しません",
  trust: "承認・信頼を確認できません",
  kind: "この版では stdio 以外の登録は利用できません",
  pending: "ホストの承認待ちです。承認後に再度確認してください",
  disabled: "登録が無効です",
  unsaved: "保存済みの登録がありません。セットアップが必要です",
  replaced: "保存済みの登録と一致しません。セットアップをやり直してください",
  configRead: "Codex の設定を取得できなかったため利用しません",
  origin: "項目ごとの設定元が揃っていないため利用しません",
  layer: "設定の層を照合できないため利用しません",
  untrusted: "プロジェクト設定が未信頼のため利用しません",
  mismatch: "一覧と設定の内容が一致しないため利用しません",
  family: "系統を確認できないため利用しません",
};

/** キーの順序に依らない JSON 文字列にするための正規化。 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/** 接続設定の指紋。環境変数は名前だけを使い、キー順に依らず整列する。 */
export function fingerprintTransport(transport) {
  if (!transport || typeof transport !== "object" || Array.isArray(transport) || typeof transport.type !== "string") return null;
  const safe = { ...transport };
  // cwd は起動先であり、登録 transport 自体の承認指紋には含めない。
  delete safe.cwd;
  // Claude の詳細表示とホスト設定では空の任意項目の表現が異なる。
  if (Array.isArray(safe.args) && safe.args.length === 0) delete safe.args;
  if (safe.env && typeof safe.env === "object" && !Array.isArray(safe.env) && Object.keys(safe.env).length === 0) delete safe.env;
  if (safe.env && typeof safe.env === "object" && !Array.isArray(safe.env)) {
    safe.env = Object.keys(safe.env).sort();
  }
  return createHash("sha256").update(JSON.stringify(canonical(safe))).digest("hex");
}

/** 観測結果から判定に使う項目だけを取り出す。transport 本体は保持しない。 */
function toObservation(source) {
  const transportType = source.transportType ?? source.transport?.type ?? null;
  return {
    host: source.host ?? null,
    name: typeof source.name === "string" ? source.name : "",
    family: typeof source.family === "string" ? source.family : null,
    scope: source.scope ?? null,
    enabled: source.enabled ?? null,
    approved: source.approved ?? null,
    trusted: source.trusted ?? null,
    transportType,
    transportFingerprint: source.transport ? fingerprintTransport(source.transport) : source.transportFingerprint ?? null,
    registrationId: source.registrationId ?? fingerprintTransport(source.transport),
    error: source.error ? (Object.values(REASON).includes(source.error) ? source.error : REASON.readFailed) : null,
  };
}

/** 判定結果。元の判定入力も残し、結果を再度解決に渡しても同じ判定になるようにする。 */
function withStatus(observation, status, reason) {
  const { host, name, family, scope, enabled, approved, trusted, transportType, transportFingerprint, registrationId, error } = observation;
  return { host, name, family, scope, enabled, approved, trusted, transportType, transportFingerprint, registrationId, error, status, reason };
}

/** 識別情報を照合せずに、有効・承認待ち・無効・不明を判定する。 */
export function classifyRegistration(source) {
  const observation = toObservation(source);
  if (!HOSTS.has(observation.host)) return withStatus(observation, "unknown", REASON.unsupportedHost);
  if (observation.error) return withStatus(observation, "unknown", observation.error);
  if (observation.enabled === false) return withStatus(observation, "disabled", REASON.disabled);
  if (observation.approved === false) return withStatus(observation, "pending", REASON.pending);
  if (!SCOPES.has(observation.scope)) return withStatus(observation, "unknown", REASON.scope);
  if (observation.enabled !== true || observation.approved !== true || observation.trusted !== true) {
    return withStatus(observation, "unknown", REASON.trust);
  }
  if (!LAUNCHABLE.has(observation.transportType)) return withStatus(observation, "unknown", REASON.kind);
  if (!observation.registrationId) return withStatus(observation, "unknown", REASON.identity);
  return withStatus(observation, "eligible", null);
}

/** 保存済みの識別情報と照合して再解決する。保存がない、または一致しない場合は利用しない。 */
export function resolveRegistration(source, saved, { verifiedFamily } = {}) {
  const classified = classifyRegistration(source);
  if (classified.status !== "eligible") return classified;
  if (typeof verifiedFamily !== "string" || !verifiedFamily || !saved || saved.family !== verifiedFamily) {
    return { ...classified, status: "unknown", reason: REASON.family };
  }
  if (!saved || typeof saved !== "object") return { ...classified, status: "unknown", reason: REASON.unsaved };
  const same = saved.registrationName === classified.name && saved.scope === classified.scope &&
    saved.registrationId === classified.registrationId;
  if (!same) return { ...classified, status: "unknown", reason: REASON.replaced };
  return classified;
}

/**
 * 読み取り専用の CLI を、シェルを介さず、時間上限と受信量の上限つきで実行する。
 * 時間切れ・上限超過・終了のいずれでも子を SIGKILL で止め、Promise を必ず返す。
 * 子の終了を待つのは stdio が閉じるまでではなく、この時点で打ち切る（孫プロセスが出力を握っても止まらないように）。
 */
export function runReadOnlyCli(executable, args, cwd, { timeoutMs = CLI_TIMEOUT_MS, maxBytes = CLI_MAX_BUFFER } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    let stdout = "";
    let bytes = 0;
    let child;
    try {
      child = spawn(executable, args, { cwd, shell: false, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      reject(new Error(REASON.readFailed));
      return;
    }
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessTree(child);
      if (error) reject(new Error(REASON.readFailed));
      else resolve(value);
    };
    timer = setTimeout(() => finish(new Error(REASON.readFailed)), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) return finish(new Error(REASON.readFailed));
      stdout += chunk;
    });
    child.stderr.resume();
    child.on("error", () => finish(new Error(REASON.readFailed)));
    child.on("close", (code) => (code === 0 ? finish(null, stdout) : finish(new Error(REASON.readFailed))));
  });
}

/** 子プロセスのグループ全体を止め、グループ指定に失敗した場合は子だけを止める。 */
function killProcessTree(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { try { process.kill(child.pid, "SIGKILL"); } catch { /* 既に終了していれば何もしない */ } }
}

function unknownEntry(host, error) {
  return { host, name: "", family: null, scope: null, enabled: null, approved: null, trusted: null, transportType: null, error };
}

// Claude の Status 行で接続済みと読める表記（実機の表記に合わせる）。
const CLAUDE_CONNECTED = /^(?:✓\s*)?Connected$/i;

/** Claude の詳細表示を曖昧さのない stdio transport に変換する。 */
function parseClaudeTransport(text) {
  const lines = text.split(/\r?\n/);
  const command = lines.find((line) => /^\s*Command:/i.test(line))?.replace(/^\s*Command:/i, "").trim();
  const argsText = lines.find((line) => /^\s*Args:/i.test(line))?.replace(/^\s*Args:/i, "").trim() ?? "";
  if (!command || /\s/.test(command)) return null;
  // `claude mcp get` は Args を表示用に引用する。シェルは実行せず、引用符と
  // バックスラッシュだけを解釈する限定 tokenizer で argv に戻す。
  const args = [];
  let token = "", quote = null, escaped = false, started = false;
  for (const char of argsText) {
    if (escaped) { token += char; escaped = false; started = true; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) { args.push(token); token = ""; started = false; }
      continue;
    }
    token += char; started = true;
  }
  if (escaped || quote) return null;
  if (started) args.push(token);
  const env = {};
  let inEnvironment = false;
  for (const line of lines) {
    if (/^\s*Environment:\s*$/i.test(line)) { inEnvironment = true; continue; }
    if (inEnvironment && /^\s{2,}\S/.test(line)) {
      const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|:)\s*(.*)$/);
      if (!match || Object.hasOwn(env, match[1])) return null;
      env[match[1]] = match[2];
      continue;
    }
    inEnvironment = false;
  }
  return { type: "stdio", command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) };
}

/** `claude mcp get` の結果を読む。接続時にホストから登録を読み直すため、環境変数値の差し替えは識別値では検出しない。 */
function parseClaudeDetail(host, name, text, realCwd) {
  const lines = text.split(/\r?\n/);
  const statusLine = lines.find((line) => /^\s*Status:/i.test(line));
  const scopeLine = lines.find((line) => /^\s*Scope:/i.test(line)) ?? "";
  const typeLine = lines.find((line) => /^\s*Type:/i.test(line)) ?? "";
  if (statusLine === undefined) return unknownEntry(host, REASON.trust);
  const scope = /Project config/i.test(scopeLine) ? "project" : /User config/i.test(scopeLine) ? "user" : null;
  const disabled = /disabled/i.test(statusLine);
  const pending = /Pending approval/i.test(statusLine);
  // 承認・信頼を肯定できるのは「✓ Connected」「Connected」だけ。それ以外の表記は unknown に閉じる。
  const statusValue = statusLine.replace(/^\s*Status:/i, "").trim();
  const connected = !disabled && !pending && CLAUDE_CONNECTED.test(statusValue);
  // Environment の値は捨て、認識できる名前だけを指紋に含める。
  let inEnvironment = false;
  let malformedEnvironment = false;
  const environmentNames = [];
  const identityLines = lines.filter((line) => {
    if (/^\s*Environment:\s*$/i.test(line)) { inEnvironment = true; return false; }
    if (inEnvironment && /^\s{2,}\S/.test(line)) {
      const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|:)\s*.*$/);
      if (match) environmentNames.push(match[1]);
      else malformedEnvironment = true;
      return false;
    }
    inEnvironment = false;
    return !/^\s*Status:/i.test(line);
  }).join("\n");
  if (malformedEnvironment) return unknownEntry(host, REASON.identity);
  const identityText = JSON.stringify({ detail: identityLines, environmentNames: environmentNames.sort(), cwd: realCwd });
  const transport = parseClaudeTransport(text);
  return {
    host, name, family: null, scope,
    enabled: !disabled,
    approved: disabled ? null : pending ? false : connected ? true : null,
    trusted: connected ? true : null,
    transportType: typeLine.match(/Type:\s*(\S+)/i)?.[1] ?? null,
    transportFingerprint: transport ? fingerprintTransport(transport) : null,
    registrationId: createHash("sha256").update(identityText).digest("hex"),
  };
}

async function readClaude(run, cwd) {
  const realCwd = await realpath(cwd).catch(() => resolve(cwd));
  const listing = await run("claude", ["mcp", "list"], cwd);
  const names = [...new Set([...listing.matchAll(/^([\w.-]+):/gm)].map((match) => match[1]))];
  return Promise.all(names.map(async (name) => {
    try {
      return parseClaudeDetail("claude", name, await run("claude", ["mcp", "get", name], cwd), realCwd);
    } catch {
      return unknownEntry("claude", REASON.readFailed);
    }
  }));
}

function itemsOf(data) {
  const items = Array.isArray(data) ? data : data?.servers;
  if (!Array.isArray(items)) throw new Error("想定外の形式");
  return items;
}

/**
 * codex app-server に問い合わせ、設定と設定元（layers を含む）を読み取る。
 * シェルは使わず、時間上限と受信量の上限を付け、終了時には子プロセスを必ず止める。
 */
export function requestCodexConfig({ executable = "codex", cwd, timeoutMs = APP_SERVER_TIMEOUT_MS, maxBytes = APP_SERVER_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    let buffer = "";
    let bytes = 0;
    let child;
    try {
      child = spawn(executable, ["app-server", "--listen", "stdio://"], {
        cwd, shell: false, detached: true, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      reject(new Error(REASON.configRead));
      return;
    }
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessTree(child);
      if (error) reject(new Error(REASON.configRead));
      else resolve(value);
    };
    const fail = () => finish(new Error(REASON.configRead));
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const handle = (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== "object") return;
      // 通知（id のない行）は読み飛ばす。
      if (message.id === 1) {
        if (message.error) return fail();
        send({ method: "initialized" });
        send({ id: 2, method: "config/read", params: { cwd, includeLayers: true } });
      } else if (message.id === 2) {
        if (message.error) return fail();
        try { finish(null, parseCodexConfig(message.result)); } catch { fail(); }
      }
    };
    timer = setTimeout(fail, timeoutMs);
    child.on("error", fail);
    child.on("exit", fail);
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) return fail();
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0 && !settled) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handle(line);
        index = buffer.indexOf("\n");
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "cc-sdd-bootstrap", version: "0" } } });
  });
}

/** config/read の結果の形を確かめる。形が違えば例外にして unknown に閉じる。 */
function parseCodexConfig(result) {
  const valid = result && typeof result === "object" && !Array.isArray(result) &&
    result.config && typeof result.config === "object" && !Array.isArray(result.config) &&
    result.origins && typeof result.origins === "object" && !Array.isArray(result.origins) &&
    Array.isArray(result.layers);
  if (!valid) throw new Error(REASON.configRead);
  return { config: result.config, origins: result.origins, layers: result.layers };
}

/** 入れ子の設定を「mcp_servers.<名前>.<項目>」の葉の経路（ドットつき）に平らにする。 */
function leafPaths(value, prefix = []) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) => leafPaths(child, [...prefix, key]));
  }
  return [prefix.join(".")];
}

/** 設定元の名前を、キーの順序に依らず比べられる文字列にする。 */
const sourceKey = (name) => JSON.stringify(canonical(name));

// 一覧の transport と設定の内容を照合する項目。値そのものは診断に出さない。
const TRANSPORT_KEYS = ["command", "args", "cwd", "env"];

/** 未指定（null・未定義・空の配列や表）は同じものとして扱う。 */
function comparable(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return null;
  return JSON.stringify(canonical(value));
}

/** 一覧の transport と config/read の項目が、接続に使う項目すべてで一致するか。 */
function sameTransport(transport, server) {
  const envVars = (value) => Array.isArray(value) ? [...value].sort() : value;
  return TRANSPORT_KEYS.every((key) => comparable(transport?.[key]) === comparable(server[key])) &&
    comparable(envVars(transport?.env_vars)) === comparable(envVars(server.env_vars));
}

/**
 * 登録の設定元と信頼を app-server の結果から決める。
 * 無効の登録は無効のまま返し、それ以外は設定元か信頼が確かめられない場合に error を付けて unknown に閉じる。
 */
function applyCodexConfig(item, { config, origins, layers }, realCwd) {
  if (item.enabled === false) return item;
  const fail = (error) => ({ ...item, error });
  const { name } = item;
  const servers = config.mcp_servers;
  // ドットを含む名前は「mcp_servers.<名前>.<項目>」の経路と紛れるため照合しない。
  if (!name || name.includes(".") || !servers || typeof servers !== "object" || !Object.hasOwn(servers, name)) {
    return fail(REASON.identity);
  }
  // 実機の config/read は、初期値の項目（enabled など）に設定元を付けない。
  // 設定元が付いた項目だけを対象にし、接続を決める command か url の項目が含まれることを必須にする。
  const server = servers[name];
  // 接続種別は stdio だけ。command を持ち、url を持たない登録だけを対象にする。
  if (typeof server.command !== "string" || Object.hasOwn(server, "url")) return fail(REASON.kind);
  if (server.enabled === false) return { ...item, enabled: false, error: null };
  if (server.enabled !== undefined && server.enabled !== item.enabled) return fail(REASON.mismatch);
  // 一覧の transport と設定の内容が食い違えば、同名の別の登録とみなして閉じる。
  if (!sameTransport(item.transport, server)) return fail(REASON.mismatch);
  const prefix = `mcp_servers.${name}.`;
  const originKeys = Object.keys(origins ?? {}).filter((key) => key.startsWith(prefix));
  const hasConnectionKey = originKeys.some((key) => /^(command|url)(\.|$)/.test(key.slice(prefix.length)));
  const leaves = leafPaths(servers[name]).filter((path) => path !== "");
  if (leaves.length === 0 || !hasConnectionKey) return fail(REASON.identity);
  // 接続を決める項目（値があるもの）は、必ず設定元が付いていなければならない。
  const identityTop = new Set(["command", "args", "cwd", "env", "env_vars", "url", "http_headers", "env_http_headers", "bearer_token_env_var"]);
  for (const leaf of leaves) {
    if (identityTop.has(leaf.split(".")[0]) && !originKeys.some((key) => key === prefix + leaf || key.startsWith(`${prefix}${leaf}.`))) return fail(REASON.origin);
  }
  const sources = [];
  for (const key of originKeys) {
    const origin = origins[key];
    if (!origin || typeof origin !== "object" || !origin.name || typeof origin.name.type !== "string") return fail(REASON.origin);
    sources.push({ path: key.slice(prefix.length), name: origin.name });
  }
  // 項目の設定元の種類が一つに揃うときだけ採用する。
  const types = new Set(sources.map(({ name }) => name.type));
  if (types.size !== 1) return fail(REASON.origin);
  const [type] = types;
  // 設定元の実体（ファイルまたは .codex の場所）を識別できない情報は、差し替えを検出できないため採用しない。
  const locator = type === "user" ? "file" : type === "project" ? "dotCodexFolder" : null;
  if (locator && !sources.every(({ name }) => typeof name[locator] === "string" && name[locator] !== "")) return fail(REASON.origin);
  const sourceIdentity = sources
    .map(({ path, name }) => ({ path, name: canonical(name) }))
    .sort((a, b) => a.path.localeCompare(b.path) || JSON.stringify(a.name).localeCompare(JSON.stringify(b.name)));
  const registrationId = createHash("sha256").update(JSON.stringify({ transport: fingerprintTransport(item.transport), source: sourceIdentity, cwd: realCwd })).digest("hex");
  if (type === "user") return { ...item, scope: "user", registrationId, approved: true, trusted: true, error: null };
  if (type !== "project") return fail(REASON.scope);
  // project 層は、同じ設定元の層が見つかり、信頼済み（disabledReason が null）のときだけ採用する。
  for (const source of new Set(sources.map(({ name }) => sourceKey(name)))) {
    const layer = layers.find((candidate) => candidate && typeof candidate === "object" && sourceKey(candidate.name) === source);
    if (!layer) return fail(REASON.layer);
    if (layer.disabledReason !== null) return fail(REASON.untrusted);
  }
  // Codex には登録ごとの承認がないため、信頼済みの project 層を承認とみなす。
  return { ...item, scope: "project", registrationId, approved: true, trusted: true, error: null };
}

async function readCodex(run, cwd, { readConfig }) {
  const realCwd = await realpath(cwd).catch(() => resolve(cwd));
  const items = itemsOf(JSON.parse(await run("codex", ["mcp", "list", "--json"], cwd))).map((item) => ({
    host: "codex",
    name: typeof item.name === "string" ? item.name : "",
    family: null,
    scope: null,
    enabled: item.disabled_reason ? false : item.enabled === true ? true : item.enabled === false ? false : null,
    approved: null,
    trusted: null,
    transport: item.transport ?? null,
  }));
  if (items.length === 0) return items;
  let codexConfig;
  try {
    codexConfig = parseCodexConfig(await readConfig({ cwd }));
  } catch {
    // 設定を読めなければ、無効の判定だけ残して他は unknown に閉じる。
    return items.map((item) => (item.enabled === false ? item : { ...item, error: REASON.configRead }));
  }
  return items.map((item) => applyCodexConfig(item, codexConfig, realCwd));
}

async function readPi(run, cwd) {
  // Pi の一覧の設定元と信頼の表現は未確認のため、有効でも不明として扱う。
  return itemsOf(JSON.parse(await run("pi", ["mcp", "list", "--json"], cwd))).map((item) => ({
    host: "pi",
    name: typeof item.name === "string" ? item.name : "",
    family: null,
    scope: null,
    enabled: item.enabled === false ? false : item.enabled === true ? true : null,
    approved: null,
    trusted: null,
    transport: item.transport ?? null,
  }));
}

const READERS = { claude: readClaude, codex: readCodex, pi: readPi };

/**
 * ホストの読み取り専用 CLI から登録を取得し、判定結果の一覧を返す。
 * run・binaries・appServer は差し替え可能で、テストでは決定的な応答を与える。
 * appServer は { cwd, executable, timeoutMs } を受け、config/read の結果を返す関数。
 */
export async function listRegistrations(host, {
  cwd = process.cwd(), run = runReadOnlyCli, binaries = {}, appServer = requestCodexConfig, appServerTimeoutMs,
} = {}) {
  if (!HOSTS.has(host)) return [withStatus(toObservation({ host: String(host), error: REASON.unsupportedHost }), "unknown", REASON.unsupportedHost)];
  const execute = (executable, args, dir) => run(binaries[executable] ?? executable, args, dir);
  const readConfig = ({ cwd: dir }) => appServer({ cwd: dir, executable: binaries.codex ?? "codex", timeoutMs: appServerTimeoutMs });
  try {
    const observations = await READERS[host](execute, cwd, { readConfig });
    return observations.map((observation) => classifyRegistration(observation));
  } catch {
    return [withStatus(toObservation({ host, error: REASON.readFailed }), "unknown", REASON.readFailed)];
  }
}

/** Claude のプロジェクト登録から承認済み stdio transport を読み直す。 */
export async function readTransport(registration, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => key !== "cwd") ||
      options.cwd !== undefined && (typeof options.cwd !== "string" || !options.cwd.trim()) ||
      !registration || typeof registration !== "object" || Array.isArray(registration) ||
      Object.keys(registration).some((key) => !["host", "name", "scope", "registrationId", "status", "transportFingerprint", "cwd"].includes(key)) ||
      registration.cwd !== undefined && (typeof registration.cwd !== "string" || !registration.cwd.trim()) ||
      registration.transportFingerprint !== undefined && (typeof registration.transportFingerprint !== "string" || !registration.transportFingerprint.trim()) ||
      !["claude", "codex"].includes(registration.host) || !["project", "user"].includes(registration.scope) || typeof registration.name !== "string" || !registration.name.trim() || registration.status !== "eligible") return null;
  const cwd = options.cwd ?? process.cwd();
  if (registration.host === "codex") {
    try {
      const observed = await requestCodexConfig({ cwd });
      const transport = observed.config?.mcp_servers?.[registration.name];
      if (!transport || typeof transport !== "object" || Array.isArray(transport) || typeof transport.command !== "string" || !transport.command.trim() ||
          transport.args !== undefined && (!Array.isArray(transport.args) || !transport.args.every((item) => typeof item === "string")) ||
          transport.env !== undefined && (!transport.env || typeof transport.env !== "object" || Array.isArray(transport.env) || !Object.values(transport.env).every((item) => typeof item === "string"))) return null;
      return { type: "stdio", command: transport.command, ...(transport.args === undefined ? {} : { args: transport.args }), ...(transport.env === undefined ? {} : { env: transport.env }), cwd };
    } catch { return null; }
  }
  if (registration.scope === "user") {
    try {
      const detail = await runReadOnlyCli("claude", ["mcp", "get", registration.name], cwd);
      return parseClaudeTransport(detail);
    } catch { return null; }
  }
  if (registration.scope !== "project") return null;
  try {
    const { readFile } = await import("node:fs/promises");
    const config = JSON.parse(await readFile(resolve(cwd, ".mcp.json"), "utf8"));
    const value = config?.mcpServers?.[registration.name];
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.command !== "string" || !value.command.trim() ||
        value.args !== undefined && (!Array.isArray(value.args) || !value.args.every((item) => typeof item === "string")) ||
        value.env !== undefined && (!value.env || typeof value.env !== "object" || Array.isArray(value.env) || !Object.values(value.env).every((item) => typeof item === "string"))) return null;
    return { type: "stdio", command: value.command, ...(value.args === undefined ? {} : { args: value.args }), ...(value.env === undefined ? {} : { env: value.env }), cwd };
  } catch { return null; }
}
