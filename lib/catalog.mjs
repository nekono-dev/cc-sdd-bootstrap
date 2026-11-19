// 共有の定数（他の lib はここから import する）。
// このファイルはデータだけを持ち、他の lib を import しない。
// カタログ本体（写すファイル・フック・.gitignore の行・CLAUDE.md の文章）は後続のタスクで足す。

/** 配置先のディレクトリ */
export const DEPLOY_DIR = ".agent-hooks/cc-sdd-bootstrap";

/** 一式のフックの見分けの文字列 */
export const OWNED_MARKER = "/.agent-hooks/cc-sdd-bootstrap/";

/** 設定ファイルの名前 */
export const CONFIG_PATH = ".cc-sdd-bootstrap.json";

/** 配置の記録の道筋 */
export const LEDGER_PATH = ".agent-hooks/cc-sdd-bootstrap/installed.json";
