// 計画の計算（純粋。ファイルの入出力はしない）。
// 操作・対象の今の状態・カタログから、書く内容と中止の理由を計算する。
import { DEPLOY_DIR, CONFIG_PATH, LEDGER_PATH } from "./catalog.mjs";
import { parseLedger, decideModified, buildLedger, serializeLedger } from "./ledger.mjs";
import { serializeConfig } from "./config.mjs";
import { mergeHooks } from "./settings-hooks.mjs";
import { upsertBlock, CLAUDE_MD_MARKERS, GITIGNORE_MARKERS } from "./blocks.mjs";

/** .gitignore の管理区画の開始・終了の行 */
export const GITIGNORE_BEGIN_LINE = "# >>> cc-sdd-bootstrap（この区画は cc-sdd-bootstrap が管理する）";
export const GITIGNORE_END_LINE = "# <<< cc-sdd-bootstrap";
/** CLAUDE.md の管理区画の開始・終了の行 */
export const CLAUDE_MD_BEGIN_LINE =
  "<!-- cc-sdd-bootstrap:begin この区画は cc-sdd-bootstrap が管理する。手で書き換えると update で戻る -->";
export const CLAUDE_MD_END_LINE = "<!-- cc-sdd-bootstrap:end -->";

/**
 * @typedef {"init" | "update" | "uninstall"} Operation
 * @typedef {object} TargetSnapshot 対象の今の状態（無いファイルは null）
 * @property {string | null} config
 * @property {string | null} ledger
 * @property {string | null} settings
 * @property {string | null} gitignore
 * @property {string | null} claudeMd
 * @property {Record<string, Buffer | null>} files カタログと記録に載る道筋の今の内容
 * @property {string[]} ignoredPresent
 * @typedef {object} PlanInput
 * @property {Operation} operation
 * @property {object | null} config
 * @property {TargetSnapshot} snapshot
 * @property {import("./catalog.mjs").Catalog} catalog
 * @property {Record<string, Buffer>} packageFiles 同梱の配置物の内容
 * @property {string} bootstrapVersion
 * @property {boolean} force
 * @typedef {{ action: "write", path: string, content: Buffer, executable: boolean, note?: "restored" | "overwritten" }
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
  return path.startsWith(`${DEPLOY_DIR}/`);
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
    if (now.equals(incoming)) continue;
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
 * 書き換えない固有の部分は、前の記録の項目をそのまま引き継ぐ（記録に無ければ載せない）。
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
  const ledger = buildLedger(bootstrapVersion, placed);
  for (const [path, entry] of kept) {
    Object.defineProperty(ledger.files, path, { value: { ...entry }, writable: true, enumerable: true, configurable: true });
  }
  return ledger;
}

/**
 * 計画を計算する。
 * @param {PlanInput} input
 * @returns {Plan}
 */
export function makePlan(input) {
  if (input.operation === "uninstall") {
    throw new Error("uninstall の計画は未実装です");
  }
  const { snapshot, catalog, operation } = input;
  const files = planFiles(input);
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
  writeIfChanged(LEDGER_PATH, serializeLedger(buildNextLedger(input, files.changes)), snapshot.ledger);

  // 3. .claude/settings.json
  const settingsPath = ".claude/settings.json";
  const merged = mergeHooks({ text: snapshot.settings, hooks: catalog.hooks });
  if ("code" in merged) {
    blocks.push({ kind: "settings", path: settingsPath, detail: merged.detail });
  } else if (merged.changed) {
    if (merged.text === null) changes.push({ action: "delete", path: settingsPath });
    else writeIfChanged(settingsPath, merged.text, snapshot.settings);
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
    catalog.gitignore.join("\n"), ".gitignore");
  upsert("CLAUDE.md", snapshot.claudeMd, CLAUDE_MD_MARKERS, CLAUDE_MD_BEGIN_LINE, CLAUDE_MD_END_LINE,
    catalog.claudeSections.map((c) => c.body.replace(/\n+$/, "")).join("\n\n"), "CLAUDE.md");

  return { changes, blocks, notices, pruneDirs: [] };
}
