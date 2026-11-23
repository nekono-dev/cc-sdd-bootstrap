// 両ツールのフック設定を読み取り、統合・取り外しする
import { isDeepStrictEqual } from "node:util";
import { DEPLOY_DIR, OWNED_MARKER } from "./catalog.mjs";

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const objectFrom = (entries) => Object.fromEntries(entries);
const error = (file, detail) => ({ code: "HOOKS_UNREADABLE", file, detail });

/** ツールに合わせた配置先の呼び出し文字列を作る */
export function buildCommand(tool, hook) {
  const root = tool === "claude"
    ? `"$CLAUDE_PROJECT_DIR/${DEPLOY_DIR}/${hook.script}"`
    : `"$(git rev-parse --show-toplevel)/${DEPLOY_DIR}/${hook.script}"`;
  return `node ${root}${hook.args?.length ? ` ${hook.args.join(" ")}` : ""}`;
}

const isOwned = (handler) => isObject(handler) && typeof handler.command === "string" && handler.command.includes(OWNED_MARKER);

function readHooks(file, text) {
  let root;
  if (text === null) return { root: {}, events: [] };
  try {
    root = JSON.parse(text);
  } catch (e) {
    return { error: error(file, `JSON として読めません（${e.message}）`) };
  }
  if (!isObject(root)) return { error: error(file, "最上位が JSON のオブジェクトではありません") };
  const events = [];
  if (Object.hasOwn(root, "hooks")) {
    if (!isObject(root.hooks)) return { error: error(file, "`hooks` がオブジェクトではありません") };
    for (const [event, groups] of Object.entries(root.hooks)) {
      if (!Array.isArray(groups)) return { error: error(file, `\`hooks.${event}\` が配列ではありません`) };
      const kept = [];
      let removed = false;
      for (const [i, group] of groups.entries()) {
        if (!isObject(group)) return { error: error(file, `\`hooks.${event}[${i}]\` がオブジェクトではありません`) };
        if (!Array.isArray(group.hooks)) return { error: error(file, `\`hooks.${event}[${i}].hooks\` が配列ではありません`) };
        const handlers = group.hooks.filter((handler) => !isOwned(handler));
        if (handlers.length === group.hooks.length) kept.push(group);
        else {
          removed = true;
          if (handlers.length) kept.push(objectFrom(Object.entries(group).map(([key, value]) => [key, key === "hooks" ? handlers : value])));
        }
      }
      events.push([event, kept, removed]);
    }
  }
  return { root, events };
}

function filteredRoot(root, events, hadHooks, preserveEmptyHooks = false) {
  const retained = events.filter(([, groups, removed]) => groups.length > 0 || !removed);
  const output = [];
  for (const [key, value] of Object.entries(root)) {
    if (key !== "hooks") output.push([key, value]);
    else if (retained.length || (hadHooks && (events.length === 0 || preserveEmptyHooks))) output.push([key, objectFrom(retained.map(([event, groups]) => [event, groups]))]);
  }
  if (!Object.hasOwn(root, "hooks") && retained.length) output.push(["hooks", objectFrom(retained.map(([event, groups]) => [event, groups]))]);
  return objectFrom(output);
}

/** 一式のフックを取り除いてから対象ツールの登録を足す */
export function mergeHooks({ file, text, tool, hooks }) {
  const parsed = readHooks(file, text);
  if (parsed.error) return parsed.error;
  const hadHooks = Object.hasOwn(parsed.root, "hooks");
  const base = filteredRoot(parsed.root, parsed.events, hadHooks, true);
  const events = Object.entries(base.hooks ?? {}).map(([event, groups]) => [event, groups, false]);
  for (const hook of hooks.filter((candidate) => candidate.tools?.includes(tool))) {
    const handler = { type: "command", command: buildCommand(tool, hook) };
    if (hook.timeout !== undefined) handler.timeout = hook.timeout;
    const group = {};
    if (hook.matcher !== undefined) group.matcher = hook.matcher;
    group.hooks = [handler];
    const found = events.find(([event]) => event === hook.event);
    if (found) found[1].push(group);
    else events.push([hook.event, [group]]);
  }
  const entries = [];
  let inserted = false;
  for (const [key, value] of Object.entries(base)) {
    if (key === "hooks") {
      inserted = true;
      if (events.length) entries.push([key, objectFrom(events)]);
    } else entries.push([key, value]);
  }
  if (!inserted && events.length) entries.push(["hooks", objectFrom(events)]);
  const result = objectFrom(entries);
  if (text !== null && isDeepStrictEqual(result, parsed.root)) return { text, changed: false };
  return { text: `${JSON.stringify(result, null, 2)}\n`, changed: true };
}

/** 一式のコマンドだけを取り除く */
export function removeHooks({ file, text }) {
  const parsed = readHooks(file, text);
  if (parsed.error) return parsed.error;
  const result = filteredRoot(parsed.root, parsed.events, Object.hasOwn(parsed.root, "hooks"));
  if (isDeepStrictEqual(result, parsed.root)) return { text, changed: false };
  if (Object.keys(result).length === 0) return { text: null, changed: true };
  return { text: `${JSON.stringify(result, null, 2)}\n`, changed: true };
}
