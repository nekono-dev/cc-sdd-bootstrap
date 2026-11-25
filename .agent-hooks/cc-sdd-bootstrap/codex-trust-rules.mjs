// 純粋な部品: Codex のフックの承認の記録（キーとハッシュ）を求める。
// 入出力は行わず、lib/ も import しない（導入コマンドの側の定数とは試験で一致を確かめる）。
// 計算式の出典: poc/codex-hook-trust/run.mjs の trustEntries（openai/codex の hook_hash に対応）。
import { createHash } from "node:crypto";

/** 自分のフックの印（lib/catalog.mjs の OWNED_MARKER と同じ値。試験で一致を確かめる） */
export const OWNED_MARKER = "/.agent-hooks/cc-sdd-bootstrap/";

/** Codex のイベント名（hooks.json の書き方）から、承認の記録に使うイベント名への対応 */
// Map にするのは、通常のオブジェクトだと toString・constructor・__proto__ などの継承プロパティを拾うため
const EVENT_LABELS = new Map([
  ["SessionStart", "session_start"],
  ["UserPromptSubmit", "user_prompt_submit"],
  ["PreToolUse", "pre_tool_use"],
  ["PostToolUse", "post_tool_use"],
  ["Stop", "stop"],
]);

/** 自分のフックで扱ってよい項目。これ以外の項目を持つと、計算式が確かめられないので除く */
const SUPPORTED_KEYS = new Set(["type", "command", "timeout"]);

/** timeout を省いたときの既定値（秒） */
const DEFAULT_TIMEOUT = 600;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 入力の項目を、自分のキーだけで読む（継承プロパティを拾わない） */
const ownValue = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);

/** オブジェクトのキーを辞書順に並べ直す（入れ子も同様）。ハッシュの入力を毎回同じ形にするため */
const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
};

/** 識別情報を sha256 で要約し、"sha256:" に続けて返す */
function hashOf(identity) {
  return "sha256:" + createHash("sha256").update(JSON.stringify(sortKeys(identity))).digest("hex");
}

/**
 * hooks.json の文章から、自分のフック（コマンドに印を含む command フック）の承認の記録を求める。
 * キーは `<hooksJsonPath>:<イベント名の小文字スネーク>:<グループ番号>:<フック番号>`。
 * 番号は利用者のフックも数える（0 から始まる添字）。
 * 扱えない項目を持つ自分のフック・表にないイベントの自分のフックは、理由つきで skipped に載せて除く。
 * @returns {{ ok: true, entries: { key: string, hash: string }[], skipped: string[] } | { ok: false, reason: string }}
 */
export function computeTrustEntries(hooksJsonText, hooksJsonPath) {
  let doc;
  try {
    doc = JSON.parse(hooksJsonText);
  } catch (error) {
    return { ok: false, reason: `hooks.json を JSON として読めない: ${error.message}` };
  }
  if (!isObject(doc)) return { ok: false, reason: "hooks.json の最上位がオブジェクトではない" };

  const docHooks = ownValue(doc, "hooks");
  const hooks = docHooks === undefined ? {} : docHooks;
  if (!isObject(hooks)) return { ok: false, reason: "hooks.json の hooks がオブジェクトではない" };

  // 形の確認: イベントごとにグループの配列、グループごとにフックの配列がある
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) return { ok: false, reason: `イベント ${event} の値が配列ではない` };
    for (const group of groups) {
      if (!isObject(group)) return { ok: false, reason: `イベント ${event} のグループがオブジェクトではない` };
      if (!Array.isArray(ownValue(group, "hooks"))) return { ok: false, reason: `イベント ${event} のグループの hooks が配列ではない` };
      for (const handler of group.hooks) {
        if (!isObject(handler)) return { ok: false, reason: `イベント ${event} のフックがオブジェクトではない` };
      }
    }
  }

  const entries = [];
  const skipped = [];

  for (const [event, groups] of Object.entries(hooks)) {
    groups.forEach((group, groupIndex) => {
      group.hooks.forEach((handler, handlerIndex) => {
        // 対象は、コマンドに印を含む type: command のフックだけ（利用者のフックは番号を数えるだけ）
        const handlerType = ownValue(handler, "type");
        const command = ownValue(handler, "command");
        const isOwned = handlerType === "command" && typeof command === "string" && command.includes(OWNED_MARKER);
        if (!isOwned) return;

        const where = `イベント ${event} のグループ ${groupIndex}・フック ${handlerIndex}`;
        const label = EVENT_LABELS.get(event);
        if (label === undefined) {
          skipped.push(`${where}: Codex の承認の表にないイベントのため除く`);
          return;
        }

        const extraKeys = Object.keys(handler).filter((k) => !SUPPORTED_KEYS.has(k));
        if (extraKeys.length > 0) {
          skipped.push(`${where}: 扱えない項目（${extraKeys.join("、")}）を持つため除く`);
          return;
        }

        const rawTimeout = ownValue(handler, "timeout") === undefined ? DEFAULT_TIMEOUT : handler.timeout;
        if (!Number.isInteger(rawTimeout)) {
          skipped.push(`${where}: timeout が整数ではないため除く`);
          return;
        }
        const timeout = Math.max(1, rawTimeout);

        // 識別情報: matcher は指定があるときだけ含める。async は false に固定する
        const identity = { event_name: label, hooks: [{ type: "command", command, timeout, async: false }] };
        const matcher = ownValue(group, "matcher");
        if (matcher !== undefined && matcher !== null) identity.matcher = matcher;

        entries.push({ key: `${hooksJsonPath}:${label}:${groupIndex}:${handlerIndex}`, hash: hashOf(identity) });
      });
    });
  }

  return { ok: true, entries, skipped };
}
