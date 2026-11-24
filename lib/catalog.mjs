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

const kiroGateTable = [
  "| 依頼の種類 | 使うスキル |",
  "|---|---|",
  "| 新機能・新プロジェクトの相談、分割の検討 | `kiro-discovery` |",
  "| 次にやること・進み具合の確認 | `kiro-spec-status` |",
  "| 既存コードと要件の差の確認 | `kiro-validate-gap` |",
  "| 設計のレビュー | `kiro-validate-design` |",
  "| 実装後の最終確認 | `kiro-validate-impl` |",
  "| プロジェクトの方針の整備・更新 | `kiro-steering` |",
  "| 完了・成功と報告する前 | `kiro-verify-completion` |",
].join("\n");

/** @type {{ hooks: object[], gitignore: string[], agentSections: object[], generated: object[], files: {path:string}[] }} */
export const catalog = {
  hooks: [
    { tools: ["claude"], event: "SessionStart", script: "install-cc-sdd.mjs", args: ["session-start", "--tool", "claude"], timeout: 30 },
    { tools: ["codex"], event: "SessionStart", script: "install-cc-sdd.mjs", args: ["session-start", "--tool", "codex"], timeout: 30 },
    { tools: ["claude"], event: "UserPromptSubmit", script: "install-cc-sdd.mjs", args: ["user-prompt-submit", "--tool", "claude"], timeout: 600 },
    { tools: ["codex"], event: "UserPromptSubmit", script: "install-cc-sdd.mjs", args: ["user-prompt-submit", "--tool", "codex"], timeout: 600 },
    ...["claude", "codex"].flatMap((tool) => [
      { tools: [tool], event: "SessionStart", script: "kiro-gate.mjs", args: ["session-start", "--tool", tool], timeout: 10 },
      { tools: [tool], event: "UserPromptSubmit", script: "kiro-gate.mjs", args: ["user-prompt-submit", "--tool", tool], timeout: 10 },
      { tools: [tool], event: "PreToolUse", script: "kiro-gate.mjs", args: ["pre-tool-use", "--tool", tool], timeout: 10 },
      { tools: [tool], event: "PostToolUse", script: "kiro-gate.mjs", args: ["post-tool-use", "--tool", tool], timeout: 10 },
      { tools: [tool], event: "Stop", script: "kiro-gate.mjs", args: ["stop", "--tool", tool], timeout: 10 },
    ]),
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
    {
      id: "kiro-gate",
      claude: [kiroGateTable,
        "表に該当する依頼では `/kiro-*` で始まっていなくても、対応する手順書を読んで手順を最後まで実行してください。",
        "手順書は `.claude/skills/<スキル名>/SKILL.md` を直接読んでください。",
        "依頼の種類を判断できなければ、スキルを使うか利用者に尋ねてください。",
        "`/kiro-*` で始めた依頼では、フックが有効なら手順書を読むまで他の作業ツールが拒否されます。",
        "プロジェクト独自の決まりは `.kiro/steering/` から読んでください。",
      ].join("\n\n"),
      codex: [kiroGateTable,
        "表に該当する依頼では `/kiro-*` で始まっていなくても、対応する手順書を読んで手順を最後まで実行してください。",
        "手順書は `.agents/skills/<スキル名>/SKILL.md` を直接読んでください。",
        "依頼の種類を判断できなければ、スキルを使うか利用者に尋ねてください。",
        "`/kiro-*`（Codex は `$kiro-*`）で始めた依頼では、フックが有効なら手順書を読むまで他の作業ツールが拒否されます。",
        "フックの信頼が承認されていない環境でも、作業の前に対応する手順書を読んでください。",
        "プロジェクト独自の決まりは `.kiro/steering/` から読んでください。",
      ].join("\n\n"),
    },
  ],
  generated: [],
  files: [
    { path: `${DEPLOY_DIR}/install-cc-sdd.mjs` },
    { path: `${DEPLOY_DIR}/install-rules.mjs` },
    { path: `${DEPLOY_DIR}/config-schema.mjs` },
    { path: `${DEPLOY_DIR}/subagent-roles.mjs` },
    { path: `${DEPLOY_DIR}/kiro-gate.mjs` },
    { path: `${DEPLOY_DIR}/kiro-gate-rules.mjs` },
  ],
};
