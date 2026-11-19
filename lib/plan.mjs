// 計画の計算（純粋。ファイルの入出力はしない）。
// 操作・対象の今の状態・カタログから、書く内容と中止の理由を計算する。
import { DEPLOY_DIR } from "./catalog.mjs";
import { parseLedger, decideModified } from "./ledger.mjs";

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
 * 計画を計算する。
 * @param {PlanInput} input
 * @returns {Plan}
 */
export function makePlan(input) {
  if (input.operation === "uninstall") {
    throw new Error("uninstall の計画は未実装です");
  }
  const files = planFiles(input);
  // ここに設定ファイル・記録・settings・.gitignore・CLAUDE.md の計算が続く
  return { changes: files.changes, blocks: files.blocks, notices: files.notices, pruneDirs: [] };
}
