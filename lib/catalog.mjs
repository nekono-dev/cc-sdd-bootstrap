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
    { tools: ["claude"], event: "SessionStart", script: "install-cc-sdd.mjs", args: ["session-start", "--tool", "claude"], timeout: 30 },
    { tools: ["codex"], event: "SessionStart", script: "install-cc-sdd.mjs", args: ["session-start", "--tool", "codex"], timeout: 30 },
    { tools: ["claude"], event: "UserPromptSubmit", script: "install-cc-sdd.mjs", args: ["user-prompt-submit", "--tool", "claude"], timeout: 600 },
    { tools: ["codex"], event: "UserPromptSubmit", script: "install-cc-sdd.mjs", args: ["user-prompt-submit", "--tool", "codex"], timeout: 600 },
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
    {
      id: "session-install",
      claude: [
        "cc-sdd の導入は起動前（環境の準備スクリプト）か最初の入力時に行われ、必要なファイルが揃っていれば省かれます。`kiro-` で始まる独自のスキルを置かないでください。",
        "導入が未完了なら入力は止まります。再試行は通常の端末で `node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs` を実行してください。",
        "スキル一覧に載らないスキルは `.claude/skills/<名前>/SKILL.md` を直接読んで手順を最後まで実行してください。手順書が見つからなければ導入を確かめて再試行し、手順書が使えるまで開発作業を進めないでください。",
        "プロジェクト独自の決まりは `.kiro/steering/` から読んでください。",
      ].join("\n\n"),
      codex: [
        "cc-sdd の導入は起動前（環境の準備スクリプト）か最初の入力時に行われ、必要なファイルが揃っていれば省かれます。`kiro-` で始まる独自のスキルを置かないでください。",
        "導入が未完了なら入力は止まります。再試行は通常の端末で `node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs` を実行してください。",
        "スキル一覧に載らないスキルは `.agents/skills/<名前>/SKILL.md` を直接読んで手順を最後まで実行してください。手順書が見つからなければ導入を確かめて再試行し、手順書が使えるまで開発作業を進めないでください。",
        "プロジェクト独自の決まりは `.kiro/steering/` から読んでください。",
        "フックの信頼が承認されていないと、入力の停止は機械的には保証されません。その場合は作業の前に上の再試行コマンドで導入を実行・確認し、失敗・未完了なら作業を止めて利用者に復旧方法を伝えてください。",
      ].join("\n\n"),
    },
  ],
  generated: [],
  files: [
    { path: `${DEPLOY_DIR}/install-cc-sdd.mjs` },
    { path: `${DEPLOY_DIR}/install-rules.mjs` },
    { path: `${DEPLOY_DIR}/config-schema.mjs` },
  ],
};
