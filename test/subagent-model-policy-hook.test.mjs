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

test("Codex の子エージェント状態と終了イベントは同じホスト session_id の親から分離する", async () => {
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createKiroDelegationContext } = await import("../.agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs");
  const base = await mkdtemp(join(tmpdir(), "cc-sdd-codex-agent-scope-"));
  try {
    const cwd = join(base, "project");
    await mkdir(join(cwd, ".agents/skills/kiro-impl"), { recursive: true });
    await writeFile(join(cwd, ".agents/skills/kiro-impl/SKILL.md"), "# Test\n");
    const rawSessionId = "shared-host-session";
    const parent = createKiroDelegationContext({ runtimeRoot: join(base, "runtime"), writableRoots: [cwd], skillsRoot: join(cwd, ".agents/skills"), client: "codex" });
    const input = { cwd, session_id: rawSessionId, turn_id: "parent-turn", prompt: "/kiro-impl" };
    await routeHostEvent({ client: "codex", eventName: "UserPromptSubmit", input, context: parent });
    assert.equal((await parent.current({ cwd, sessionId: rawSessionId })).active, true);

    const childInput = { ...input, turn_id: "child-turn", agent_id: "agent-child-7", prompt: "child work" };
    await routeHostEvent({ client: "codex", eventName: "UserPromptSubmit", input: childInput, context: parent });
    const childPrompt = normalizeHostEvent("codex", "UserPromptSubmit", childInput);
    assert.notEqual(childPrompt.sessionId, rawSessionId);
    assert.equal((await parent.current({ cwd, sessionId: rawSessionId })).active, true);
    assert.equal((await parent.current({ cwd, sessionId: childPrompt.sessionId })).active, false);

    const childLaunch = normalizeHostEvent("codex", "PreToolUse", { ...childInput, tool_name: "spawn_agent", tool_use_id: "launch-1", tool_input: {} });
    assert.equal(childLaunch.sessionId, childPrompt.sessionId);
    await routeHostEvent({ client: "codex", eventName: "TurnEnd", input: { ...childInput, hook_event_name: "TurnEnd" }, context: parent });
    assert.equal((await parent.current({ cwd, sessionId: rawSessionId })).active, true);
    assert.equal((await parent.current({ cwd, sessionId: childPrompt.sessionId })).ended, true);

    assert.equal(normalizeHostEvent("codex", "UserPromptSubmit", { ...childInput, agent_id: " " }), null);
    assert.equal(normalizeHostEvent("codex", "UserPromptSubmit", { ...childInput, agent_id: 7 }), null);
    assert.equal(normalizeHostEvent("codex", "UserPromptSubmit", { ...childInput, session_id: undefined }), null);
    assert.equal(normalizeHostEvent("claude", "UserPromptSubmit", { cwd, session_id: rawSessionId, agent_id: "agent-child-7", prompt_id: "claude-prompt" }).sessionId, rawSessionId);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
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
