import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalog, CODEX_OWNED_MARKER, delegationSection } from "../lib/catalog.mjs";
import { createKiroDelegationContext } from "../.agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs";
import { normalizeHostEvent, routeHostEvent } from "../.agent-hooks/cc-sdd-bootstrap/subagent-model-policy-hook.mjs";
import { MANAGED_DELEGATION, decideMcpGate, handleMcpPreToolUse } from "../.agent-hooks/cc-sdd-bootstrap/delegation-mcp-gate.mjs";

// 検証済みの経路を模した設定。本番の既定は無効のままにする。
const ENABLED = { claude: { enabled: true, reason: "" }, codex: { enabled: true, reason: "" } };
const GATE_FILE = "delegation-mcp-gate.mjs";
const MATCH = (matcher, name) => new RegExp(`^(?:${matcher})$`).test(name);

test("未検証の経路では管理委任を有効にせず、理由を示す", () => {
  for (const client of ["claude", "codex"]) {
    assert.equal(MANAGED_DELEGATION[client].enabled, false, client);
    assert.match(MANAGED_DELEGATION[client].reason, /\S/, client);
  }
  assert.deepEqual(decideMcpGate({ client: "claude", toolName: "mcp__pi-agent__pi_start", active: true }), { action: "pass-through" });
});

test("作業中は Pi と Codex の起動ツールの直接呼び出しを拒否し、管理入口を示す", () => {
  const cases = [
    ["claude", "mcp__pi-agent__pi_start"],
    ["claude", "mcp__cc-sdd-codex__codex_start"],
    ["codex", "mcp__pi_agent__pi_start"],
    ["codex", "mcp__cc-sdd-codex__codex_start"],
  ];
  for (const [client, toolName] of cases) {
    const decision = decideMcpGate({ client, toolName, active: true }, ENABLED);
    assert.equal(decision.action, "deny", toolName);
    assert.match(decision.reason, /delegate\.mjs start/, toolName);
    assert.match(decision.reason, /--reference/, toolName);
  }
});

test("作業中でも、起動以外の操作・非エージェント MCP・通常のツールは通す", () => {
  const names = [
    "mcp__pi-agent__pi_models", "mcp__pi-agent__pi_capabilities", "mcp__pi-agent__pi_status", "mcp__pi-agent__pi_cancel",
    "mcp__cc-sdd-codex__codex_status", "mcp__cc-sdd-codex__codex_stop", "mcp__github__create_issue", "Bash", "Agent",
  ];
  for (const toolName of names) {
    assert.deepEqual(decideMcpGate({ client: "claude", toolName, active: true }, ENABLED), { action: "pass-through" }, toolName);
  }
});

test("cc-sdd の作業中でなければ、起動ツールも通す", () => {
  assert.deepEqual(decideMcpGate({ client: "claude", toolName: "mcp__pi-agent__pi_start", active: false }, ENABLED), { action: "pass-through" });
  assert.deepEqual(decideMcpGate({ client: "codex", toolName: "mcp__cc-sdd-codex__codex_start", active: false }, ENABLED), { action: "pass-through" });
});

test("入力が不正なら例外でなく拒否結果を返す", () => {
  const valid = { client: "claude", toolName: "mcp__pi-agent__pi_start", active: true };
  const invalid = [null, [], "text", { ...valid, extra: 1 }, { ...valid, client: "other" }, { ...valid, toolName: "" },
    { ...valid, active: "yes" }, { client: "claude", toolName: "mcp__pi-agent__pi_start" }];
  for (const input of invalid) {
    const decision = decideMcpGate(input, ENABLED);
    assert.equal(decision.action, "deny", JSON.stringify(input));
    assert.match(decision.reason, /\S/, JSON.stringify(input));
  }
});

test("実際の作業コンテキストで作業中を判定し、起動だけを拒否する", async () => {
  const base = await mkdtemp(join(tmpdir(), "cc-sdd-mcp-gate-"));
  try {
    const cwd = join(base, "project");
    await mkdir(join(cwd, ".claude/skills/kiro-impl"), { recursive: true });
    await writeFile(join(cwd, ".claude/skills/kiro-impl/SKILL.md"), "# Test\n");
    const context = createKiroDelegationContext({ client: "claude", runtimeRoot: join(base, "runtime"), writableRoots: [cwd], skillsRoot: join(cwd, ".claude/skills") });
    const sessionId = "session-gate";
    const launchInput = { cwd, session_id: sessionId, tool_name: "mcp__pi-agent__pi_start", tool_use_id: "use-1", tool_input: {} };

    // 作業開始前は、起動ツールでも cc-sdd の作業ではないため通す
    const beforeWork = normalizeHostEvent("claude", "PreToolUse", launchInput);
    assert.deepEqual(await handleMcpPreToolUse({ client: "claude", event: beforeWork, toolName: launchInput.tool_name, context, managed: ENABLED }), { action: "pass-through" });

    await routeHostEvent({ client: "claude", eventName: "UserPromptSubmit", input: { cwd, session_id: sessionId, prompt_id: "prompt-1", prompt: "/kiro-impl" }, context });

    const launch = normalizeHostEvent("claude", "PreToolUse", { ...launchInput, tool_use_id: "use-2" });
    const denied = await handleMcpPreToolUse({ client: "claude", event: launch, toolName: launchInput.tool_name, context, managed: ENABLED });
    assert.equal(denied.action, "deny");
    assert.match(denied.reason, /delegate\.mjs start/);

    const status = normalizeHostEvent("claude", "PreToolUse", { ...launchInput, tool_name: "mcp__pi-agent__pi_status", tool_use_id: "use-3", tool_input: { job_id: "job" } });
    assert.deepEqual(await handleMcpPreToolUse({ client: "claude", event: status, toolName: "mcp__pi-agent__pi_status", context, managed: ENABLED }), { action: "pass-through" });

    // ホスト情報を取得できない起動は、手順の中か判断できないため拒否する
    assert.equal((await handleMcpPreToolUse({ client: "claude", event: null, toolName: launchInput.tool_name, context, managed: ENABLED })).action, "deny");
    assert.deepEqual(await handleMcpPreToolUse({ client: "claude", event: null, toolName: "mcp__github__create_issue", context, managed: ENABLED }), { action: "pass-through" });

    // 作業が終わったあとは通す
    await routeHostEvent({ client: "claude", eventName: "Stop", input: { cwd, session_id: sessionId, prompt_id: "prompt-1" }, context });
    const afterWork = normalizeHostEvent("claude", "PreToolUse", { ...launchInput, tool_use_id: "use-4" });
    assert.deepEqual(await handleMcpPreToolUse({ client: "claude", event: afterWork, toolName: launchInput.tool_name, context, managed: ENABLED }), { action: "pass-through" });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("配布物と全フックに MCP ガードと管理入口を登録する", () => {
  const paths = catalog.files.map((file) => file.path);
  for (const name of ["delegate.mjs", GATE_FILE]) {
    assert.ok(paths.includes(`.agent-hooks/cc-sdd-bootstrap/${name}`), name);
  }
  const claudeGate = catalog.hooks.filter((hook) => hook.command.includes(GATE_FILE));
  assert.equal(claudeGate.length, 1);
  assert.equal(claudeGate[0].event, "PreToolUse");
  assert.equal(claudeGate[0].matcher, "mcp__.*");
  const codexGate = catalog.codexHooks.filter((hook) => hook.command.includes(GATE_FILE));
  assert.equal(codexGate.length, 1);
  assert.equal(codexGate[0].event, "PreToolUse");
  assert.equal(codexGate[0].matcher, "mcp__.*");
  assert.ok(codexGate[0].command.endsWith(CODEX_OWNED_MARKER));
});

test("上流のネイティブガードと MCP ガードの matcher は互いに重ならない", () => {
  for (const [hooks, native] of [
    [catalog.hooks, "Bash|Agent"],
    [catalog.codexHooks, "Bash|shell|spawn_agent|collaborationspawn_agent"],
  ]) {
    const nativeHook = hooks.find((hook) => hook.event === "PreToolUse" && hook.command.includes("subagent-model-policy-hook.mjs"));
    assert.equal(nativeHook.matcher, native);
    const gateHook = hooks.find((hook) => hook.event === "PreToolUse" && hook.command.includes(GATE_FILE));
    assert.equal(MATCH(nativeHook.matcher, "Bash"), true);
    assert.equal(MATCH(nativeHook.matcher, native.includes("Agent") ? "Agent" : "spawn_agent"), true);
    assert.equal(MATCH(nativeHook.matcher, "mcp__pi-agent__pi_start"), false);
    assert.equal(MATCH(gateHook.matcher, "mcp__pi-agent__pi_start"), true);
    for (const name of ["Bash", "Agent", "spawn_agent", "shell"]) assert.equal(MATCH(gateHook.matcher, name), false, name);
  }
});

test("管理区画は管理委任の状態を示し、無効な間は管理入口の手順を出さない", () => {
  const disabled = delegationSection("claude", MANAGED_DELEGATION);
  assert.equal(disabled.id, "cc-sdd-delegation");
  assert.match(disabled.body, /無効/);
  assert.doesNotMatch(disabled.body, /delegate\.mjs start/);

  const enabled = delegationSection("codex", ENABLED);
  assert.match(enabled.body, /delegate\.mjs start/);
  assert.match(enabled.body, /delegate\.mjs status/);
  assert.match(enabled.body, /delegate\.mjs stop/);
  assert.match(enabled.body, /直接起動/);
  assert.match(enabled.body, /拒否/);

  for (const [sections, client] of [[catalog.claudeSections, "claude"], [catalog.agentsSections, "codex"]]) {
    assert.ok(sections.some((section) => section.id === "cc-sdd-delegation"), client);
  }
});
