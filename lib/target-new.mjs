// 新しい計画が必要とする対象の状態だけを読み取る。
import fs from "node:fs";
import path from "node:path";
import { posix } from "node:path";
import {
  CONFIG_PATH, CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH, DEPLOY_DIR,
  AGENT_DOCS, catalog as defaultCatalog,
} from "./catalog.mjs";

const TEXT_PATHS = [CONFIG_PATH, CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH, ".gitignore", AGENT_DOCS.claude, AGENT_DOCS.codex];

/** 指定した根の直下に .git（ディレクトリまたはファイル）があるか。 */
export function isGitRoot(dir) {
  return fs.existsSync(path.join(dir, ".git"));
}

/** 相対の道筋が根の外へ出ず、途中にシンボリックリンクが無いか調べる。 */
export function checkPathSafety(root, relPath) {
  const at = String(relPath);
  if (typeof relPath !== "string" || relPath === "" || path.isAbsolute(relPath) || relPath.includes("\\") || relPath.split("/").includes("..") || posix.normalize(relPath) !== relPath) {
    return { ok: false, reason: "OUTSIDE", at };
  }
  const absoluteRoot = path.resolve(root);
  try {
    if (fs.lstatSync(absoluteRoot).isSymbolicLink()) return { ok: false, reason: "SYMLINK", at };
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
  const absolute = path.resolve(absoluteRoot, relPath);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) return { ok: false, reason: "OUTSIDE", at };
  let current = absoluteRoot;
  for (const part of relPath.split("/")) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return { ok: false, reason: "SYMLINK", at };
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") break;
      throw error;
    }
  }
  return { ok: true };
}

function readText(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), "utf8"); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
}

function readBuffer(root, rel) {
  try { return fs.readFileSync(path.join(root, rel)); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
}

// ディレクトリのシンボリックリンクはたどらず、その道筋自体を候補に含める。
function listFiles(root, relative) {
  const absolute = path.join(root, relative);
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return []; throw error; }
  if (stat.isSymbolicLink()) return [relative];
  if (stat.isFile()) return [relative];
  if (!stat.isDirectory()) return [];
  const found = [];
  for (const name of fs.readdirSync(absolute)) found.push(...listFiles(root, relative === "." ? name : `${relative}/${name}`));
  return found;
}

function patternMatches(file, pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
  return new RegExp(`^${escaped}$`).test(file);
}

function generatedCandidates(root, catalog) {
  const candidates = new Set();
  for (const generated of catalog.generated ?? []) {
    for (const pattern of generated.owns ?? []) {
      // owns はファイル名の一箇所にある * を使う型。
      const slash = pattern.lastIndexOf("/");
      const parent = slash < 0 ? "." : pattern.slice(0, slash);
      const base = slash < 0 ? pattern : pattern.slice(slash + 1);
      if (base.includes("/")) continue;
      const directory = parent === "." ? root : path.join(root, parent);
      let names;
      try { names = fs.readdirSync(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") continue; throw error; }
      for (const entry of names) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        const name = entry.name;
        const file = parent === "." ? name : `${parent}/${name}`;
        if (patternMatches(file, pattern)) candidates.add(file);
      }
    }
  }
  return [...candidates];
}

/**
 * 指定操作で必要な状態を読み取る。安全確認の失敗は読み取り前に返す。
 * @returns {import("./plan-new.mjs").TargetSnapshot | { ok: false, reason: "OUTSIDE" | "SYMLINK", at: string }}
 */
export function readSnapshot(root, packageRoot, catalog = defaultCatalog, operation = "init") {
  const uninstall = operation === "uninstall";
  if (uninstall) {
    const paths = [CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH, AGENT_DOCS.claude, AGENT_DOCS.codex];
    for (const rel of paths) { const safe = checkPathSafety(root, rel); if (!safe.ok) return safe; }
  } else {
    const parents = [DEPLOY_DIR, ...(catalog.generated ?? []).flatMap((generated) => (generated.owns ?? []).map((pattern) => {
      const slash = pattern.lastIndexOf("/"); return slash < 0 ? "." : pattern.slice(0, slash);
    }))];
    for (const rel of [...TEXT_PATHS, ...parents.filter((parent) => parent !== ".")]) {
      const safe = checkPathSafety(root, rel);
      if (!safe.ok) return safe;
    }
  }
  const deployFiles = uninstall ? [] : listFiles(root, DEPLOY_DIR);
  const generatedFiles = uninstall ? [] : generatedCandidates(root, catalog);
  const packagePaths = uninstall ? [] : (catalog.files ?? []).map((file) => file.path);
  const generatedParents = uninstall ? [] : (catalog.generated ?? []).flatMap((generated) => (generated.owns ?? []).map((pattern) => {
    const slash = pattern.lastIndexOf("/");
    return slash < 0 ? "." : pattern.slice(0, slash);
  }));
  const targetPaths = uninstall
    ? []
    : [...TEXT_PATHS, DEPLOY_DIR, ...deployFiles, ...generatedParents.filter((parent) => parent !== "."), ...generatedFiles];

  for (const rel of targetPaths) {
    const safe = checkPathSafety(root, rel);
    if (!safe.ok) return safe;
  }
  for (const rel of packagePaths) {
    const safe = checkPathSafety(packageRoot, rel);
    if (!safe.ok) return safe;
  }

  const agentDocs = { claude: readText(root, AGENT_DOCS.claude), codex: readText(root, AGENT_DOCS.codex) };
  const snapshot = {
    config: uninstall ? null : readText(root, CONFIG_PATH),
    claudeSettings: readText(root, CLAUDE_SETTINGS_PATH),
    codexHooks: readText(root, CODEX_HOOKS_PATH),
    gitignore: uninstall ? null : readText(root, ".gitignore"),
    agentDocs,
    deployDirFiles: {},
    generatedFiles: {},
    sourceFiles: {},
  };
  if (!uninstall) {
    for (const rel of deployFiles) {
      const content = readBuffer(root, rel);
      if (content !== null) snapshot.deployDirFiles[rel] = content;
    }
    for (const rel of generatedFiles) {
      const content = readBuffer(root, rel);
      if (content !== null) snapshot.generatedFiles[rel] = content;
    }
    for (const rel of packagePaths) {
      const content = readBuffer(packageRoot, rel);
      if (content === null) throw new Error(`同梱のファイルが見つかりません: ${rel}`);
      snapshot.sourceFiles[rel] = content;
    }
  }
  return snapshot;
}
