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

test("区画の文章は導入・手順書・独自の決まりを案内する", () => {
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
  const installHooks = [
    { tools: ["claude"], event: "SessionStart", script: "install-cc-sdd.mjs", args: ["session-start", "--tool", "claude"], timeout: 30 },
    { tools: ["codex"], event: "SessionStart", script: "install-cc-sdd.mjs", args: ["session-start", "--tool", "codex"], timeout: 30 },
    { tools: ["claude"], event: "UserPromptSubmit", script: "install-cc-sdd.mjs", args: ["user-prompt-submit", "--tool", "claude"], timeout: 600 },
    { tools: ["codex"], event: "UserPromptSubmit", script: "install-cc-sdd.mjs", args: ["user-prompt-submit", "--tool", "codex"], timeout: 600 },
  ];
  assert.deepEqual(catalog.hooks.slice(0, installHooks.length), installHooks);
  const gateHooks = catalog.hooks.filter((hook) => hook.script === "kiro-gate.mjs");
  assert.deepEqual(gateHooks, ["claude", "codex"].flatMap((tool) => [
    { tools: [tool], event: "SessionStart", script: "kiro-gate.mjs", args: ["session-start", "--tool", tool], timeout: 10 },
    { tools: [tool], event: "UserPromptSubmit", script: "kiro-gate.mjs", args: ["user-prompt-submit", "--tool", tool], timeout: 10 },
    { tools: [tool], event: "PreToolUse", script: "kiro-gate.mjs", args: ["pre-tool-use", "--tool", tool], timeout: 10 },
    { tools: [tool], event: "PostToolUse", script: "kiro-gate.mjs", args: ["post-tool-use", "--tool", tool], timeout: 10 },
    { tools: [tool], event: "Stop", script: "kiro-gate.mjs", args: ["stop", "--tool", tool], timeout: 10 },
  ]));
  assert.ok(catalog.hooks.findIndex((hook) => hook.script === "kiro-gate.mjs" && hook.event === "UserPromptSubmit") >
    catalog.hooks.findIndex((hook) => hook.script === "install-cc-sdd.mjs" && hook.event === "UserPromptSubmit"));
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
  for (const file of [".claude/skills/kiro-x/SKILL.md", ".agents/skills/kiro-x/SKILL.md", ".kiro/settings/config.json", "CLAUDE.md", "AGENTS.md", ".cache/cc-sdd-install.failed"]) {
    assert.ok(catalog.gitignore.some((line) => excludedBy(line, file)), file);
  }
  for (const file of [".claude/skills/my-skill/SKILL.md", ".agents/skills/my-skill/SKILL.md", ".kiro/specs/x.md", ".kiro/steering/product.md", ".claude/settings.json", ".codex/hooks.json"]) {
    assert.ok(!catalog.gitignore.some((line) => excludedBy(line, file)), file);
  }
});

test("kiro-gate の案内は要件の対応表と両ツール向けの手順を示す", () => {
  const section = catalog.agentSections.find((item) => item.id === "kiro-gate");
  assert.ok(section);
  const table = [
    ["新機能・新プロジェクトの相談、分割の検討", "kiro-discovery"],
    ["次にやること・進み具合の確認", "kiro-spec-status"],
    ["既存コードと要件の差の確認", "kiro-validate-gap"],
    ["設計のレビュー", "kiro-validate-design"],
    ["実装後の最終確認", "kiro-validate-impl"],
    ["プロジェクトの方針の整備・更新", "kiro-steering"],
    ["完了・成功と報告する前", "kiro-verify-completion"],
  ];
  const markdownTable = [
    "| 依頼の種類 | 使うスキル |",
    "|---|---|",
    ...table.map(([kind, skill]) => `| ${kind} | \`${skill}\` |`),
  ].join("\n");
  for (const tool of ["claude", "codex"]) {
    assert.ok(section[tool].includes(markdownTable), `${tool}: 対応表が連続した Markdown 表であること`);
    for (const phrase of ["/kiro-*", "対応する手順書", "最後まで", "依頼の種類", "尋ねてください", "他の作業ツール", "フックが有効"]) {
      assert.ok(section[tool].includes(phrase), `${tool}: ${phrase}`);
    }
  }
  assert.equal(section.claude.includes("フックの信頼が承認されていない環境でも"), false);
  assert.equal(section.codex.includes("フックの信頼が承認されていない環境でも"), true);
  assert.ok(section.claude.includes(".claude/skills/<スキル名>/SKILL.md"));
  assert.ok(section.codex.includes(".agents/skills/<スキル名>/SKILL.md"));
  assert.match(section.codex, /信頼が承認されていない環境でも.*作業の前/s);
  assert.doesNotMatch(section.claude, /信頼が承認されていない環境でも/);
});

test("kiro-gate の配置物が package.json の配布範囲にも含まれる", () => {
  for (const name of ["kiro-gate.mjs", "kiro-gate-rules.mjs"]) {
    const file = `${DEPLOY_DIR}/${name}`;
    assert.ok(catalog.files.some((entry) => entry.path === file));
    assert.ok(pkg.files.includes(file));
  }
});

test("session-install の区画は両ツールの導入案内を持ち Codex だけに信頼の注意を含む", () => {
  const section = catalog.agentSections.find((item) => item.id === "session-install");
  assert.ok(section);
  for (const tool of ["claude", "codex"]) {
    const body = section[tool];
    for (const phrase of ["起動前", "最初の入力", "省", "kiro-", "未完了", "node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs", tool === "claude" ? ".claude/skills/<名前>/SKILL.md" : ".agents/skills/<名前>/SKILL.md", "手順書", "開発作業を進めない", ".kiro/steering/"]) {
      assert.ok(body.includes(phrase), `${tool}: ${phrase}`);
    }
  }
  assert.match(section.codex, /信頼/);
  assert.match(section.codex, /機械的/);
  assert.match(section.codex, /失敗・未完了/);
  assert.doesNotMatch(section.claude, /信頼|機械的/);
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

test("subagent-delegation のスクリプト・フック・生成物が登録され、配る範囲に含まれる", () => {
  for (const name of ["subagent-check.mjs", "delegate.mjs", "subagent-roles.mjs"]) {
    const file = `${DEPLOY_DIR}/${name}`;
    assert.ok(catalog.files.some((item) => item.path === file), file);
    assert.ok(pkg.files.includes(file), file);
  }
  const claude = catalog.hooks.find((hook) => hook.script === "subagent-check.mjs" && hook.tools.includes("claude"));
  assert.deepEqual(claude, { tools: ["claude"], event: "PreToolUse", matcher: "Agent", script: "subagent-check.mjs", args: ["pre-tool-use", "--tool", "claude"], timeout: 10 });
  const codex = catalog.hooks.find((hook) => hook.script === "subagent-check.mjs" && hook.tools.includes("codex"));
  assert.deepEqual(codex, { tools: ["codex"], event: "PreToolUse", script: "subagent-check.mjs", args: ["pre-tool-use", "--tool", "codex"], timeout: 10 });
  const generated = catalog.generated.find((item) => item.id === "subagent-definitions");
  assert.deepEqual(generated.owns, [".claude/agents/cc-sdd-*.md", ".codex/agents/cc_sdd_*.toml"]);
  const rendered = generated.render({});
  assert.equal(rendered.files.filter((file) => file.path.startsWith(".claude/agents/")).length, 12);
  assert.deepEqual(rendered.files.filter((file) => file.path.startsWith(".codex/agents/")).map((file) => file.path), [".codex/agents/cc_sdd_implement.toml"]);
});
