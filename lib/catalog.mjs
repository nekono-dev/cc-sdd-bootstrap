// 共有の定数（他の lib はここから import する）。
// カタログと登録コマンドの定義を持ち、他の lib を import しない。
// 下流の spec が配置物・フック・除外行・指示文書の項目を足す。

/** 配置先のディレクトリ */
export const DEPLOY_DIR = ".agent-hooks/cc-sdd-bootstrap";

/** 一式のフックの見分けの文字列 */
export const OWNED_MARKER = "/.agent-hooks/cc-sdd-bootstrap/";

/** Codex の管理対象フックを識別するコマンド末尾のコメント */
export const CODEX_OWNED_MARKER = "# cc-sdd-bootstrap:managed";

/**
 * 作業ディレクトリから Git ルートを解決する POSIX シェル用のコマンドを作る。
 * @param {string} scriptName 配置先の直下に置くスクリプトのファイル名
 * @param {...string} args カタログに記述する操作名などの固定引数
 * @returns {string}
 */
export function codexHookCommand(scriptName, ...args) {
  if (!/^[a-z0-9-]+\.mjs$/.test(scriptName) || args.some((arg) => !/^[a-z0-9-]+$/.test(arg))) {
    throw new TypeError("Codex フックのスクリプト名または引数の形式が不正です。");
  }
  return [
    'repo_root="$(git rev-parse --show-toplevel)" && node',
    `"$repo_root${OWNED_MARKER}${scriptName}"`,
    ...args,
    CODEX_OWNED_MARKER,
  ].join(" ");
}

/** 設定ファイルの名前 */
export const CONFIG_PATH = ".cc-sdd-bootstrap.json";

/** 配置の記録の道筋 */
export const LEDGER_PATH = ".agent-hooks/cc-sdd-bootstrap/installed.json";

/** @typedef {"claude" | "codex"} CatalogClient */

/**
 * 写すファイル 1 件。
 * @typedef {object} CatalogFile
 * @property {string} path リポジトリの根からの道筋。DEPLOY_DIR の下に限る（`..` は含めない）
 * @property {"common" | "project"} kind common は版で置き換える、project は無いときだけ置く
 * @property {boolean} executable true なら写した後に 0o755 にする
 * @property {CatalogClient} [client] 省略時は両クライアントで共有する
 */

/**
 * クライアントの設定ファイルに登録するフック 1 件。
 * @typedef {object} CatalogHook
 * @property {string} event "SessionStart" など
 * @property {string} [matcher]
 * @property {string} command 必ず OWNED_MARKER を含む。Codex 用は CODEX_OWNED_MARKER で終わる
 * @property {number} [timeout] 秒
 */

/**
 * CLAUDE.md または AGENTS.md の管理区画に入れる文章 1 件。
 * @typedef {object} CatalogSection
 * @property {string} id 並びと重複の確認に使う
 * @property {string} body 管理区画に入れる文章（Markdown）
 */

/**
 * .gitignore の行 1 件。文字列は共有する。オブジェクトでは設定条件とクライアント条件を指定できる。
 * @typedef {string | { line: string, when?: { path: string, equals: import("./config-schema.mjs").ConfigValue }, client?: CatalogClient }} CatalogGitignoreLine
 */

/**
 * 配置するものの一覧。
 * @typedef {object} Catalog
 * @property {CatalogFile[]} files
 * @property {CatalogHook[]} hooks Claude Code 用
 * @property {CatalogHook[]} codexHooks Codex 用
 * @property {CatalogGitignoreLine[]} gitignore
 * @property {CatalogSection[]} claudeSections
 * @property {CatalogSection[]} agentsSections
 */

/** @type {Catalog} */
export const catalog = {
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
  codexHooks: [],
  gitignore: [
    { line: ".claude/skills/kiro-*/", client: "claude" },
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
  agentsSections: [],
};
