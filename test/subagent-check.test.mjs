import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hooksSrc = path.join(repo, ".agent-hooks/cc-sdd-bootstrap");

// 一時の根に、確認のスクリプトと役割の規則を写す
function fixture(t, config) {
  const root = mkdtempSync(path.join(os.tmpdir(), "subagent-check-test-"));
  const hooks = path.join(root, ".agent-hooks/cc-sdd-bootstrap");
  mkdirSync(hooks, { recursive: true });
  for (const f of ["subagent-check.mjs", "subagent-roles.mjs"]) copyFileSync(path.join(hooksSrc, f), path.join(hooks, f));
  if (config !== undefined) {
    writeFileSync(path.join(root, ".cc-sdd-bootstrap.json"), typeof config === "string" ? config : JSON.stringify(config));
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, entry: path.join(hooks, "subagent-check.mjs") };
}

function run(f, tool, input, raw) {
  return spawnSync(process.execPath, [f.entry, "pre-tool-use", "--tool", tool], {
    cwd: f.root, encoding: "utf8", input: raw ?? JSON.stringify(input),
  });
}

function claudeAgent(f, name, model, effort) {
  const file = path.join(f.root, ".claude/agents", `${name}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  const lines = ["---", `name: ${name}`, "description: 試験用"];
  if (model) lines.push(`model: "${model}"`);
  if (effort) lines.push(`effort: ${effort}`);
  writeFileSync(file, `${lines.join("\n")}\n---\n本文\n`);
}

function codexAgent(f, name, model, effort) {
  const file = path.join(f.root, ".codex/agents", `${name}.toml`);
  mkdirSync(path.dirname(file), { recursive: true });
  const lines = [`name = "${name}"`, 'description = "試験用"'];
  if (model) lines.push(`model = "${model}"`);
  if (effort) lines.push(`model_reasoning_effort = "${effort}"`);
  lines.push('developer_instructions = """', "本文", '"""');
  writeFileSync(file, `${lines.join("\n")}\n`);
}

function transcript(f, ...models) {
  const file = path.join(f.root, "transcript.jsonl");
  writeFileSync(file, "");
  addTurns(file, ...models);
  return file;
}
function addTurns(file, ...models) {
  for (const m of models) {
    appendFileSync(file, `${JSON.stringify({ type: "user", message: { role: "user", content: "やって" } })}\n`);
    appendFileSync(file, `${JSON.stringify({ type: "assistant", message: { role: "assistant", model: m, content: [] } })}\n`);
  }
}

const claudeInput = (f, tp, toolInput) => ({
  session_id: "s1", transcript_path: tp, tool_name: "Agent", tool_input: { prompt: "x", ...toolInput },
});
const codexInput = (model, toolInput, toolName = "spawn_agent") => ({
  session_id: "s1", model, tool_name: toolName, tool_input: { message: "x", ...toolInput },
});

const denied = (r) => {
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  return out.hookSpecificOutput.permissionDecisionReason;
};
const passed = (r) => {
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
};

test("Claude Code: Haiku の定義を Sonnet の指揮役が選ぶと通り、何も出さない", (t) => {
  const f = fixture(t);
  claudeAgent(f, "cc-sdd-implement-haiku", "haiku", "high");
  const tp = transcript(f, "claude-sonnet-5-5");
  passed(run(f, "claude", claudeInput(f, tp, { subagent_type: "cc-sdd-implement-haiku" })));
});

test("Claude Code: Sonnet の定義を Sonnet の指揮役が選ぶと同じ系統で拒否", (t) => {
  const f = fixture(t);
  claudeAgent(f, "cc-sdd-implement-sonnet", "sonnet", "medium");
  const tp = transcript(f, "claude-sonnet-5-5");
  const reason = denied(run(f, "claude", claudeInput(f, tp, { subagent_type: "cc-sdd-implement-sonnet" })));
  assert.match(reason, /子の起動を拒否/);
});

test("Claude Code: 名前を付けない起動は拒否され、理由に --resolve-model が入る", (t) => {
  const f = fixture(t);
  const tp = transcript(f, "claude-sonnet-5-5");
  for (const toolInput of [{}, { subagent_type: "general-purpose" }]) {
    const reason = denied(run(f, "claude", claudeInput(f, tp, toolInput)));
    assert.match(reason, /--resolve-model/);
    assert.match(reason, /--from claude/);
  }
});

test("Claude Code: Haiku（high）の定義を model sonnet で上書きすると Sonnet の上限 medium で拒否", (t) => {
  const f = fixture(t, { subagents: { maxEffort: { default: "high", sonnet: "medium" } } });
  claudeAgent(f, "cc-sdd-implement-haiku", "haiku", "high");
  const tp = transcript(f, "claude-opus-4-5");
  const reason = denied(run(f, "claude", claudeInput(f, tp, { subagent_type: "cc-sdd-implement-haiku", model: "sonnet" })));
  assert.match(reason, /推論量/);
  assert.match(reason, /medium/);
  // 上書きしなければ Haiku の上限（high）で通る
  passed(run(f, "claude", claudeInput(f, tp, { subagent_type: "cc-sdd-implement-haiku" })));
});

test("Codex: 定義の推論量 low が入力の推論量 xhigh より優先される", (t) => {
  const f = fixture(t, { subagents: { maxEffort: { default: "high" } } });
  codexAgent(f, "cc_sdd_implement", "gpt-6.1-terra", "low");
  passed(run(f, "codex", codexInput("gpt-6.1-sol", { agent_type: "cc_sdd_implement", reasoning_effort: "xhigh" })));
  // 定義に推論量が無ければ入力の xhigh が上限 high を超えて拒否
  codexAgent(f, "cc_sdd_noeffort", "gpt-6.1-terra", undefined);
  const reason = denied(run(f, "codex", codexInput("gpt-6.1-sol", { agent_type: "cc_sdd_noeffort", reasoning_effort: "xhigh" })));
  assert.match(reason, /推論量/);
});

test("Codex: モデル無しの定義・agent_type 無しは未指定で拒否（codex を案内）", (t) => {
  const f = fixture(t);
  codexAgent(f, "cc_sdd_implement", undefined, undefined);
  const reason = denied(run(f, "codex", codexInput("gpt-6.1-sol", { agent_type: "cc_sdd_implement" })));
  assert.match(reason, /--from codex/);
  denied(run(f, "codex", codexInput("gpt-6.1-sol", {})));
});

test("Codex: tool_input.model で子を明示すると通り、ツール名は spawn_agent を含めば見る", (t) => {
  const f = fixture(t);
  passed(run(f, "codex", codexInput("gpt-6.1-sol", { model: "gpt-6.1-terra" }, "mcp__x__spawn_agent_v2")));
});

test("壊れた設定は、明示の起動でも拒否して直し方を示す", (t) => {
  for (const config of ["{ 壊れた", { subagents: { maxEffort: { default: "とても強い" } } }]) {
    const f = fixture(t, config);
    claudeAgent(f, "cc-sdd-implement-haiku", "haiku", "high");
    const tp = transcript(f, "claude-sonnet-5-5");
    const reason = denied(run(f, "claude", claudeInput(f, tp, { subagent_type: "cc-sdd-implement-haiku" })));
    assert.match(reason, /subagents の設定に問題/);
  }
});

test("設定ファイルが無い、または subagents が無ければ既定で判定する", (t) => {
  const f = fixture(t);
  claudeAgent(f, "cc-sdd-implement-haiku", "haiku", "high");
  const tp = transcript(f, "claude-sonnet-5-5");
  passed(run(f, "claude", claudeInput(f, tp, { subagent_type: "cc-sdd-implement-haiku" })));
  const g = fixture(t, { ccSdd: { lang: "ja" } });
  claudeAgent(g, "cc-sdd-implement-haiku", "haiku", "high");
  passed(run(g, "claude", claudeInput(g, transcript(g, "claude-sonnet-5-5"), { subagent_type: "cc-sdd-implement-haiku" })));
});

test("同じ子の起動でも、会話の記録の最後の応答のモデルが変わると判定が変わる", (t) => {
  const f = fixture(t);
  claudeAgent(f, "cc-sdd-implement-sonnet", "sonnet", "medium");
  const tp = transcript(f, "claude-sonnet-5-5");
  const input = claudeInput(f, tp, { subagent_type: "cc-sdd-implement-sonnet" });
  denied(run(f, "claude", input));
  addTurns(tp, "claude-opus-4-5");
  passed(run(f, "claude", input));
});

test("指揮役のモデルが読めなければ不明として、同じ系統の確認は通す", (t) => {
  const f = fixture(t);
  claudeAgent(f, "cc-sdd-implement-sonnet", "sonnet", "medium");
  passed(run(f, "claude", claudeInput(f, path.join(f.root, "無い.jsonl"), { subagent_type: "cc-sdd-implement-sonnet" })));
});

test("対象外のツール名では何も出さない", (t) => {
  const f = fixture(t);
  passed(run(f, "claude", { session_id: "s", tool_name: "Bash", tool_input: { command: "ls" } }));
  passed(run(f, "codex", { session_id: "s", model: "gpt-6.1-sol", tool_name: "shell", tool_input: {} }));
  // Claude Code では spawn_agent を含む名前は見ない
  passed(run(f, "claude", { session_id: "s", tool_name: "spawn_agent", tool_input: {} }));
});

test("壊れた入力の JSON は標準エラーに出して通す", (t) => {
  const f = fixture(t);
  const r = run(f, "claude", null, "{壊れた");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /subagent-check/);
});

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

test("設定ファイルがディレクトリで読めないときは、起動を拒否して設定の問題を示す", (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.root, ".cc-sdd-bootstrap.json"));
  claudeAgent(f, "cc-sdd-implement-haiku", "haiku", "high");
  const tp = transcript(f, "claude-sonnet-5-5");
  const reason = denied(run(f, "claude", claudeInput(f, tp, { subagent_type: "cc-sdd-implement-haiku" })));
  assert.match(reason, /subagents の設定に問題/);
  assert.match(reason, /\.cc-sdd-bootstrap\.json を読み取れません/);
});

test("設定ファイルの権限が無いときは、起動を拒否して設定の問題を示す", { skip: isRoot }, (t) => {
  const f = fixture(t, { subagents: {} });
  chmodSync(path.join(f.root, ".cc-sdd-bootstrap.json"), 0o000);
  claudeAgent(f, "cc-sdd-implement-haiku", "haiku", "high");
  const tp = transcript(f, "claude-sonnet-5-5");
  const reason = denied(run(f, "claude", claudeInput(f, tp, { subagent_type: "cc-sdd-implement-haiku" })));
  assert.match(reason, /\.cc-sdd-bootstrap\.json を読み取れません/);
});

test("会話の記録の権限が無いときは指揮役を不明として続け、格 4 の子は拒否する", { skip: isRoot }, (t) => {
  const f = fixture(t);
  const tp = transcript(f, "claude-sonnet-5-5");
  chmodSync(tp, 0o000);
  denied(run(f, "claude", claudeInput(f, tp, { model: "fable" })));
});

test("Codex の定義の引用符付きのキー model を読み取る", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, ".codex/agents/cc_sdd_quoted.toml");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '"name" = "cc_sdd_quoted"\n"model" = "gpt-6.1-terra"\n');
  passed(run(f, "codex", codexInput("gpt-6.1-sol", { agent_type: "cc_sdd_quoted" })));
});

test("Codex の定義の引用符付きのキー model_reasoning_effort を読み取る", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, ".codex/agents/cc_sdd_quoted.toml");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "model = \"gpt-6.1-terra\"\n'model_reasoning_effort' = \"xhigh\"\n");
  const reason = denied(run(f, "codex", codexInput("gpt-6.1-sol", { agent_type: "cc_sdd_quoted", reasoning_effort: "low" })));
  assert.match(reason, /推論量/);
});
