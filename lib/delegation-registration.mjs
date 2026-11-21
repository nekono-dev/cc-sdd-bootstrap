// 管理対象の Claude Code 向け Codex MCP 登録を変更計画に変換する。
import { sha256 } from "./ledger.mjs";

export const CODEX_MCP_REGISTRATION_NAME = "cc-sdd-codex";
const REGISTRATION_PATH = ".mcp.json";
const ENTRY = {
  command: "sh",
  args: ["-c", 'repo_root="$(git rev-parse --show-toplevel)" && exec node "$repo_root/.agent-hooks/cc-sdd-bootstrap/codex-agent-mcp.mjs"'],
};
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function entryHash(value) {
  return sha256(Buffer.from(JSON.stringify(canonical(value))));
}
function parseConfig(text) {
  if (text === null) return {};
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isObject(value) || (value.mcpServers !== undefined && !isObject(value.mcpServers))) return null;
  return value;
}
function changeFor(value, oldText) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (text === oldText) return null;
  return { action: "write", path: REGISTRATION_PATH, content: Buffer.from(text), executable: false };
}

/** 登録の所有記録と現在値を照合し、管理キーだけの変更を返す。 */
export function planCodexMcpRegistration({ enabled, currentText, ownedHash, ownedHashes }) {
  const notices = [];
  const config = parseConfig(currentText);
  if (config === null) {
    return { changes: [], blocks: [{ kind: "settings", path: REGISTRATION_PATH, detail: ".mcp.json は JSON オブジェクトとして読めません" }], notices, ownedHash: null };
  }
  const servers = config.mcpServers ?? {};
  const currentEntry = servers[CODEX_MCP_REGISTRATION_NAME];
  const currentHash = currentEntry === undefined ? null : entryHash(currentEntry);
  const allowed = Array.isArray(ownedHashes) ? ownedHashes : typeof ownedHash === "string" ? [ownedHash] : [];
  const isOwned = currentHash !== null && allowed.includes(currentHash);

  if (enabled) {
    const nextHash = entryHash(ENTRY);
    if (currentEntry !== undefined && currentHash === nextHash && isOwned) return { changes: [], blocks: [], notices, ownedHash: nextHash, ownedHashes: [nextHash] };
    if (currentEntry !== undefined && !isOwned) {
      return { changes: [], blocks: [{ kind: "settings", path: REGISTRATION_PATH, detail: `.mcp.json の mcpServers.${CODEX_MCP_REGISTRATION_NAME} は利用者が登録しているため上書きしません` }], notices, ownedHash: null };
    }
    const next = { ...config, mcpServers: { ...servers, [CODEX_MCP_REGISTRATION_NAME]: ENTRY } };
    return { changes: [changeFor(next, currentText)].filter(Boolean), blocks: [], notices, ownedHash: nextHash, ownedHashes: isOwned ? [...new Set([currentHash, nextHash])] : [nextHash] };
  }

  if (currentEntry === undefined) return { changes: [], blocks: [], notices, ownedHash: null, ownedHashes: [] };
  if (!isOwned) {
    if (ownedHash) notices.push(`.mcp.json の mcpServers.${CODEX_MCP_REGISTRATION_NAME} は書き換えられているため残した。`);
    return { changes: [], blocks: [], notices, ownedHash: null, ownedHashes: [] };
  }
  const nextServers = { ...servers };
  delete nextServers[CODEX_MCP_REGISTRATION_NAME];
  const next = { ...config };
  if (Object.keys(nextServers).length) next.mcpServers = nextServers;
  else delete next.mcpServers;
  return { changes: [changeFor(next, currentText)].filter(Boolean), blocks: [], notices, ownedHash: currentHash, ownedHashes: [currentHash] };
}
