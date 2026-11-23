import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectCommand, isExpandedInvocation, messageAdditionalContext, skillPath } from "./kiro-gate-rules.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function argumentsOf(argv) {
  const event = argv[0];
  const toolIndex = argv.indexOf("--tool");
  const tool = toolIndex >= 0 ? argv[toolIndex + 1] : null;
  if (!new Set(["session-start", "user-prompt-submit", "pre-tool-use", "post-tool-use", "stop"]).has(event)) {
    throw new Error("フックの種類を判定できません。");
  }
  if (tool !== "claude" && tool !== "codex") throw new Error("作業ツールを判定できません。");
  return { event, tool };
}

async function readInput() {
  let raw = "";
  for await (const part of process.stdin) raw += part;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    if (typeof value.session_id !== "string" || !value.session_id) throw new Error("session_id がありません。");
    return value;
  } catch (error) {
    if (error.message === "session_id がありません。") throw error;
    throw new Error("入力の JSON を読み取れません。");
  }
}

function stateFile(sessionId) {
  const key = createHash("sha256").update(`${root}\0${sessionId}`).digest("hex");
  return path.join(os.tmpdir(), "cc-sdd-bootstrap-kiro-gate", `${key}.json`);
}

async function loadState(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(value.listed) || !(value.turn === null || (value.turn && typeof value.turn === "object"))) {
      throw new Error("状態の形が正しくありません。");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { listed: [], turn: null };
    throw error;
  }
}

async function saveState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    throw new Error(`状態の保存に失敗しました: ${error.message}`);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function listedSkills(tool) {
  const directory = path.join(root, tool === "claude" ? ".claude/skills" : ".agents/skills");
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const names = [];
  for (const entry of entries) {
    if (entry.isDirectory() && /^kiro-.+/.test(entry.name)) {
      try {
        if ((await fs.stat(path.join(directory, entry.name, "SKILL.md"))).isFile()) names.push(entry.name);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return names.sort();
}

async function run() {
  const { event, tool } = argumentsOf(process.argv.slice(2));
  if (["pre-tool-use", "post-tool-use", "stop"].includes(event)) return;
  const input = await readInput();
  const file = stateFile(input.session_id);
  const state = await loadState(file);

  if (event === "session-start") {
    if (!(tool === "claude" && input.source === "compact")) {
      state.listed = await listedSkills(tool);
      await saveState(file, state);
    }
    return;
  }

  const command = typeof input.prompt === "string" ? detectCommand(input.prompt) : null;
  if (!command) {
    if (state.turn !== null) {
      state.turn = null;
      await saveState(file, state);
    }
    return;
  }
  const relative = skillPath(tool, command.skill);
  try {
    if (!(await fs.stat(path.join(root, relative))).isFile()) throw Object.assign(new Error(), { code: "ENOENT" });
  } catch (error) {
    if (error.code === "ENOENT") {
      if (state.turn !== null) { state.turn = null; await saveState(file, state); }
      return;
    }
    throw error;
  }

  const turn = { skill: command.skill, skillPath: relative,
    read: isExpandedInvocation(tool, command.sigil, command.skill, state.listed), stopBlocked: false };
  state.turn = turn;
  await saveState(file, state);
  if (!turn.read) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
      hookEventName: "UserPromptSubmit", additionalContext: messageAdditionalContext(turn),
    } })}\n`);
  }
}

run().catch((error) => {
  const detail = error.message || "詳細のないエラーです。";
  process.stderr.write(`kiro-gate: フックの処理に失敗しました。詳細: ${detail}\n`);
  process.exitCode = 0;
});
