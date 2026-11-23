// 共有の定数と配置する内容をまとめる。
export const DEPLOY_DIR = ".agent-hooks/cc-sdd-bootstrap";
export const OWNED_MARKER = "/.agent-hooks/cc-sdd-bootstrap/";
export const CONFIG_PATH = ".cc-sdd-bootstrap.json";
export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
export const CODEX_HOOKS_PATH = ".codex/hooks.json";
export const AGENT_DOCS = { claude: "CLAUDE.md", codex: "AGENTS.md" };
export const AGENT_SECTION_FILES = {
  claude: `${DEPLOY_DIR}/agent-section-claude.md`,
  codex: `${DEPLOY_DIR}/agent-section-codex.md`,
};
export const AGENT_SECTION_MARKERS = {
  begin: "<!-- cc-sdd-bootstrap:begin（この区画は cc-sdd の導入のたびに書き足される。編集しない） -->",
  end: "<!-- cc-sdd-bootstrap:end -->",
};

/** @type {{ hooks: object[], gitignore: string[], agentSections: object[], generated: object[], files: {path:string}[] }} */
export const catalog = {
  hooks: [
    { tools: ["claude"], event: "SessionStart", script: "install-cc-sdd.mjs", args: ["session-start"], timeout: 600 },
    { tools: ["claude"], event: "UserPromptSubmit", script: "install-gate.mjs", args: ["user-prompt-submit"], timeout: 10 },
  ],
  gitignore: [
    ".claude/skills/kiro-*/",
    ".agents/skills/kiro-*/",
    ".kiro/settings/",
    "/CLAUDE.md",
    "/AGENTS.md",
    "/.cache/",
  ],
  agentSections: [
    {
      id: "bootstrap-intro",
      claude: [
        "この区画は cc-sdd-bootstrap の導入のたびに書き足されるため、直接編集しないでください。",
        `共通の配置物（\`${DEPLOY_DIR}/\`）を直接編集しないでください。変更は導入コマンドの更新で反映し、差分は git で確認してください。`,
        "プロジェクト独自の決まりは、作業を始める前に `.kiro/steering/` の `product.md`・`tech.md`・`structure.md` と独自の文書を読んでください。",
      ].join("\n\n"),
      codex: [
        "この区画は cc-sdd-bootstrap の導入のたびに書き足されるため、直接編集しないでください。",
        `共通の配置物（\`${DEPLOY_DIR}/\`）を直接編集しないでください。変更は導入コマンドの更新で反映し、差分は git で確認してください。`,
        "プロジェクト独自の決まりは、作業を始める前に `.kiro/steering/` の `product.md`・`tech.md`・`structure.md` と独自の文書を読んでください。",
      ].join("\n\n"),
    },
  ],
  generated: [],
  files: [
    { path: `${DEPLOY_DIR}/install-cc-sdd.mjs` },
    { path: `${DEPLOY_DIR}/install-rules.mjs` },
    { path: `${DEPLOY_DIR}/config-schema.mjs` },
    { path: `${DEPLOY_DIR}/install-gate.mjs` },
  ],
};
