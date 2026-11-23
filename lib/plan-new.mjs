// 導入・更新の変更案を入力だけから計算する。
import { posix } from "node:path";
import { parseConfigNew, validateConfigNew, fillDefaultsNew, serializeConfigNew } from "./config.mjs";
import { upsertBlock, GITIGNORE_MARKERS } from "./blocks.mjs";
import { mergeHooks } from "./hooks-merge.mjs";
import { CONFIG_PATH, CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH, DEPLOY_DIR, catalog as defaultCatalog } from "./catalog.mjs";

const CONFIG_FORMAT = 1;
const same = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : String(a) === String(b);

function allowed(path, catalog) {
  if (path.includes("\\") || posix.normalize(path) !== path || path.startsWith("/")) return false;
  if (path === CONFIG_PATH || path === CLAUDE_SETTINGS_PATH || path === CODEX_HOOKS_PATH || path === ".gitignore") return true;
  if (path.startsWith(`${DEPLOY_DIR}/`)) return true;
  return (catalog.generated ?? []).some((item) => (item.owns ?? []).some((pattern) => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
    return new RegExp(`^${escaped}$`).test(path);
  }));
}

/** 変更先が計画で許された範囲にあるかを確認する。 */
export function assertAllowedPath(path, catalog = defaultCatalog) {
  if (!allowed(path, catalog)) throw new Error(`変更の道筋が許可範囲外です: ${path}`);
}

function record(changes, path, content, old) {
  if (old !== null && old !== undefined && same(old, content)) return;
  changes.push({ kind: "write", path, content, created: old === null || old === undefined });
}

/** 導入・更新の変更案を作る。 */
export function computePlan({ operation, snapshot, catalog = defaultCatalog, fields = [] }) {
  if (operation !== "init" && operation !== "update") throw new TypeError(`未対応の操作です: ${operation}`);
  const aborts = [];
  const changes = [];
  const notices = [];
  let config;
  if (operation === "init") {
    if (snapshot.config !== null) aborts.push({ code: "CONFIG_EXISTS" });
    else {
      const filled = fillDefaultsNew({ format: CONFIG_FORMAT }, fields);
      config = filled.config;
      record(changes, CONFIG_PATH, serializeConfigNew(config), null);
      notices.push({ code: "CONFIG_CREATED", defaults: filled.filled });
    }
  } else if (snapshot.config === null) aborts.push({ code: "CONFIG_MISSING" });
  else {
    const parsed = parseConfigNew(snapshot.config, CONFIG_PATH);
    if (!parsed.ok) aborts.push(parsed.error);
    else {
      config = parsed.config;
      const invalid = validateConfigNew(config, fields, CONFIG_PATH);
      if (invalid) aborts.push(invalid);
      else {
        const filled = fillDefaultsNew(config, fields);
        config = filled.config;
        if (filled.filled.length > 0) record(changes, CONFIG_PATH, serializeConfigNew(config), snapshot.config);
      }
    }
  }

  if (operation === "init" && config) {
    const existing = ["CLAUDE.md", "AGENTS.md"].filter((path) => snapshot.agentDocs?.[path === "CLAUDE.md" ? "claude" : "codex"] != null);
    if (existing.length) notices.push({ code: "EXISTING_AGENT_DOCS", files: existing });
  }
  notices.push({ code: "CODEX_TRUST" });

  const hooks = catalog.agentHooks ?? [];
  for (const [tool, path, text] of [["claude", CLAUDE_SETTINGS_PATH, snapshot.claudeSettings], ["codex", CODEX_HOOKS_PATH, snapshot.codexHooks]]) {
    const merged = mergeHooks({ file: path, text, tool, hooks });
    if (merged.code) aborts.push(merged);
    else if (merged.changed) record(changes, path, merged.text, text);
  }

  const block = upsertBlock({ text: snapshot.gitignore, markers: GITIGNORE_MARKERS, beginLine: GITIGNORE_MARKERS.begin, endLine: GITIGNORE_MARKERS.end, body: (catalog.agentGitignore ?? []).join("\n"), file: ".gitignore" });
  if (block.code) aborts.push(block);
  else record(changes, ".gitignore", block.text, snapshot.gitignore);

  if (aborts.length) return { ok: false, aborts };
  for (const change of changes) {
    assertAllowedPath(change.path, catalog);
  }
  return { ok: true, changes, notices, removed: [] };
}
