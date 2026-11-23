import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { catalog, DEPLOY_DIR, CONFIG_PATH, CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH, AGENT_SECTION_FILES, AGENT_DOCS } from "../lib/catalog.mjs";
import pkg from "../package.json" with { type: "json" };

function excludedBy(line, file) {
  const source = line.replace(/^\//, "").replace(/\/$/, "").split("*")
    .map((part) => part.split(".").join("\\."))
    .join("[^/]*");
  return new RegExp("^" + source + "(?:/.*)?$").test(file);
}

test("カタログの配置ファイルが存在し、配布範囲に含まれる", () => {
  for (const file of catalog.files) {
    assert.ok(file.path.startsWith(`${DEPLOY_DIR}/`));
    assert.ok(fs.existsSync(path.resolve(file.path)), file.path);
    assert.ok(pkg.files.includes(file.path), file.path);
  }
  assert.equal(catalog.files.some((file) => file.path.includes("/skills/")), false);
});

test("カタログには記録や旧形式のファイル指定がない", () => {
  for (const file of catalog.files) assert.deepEqual(Object.keys(file), ["path"]);
});

test("フック・除外設定・区画は両方の運用文書に必要な内容を持つ", () => {
  assert.ok(catalog.hooks.length);
  assert.ok(catalog.gitignore.includes("/CLAUDE.md"));
  assert.ok(catalog.gitignore.includes("/AGENTS.md"));
  for (const tool of ["claude", "codex"]) {
    const section = catalog.agentSections.map((item) => item[tool]).join("\n");
    assert.match(section, /\.kiro\/steering/);
    assert.match(section, /git で確認/);
    assert.ok(AGENT_SECTION_FILES[tool].startsWith(`${DEPLOY_DIR}/`));
  }
  assert.deepEqual([CONFIG_PATH, CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH].length, 3);
});

test("配置ファイルの道筋は配置先の通常ファイルで、上位移動を含まない", () => {
  for (const file of catalog.files) {
    assert.ok(file.path.startsWith(DEPLOY_DIR + "/"), file.path);
    assert.ok(!file.path.split("/").includes(".."), file.path);
    assert.ok(fs.statSync(path.resolve(file.path)).isFile(), file.path);
  }
});

test("配置物は lib/ を読み込まない", () => {
  for (const file of catalog.files) {
    const source = fs.readFileSync(path.resolve(file.path), "utf8");
    assert.ok(!/(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["'][^"']*\blib\//.test(source), file.path);
  }
});

test("新しいフックと除外行が設計どおりで、共有物や設定を除外しない", () => {
  assert.deepEqual(catalog.hooks, [
    { tools: ["claude"], event: "SessionStart", script: "install-cc-sdd.mjs", args: ["session-start"], timeout: 600 },
    { tools: ["claude"], event: "UserPromptSubmit", script: "install-gate.mjs", args: ["user-prompt-submit"], timeout: 10 },
  ]);
  assert.deepEqual(catalog.gitignore, [
    ".claude/skills/kiro-*/", ".agents/skills/kiro-*/", ".kiro/settings/", "/CLAUDE.md", "/AGENTS.md", "/.cache/",
  ]);
  const protectedPaths = [
    CONFIG_PATH, ...catalog.files.map((file) => file.path), CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH,
    ".kiro/specs/installer-core/requirements.md", ".kiro/steering/product.md",
  ];
  for (const line of catalog.gitignore) {
    for (const file of protectedPaths) {
      assert.ok(!excludedBy(line, file), line + " -> " + file);
    }
  }
});

test("運用区画に標準文書の見出しを複製せず、道筋と目印がそろう", () => {
  assert.deepEqual(AGENT_DOCS, { claude: "CLAUDE.md", codex: "AGENTS.md" });
  assert.equal(AGENT_SECTION_FILES.claude, DEPLOY_DIR + "/agent-section-claude.md");
  assert.equal(AGENT_SECTION_FILES.codex, DEPLOY_DIR + "/agent-section-codex.md");
  assert.ok(catalog.agentSections.length > 0);
  for (const item of catalog.agentSections) {
    for (const body of [item.claude, item.codex]) {
      assert.ok(body.includes(".kiro/steering/"));
      assert.ok(!body.includes("# Agentic SDLC and Spec-Driven Development"));
      assert.ok(!body.includes("## cc-sdd の標準の決まり"));
    }
  }
});
