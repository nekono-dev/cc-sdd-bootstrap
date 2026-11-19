// 共有の定数（他の lib はここから import する）。
// このファイルはデータだけを持ち、他の lib を import しない。
// 後半はカタログ本体（写すファイル・フック・.gitignore の行・CLAUDE.md の文章）。下流の spec が項目を足す。

/** 配置先のディレクトリ */
export const DEPLOY_DIR = ".agent-hooks/cc-sdd-bootstrap";

/** 一式のフックの見分けの文字列 */
export const OWNED_MARKER = "/.agent-hooks/cc-sdd-bootstrap/";

/** 設定ファイルの名前 */
export const CONFIG_PATH = ".cc-sdd-bootstrap.json";

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
 * 配置するものの一覧。
 * @typedef {object} Catalog
 * @property {CatalogFile[]} files
 * @property {CatalogHook[]} hooks
 * @property {string[]} gitignore
 * @property {CatalogSection[]} claudeSections
 */

/** @type {Catalog} */
export const catalog = {
  files: [
    { path: `${DEPLOY_DIR}/install-cc-sdd.sh`, kind: "common", executable: true },
    { path: `${DEPLOY_DIR}/install-gate.mjs`, kind: "common", executable: false },
  ],
  hooks: [
    {
      event: "SessionStart",
      command: `"$CLAUDE_PROJECT_DIR${OWNED_MARKER}install-cc-sdd.sh" --claude`,
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
    ".kiro/settings/",
    "/.cache/cc-sdd-install.failed",
  ],
  claudeSections: [
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
