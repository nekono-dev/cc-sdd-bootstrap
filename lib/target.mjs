// 対象のリポジトリと同梱のファイルの読み取り、計画の適用（ファイルの入出力はここに集める）。
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CONFIG_PATH, LEDGER_PATH } from "./catalog.mjs";

/** Codex のフック設定とプロジェクト指示のリポジトリ相対パス */
const CODEX_HOOKS_PATH = ".codex/hooks.json";
const AGENTS_MD_PATH = "AGENTS.md";

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

/** 設定ファイルの状態を返す。シンボリックリンクは管理対象と同じ規則で拒む。 */
export function readConfigState(root) {
  assertNoSymlinkComponents(root, CONFIG_PATH);
  try {
    return { kind: fs.lstatSync(path.join(root, CONFIG_PATH)).isFile() ? "file" : "other" };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { kind: "missing" };
    throw error;
  }
}

/** 同梱 package.json の版を返す。 */
export function readPackageVersion(packageRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  return packageJson.version;
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

/** 道筋の既存要素を lstat で調べ、シンボリックリンクを拒む */
function assertNoSymlinkComponents(root, rel) {
  if (!isSafeRel(rel)) throw new Error(`道筋が不正です: ${rel}`);
  let current = path.resolve(root);
  const components = [current, ...rel.split(/[\\/]/).filter(Boolean)];
  for (let i = 0; i < components.length; i++) {
    if (i > 0) current = path.join(current, components[i]);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        const error = new Error(`シンボリックリンクを通る道筋は扱えません: ${rel}`);
        error.path = rel;
        throw error;
      }
    } catch (error) {
      if (error?.path === rel && error.message?.includes("シンボリックリンク")) throw error;
      if (error.code === "ENOENT" || error.code === "ENOTDIR") break;
      throw error;
    }
  }
}

/** `*` だけを含む 1 区間の書き方を正規表現にする */
function globToRegExp(seg) {
  const esc = seg.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${esc.join(".*")}$`);
}

/**
 * 条件に関わらず、すべての .gitignore の行を取り出す（打ち消しの行は除く）。
 * 取り除き後に未追跡として現れうる道筋を調べるために使う。
 * @param {import("./catalog.mjs").CatalogGitignoreLine[]} lines 入力データ
 * @returns {string[]} 除外の行の配列
 */
export function allIgnoreLines(lines) {
  return lines.map((l) => (typeof l === "string" ? l : l.line)).filter((l) => !l.startsWith("!"));
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
  const managedPaths = [...new Set([
    ...paths,
    CONFIG_PATH,
    LEDGER_PATH,
    ".claude/settings.json",
    CODEX_HOOKS_PATH,
    ".gitignore",
    "CLAUDE.md",
    AGENTS_MD_PATH,
  ])];
  for (const p of managedPaths) assertNoSymlinkComponents(root, p);
  /** @type {Record<string, Buffer | null>} */
  const files = {};
  /** @type {Record<string, boolean | null>} */
  const modes = {};
  for (const p of paths) {
    files[p] = readBuf(root, p);
    if (files[p] === null) {
      modes[p] = null;
    } else {
      const mode = fs.statSync(path.join(root, p)).mode;
      modes[p] = (mode & 0o111) !== 0;
    }
  }
  const present = new Set();
  for (const line of ignored) for (const p of expandIgnored(root, line)) present.add(p);
  return {
    config: readText(root, CONFIG_PATH),
    ledger: readText(root, LEDGER_PATH),
    settings: readText(root, ".claude/settings.json"),
    codexHooksJson: readText(root, CODEX_HOOKS_PATH),
    gitignore: readText(root, ".gitignore"),
    claudeMd: readText(root, "CLAUDE.md"),
    agentsMd: readText(root, AGENTS_MD_PATH),
    agentsOverrideExists: existsWithoutFollowingLinks(root, "AGENTS.override.md"),
    files,
    modes,
    ignoredPresent: [...present].sort(),
  };
}

/** 存在だけを確認する。lstat でシンボリックリンク自体を扱い、リンク先は読まない。 */
function existsWithoutFollowingLinks(root, rel) {
  try {
    fs.lstatSync(path.join(root, rel));
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
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
  assertNoSymlinkComponents(root, change.path);
  const target = path.join(root, change.path);
  if (change.action === "delete") {
    fs.rmSync(target, { force: true });
    return;
  }
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.cc-sdd-bootstrap.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
  let fd;
  let created = false;
  let createdIdentity;
  try {
    let mode = change.executable ? 0o755 : 0o644;
    try {
      // 既存のファイルの権限は保つ（executable のときは 0o755）
      if (!change.executable) mode = fs.statSync(target).mode & 0o777;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    fd = fs.openSync(tmp, "wx", mode);
    created = true;
    const stat = fs.fstatSync(fd);
    createdIdentity = { dev: stat.dev, ino: stat.ino };
    let offset = 0;
    while (offset < change.content.length) {
      offset += fs.writeSync(fd, change.content, offset, change.content.length - offset);
    }
    fs.fchmodSync(fd, mode);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
  } catch (e) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    if (created) {
      try {
        const stat = fs.lstatSync(tmp);
        if (stat.isFile() && stat.dev === createdIdentity.dev && stat.ino === createdIdentity.ino) fs.unlinkSync(tmp);
      } catch {}
    }
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
        failed: { change, message: e?.message?.includes("シンボリックリンク")
          ? e.message
          : `書き込みに失敗した（${change.path}）: ${e.message}` },
        pending: plan.changes.slice(i + 1),
        prunedDirs: [],
      };
    }
  }
  const prunedDirs = plan.pruneDirs.filter((d) => pruneIfEmpty(root, d));
  return { ok: true, done, pending: [], prunedDirs };
}
