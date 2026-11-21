import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHostEvent, routeHostEvent } from "../.agent-hooks/cc-sdd-bootstrap/subagent-model-policy-hook.mjs";

test("Claude の UserPromptSubmit を信頼済みターン開始へ正規化する", async () => {
  const event = normalizeHostEvent("claude", "UserPromptSubmit", { cwd: "/work", session_id: "s", prompt_id: "p", prompt: "/kiro-impl" });
  assert.equal(event.trusted, true);
  assert.equal(event.source, "host");
  assert.equal(event.sessionId, "s");
  assert.equal(event.promptId, "p");
  let called;
  await routeHostEvent({ client: "claude", eventName: "UserPromptSubmit", input: { cwd: "/work", session_id: "s", prompt_id: "p", prompt: "/kiro-impl", trusted: false }, context: { beginTurn: async value => (called = value, true) } });
  assert.equal(called.trusted, true);
  assert.equal(called.prompt, "/kiro-impl");
});

test("Codex は turn_id 欠落を拒否し、未知のイベントは処理しない", async () => {
  assert.equal(normalizeHostEvent("codex", "UserPromptSubmit", { cwd: "/work", session_id: "s" }), null);
  assert.equal(normalizeHostEvent("codex", "Unexpected", {}), null);
});

test("Claude SessionStart は実際の observe 契約にモデルと正規プロジェクトを渡す", async () => {
  let observed;
  const result = await routeHostEvent({ client: "claude", eventName: "SessionStart",
    input: { cwd: "/work", session_id: "s", model: "claude-sonnet-4-5" },
    context: {}, observationAdapter: { observe: async value => (observed = value, true) },
    observationContext: event => ({ project: event.cwd, sessionId: event.sessionId }) });
  assert.equal(result.action, "continue");
  assert.deepEqual(observed, { project: "/work", sessionId: "s", event: "SessionStart", model: "claude-sonnet-4-5" });
});

test("管理入口は一回限りの参照をフック内で消費し、表示用コマンドだけを返す", async () => {
  const { mkdir, mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createKiroDelegationContext } = await import("../.agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs");
  const base = await mkdtemp(join(tmpdir(), "cc-sdd-hook-test-"));
  try {
    const cwd = join(base, "project");
    const skillsRoot = join(cwd, ".claude/skills");
    const skill = "kiro-impl";
    const installed = join(skillsRoot, skill);
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "# Test\n");
    const context = createKiroDelegationContext({ runtimeRoot: join(base, "runtime"), writableRoots: [cwd], skillsRoot, client: "claude" });
    const input = { cwd, session_id: "s", prompt_id: "p" };
    const route = (eventName, details) => routeHostEvent({ client: "claude", eventName, input: { ...input, ...details }, context });
    await route("UserPromptSubmit", { prompt: "実装して" });
    const command = "node .agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs enter kiro-impl";
    const tool = { tool_name: "Bash", tool_use_id: "tool-one", tool_input: { command } };
    const first = await route("PreToolUse", tool);
    assert.equal(first.action, "rewrite");
    assert.match(first.updatedInput.command, / receipt [a-zA-Z0-9_-]+$/);
    assert.equal((await context.current({ cwd, sessionId: "s" })).active, true);
    assert.equal((await route("PreToolUse", tool)).action, "deny");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
