// .claude/settings.json のフックの登録の統合（純粋。ファイルは読み書きしない）
import { isDeepStrictEqual } from "node:util";
import { OWNED_MARKER } from "./catalog.mjs";

/** @typedef {import("./catalog.mjs").CatalogHook} CatalogHook */
/** @typedef {{ code: "SETTINGS_UNREADABLE", detail: string }} SettingsError */

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** 一式が登録したフック（command に目印を含む）か */
const isOwnedHandler = (h) =>
  isPlainObject(h) && typeof h.command === "string" && h.command.includes(OWNED_MARKER);

/** @returns {SettingsError} */
const unreadable = (detail) => ({ code: "SETTINGS_UNREADABLE", detail });

/**
 * 鍵と値の組から新しいオブジェクトを作る。
 * `__proto__` などの鍵も通常の鍵として持たせる（代入ではなく fromEntries を使う）。
 */
const build = (entries) => Object.fromEntries(entries);

/**
 * 一式のフックを取り除き、カタログのフックを各イベントの配列の最後に足す。
 * @param {{ text: string | null, hooks: CatalogHook[] }} input
 * @returns {{ text: string | null, changed: boolean } | SettingsError}
 */
export function mergeHooks({ text, hooks }) {
  let root;
  if (text === null) {
    root = {};
  } else {
    try {
      root = JSON.parse(text);
    } catch (e) {
      return unreadable(`JSON として読めません（${e.message}）`);
    }
    if (!isPlainObject(root)) {
      return unreadable("最上位が JSON のオブジェクトではありません");
    }
  }

  // 1. hooks の形を検査しながら、一式のものを取り除く
  /** @type {Array<[string, any]>} */
  let events = [];
  const hasHooksKey = Object.hasOwn(root, "hooks");
  let hooksRemoved = false;
  if (hasHooksKey) {
    if (!isPlainObject(root.hooks)) {
      return unreadable("`hooks` がオブジェクトではありません");
    }
    for (const [event, groups] of Object.entries(root.hooks)) {
      if (!Array.isArray(groups)) {
        return unreadable(`\`hooks.${event}\` が配列ではありません`);
      }
      let eventRemoved = false;
      const kept = [];
      for (const [i, group] of groups.entries()) {
        if (!isPlainObject(group)) {
          return unreadable(`\`hooks.${event}[${i}]\` がオブジェクトではありません`);
        }
        if (!Array.isArray(group.hooks)) {
          return unreadable(`\`hooks.${event}[${i}].hooks\` が配列ではありません`);
        }
        const handlers = group.hooks.filter((h) => !isOwnedHandler(h));
        if (handlers.length === group.hooks.length) {
          kept.push(group);
        } else if (handlers.length > 0) {
          kept.push(build(Object.entries(group).map(([k, v]) => [k, k === "hooks" ? handlers : v])));
          eventRemoved = true;
        } else {
          eventRemoved = true; // 取り除いて空になった組は捨てる
        }
      }
      if (eventRemoved) hooksRemoved = true;
      if (kept.length === 0 && eventRemoved) continue; // 取り除いて空になったイベントは捨てる
      events.push([event, kept]);
    }
  }

  // 2. カタログの各項目を 1 組ずつ、イベントの配列の最後に足す
  for (const h of hooks) {
    const handler = { type: "command", command: h.command };
    if (h.timeout !== undefined) handler.timeout = h.timeout;
    const group = {};
    if (h.matcher !== undefined) group.matcher = h.matcher;
    group.hooks = [handler];
    const found = events.find(([e]) => e === h.event);
    if (found) found[1].push(group);
    else events.push([h.event, [group]]);
  }

  // 3. 他の鍵と順番を保って組み立て直す
  const entries = [];
  for (const [k, v] of Object.entries(root)) {
    if (k !== "hooks") entries.push([k, v]);
    else if (events.length > 0 || (!hooksRemoved && hasHooksKey)) entries.push([k, build(events)]);
  }
  if (!hasHooksKey && events.length > 0) entries.push(["hooks", build(events)]);
  const result = build(entries);

  // 4. 元と同じなら書かない（6.4）
  if (isDeepStrictEqual(result, root)) {
    return { text, changed: false };
  }
  if (Object.keys(result).length === 0) {
    return { text: null, changed: true };
  }
  return { text: JSON.stringify(result, null, 2) + "\n", changed: true };
}
