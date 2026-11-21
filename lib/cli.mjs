// コマンドの処理の本体。引数の解析と使い方の表示を持つ。
// （操作の実行・対話・出力の整形は後のタスクで同じファイルに足していく）
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { configFields } from "./config-schema.mjs";
import { catalog, CONFIG_PATH, DEPLOY_DIR, LEDGER_PATH } from "./catalog.mjs";
import { generateNativeAgentDefinitions } from "../.agent-hooks/cc-sdd-bootstrap/native-agent-definitions.mjs";
import { parseConfig, validateConfig, findUnknownKeys, fillDefaults, resolveValues } from "./config.mjs";
import { parseLedger } from "./ledger.mjs";
import { makePlan, isNativeAgentPath } from "./plan.mjs";
import { isGitRoot, readSnapshot, readPackageFiles, readConfigState, readPackageVersion, applyPlan, allIgnoreLines } from "./target.mjs";
import path from "node:path";

/** @typedef {import("./config-schema.mjs").ConfigField} ConfigField */
/** @typedef {import("./config-schema.mjs").ConfigValue} ConfigValue */

/**
 * 引数の解析結果。
 * @typedef {{ kind: "help" }
 *   | { kind: "usage-error", message: string }
 *   | { kind: "run", operation: "init" | "update" | "uninstall", given: Record<string, ConfigValue>, force: boolean }} ParsedArgs
 */

const OPERATIONS = ["init", "update", "uninstall"];
/** 設定の指定を受け付ける操作 */
const CONFIG_OPERATIONS = ["init", "update"];
/** 対応の役割名として使えない名前（オブジェクトの土台を書き換えられないように） */
const FORBIDDEN_ROLES = ["__proto__", "constructor", "prototype"];

/**
 * 使い方の文章を設定の定義から作る。
 * @param {ConfigField[]} [fields]
 * @returns {string}
 */
export function buildUsage(fields = configFields) {
  const lines = [
    "使い方: cc-sdd-bootstrap <操作> [オプション]",
    "",
    "操作:",
    "  init        cc-sdd の運用一式をこのリポジトリへ導入する",
    "  update      導入済みの一式を最新にする",
    "  uninstall   導入した一式を取り除く",
    "",
    "オプション（3 つの操作すべて）:",
    "  --force     内容の違う同名のファイルがあっても置き換える",
    "  -h, --help  この使い方を表示する",
    "",
    "設定のオプション（init と update だけ）:",
  ];
  for (const f of fields) {
    lines.push(`  ${flagSyntax(f)}`);
    lines.push(`      ${f.question}（既定値: ${describeDefault(f)}）`);
  }
  const declaredFlags = new Set(fields.map((f) => f.flag));
  if (declaredFlags.has("clients") && declaredFlags.has("codex")) {
    lines.push("  --clients は導入対象、--codex は Claude Code から Codex への MCP 委任の指定です。");
  }
  return lines.join("\n") + "\n";
}

const pathList = (items) => items.length ? items.map((item) => `  ${item.path}${item.note === "restored" ? "（作り直した）" : item.note === "overwritten" ? "（上書きした）" : item.note === "permission-restored" ? "（実行権限を戻した）" : ""}`).join("\n") : "  なし";
export function formatSuccess({ operation, plan, defaulted = [], filled = [], unknown = [], config = null, agentsOverrideExists = false }) {
  const lines = plan.changes.length ? [`${operation} が完了しました。`, "作成", pathList(plan.changes.filter((c) => c.action === "write" && !c.existed)), "更新", pathList(plan.changes.filter((c) => c.action === "write" && c.existed)), "削除", pathList(plan.changes.filter((c) => c.action === "delete"))] : ["変更はありません。"];
  const valueAt = (key) => key.split(".").reduce((v, k) => v?.[k], config);
  if (operation === "init" || operation === "update") {
    lines.push(`導入対象: ${valueAt("clients") ?? "不明"}`);
    if (valueAt("clients") === "codex" || valueAt("clients") === "both") {
      lines.push("Codex で使うにはプロジェクトを信頼し、/hooks で登録を確認して承認してください。");
      if (agentsOverrideExists) lines.push("AGENTS.override.md があるため既存の上書き指示を尊重します。Codex で導入手順を確認するときは AGENTS.md の cc-sdd-bootstrap 管理区画を参照してください。");
    }
  }
  for (const [label, keys] of [["既定値を使った項目", defaulted], ["補った項目", filled]]) if (keys.length) lines.push(`${label}:`, ...keys.map((key) => `  ${key}: ${JSON.stringify(valueAt(key))}`));
  if (unknown.length) lines.push("警告: 設定に知らない項目があります。", ...unknown.map((key) => `  ${key}`));
  // 計画の注記に続けて、値が真の項目のお知らせ（init・update のとき）を示す
  const notices = [...plan.notices, ...((operation === "init" || operation === "update") ? configFields.filter((f) => f.notice && valueAt(f.path) === true).map((f) => f.notice) : [])];
  if (notices.length) lines.push("お知らせ:", ...notices.map((n) => `  ${n}`));
  if (operation === "init") lines.push("設定ファイルと配置したファイルをコミットしてください。", "cc-sdd 本体は次の Claude Code セッションの開始時に導入されます。", "版を固定するには npx github:nekono-dev/cc-sdd-bootstrap#<タグ> を使えます。");
  return lines.join("\n") + "\n";
}
export function formatAbort(blocks, operation, sourceCatalog = catalog) {
  return blocks.map((b) => {
    if (b.kind === "modified") {
      const deletes = operation === "uninstall" || !sourceCatalog.files.some((file) => file.path === b.path);
      return `書き換えられたファイル: ${b.path}${b.detail && b.detail !== b.path ? `（${b.detail}）` : ""}\n--force を付けて再実行すると${deletes ? "削除" : "上書き"}します。`;
    }
    if (b.kind === "markers") return `${b.detail}\n${b.path} の目印の行を直してから再実行してください。`;
    return `${b.detail}\n${b.path} が読めません。内容を直してから再実行してください。`;
  }).join("\n") + "\n";
}
export function formatConfigError(error) {
  const prefix = error.code === "CONFIG_UNREADABLE" ? `${CONFIG_PATH} を JSON として読めません。` : `${CONFIG_PATH} に問題があります。`;
  const reasons = error.messages.map((message) => `  ${message.replace(/^設定ファイル:\s*/, "")}`).join("\n");
  return `${prefix}\n${reasons}\nファイルを直してから再実行してください。\n`;
}
export function formatApplyFailure(result, operation = "init", configExisted = false) {
  const retry = operation === "uninstall" ? "uninstall" :
    configExisted || result.done.some((change) => change.path === CONFIG_PATH) ? "update" : "init";
  return [
    `済んだもの:\n${pathList(result.done)}`,
    `失敗したもの: ${result.failed.change.path}（${result.failed.message}）`,
    `未処理のもの:\n${pathList(result.pending)}`,
    `失敗した道筋の権限またはファイルの種類を確認して直してください（例: ディレクトリが必要な場所に通常ファイルがある場合）。`,
    `直したあと、${retry} をもう一度実行してください。`,
  ].join("\n") + "\n";
}
export function formatReadFailure(error) {
  const pathHint = error && typeof error === "object" && error.path ? `（${error.path}）` : "";
  const reason = error instanceof Error ? error.message : String(error);
  return `処理を続けられませんでした${pathHint}: ${reason}\n確認して直してから、同じ操作をもう一度実行してください\n`;
}

/** @param {ConfigField} f */
function flagSyntax(f) {
  if (f.kind === "boolean") return `--${f.flag} yes|no`;
  if (f.kind === "map") return `--${f.flag} <役割>=<モデル>（繰り返し指定できる）`;
  if (f.kind === "enum" && f.choices) return `--${f.flag} <${f.choices.join("|")}>`;
  return `--${f.flag} <値>`;
}

/** @param {ConfigField} f */
function describeDefault(f) {
  if (f.kind === "boolean") return f.defaultValue ? "yes" : "no";
  if (f.kind === "map") {
    const entries = Object.entries(/** @type {Record<string, string>} */ (f.defaultValue));
    return entries.length === 0 ? "なし" : entries.map(([k, v]) => `${k}=${v}`).join(", ");
  }
  return String(f.defaultValue);
}

/**
 * 引数を解析する。
 * @param {string[]} argv
 * @param {ConfigField[]} fields
 * @returns {ParsedArgs}
 */
export function parseCliArgs(argv, fields) {
  const endIdx = argv.indexOf("--");
  const head = endIdx === -1 ? argv : argv.slice(0, endIdx);
  if (head.includes("--help") || head.includes("-h")) return { kind: "help" };

  /** @type {Record<string, any>} */
  const options = { help: { type: "boolean", short: "h" }, force: { type: "boolean" } };
  for (const f of fields) {
    options[f.flag] = f.kind === "map" ? { type: "string", multiple: true } : { type: "string" };
  }

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, strict: true, allowPositionals: true });
  } catch (err) {
    return { kind: "usage-error", message: describeParseError(err) };
  }

  const { values, positionals } = parsed;
  if (positionals.length === 0) return { kind: "help" };
  const operation = positionals[0];
  if (!OPERATIONS.includes(operation)) {
    return { kind: "usage-error", message: `未知の操作です: ${operation}（init・update・uninstall のどれかを指定してください）` };
  }
  if (positionals.length > 1) {
    return { kind: "usage-error", message: `余分な引数があります: ${positionals.slice(1).join(" ")}` };
  }

  /** @type {Record<string, ConfigValue>} */
  const given = {};
  for (const f of fields) {
    const raw = values[f.flag];
    if (raw === undefined) continue;
    if (!CONFIG_OPERATIONS.includes(operation)) {
      return { kind: "usage-error", message: `--${f.flag} は ${operation} では指定できません（init と update だけで指定できます）` };
    }
    if (f.kind === "boolean") {
      const b = parseBool(/** @type {string} */ (raw));
      if (b === null) {
        return { kind: "usage-error", message: `--${f.flag} には yes・no・true・false のどれかを指定してください（指定された値: ${raw}）` };
      }
      given[f.path] = b;
    } else if (f.kind === "map") {
      const map = parseMapEntries(f.flag, /** @type {string[]} */ (raw));
      if (typeof map === "string") return { kind: "usage-error", message: map };
      given[f.path] = map;
    } else {
      given[f.path] = /** @type {string} */ (raw);
    }
  }
  return { kind: "run", operation: /** @type {any} */ (operation), given, force: Boolean(values.force) };
}

/**
 * yes/no/true/false（大文字小文字は区別しない）を真偽にする。
 * @param {string} s
 * @returns {boolean | null}
 */
function parseBool(s) {
  const v = s.toLowerCase();
  if (v === "yes" || v === "true") return true;
  if (v === "no" || v === "false") return false;
  return null;
}

/**
 * 対話の真偽の答え（y・n も受け付ける）を真偽にする。解釈できなければ undefined。
 * @param {string} s
 * @returns {boolean | undefined}
 */
function parseAnswerBool(s) {
  const v = s.toLowerCase();
  if (v === "y") return true;
  if (v === "n") return false;
  return parseBool(s) ?? undefined;
}

/**
 * 「役割=モデル」の繰り返しを対応にする。誤りなら日本語の理由の文字列を返す。
 * @param {string} flag
 * @param {string[]} entries
 * @returns {Record<string, string> | string}
 */
function parseMapEntries(flag, entries) {
  /** @type {Record<string, string>} */
  const map = Object.create(null);
  for (const entry of entries) {
    const i = entry.indexOf("=");
    if (i === -1) return `--${flag} は「役割=モデル」の形で指定してください（指定された値: ${entry}）`;
    const role = entry.slice(0, i);
    const model = entry.slice(i + 1);
    if (role === "" || model === "") {
      return `--${flag} は役割もモデルも空にできません（指定された値: ${entry}）`;
    }
    if (FORBIDDEN_ROLES.includes(role)) return `--${flag} の役割名に ${role} は使えません`;
    map[role] = model;
  }
  return { ...map };
}

/**
 * parseArgs の例外を日本語の理由にする。
 * @param {any} err
 * @returns {string}
 */
function describeParseError(err) {
  const msg = String(err && err.message);
  switch (err && err.code) {
    case "ERR_PARSE_ARGS_UNKNOWN_OPTION": {
      const m = msg.match(/Unknown option '([^']+)'/);
      return `未知のオプションです: ${m ? m[1] : msg}`;
    }
    case "ERR_PARSE_ARGS_INVALID_OPTION_VALUE": {
      const m = msg.match(/Option '([^']+)/);
      return `オプションに値が必要です: ${m ? m[1].replace(/ <value>$/, "") : msg}`;
    }
    default:
      return `引数を解釈できません: ${msg}`;
  }
}

/**
 * 対話に使う入出力。
 * @typedef {object} CliIo
 * @property {NodeJS.ReadableStream} stdin
 * @property {{ write(s: string): unknown }} stdout
 * @property {{ write(s: string): unknown }} stderr
 * @property {boolean} interactive 入力と出力の両方が端末か
 */

/**
 * 設定の道筋（"a.b"）で入れ子の値を取り出す。無ければ undefined。
 * @param {any} obj
 * @param {string} path
 */
function lookup(obj, path) {
  let cur = obj;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * 対話で項目を尋ね、答えを道筋ごとにまとめて返す（端末かどうかは呼び出し側が決める）。
 * 引数で渡された項目（given にある道筋）は尋ねない。既定値は既存の設定（base）を優先する。
 * @param {CliIo} io
 * @param {ConfigField[]} fields
 * @param {Record<string, any>} base 既存の設定
 * @param {Record<string, ConfigValue>} given 引数で渡された値
 * @returns {Promise<Record<string, ConfigValue>>}
 */
export async function promptValues(io, fields, base, given) {
  const rl = createInterface({ input: io.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  /** 1 行読む。入力が尽きたら null */
  const readLine = async () => {
    const r = await lines.next();
    return r.done ? null : String(r.value).trim();
  };
  /**
   * 1 つの値を、正しくなるまで尋ねる。
   * @param {string} label
   * @param {string} shown 既定値の表示
   * @param {(input: string) => unknown} convert 空でない入力を値にする（変換できなければ undefined）
   * @param {unknown} dflt
   * @param {(v: unknown) => string | null} check
   * @param {string} badForm 変換できないときの理由
   */
  const ask = async (label, shown, convert, dflt, check, badForm) => {
    for (;;) {
      io.stdout.write(`${label} [${shown}]: `);
      const input = await readLine();
      io.stdout.write("\n");
      const eof = input === null;
      let value = dflt;
      if (!eof && input !== "") {
        value = convert(input);
        if (value === undefined) {
          io.stdout.write(`${badForm}\n`);
          continue;
        }
      }
      const reason = check(value);
      if (reason === null) return value;
      if (eof) {
        throw new Error(`入力が終わりました。「${label}」の既定値が正しくないため決められません: ${reason}`);
      }
      io.stdout.write(`${reason}\n`);
    }
  };

  /** @type {Record<string, ConfigValue>} */
  const out = {};
  try {
    for (const f of fields) {
      if (Object.hasOwn(given, f.path)) continue;
      const existing = lookup(base, f.path);
      if (f.kind === "map") {
        const keys = f.mapKeys ?? [];
        if (keys.length === 0) continue;
        const baseMap = existing && typeof existing === "object" ? existing : {};
        const defMap = /** @type {Record<string, string>} */ (f.defaultValue);
        /** @type {Record<string, string>} */
        const map = {};
        for (const key of keys) {
          const dflt = Object.hasOwn(baseMap, key) ? baseMap[key] : Object.hasOwn(defMap, key) ? defMap[key] : "";
          map[key] = /** @type {string} */ (await ask(
            `${f.question}: ${key}`, dflt, (s) => s, dflt,
            (v) => f.validate({ [key]: v }), "",
          ));
        }
        out[f.path] = map;
      } else if (f.kind === "boolean") {
        const dflt = typeof existing === "boolean" ? existing : Boolean(f.defaultValue);
        out[f.path] = /** @type {boolean} */ (await ask(
          f.question, dflt ? "yes" : "no", parseAnswerBool, dflt, (v) => f.validate(v),
          "yes・no・true・false のどれかで答えてください",
        ));
      } else {
        const dflt = typeof existing === "string" ? existing : String(f.defaultValue);
        out[f.path] = /** @type {string} */ (await ask(
          f.question, dflt, (s) => s, dflt, (v) => f.validate(v), "",
        ));
      }
    }
  } finally {
    rl.close();
  }
  return out;
}

/**
 * コマンドの処理。終了コードを返す。
 * @param {string[]} argv
 * @param {{ stdout: { write(s: string): unknown }, stderr: { write(s: string): unknown } }} io
 * @returns {Promise<number>}
 */
export async function runCli(argv, io) {
  const parsed = parseCliArgs(argv, configFields);
  if (parsed.kind === "help") {
    io.stdout.write(buildUsage(configFields));
    return 0;
  }
  if (parsed.kind === "usage-error") {
    io.stderr.write(`${parsed.message}\n\n${buildUsage(configFields)}`);
    return 2;
  }
  try {
    return await runOperation(parsed, io);
  } catch (error) {
    io.stderr.write(formatReadFailure(error));
    return 1;
  }
}

/** 操作の結果を短い日本語で知らせる。後から出力を整えやすいよう種類ごとに分ける。 */
function writeOperationMessage(io, kind, message) {
  (kind === "error" ? io.stderr : io.stdout).write(`${message}\n`);
}

/** git ルート確認から計画の適用までを行う。 */
async function runOperation(parsed, io) {
  const { operation, given, force } = parsed;
  const root = io.cwd ?? process.cwd();
  if (!isGitRoot(root)) {
    writeOperationMessage(io, "error", "git リポジトリの最上位で実行してください。");
    return 1;
  }
  const configState = readConfigState(root);
  const configExists = configState.kind !== "missing";
  if (operation === "init" && configExists) {
    writeOperationMessage(io, "info", "すでに導入されています。更新には update を使ってください。");
    return 0;
  }
  if (operation !== "init" && !configExists) {
    writeOperationMessage(io, "error", `まだ導入されていません。先に init を実行してください。`);
    return 1;
  }
  if (operation !== "init" && configState.kind !== "file") {
    writeOperationMessage(io, "error", `設定ファイル ${CONFIG_PATH} が読めません。ファイルに直してから再実行してください。`);
    return 1;
  }

  const ledgerOnlySnapshot = readSnapshot(root, [CONFIG_PATH, LEDGER_PATH], allIgnoreLines(catalog.gitignore));
  const ledger = parseLedger(ledgerOnlySnapshot.ledger);
  let selectedDefinitions = [];
  let selectedClients = [];
  const catalogPaths = catalog.files.map((file) => file.path);
  const recordedPaths = Object.keys(ledger?.files ?? {}).filter((entry) =>
    (entry.startsWith(`${DEPLOY_DIR}/`) || isNativeAgentPath(entry)) && !entry.split(/[\\/]/).some((part) => part === ".." || part === "."),
  );
  let config = null;
  let filled = [];
  let unknown = [];
  let defaulted = [];
  if (operation !== "uninstall") {
    let base = null;
    let prompted = {};
    if (operation === "update") {
      const parsedConfig = parseConfig(ledgerOnlySnapshot.config);
      if (!parsedConfig.ok) {
        io.stderr.write(formatConfigError(parsedConfig.error));
        return 1;
      }
      const validation = validateConfig(parsedConfig.config, configFields);
      if (validation) {
        io.stderr.write(formatConfigError(validation));
        return 1;
      }
      unknown = findUnknownKeys(parsedConfig.config, configFields);
      const defaults = fillDefaults(parsedConfig.config, configFields);
      base = defaults.config;
      filled = defaults.filled;
    } else if (io.interactive) {
      try {
        prompted = await promptValues(io, configFields, {}, given);
      } catch (error) {
        writeOperationMessage(io, "error", error instanceof Error ? error.message : String(error));
        return 1;
      }
    }
    const resolved = resolveValues({ base, given, prompted, fields: configFields });
    const validation = validateConfig(resolved.config, configFields);
    if (validation) {
      io.stderr.write(formatConfigError(validation));
      return 1;
    }
    config = resolved.config;
    defaulted = resolved.defaulted;
    selectedClients = config.clients === "both" ? ["claude", "codex"] : [config.clients];
    selectedDefinitions = selectedClients.flatMap((client) => generateNativeAgentDefinitions(config, client).map((definition) => ({ ...definition, client })));
  }
  const nativeFiles = operation === "uninstall"
    ? recordedPaths.filter((entry) => entry.startsWith(".claude/agents/") || entry.startsWith(".codex/agents/")).map((entry) => ({ path: entry, kind: "common", executable: false, client: entry.startsWith(".claude/") ? "claude" : "codex" }))
    : selectedDefinitions.map(({ relativePath, client }) => ({ path: relativePath, kind: "common", executable: false, client }));
  const activeCatalog = { ...catalog, files: [...catalog.files, ...nativeFiles] };
  const paths = [...new Set([...catalogPaths, ...nativeFiles.map((file) => file.path), ...recordedPaths])];
  const snapshot = readSnapshot(root, paths, allIgnoreLines(catalog.gitignore), [...new Set([...nativeFiles.map((file) => file.path), ...recordedPaths.filter(isNativeAgentPath)])]);

  if (operation === "uninstall") {
    const parsedConfig = parseConfig(snapshot.config);
    const configError = !parsedConfig.ok
      ? parsedConfig.error
      : validateConfig(parsedConfig.config, configFields);
    if (configError) {
      const reason = configError.code === "CONFIG_UNREADABLE"
        ? "JSON として読めません"
        : configError.messages.join("、");
      io.stderr.write(`${CONFIG_PATH} に問題がありますが、設定の値を使わずに取り除きを続けます。${reason}\n`);
    }
  }

  const packageRoot = io.packageRoot ?? path.resolve(".");
  const packageFiles = { ...readPackageFiles(packageRoot, catalog), ...Object.fromEntries(selectedDefinitions.map((definition) => [definition.relativePath, Buffer.from(definition.content)])) };
  const bootstrapVersion = readPackageVersion(packageRoot);
  const plan = makePlan({ operation, config, snapshot, catalog: activeCatalog, packageFiles, bootstrapVersion, force });
  if (plan.blocks.length) {
    io.stderr.write(formatAbort(plan.blocks, operation));
    return 1;
  }
  const names = { [CONFIG_PATH]: snapshot.config, [LEDGER_PATH]: snapshot.ledger, ".claude/settings.json": snapshot.settings, ".mcp.json": snapshot.mcpJson, ".gitignore": snapshot.gitignore, "CLAUDE.md": snapshot.claudeMd };
  const displayPlan = { ...plan, changes: plan.changes.map((c) => ({ ...c, existed: c.action === "write" && (names[c.path] != null || snapshot.files[c.path] != null) })) };
  const warnings = unknown;
  if (warnings.length) io.stderr.write(`警告: 設定に知らない項目があります。\n${warnings.map((k) => `  ${k}`).join("\n")}\n`);
  if (!plan.changes.length) {
    io.stdout.write(formatSuccess({ operation, plan: displayPlan, defaulted: defaulted ?? [], filled, config, agentsOverrideExists: snapshot.agentsOverrideExists }));
    return 0;
  }
  const result = applyPlan(root, plan);
  if (!result.ok) {
    io.stderr.write(formatApplyFailure(result, operation, configExists));
    return 1;
  }
  io.stdout.write(formatSuccess({ operation, plan: displayPlan, defaulted: defaulted ?? [], filled, config, unknown: [], agentsOverrideExists: snapshot.agentsOverrideExists }));
  return 0;
}
