// 導入・更新の変更案を入力だけから計算する。
import { posix } from "node:path";
import { parseConfigNew, validateConfigNew, fillDefaultsNew, serializeConfigNew } from "./config.mjs";
import { upsertBlock, removeBlock, GITIGNORE_MARKERS } from "./blocks.mjs";
import { mergeHooks, removeHooks } from "./hooks-merge.mjs";
import { CONFIG_PATH, CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH, DEPLOY_DIR, AGENT_DOCS, AGENT_SECTION_FILES, AGENT_SECTION_MARKERS, catalog as defaultCatalog } from "./catalog.mjs";

const CONFIG_FORMAT = 1;
const same = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : String(a) === String(b);

function allowed(path, catalog, operation) {
  if (path.includes("\\") || posix.normalize(path) !== path || path.startsWith("/")) return false;
  if (path === CONFIG_PATH || path === CLAUDE_SETTINGS_PATH || path === CODEX_HOOKS_PATH || path === ".gitignore") return true;
  if (operation === "uninstall" && (path === "CLAUDE.md" || path === "AGENTS.md")) return true;
  if (path.startsWith(`${DEPLOY_DIR}/`)) return true;
  return (catalog.generated ?? []).some((item) => (item.owns ?? []).some((pattern) => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
    return new RegExp(`^${escaped}$`).test(path);
  }));
}

function matchesOwnedPath(path, patterns) {
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
    return new RegExp(`^${escaped}$`).test(path);
  });
}

/** 変更先が計画で許された範囲にあるかを確認する。 */
export function assertAllowedPath(path, catalog = defaultCatalog, operation) {
  if (!allowed(path, catalog, operation)) throw new Error(`変更の道筋が許可範囲外です: ${path}`);
}

function record(changes, path, content, old) {
  if (old !== null && old !== undefined && same(old, content)) return;
  changes.push({ kind: "write", path, content, created: old === null || old === undefined });
}

function renderAgentSection(tool, sections) {
  const content = sections.map((section) => section[tool]).filter(Boolean).join("\n\n");
  return `${AGENT_SECTION_MARKERS.begin}\n\n${content}\n\n${AGENT_SECTION_MARKERS.end}\n`;
}

/** 導入・更新の変更案を作る。 */
export function computePlan({ operation, snapshot, catalog = defaultCatalog, fields = [] }) {
  if (operation !== "init" && operation !== "update" && operation !== "uninstall") throw new TypeError(`未対応の操作です: ${operation}`);
  const aborts = [];
  const changes = [];
  const notices = [];
  const removed = [];
  if (operation === "uninstall") {
    for (const [path, text] of [[CLAUDE_SETTINGS_PATH, snapshot.claudeSettings], [CODEX_HOOKS_PATH, snapshot.codexHooks]]) {
      const result = removeHooks({ file: path, text });
      if (result.code) aborts.push(result);
      else if (result.changed) {
        removed.push(path);
        if (result.text === null) changes.push({ kind: "delete", path });
        else record(changes, path, result.text, text);
      }
    }
    for (const tool of ["claude", "codex"]) {
      const path = AGENT_DOCS[tool];
      const text = snapshot.agentDocs?.[tool];
      if (text == null) continue;
      const result = removeBlock(text, AGENT_SECTION_MARKERS, path);
      if (result.code) aborts.push(result);
      else if (result !== text) {
        removed.push(path);
        changes.push({ kind: "write", path, content: result, created: false });
      }
    }
    if (aborts.length) return { ok: false, aborts };
    for (const change of changes) assertAllowedPath(change.path, catalog, operation);
    return { ok: true, changes, notices, removed };
  }
  let config;
  let configReady = false;
  if (operation === "init") {
    if (snapshot.config !== null) aborts.push({ code: "CONFIG_EXISTS" });
    else {
      const filled = fillDefaultsNew({ format: CONFIG_FORMAT }, fields);
      config = filled.config;
      configReady = true;
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
        configReady = true;
        if (filled.filled.length > 0) record(changes, CONFIG_PATH, serializeConfigNew(config), snapshot.config);
      }
    }
  }

  if (operation === "init" && config) {
    const existing = ["CLAUDE.md", "AGENTS.md"].filter((path) => snapshot.agentDocs?.[path === "CLAUDE.md" ? "claude" : "codex"] != null);
    if (existing.length) notices.push({ code: "EXISTING_AGENT_DOCS", files: existing });
  }

  if (configReady) {
    for (const generated of catalog.generated ?? []) {
      const rendered = generated.render(config);
      const returned = new Set();
      for (const file of rendered.files) {
        if (!matchesOwnedPath(file.path, generated.owns ?? [])) {
          throw new Error(`変更の道筋が許可範囲外です: ${file.path}`);
        }
        returned.add(file.path);
        record(changes, file.path, file.content, snapshot.generatedFiles?.[file.path]);
      }
      for (const path of Object.keys(snapshot.generatedFiles ?? {})) {
        if (matchesOwnedPath(path, generated.owns ?? []) && !returned.has(path)) changes.push({ kind: "delete", path });
      }
      if (rendered.notices?.length) notices.push({ code: "GENERATED_NOTICE", id: generated.id, messages: rendered.notices });
    }
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

  const sectionPaths = Object.values(AGENT_SECTION_FILES);
  const desiredPaths = new Set([...(catalog.files ?? []).map((file) => file.path), ...sectionPaths]);
  for (const path of Object.keys(snapshot.deployDirFiles ?? {})) {
    if (!desiredPaths.has(path)) changes.push({ kind: "delete", path });
  }
  for (const file of catalog.files ?? []) {
    if (snapshot.sourceFiles?.[file.path] !== undefined) {
      record(changes, file.path, snapshot.sourceFiles[file.path], snapshot.deployDirFiles?.[file.path]);
    }
  }
  for (const tool of ["claude", "codex"]) {
    const path = AGENT_SECTION_FILES[tool];
    record(changes, path, renderAgentSection(tool, catalog.agentSections ?? []), snapshot.deployDirFiles?.[path]);
  }

  if (aborts.length) return { ok: false, aborts };
  for (const change of changes) {
    assertAllowedPath(change.path, catalog);
  }
  return { ok: true, changes, notices, removed };
}
