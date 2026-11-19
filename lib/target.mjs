// 対象のリポジトリと同梱のファイルの読み取り、計画の適用（ファイルの入出力はここに集める）。
import fs from "node:fs";
import path from "node:path";
import { CONFIG_PATH, LEDGER_PATH } from "./catalog.mjs";

/**
 * @typedef {import("./plan.mjs").Plan} Plan
 * @typedef {import("./plan.mjs").TargetSnapshot} TargetSnapshot
 * @typedef {import("./plan.mjs").FileChange} FileChange
 * @typedef {import("./catalog.mjs").Catalog} Catalog
 * @typedef {object} ApplyResult
 * @property {boolean} ok
 * @property {FileChange[]} done 書き終えた変更
 * @property {{ change: FileChange, message: string }} [failed] 失敗した変更と理由
 * @property {FileChange[]} pending 失敗のため行わなかった変更
 * @property {string[]} prunedDirs 取り除いた空のディレクトリ
 */

/** dir 直下に .git（ディレクトリまたはファイル）があるか */
export function isGitRoot(dir) {
  return fs.existsSync(path.join(dir, ".git"));
}

/** ファイルを文字列で読む。無ければ null */
function readText(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  }
}

/** ファイルを Buffer で読む。無ければ null */
function readBuf(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel));
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  }
}

/** `*` だけを含む 1 区間の書き方を正規表現にする */
function globToRegExp(seg) {
  const esc = seg.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${esc.join(".*")}$`);
}

/** .gitignore の 1 行が指す、実在する相対の道筋を返す */
function expandIgnored(root, line) {
  let p = line.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (p === "" || p.startsWith("#") || p.startsWith("!")) return [];
  if (p.split("/").includes("..") || p.includes("\\")) return [];
  const segs = p.split("/");
  const last = segs[segs.length - 1];
  if (!last.includes("*")) return fs.existsSync(path.join(root, p)) ? [p] : [];
  const parent = segs.slice(0, -1).join("/");
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, parent));
  } catch {
    return [];
  }
  const re = globToRegExp(last);
  return entries.filter((n) => re.test(n)).map((n) => (parent ? `${parent}/${n}` : n));
}

/**
 * 対象の今の状態を読む。
 * @param {string} root 対象の根
 * @param {string[]} paths 内容を読む道筋
 * @param {string[]} ignored .gitignore に入れる行（実在を調べる）
 * @returns {TargetSnapshot}
 */
export function readSnapshot(root, paths, ignored) {
  /** @type {Record<string, Buffer | null>} */
  const files = {};
  for (const p of paths) files[p] = readBuf(root, p);
  const present = new Set();
  for (const line of ignored) for (const p of expandIgnored(root, line)) present.add(p);
  return {
    config: readText(root, CONFIG_PATH),
    ledger: readText(root, LEDGER_PATH),
    settings: readText(root, ".claude/settings.json"),
    gitignore: readText(root, ".gitignore"),
    claudeMd: readText(root, "CLAUDE.md"),
    files,
    ignoredPresent: [...present].sort(),
  };
}

/**
 * 同梱の配置物を読む。
 * @param {string} packageRoot
 * @param {Catalog} catalog
 * @returns {Record<string, Buffer>}
 */
export function readPackageFiles(packageRoot, catalog) {
  /** @type {Record<string, Buffer>} */
  const out = {};
  for (const f of catalog.files) {
    const buf = readBuf(packageRoot, f.path);
    if (buf === null) throw new Error(`同梱のファイルが見つからない: ${f.path}`);
    out[f.path] = buf;
  }
  return out;
}

/** 相対の道筋として安全か（絶対・`..` を含むものは外） */
function isSafeRel(p) {
  if (typeof p !== "string" || p === "" || path.isAbsolute(p) || p.startsWith("/")) return false;
  return !p.split(/[\\/]/).includes("..");
}

/** 1 件の変更を行う。失敗したら例外 */
function applyChange(root, change) {
  if (!isSafeRel(change.path)) throw new Error(`道筋が不正（絶対パスまたは .. を含む）: ${change.path}`);
  const target = path.join(root, change.path);
  if (change.action === "delete") {
    fs.rmSync(target, { force: true });
    return;
  }
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.cc-sdd-bootstrap.tmp`);
  try {
    let mode = change.executable ? 0o755 : 0o644;
    try {
      // 既存のファイルの権限は保つ（executable のときは 0o755）
      if (!change.executable) mode = fs.statSync(target).mode & 0o777;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    fs.writeFileSync(tmp, change.content);
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** 空のディレクトリだけを消す。消したら true */
function pruneIfEmpty(root, rel) {
  if (!isSafeRel(rel)) return false;
  const dir = path.join(root, rel);
  try {
    if (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length > 0) return false;
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * 計画を適用する。1 つ失敗したらそこで止める。
 * @param {string} root
 * @param {Plan} plan
 * @returns {ApplyResult}
 */
export function applyPlan(root, plan) {
  /** @type {FileChange[]} */
  const done = [];
  for (let i = 0; i < plan.changes.length; i++) {
    const change = plan.changes[i];
    try {
      applyChange(root, change);
      done.push(change);
    } catch (e) {
      return {
        ok: false,
        done,
        failed: { change, message: `書き込みに失敗した（${change.path}）: ${e.message}` },
        pending: plan.changes.slice(i + 1),
        prunedDirs: [],
      };
    }
  }
  const prunedDirs = plan.pruneDirs.filter((d) => pruneIfEmpty(root, d));
  return { ok: true, done, pending: [], prunedDirs };
}
