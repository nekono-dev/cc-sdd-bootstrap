// 計画の計算（純粋。ファイルの入出力はしない）。
// 操作・対象の今の状態・カタログから、書く内容と中止の理由を計算する。
import { DEPLOY_DIR, CONFIG_PATH, LEDGER_PATH } from "./catalog.mjs";
import { parseLedger, decideModified, buildLedger, serializeLedger } from "./ledger.mjs";
import { serializeConfig } from "./config.mjs";
import { configFields, isClientSelection } from "./config-schema.mjs";
import { mergeHooks, hasOwnedHook } from "./settings-hooks.mjs";
import { upsertBlock, removeBlock, CLAUDE_MD_MARKERS, GITIGNORE_MARKERS } from "./blocks.mjs";

const NATIVE_AGENT_PATH = /^\.(?:claude\/agents\/cc-sdd-(?:design(?:-read-only)?|manufacture|review|research|debug)\.md|codex\/agents\/cc_sdd_(?:design(?:_read_only)?|manufacture|review|research|debug)\.toml)$/;

/** 固定のネイティブ定義名だけを管理対象として認める。 */
export function isNativeAgentPath(path) {
  return typeof path === "string" && NATIVE_AGENT_PATH.test(path);
}

function hasMarker(text, markers) {
  return typeof text === "string" && text.split(/\r?\n/).some((line) => line.startsWith(markers.begin) || line.startsWith(markers.end));
}

/** .gitignore の管理区画の開始・終了の行 */
export const GITIGNORE_BEGIN_LINE = "# >>> cc-sdd-bootstrap（この区画は cc-sdd-bootstrap が管理する）";
export const GITIGNORE_END_LINE = "# <<< cc-sdd-bootstrap";
/** CLAUDE.md の管理区画の開始・終了の行 */
export const CLAUDE_MD_BEGIN_LINE =
  "<!-- cc-sdd-bootstrap:begin この区画は cc-sdd-bootstrap が管理する。手で書き換えると update で戻る -->";
export const CLAUDE_MD_END_LINE = "<!-- cc-sdd-bootstrap:end -->";
/** AGENTS.md 用の目印 */
export const AGENTS_MD_MARKERS = { begin: "<!-- cc-sdd-bootstrap:begin", end: "<!-- cc-sdd-bootstrap:end" };
export const AGENTS_MD_BEGIN_LINE = CLAUDE_MD_BEGIN_LINE;
export const AGENTS_MD_END_LINE = CLAUDE_MD_END_LINE;

/**
 * @typedef {"init" | "update" | "uninstall"} Operation
 * @typedef {object} TargetSnapshot 対象の今の状態（無いファイルは null）
 * @property {string | null} config
 * @property {string | null} ledger
 * @property {string | null} settings
 * @property {string | null} codexHooksJson
 * @property {string | null} gitignore
 * @property {string | null} claudeMd
 * @property {string | null} agentsMd
 * @property {Record<string, Buffer | null>} files カタログと記録に載る道筋の今の内容
 * @property {Record<string, boolean | null>} [modes] 各道筋が実行権限を持つか（無いファイルは null）
 * @property {string[]} ignoredPresent
 * @typedef {object} PlanInput
 * @property {Operation} operation
 * @property {object | null} config
 * @property {TargetSnapshot} snapshot
 * @property {import("./catalog.mjs").Catalog} catalog
 * @property {Record<string, Buffer>} packageFiles 同梱の配置物の内容
 * @property {string} bootstrapVersion
 * @property {boolean} force
 * @typedef {{ action: "write", path: string, content: Buffer, executable: boolean, note?: "restored" | "overwritten" | "permission-restored" }
 *   | { action: "delete", path: string }} FileChange
 * @typedef {{ kind: "modified" | "markers" | "settings", path: string, detail: string }} PlanBlock
 * @typedef {{ changes: FileChange[], blocks: PlanBlock[], notices: string[], pruneDirs: string[] }} Plan
 */

/** 自分のキーとして持っているか */
const has = (obj, key) => Object.hasOwn(obj, key);

/** 管理区画（DEPLOY_DIR）の下の相対の道筋か（絶対・`..` を含むものは外） */
function isManagedPath(path) {
  if (path.startsWith("/") || path.includes("\\")) return false;
  const segs = path.split("/");
  if (segs.some((s) => s === ".." || s === "." || s === "")) return false;
  return path.startsWith(`${DEPLOY_DIR}/`) || isNativeAgentPath(path);
}

/**
 * ファイルの扱い（init・update 共通）。内容が今と同じものは changes に入れない。
 * @param {PlanInput} input
 * @returns {{ changes: FileChange[], blocks: PlanBlock[], notices: string[] }}
 */
function planFiles(input) {
  const { snapshot, catalog, packageFiles, force } = input;
  const ledger = parseLedger(snapshot.ledger);
  /** @type {FileChange[]} */
  const changes = [];
  /** @type {PlanBlock[]} */
  const blocks = [];
  /** @type {string[]} */
  const notices = [];
  const catalogPaths = new Set(catalog.files.map((f) => f.path));
  const current = (path) => (has(snapshot.files, path) ? snapshot.files[path] : null);

  for (const f of catalog.files) {
    const now = current(f.path);
    if (!has(packageFiles, f.path)) {
      throw new Error(`同梱の配置物に ${f.path} がありません`);
    }
    const incoming = packageFiles[f.path];
    const write = (note) => {
      changes.push({
        action: "write",
        path: f.path,
        content: incoming,
        executable: f.executable,
        ...(note ? { note } : {}),
      });
    };
    if (f.kind === "project") {
      if (now === null) write();
      continue;
    }
    if (now === null) {
      write(ledger && has(ledger.files, f.path) ? "restored" : undefined);
      continue;
    }
    if (now.equals(incoming)) {
      if (f.executable && snapshot.modes?.[f.path] === false) write("permission-restored");
      continue;
    }
    if (!decideModified({ ledger, path: f.path, current: now, incoming })) {
      write();
    } else if (force) {
      write("overwritten");
    } else {
      blocks.push({
        kind: "modified",
        path: f.path,
        detail: `${f.path} は配置したあとに書き換えられている（または記録に無い同名のファイルがある）。上書きするなら --force を付ける。`,
      });
    }
  }

  // カタログから外れた記録のファイル
  if (ledger) {
    const ignored = [];
    for (const path of Object.keys(ledger.files)) {
      if (catalogPaths.has(path)) continue;
      if (!isManagedPath(path)) {
        ignored.push(path);
        continue;
      }
      const now = current(path);
      if (now === null) continue;
      const modified = decideModified({ ledger, path, current: now, incoming: null });
      if (modified && ledger.files[path].kind === "project") {
        notices.push(`${path} は新しい版では不要だが、書き換えられているため残した。不要なら手で削除する。`);
        continue;
      }
      if (!modified || force) {
        changes.push({ action: "delete", path });
      } else {
        blocks.push({
          kind: "modified",
          path,
          detail: `${path} は新しい版では不要だが、配置したあとに書き換えられている。削除するなら --force を付ける。`,
        });
      }
    }
    if (ignored.length > 0) {
      notices.push(`配置の記録に管理区画（${DEPLOY_DIR}）の外の道筋が含まれていたため無視した: ${ignored.join(", ")}`);
    }
  }
  return { changes, blocks, notices };
}

/**
 * 適用後の配置の記録を作る。カタログの外のファイルは載せない。
 * 適用後に残る固有の部分は、前の記録の項目をそのまま引き継ぐ（記録に無ければ載せない）。
 * @param {PlanInput} input
 * @param {FileChange[]} fileChanges planFiles の変更
 * @returns {import("./ledger.mjs").Ledger}
 */
function buildNextLedger(input, fileChanges) {
  const { snapshot, catalog, packageFiles, bootstrapVersion } = input;
  const prev = parseLedger(snapshot.ledger);
  const written = new Set(fileChanges.filter((c) => c.action === "write").map((c) => c.path));
  const placed = [];
  const kept = [];
  for (const f of catalog.files) {
    const now = has(snapshot.files, f.path) ? snapshot.files[f.path] : null;
    const incoming = packageFiles[f.path];
    if (written.has(f.path) || (now !== null && now.equals(incoming) && f.kind === "common")) {
      placed.push({ path: f.path, kind: f.kind, content: incoming });
    } else if (prev && has(prev.files, f.path)) {
      kept.push([f.path, prev.files[f.path]]);
    } else if (f.kind === "project" && now !== null && now.equals(incoming)) {
      // 記録は無いが同じ内容: 一式が置いたものとして記録する
      placed.push({ path: f.path, kind: f.kind, content: incoming });
    }
  }
  const clients = input.config?.clients;
  const ledger = buildLedger(bootstrapVersion, placed, isClientSelection(clients) ? clients : undefined);
  for (const [path, entry] of kept) {
    Object.defineProperty(ledger.files, path, { value: { ...entry }, writable: true, enumerable: true, configurable: true });
  }
  return ledger;
}

/**
 * 取り除きの計画。一式が置いたものだけを戻す。cc-sdd の導入物と `.kiro/` の成果物には触れない。
 * @param {PlanInput} input
 * @returns {Plan}
 */
function planUninstall(input) {
  const { snapshot, catalog, packageFiles, force } = input;
  const ledger = parseLedger(snapshot.ledger);
  const priorClients = ledger?.clients ?? "claude";
  const codexWasInstalled = priorClients === "codex" || priorClients === "both";
  /** @type {FileChange[]} */
  const changes = [];
  /** @type {PlanBlock[]} */
  const blocks = [];
  /** @type {string[]} */
  const notices = [];
  const current = (path) => (has(snapshot.files, path) ? snapshot.files[path] : null);

  // 対象の道筋: カタログのファイルと、記録にあるファイル（記録だけのものは管理区画の下に限る）
  /** @type {Map<string, "common" | "project">} */
  const targets = new Map(catalog.files.map((f) => [f.path, f.kind]));
  const ignored = [];
  if (ledger) {
    for (const [path, entry] of Object.entries(ledger.files)) {
      if (targets.has(path)) continue;
      if (!isManagedPath(path)) {
        ignored.push(path);
        continue;
      }
      if (path === LEDGER_PATH) continue;
      targets.set(path, entry.kind);
    }
  }
  for (const [path, kind] of targets) {
    const now = current(path);
    if (now === null) continue;
    const incoming = has(packageFiles, path) && catalog.files.some((f) => f.path === path) ? packageFiles[path] : null;
    const modified = decideModified({ ledger, path, current: now, incoming });
    if (!modified) {
      changes.push({ action: "delete", path });
    } else if (kind === "project") {
      notices.push(`${path} は書き換えられているため残した。不要なら手で削除する。`);
    } else if (force) {
      changes.push({ action: "delete", path });
    } else {
      blocks.push({
        kind: "modified",
        path,
        detail: `${path} は配置したあとに書き換えられている。削除するなら --force を付ける。`,
      });
    }
  }
  if (ignored.length > 0) {
    notices.push(`配置の記録に管理区画（${DEPLOY_DIR}）の外の道筋が含まれていたため無視した: ${ignored.join(", ")}`);
  }

  // .claude/settings.json
  const settingsPath = ".claude/settings.json";
  const claudeRecorded = ledger?.clients === "claude" || ledger?.clients === "both";
  const claudeMarker = hasMarker(snapshot.claudeMd, CLAUDE_MD_MARKERS);
  const claudeHook = hasOwnedHook(snapshot.settings, "claude");
  const merged = claudeRecorded || claudeMarker || claudeHook || (snapshot.config == null && ledger == null)
    ? mergeHooks({ text: snapshot.settings, hooks: [] })
    : { changed: false, text: snapshot.settings };
  if ("code" in merged) {
    blocks.push({ kind: "settings", path: settingsPath, detail: merged.detail });
  } else if (merged.changed) {
    if (merged.text === null) changes.push({ action: "delete", path: settingsPath });
    else changes.push({ action: "write", path: settingsPath, content: Buffer.from(merged.text, "utf8"), executable: false });
  }

  // Codex の登録は、記録または予約コメントから管理対象と判定できる場合だけ取り除く。
  const codexHook = hasOwnedHook(snapshot.codexHooksJson, "codex");
  if (codexWasInstalled || codexHook) {
    const codexPath = ".codex/hooks.json";
    const codex = mergeHooks({ text: snapshot.codexHooksJson ?? null, hooks: [], ownership: "codex" });
    if ("code" in codex) blocks.push({ kind: "settings", path: codexPath, detail: codex.detail });
    else if (codex.changed) {
      if (codex.text === null) changes.push({ action: "delete", path: codexPath });
      else changes.push({ action: "write", path: codexPath, content: Buffer.from(codex.text, "utf8"), executable: false });
    }
  }

  // .gitignore と CLAUDE.md の管理区画（残りが空なら削除）
  const strip = (path, text, markers) => {
    if (text === null) return;
    const r = removeBlock({ text, markers, file: path });
    if ("code" in r) {
      blocks.push({ kind: "markers", path, detail: r.detail });
    } else if (r.removed) {
      if (r.text === "") changes.push({ action: "delete", path });
      else changes.push({ action: "write", path, content: Buffer.from(r.text, "utf8"), executable: false });
    }
  };
  strip(".gitignore", snapshot.gitignore, GITIGNORE_MARKERS);
  const claudePreviouslyManaged = ledger?.clients === "claude" || ledger?.clients === "both" || hasMarker(snapshot.claudeMd, CLAUDE_MD_MARKERS);
  if (claudePreviouslyManaged) strip("CLAUDE.md", snapshot.claudeMd, CLAUDE_MD_MARKERS);
  if (codexWasInstalled || (snapshot.agentsMd ?? "").includes("<!-- cc-sdd-bootstrap:begin") || (snapshot.agentsMd ?? "").includes("<!-- cc-sdd-bootstrap:end")) {
    strip("AGENTS.md", snapshot.agentsMd, AGENTS_MD_MARKERS);
  }

  // 記録は他の取り除きが終わるまで残し、設定ファイルを最後に削除する。
  if (snapshot.ledger !== null) changes.push({ action: "delete", path: LEDGER_PATH });
  if (snapshot.config !== null) changes.push({ action: "delete", path: CONFIG_PATH });


  if (snapshot.ignoredPresent.length > 0) {
    notices.push(
      `.gitignore の除外が外れたため、次の道筋が git の未追跡のファイルとして現れる。cc-sdd の導入物はライセンスが異なるのでコミットせず、不要なら削除する: ${snapshot.ignoredPresent.join(", ")}`,
    );
  }

  // .claude は init で .claude/settings.json を作るときに作られうる。中身が空のときだけ消える（他の物があれば残る）
  const pruneDirs = [DEPLOY_DIR, ".agent-hooks", ".claude"];
  if (codexWasInstalled || codexHook || hasMarker(snapshot.agentsMd, AGENTS_MD_MARKERS)) pruneDirs.push(".codex");
  return { changes, blocks, notices, pruneDirs };
}

/**
 * .gitignore の行を設定に合わせて絞り込む。条件つきの行は、設定の値が一致するときだけ残す。
 * @param {import("./catalog.mjs").CatalogGitignoreLine[]} lines 入力行
 * @param {object | null} config 設定オブジェクト
 * @returns {string[]} 残された行の文字列
 */
export function resolveGitignoreLines(lines, config) {
  if (!Array.isArray(lines)) return [];
  // 設定の道筋をたどる。値が無ければ設定の項目の既定値を使う
  const resolveValue = (path, config) => {
    let current = config;
    for (const key of path.split(".")) {
      if (current && typeof current === "object" && Object.hasOwn(current, key)) {
        current = current[key];
      } else {
        current = undefined;
        break;
      }
    }
    if (current !== undefined) return current;
    const field = configFields.find((f) => f.path === path);
    return field ? field.defaultValue : undefined;
  };
  return lines
    .filter((item) => {
      if (typeof item === "string") return true;
      if (!item.when) return true;
      const { path, equals } = item.when;
      return resolveValue(path, config) === equals;
    })
    .map((item) => (typeof item === "string" ? item : item.line));
}

/**
 * 計画を計算する。
 * @param {PlanInput} input
 * @returns {Plan}
 */
export function makePlan(input) {
  if (input.operation === "uninstall") return planUninstall(input);
  const { snapshot, operation } = input;
  const priorLedger = parseLedger(snapshot.ledger);
  const configured = input.config?.clients;
  const selected = configured === "codex" ? ["codex"] : configured === "both" ? ["claude", "codex"] : ["claude"];
  const catalog = {
    ...input.catalog,
    files: (input.catalog.files ?? []).filter((f) => !f.client || selected.includes(f.client)),
    hooks: selected.includes("claude") ? (input.catalog.hooks ?? []) : [],
    codexHooks: selected.includes("codex") ? (input.catalog.codexHooks ?? []) : [],
    gitignore: (input.catalog.gitignore ?? []).filter((f) => typeof f === "string" || !f.client || selected.includes(f.client)),
    claudeSections: selected.includes("claude") ? (input.catalog.claudeSections ?? []) : [],
    agentsSections: selected.includes("codex") ? (input.catalog.agentsSections ?? []) : [],
  };
  const codexWasInstalled = priorLedger?.clients === "codex" || priorLedger?.clients === "both";
  const codexHooksEnabled = selected.includes("codex") || codexWasInstalled || hasOwnedHook(snapshot.codexHooksJson, "codex");
  // Codex-selected CLI configs are normalized and explicit. Always maintain AGENTS.md
  // for those configs, even when the current instruction catalog has no sections.
  // Preserve the older low-level plan behavior when no config was supplied at all.
  const codexInstructionsEnabled = selected.includes("codex") && (input.config !== null && input.config !== undefined || (input.catalog.agentsSections?.length ?? 0) > 0 || snapshot.agentsMd !== null && snapshot.agentsMd !== undefined) || codexWasInstalled ||
    hasMarker(snapshot.agentsMd, AGENTS_MD_MARKERS);
  const claudePreviouslyManaged = priorLedger?.clients === "claude" || priorLedger?.clients === "both" || hasMarker(snapshot.claudeMd, CLAUDE_MD_MARKERS);
  const planningInput = { ...input, catalog };
  const files = planFiles(planningInput);
  const changes = [...files.changes];
  const blocks = [...files.blocks];
  const notices = [...files.notices];
  /** 内容が今と違うときだけ書く */
  const writeIfChanged = (path, text, now) => {
    if (text !== now) changes.push({ action: "write", path, content: Buffer.from(text, "utf8"), executable: false });
  };

  // 1. 設定ファイル
  if (input.config !== null) {
    writeIfChanged(CONFIG_PATH, serializeConfig(input.config), snapshot.config);
  }

  // 2. 配置の記録
  writeIfChanged(LEDGER_PATH, serializeLedger(buildNextLedger(planningInput, files.changes)), snapshot.ledger);

  // 3. .claude/settings.json
  const settingsPath = ".claude/settings.json";
  if (selected.includes("claude") || claudePreviouslyManaged || hasOwnedHook(snapshot.settings, "claude")) {
  const merged = mergeHooks({ text: snapshot.settings, hooks: selected.includes("claude") ? catalog.hooks : [], ownership: "claude" });
  if ("code" in merged) {
    blocks.push({ kind: "settings", path: settingsPath, detail: merged.detail });
  } else if (merged.changed) {
    if (merged.text === null) changes.push({ action: "delete", path: settingsPath });
    else writeIfChanged(settingsPath, merged.text, snapshot.settings);
  }
  }

  // Codex の登録は Claude と独立して統合する。
  if (codexHooksEnabled) {
    const path = ".codex/hooks.json";
    const merged = mergeHooks({ text: snapshot.codexHooksJson ?? null, hooks: catalog.codexHooks, ownership: "codex" });
    if ("code" in merged) blocks.push({ kind: "settings", path, detail: merged.detail });
    else if (merged.changed) {
      if (merged.text === null) changes.push({ action: "delete", path });
      else writeIfChanged(path, merged.text, snapshot.codexHooksJson ?? null);
    }
  }

  // 4・5. .gitignore と CLAUDE.md の管理区画
  const upsert = (path, text, markers, beginLine, endLine, body, label) => {
    const r = upsertBlock({ text, markers, beginLine, endLine, body, file: path });
    if ("code" in r) {
      blocks.push({ kind: "markers", path, detail: r.detail });
      return;
    }
    if (r.created && operation === "update") {
      notices.push(`${path} の管理区画（${label}）が無かったため作り直した。`);
    }
    writeIfChanged(path, r.text, text);
  };
  upsert(".gitignore", snapshot.gitignore, GITIGNORE_MARKERS, GITIGNORE_BEGIN_LINE, GITIGNORE_END_LINE,
    resolveGitignoreLines(catalog.gitignore, input.config).join("\n"), ".gitignore");
  const stripIfInactive = (path, text, markers) => {
    if (text === null) return;
    const r = removeBlock({ text, markers, file: path });
    if ("code" in r) blocks.push({ kind: "markers", path, detail: r.detail });
    else if (r.removed) {
      if (r.text === "") changes.push({ action: "delete", path });
      else writeIfChanged(path, r.text, text);
    }
  };
  if (selected.includes("claude")) upsert("CLAUDE.md", snapshot.claudeMd, CLAUDE_MD_MARKERS, CLAUDE_MD_BEGIN_LINE, CLAUDE_MD_END_LINE,
    catalog.claudeSections.map((c) => c.body.replace(/\n+$/, "")).join("\n\n"), "CLAUDE.md");
  else if (claudePreviouslyManaged) stripIfInactive("CLAUDE.md", snapshot.claudeMd, CLAUDE_MD_MARKERS);
  if (selected.includes("codex") && codexInstructionsEnabled) upsert("AGENTS.md", snapshot.agentsMd ?? null, AGENTS_MD_MARKERS, AGENTS_MD_BEGIN_LINE, AGENTS_MD_END_LINE,
    (catalog.agentsSections ?? []).map((c) => c.body.replace(/\n+$/, "")).join("\n\n"), "AGENTS.md");
  else if (codexInstructionsEnabled) stripIfInactive("AGENTS.md", snapshot.agentsMd ?? null, AGENTS_MD_MARKERS);

  return { changes, blocks, notices, pruneDirs: [] };
}
