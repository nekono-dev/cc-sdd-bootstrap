// 設定の項目定義の公開。基本の項目（配置物の側。利用先でも単独で使えるように、他を読み込まない）に、
// 役割表の項目（subagents。lib/ だけが使う）をつないだ一覧を configFields として公開する。
import { configFields as baseFields } from "../.agent-hooks/cc-sdd-bootstrap/config-schema.mjs";
import { subagentsField } from "../.agent-hooks/cc-sdd-bootstrap/subagent-roles.mjs";

export { CONFIG_FORMAT, formatProblem } from "../.agent-hooks/cc-sdd-bootstrap/config-schema.mjs";

/**
 * 基本の項目と役割表の項目をつないだ一覧。
 * 役割表の項目は flag・question を持たない（lib は引数や質問の文に項目の定義を使わない）。
 * @type {import("../.agent-hooks/cc-sdd-bootstrap/config-schema.mjs").ConfigField[]}
 */
export const configFields = [...baseFields, subagentsField];
