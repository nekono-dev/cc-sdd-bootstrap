// 共有の定数（他の lib はここから import する）。
// このファイルはデータだけを持ち、他の lib を import しない。
// 後半はカタログ本体（写すファイル・フック・.gitignore の行・CLAUDE.md の文章）。下流の spec が項目を足す。

/** 配置先のディレクトリ */
export const DEPLOY_DIR = ".agent-hooks/cc-sdd-bootstrap";

/** 一式のフックの見分けの文字列 */
export const OWNED_MARKER = "/.agent-hooks/cc-sdd-bootstrap/";

/** 設定ファイルの名前 */
export const CONFIG_PATH = ".cc-sdd-bootstrap.json";

/** Claude Code のフック設定 */
export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";

/** Codex のフック設定 */
export const CODEX_HOOKS_PATH = ".codex/hooks.json";

/** 運用の区画を追記する文書 */
export const AGENT_DOCS = { claude: "CLAUDE.md", codex: "AGENTS.md" };

/** 配置する運用の区画の文章 */
export const AGENT_SECTION_FILES = {
  claude: `${DEPLOY_DIR}/agent-section-claude.md`,
  codex: `${DEPLOY_DIR}/agent-section-codex.md`,
};

/** 運用の区画を囲む目印 */
export const AGENT_SECTION_MARKERS = {
  begin: "<!-- cc-sdd-bootstrap:begin（この区画は cc-sdd の導入のたびに書き足される。編集しない） -->",
  end: "<!-- cc-sdd-bootstrap:end -->",
};

/** 配置の記録の道筋 */
export const LEDGER_PATH = ".agent-hooks/cc-sdd-bootstrap/installed.json";

/**
 * 写すファイル 1 件。
 * @typedef {object} CatalogFile
 * @property {string} path リポジトリの根からの道筋。DEPLOY_DIR の下に限る（`..` は含めない）
 * @property {"common" | "project"} kind common は版で置き換える、project は無いときだけ置く
 * @property {boolean} executable true なら写した後に 0o755 にする
 */

/**
 * .claude/settings.json に登録するフック 1 件。
 * @typedef {object} CatalogHook
 * @property {string} event "SessionStart" など
 * @property {string} [matcher]
 * @property {string} command 必ず一式の見分けの文字列（OWNED_MARKER）を含む
 * @property {number} [timeout] 秒
 */

/**
 * CLAUDE.md の管理区画に入れる文章 1 件。
 * @typedef {object} CatalogSection
 * @property {string} id 並びと重複の確認に使う
 * @property {string} body 管理区画に入れる文章（Markdown）
 */

/**
 * .gitignore の行 1 件。文字列は常に有効、`when` つきは設定の項目の値が一致するときだけ有効。
 * @typedef {string | { line: string, when: { path: string, equals: import("./config-schema.mjs").ConfigValue } }} CatalogGitignoreLine
 */

/**
 * 配置するものの一覧。
 * @typedef {object} Catalog
 * @property {CatalogFile[]} files
 * @property {CatalogHook[]} hooks
 * @property {CatalogGitignoreLine[]} gitignore
 * @property {CatalogSection[]} claudeSections
 */

/** @type {Catalog} */
export const catalog = {
  // 新しい項目は旧版の利用側を切り替えるタスクまで並べて持つ。
  agentHooks: [
    { tools: ["claude"], event: "SessionStart", script: "install-cc-sdd.mjs", args: ["session-start"], timeout: 600 },
    { tools: ["claude"], event: "UserPromptSubmit", script: "install-gate.mjs", args: ["user-prompt-submit"], timeout: 10 },
  ],
  agentGitignore: [
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
    { path: `${DEPLOY_DIR}/install-cc-sdd.mjs`, kind: "common", executable: false },
    { path: `${DEPLOY_DIR}/install-rules.mjs`, kind: "common", executable: false },
    { path: `${DEPLOY_DIR}/config-schema.mjs`, kind: "common", executable: false },
    { path: `${DEPLOY_DIR}/install-gate.mjs`, kind: "common", executable: false },
  ],
  hooks: [
    {
      event: "SessionStart",
      command: `node "$CLAUDE_PROJECT_DIR${OWNED_MARKER}install-cc-sdd.mjs" session-start`,
      timeout: 600,
    },
    {
      event: "UserPromptSubmit",
      command: `node "$CLAUDE_PROJECT_DIR${OWNED_MARKER}install-gate.mjs" user-prompt-submit`,
      timeout: 10,
    },
  ],
  gitignore: [
    ".claude/skills/kiro-*/",
    { line: ".kiro/settings/", when: { path: "ccSdd.keepTemplates", equals: false } },
    { line: ".kiro/settings/*", when: { path: "ccSdd.keepTemplates", equals: true } },
    { line: "!.kiro/settings/templates/", when: { path: "ccSdd.keepTemplates", equals: true } },
    "/.cache/",
  ],
  claudeSections: [
    {
      id: "cc-sdd-session-install",
      body: [
        "## cc-sdd の導入（セッション開始時）",
        "- `.claude/skills/kiro-*` と `.kiro/settings/` は、セッションの開始時に `.cc-sdd-bootstrap.json` の版・言語で導入され、揃っていれば入れ直しを省く。",
        "- 入れ直すときは `.claude/skills/kiro-*` を消してから導入するため、`kiro-` で始まる独自のスキルは置かない。",
        "- 導入が完了していない（失敗・中断）と次の入力は止まる。理由が示される。Claude の外で `node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs` を実行して再試行する。新しいセッションを開いても再試行される。",
        "- スキル一覧に載らないスキルは、対応する `.claude/skills/<名前>/SKILL.md` を Read して手順を最後まで実行する。`SKILL.md` が見つからないときは導入が完了していないと利用者に伝え、上の再試行を勧める。",
      ].join("\n"),
    },
    {
      id: "cc-sdd-guide",
      // 標準の決まりの中身は書かず、取り込みの行だけを置く
      body: [
        "## cc-sdd の標準の決まり",
        "次の取り込みは、cc-sdd が生成する標準の決まりの文書で、セッションの開始のたびに入れ直すためコミットしない。",
        "",
        "@.kiro/settings/cc-sdd-guide.md",
      ].join("\n"),
    },
  ],
};
