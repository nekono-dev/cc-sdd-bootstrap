import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeNativeAgentAdapter } from "../.agent-hooks/cc-sdd-bootstrap/claude-native-agent-adapter.mjs";
import { createClaudeObservationStore } from "../.agent-hooks/cc-sdd-bootstrap/claude-observation-store.mjs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateNativeAgentDefinitions } from "../.agent-hooks/cc-sdd-bootstrap/native-agent-definitions.mjs";
import { createKiroDelegationContext } from "../.agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs";

test("Claude Agent launch uses scoped stored observation and preserves launch model and effort", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "claude-observe-")); t.after(() => rm(base, { recursive: true, force: true }));
  const adapter = createClaudeNativeAgentAdapter({ store: createClaudeObservationStore({ root: join(base, "store") }), aliases: { "Claude Sonnet 4.5": "claude-sonnet-4-5-20250929", sonnet: "claude-sonnet-4-5-20250929" } });
  const session = { project: base, sessionId: "s1" };
  await adapter.observe({ ...session, event: "SessionStart", model: "Claude Sonnet 4.5" });
  const settings = { subagents: { claudeModels: { review: "claude-sonnet-4-5-20250929" } } };
  const policy = { role: "review", client: "claude", agentName: "cc-sdd-review", modelId: "claude-sonnet-4-5-20250929", effort: "medium", access: "read-only" };
  const definition = generateNativeAgentDefinitions(settings, "claude").find((item) => item.relativePath === ".claude/agents/cc-sdd-review.md");
  await mkdir(join(base, ".claude", "agents"), { recursive: true });
  await writeFile(join(base, definition.relativePath), definition.content);
  assert.equal((await adapter.collectEvidence({ context: session, policy, settings, launch: { agentName: "cc-sdd-review" }, hostEvent: null })).parentModelId, "claude-sonnet-4-5-20250929");
  await adapter.observe({ ...session, event: "PreModelSwitch", from_model: "claude-sonnet-4-5-20250929", to_model: "claude-haiku-4-5-20251001" });
  await assert.rejects(adapter.collectEvidence({ context: session, policy, settings, launch: { agentName: "cc-sdd-review" }, hostEvent: { toolUseId: "t2", toolInput: { subagent_type: "cc-sdd-review" } } }), /セッションモデル/);
  assert.equal(await adapter.observe({ ...session, event: "PostModelSwitch", from_model: "claude-haiku-4-5-20251001", to_model: "claude-sonnet-4-5-20250929" }), false);
  await assert.rejects(adapter.collectEvidence({ context: session, policy, settings, launch: { agentName: "cc-sdd-review" }, hostEvent: null }), /セッションモデル/);
  await adapter.observe({ ...session, event: "PostModelSwitch", from_model: "claude-sonnet-4-5-20250929", to_model: "claude-haiku-4-5-20251001" });
  assert.deepEqual(Object.fromEntries(Object.entries(await adapter.collectEvidence({ context: session, policy, settings, launch: { agentName: "cc-sdd-review", requestedModel: "sonnet", requestedEffort: "high" }, hostEvent: { toolUseId: "t3", session_id: "s1", toolInput: { subagent_type: "cc-sdd-review", model: "sonnet", effort: "high" } } })).filter(([key]) => ["childModelId", "effort"].includes(key))), { childModelId: "claude-sonnet-4-5-20250929", effort: "high" });
  await adapter.observe({ ...session, event: "PreModelSwitch", from_model: "claude-haiku-4-5-20251001", to_model: "claude-sonnet-4-5-20250929" });
  await assert.rejects(adapter.collectEvidence({ context: session, policy, settings, launch: { agentName: "cc-sdd-review" }, hostEvent: null }), /セッションモデル/);
  assert.equal(await adapter.observe({ ...session, event: "PostModelSwitch", from_model: "claude-haiku-4-5-20251001", to_model: "claude-sonnet-4-5-20250929" }), true);
  assert.equal((await adapter.collectEvidence({ context: session, policy, settings, launch: { agentName: "cc-sdd-review" }, hostEvent: null })).parentModelId, "claude-sonnet-4-5-20250929");
  const anotherProject = { project: base, sessionId: "other-session" };
  await assert.rejects(adapter.collectEvidence({ context: anotherProject, policy, settings, launch: { agentName: "cc-sdd-review" }, hostEvent: null }), /セッションモデル/);
});

test("unconfirmed aliases and mismatched calls fail closed", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "claude-observe-")); t.after(() => rm(base, { recursive: true, force: true }));
  const adapter = createClaudeNativeAgentAdapter({ store: createClaudeObservationStore({ root: join(base, "store") }), aliases: {} });
  assert.equal(await adapter.observe({ project: "/p", sessionId: "s", event: "SessionStart", model: "Sonnet" }), false);
  await assert.rejects(adapter.collectEvidence({ context: { project: "/p", sessionId: "s" }, policy: {}, settings: {}, launch: {}, hostEvent: { toolUseId: "t", toolInput: { subagent_type: "x" } } }));
});

test("Claude の実効環境上書きは一致時だけ許可し、発行と起動の両方で再確認する", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "claude-env-")); t.after(() => rm(base, { recursive: true, force: true }));
  const session = { project: base, sessionId: "s" };
  const settings = { subagents: { claudeModels: { review: "sonnet" } } };
  const policy = { role: "review", client: "claude", agentName: "cc-sdd-review", modelId: "sonnet", effort: "medium", access: "read-only" };
  const definition = generateNativeAgentDefinitions(settings, "claude").find((item) => item.relativePath.endsWith("cc-sdd-review.md"));
  await mkdir(join(base, ".claude/agents"), { recursive: true }); await writeFile(join(base, definition.relativePath), definition.content);
  const make = (env) => createClaudeNativeAgentAdapter({ store: createClaudeObservationStore({ root: join(base, "store") }), aliases: { sonnet: "claude-sonnet-4-5-20250929", haiku: "claude-haiku-4-5-20251001" }, env });
  const evidence = (adapter, launch = { agentName: policy.agentName }) => adapter.collectEvidence({ context: session, policy, settings, launch, hostEvent: null });
  const baseAdapter = make({});
  await baseAdapter.observe({ ...session, event: "SessionStart", model: "haiku" });
  assert.equal((await evidence(baseAdapter)).effort, "medium");
  for (const env of [
    { CLAUDE_CODE_EFFORT_LEVEL: "low" },
    { CLAUDE_CODE_EFFORT_LEVEL: "" },
    { CLAUDE_CODE_EFFORT_LEVEL: "unknown" },
    { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", CLAUDE_CODE_SUBAGENT_MODEL: "haiku" },
    { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" },
    { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", CLAUDE_CODE_SUBAGENT_MODEL: "not-a-model" },
    { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "true", CLAUDE_CODE_SUBAGENT_MODEL: "haiku" },
  ]) {
    const adapter = make(env); await adapter.observe({ ...session, event: "SessionStart", model: "haiku" });
    await assert.rejects(evidence(adapter), /環境|モデル|推論量/);
  }
  const matching = make({ CLAUDE_CODE_EFFORT_LEVEL: "medium", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" });
  await matching.observe({ ...session, event: "SessionStart", model: "haiku" });
  assert.equal((await evidence(matching)).childModelId, "claude-sonnet-4-5-20250929");
  const launchOverride = make({ CLAUDE_CODE_EFFORT_LEVEL: "medium" });
  await launchOverride.observe({ ...session, event: "SessionStart", model: "haiku" });
  await assert.rejects(evidence(launchOverride, { agentName: policy.agentName, requestedEffort: "high" }), /環境/);
});

test("failed switch invalidation and corrupt/partial observations never return stale authority", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "claude-observe-")); t.after(() => rm(base, { recursive: true, force: true }));
  const store = createClaudeObservationStore({ root: join(base, "store") });
  const aliases = { sonnet: "claude-sonnet-4-5-20250929" };
  const adapter = createClaudeNativeAgentAdapter({ store, aliases });
  const session = { project: base, sessionId: "s" };
  const settings = { subagents: { claudeModels: { review: "sonnet" } } };
  const policy = { role: "review", client: "claude", agentName: "cc-sdd-review", modelId: "sonnet", effort: "medium", access: "read-only" };
  const definition = generateNativeAgentDefinitions(settings, "claude").find((item) => item.relativePath === ".claude/agents/cc-sdd-review.md");
  await mkdir(join(base, ".claude/agents"), { recursive: true }); await writeFile(join(base, definition.relativePath), definition.content);
  assert.equal(await adapter.observe({ ...session, event: "SessionStart", model: "sonnet" }), true);
  const key = store.keyFor(session);
  await store.withLock(key, async (file) => { const { writeFile } = await import("node:fs/promises"); await writeFile(file, "{"); });
  await assert.rejects(adapter.collectEvidence({ context: session, policy, settings, launch: { agentName: "cc-sdd-review" }, hostEvent: null }), /セッションモデル/);
  const other = { ...session, sessionId: "other" };
  await assert.rejects(adapter.collectEvidence({ context: other, policy, settings, launch: { agentName: "cc-sdd-review" }, hostEvent: null }), /セッションモデル/);
});

test("failed PreModelSwitch storage leaves the session unusable even if old bytes remain", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "claude-observe-")); t.after(() => rm(base, { recursive: true, force: true }));
  const store = createClaudeObservationStore({ root: join(base, "store") });
  const aliases = { sonnet: "claude-sonnet-4-5-20250929", haiku: "claude-haiku-4-5-20251001" };
  const adapter = createClaudeNativeAgentAdapter({ store, aliases });
  const session = { project: base, sessionId: "s" };
  const settings = { subagents: { claudeModels: { review: "sonnet" } } };
  const policy = { role: "review", client: "claude", agentName: "cc-sdd-review", modelId: "sonnet", effort: "medium", access: "read-only" };
  const definition = generateNativeAgentDefinitions(settings, "claude").find((item) => item.relativePath === ".claude/agents/cc-sdd-review.md");
  await mkdir(join(base, ".claude/agents"), { recursive: true }); await writeFile(join(base, definition.relativePath), definition.content);
  await adapter.observe({ ...session, event: "SessionStart", model: "haiku" });
  assert.equal((await adapter.collectEvidence({ context: session, policy, settings, launch: { agentName: "cc-sdd-review" }, hostEvent: null })).parentModelId, aliases.haiku);
  const key = store.keyFor(session);
  let release;
  const held = store.withLock(key, async () => new Promise((resolve) => { release = resolve; }));
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(await adapter.observe({ ...session, event: "PreModelSwitch", from_model: "haiku", to_model: "sonnet" }), false);
  release(); await held;
  const restarted = createClaudeNativeAgentAdapter({ store: createClaudeObservationStore({ root: join(base, "store") }), aliases });
  await assert.rejects(restarted.collectEvidence({ context: session, policy, settings, launch: { agentName: "cc-sdd-review" }, hostEvent: null }), /セッションモデル/);
  const other = { project: base, sessionId: "other" };
  await restarted.observe({ ...other, event: "SessionStart", model: "haiku" });
  assert.equal((await restarted.collectEvidence({ context: other, policy, settings, launch: { agentName: "cc-sdd-review" }, hostEvent: null })).parentModelId, aliases.haiku);
});

test("default sonnet alias is normalized, and only a matching complete switch pair confirms", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "claude-observe-")); t.after(() => rm(base, { recursive: true, force: true }));
  const store = createClaudeObservationStore({ root: join(base, "store") });
  const adapter = createClaudeNativeAgentAdapter({ store, aliases: { sonnet: "claude-sonnet-4-5-20250929", haiku: "claude-haiku-4-5-20251001" } });
  const session = { project: base, sessionId: "s" };
  const settings = { subagents: { claudeModels: { review: "sonnet" } } };
  const policy = { role: "review", client: "claude", agentName: "cc-sdd-review", modelId: "sonnet", effort: "medium", access: "read-only" };
  const definition = generateNativeAgentDefinitions(settings, "claude").find((item) => item.relativePath === ".claude/agents/cc-sdd-review.md");
  await mkdir(join(base, ".claude/agents"), { recursive: true }); await writeFile(join(base, definition.relativePath), definition.content);
  assert.equal(await adapter.observe({ ...session, event: "SessionStart", model: "sonnet" }), true);
  const evidence = await adapter.collectEvidence({ context: session, policy, settings, launch: { agentName: "cc-sdd-review" }, hostEvent: null });
  assert.equal(evidence?.parentModelId, "claude-sonnet-4-5-20250929");
  assert.equal(evidence?.childModelId, "claude-sonnet-4-5-20250929");
  assert.equal(await adapter.observe({ ...session, event: "PreModelSwitch", from_model: "sonnet", to_model: "haiku" }), true);
  assert.equal(await adapter.observe({ ...session, event: "PostModelSwitch", from_model: "haiku", to_model: "sonnet" }), false);
  await assert.rejects(adapter.collectEvidence({ context: session, policy, settings, launch: { agentName: "cc-sdd-review" }, hostEvent: null }), /セッションモデル/);
  assert.equal(await adapter.observe({ ...session, event: "PostModelSwitch", from_model: "sonnet", to_model: "haiku" }), true);
  const override = await adapter.collectEvidence({ context: session, policy, settings, launch: { agentName: "cc-sdd-review", requestedModel: "haiku", requestedEffort: "high" }, hostEvent: null });
  assert.equal(override.childModelId, "claude-haiku-4-5-20251001"); assert.equal(override.effort, "high");
});

test("deployed Claude adapter refuses workspace-write without host private-write proof", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "claude-write-proof-")); t.after(() => rm(base, { recursive: true, force: true }));
  const store = createClaudeObservationStore({ root: join(base, "store") });
  const adapter = createClaudeNativeAgentAdapter({ store, requirePrivateWriteProof: true, aliases: { haiku: "claude-haiku-4-5-20251001" } });
  const session = { project: base, sessionId: "s" };
  const settings = { subagents: { claudeModels: { manufacture: "haiku" } } };
  const policy = { role: "manufacture", client: "claude", agentName: "cc-sdd-manufacture", modelId: "haiku", effort: "medium", access: "workspace-write" };
  const definition = generateNativeAgentDefinitions(settings, "claude").find(item => item.relativePath.endsWith("cc-sdd-manufacture.md"));
  await mkdir(join(base, ".claude/agents"), { recursive: true }); await writeFile(join(base, definition.relativePath), definition.content);
  await adapter.observe({ ...session, event: "SessionStart", model: "haiku" });
  await assert.rejects(adapter.collectEvidence({ context: session, policy, settings, launch: { agentName: policy.agentName }, hostEvent: null }), /書き込み|write|証拠/i);
});

test("実 Claude adapter で事前発行から起動まで許可し、切替後と上書きを再判定する", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "claude-context-")); t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project"), writable = join(base, "write"), skills = join(base, "skills"), runtime = join(base, "runtime");
  await Promise.all([mkdir(project), mkdir(writable), mkdir(join(skills, "kiro-impl"), { recursive: true })]);
  const settings = { format: 1, ccSdd: { version: "3.1.0", lang: "ja", keepTemplates: false }, clients: "claude", codex: { enabled: false }, subagents: { claudeModels: { review: "sonnet" } } };
  await writeFile(join(project, ".cc-sdd-bootstrap.json"), JSON.stringify(settings));
  await writeFile(join(skills, "kiro-impl", "SKILL.md"), "手順");
  const definition = generateNativeAgentDefinitions(settings, "claude").find((entry) => entry.relativePath === ".claude/agents/cc-sdd-review.md");
  await mkdir(join(project, ".claude/agents"), { recursive: true }); await writeFile(join(project, definition.relativePath), definition.content);
  const observationStore = createClaudeObservationStore({ root: join(base, "observations") });
  const adapter = createClaudeNativeAgentAdapter({ store: observationStore, aliases: { sonnet: "claude-sonnet-4-5-20250929", haiku: "claude-haiku-4-5-20251001" } });
  const context = createKiroDelegationContext({ runtimeRoot: runtime, writableRoots: [writable], skillsRoot: skills, client: "claude", nativeAdapter: adapter });
  assert.equal(await adapter.observe({ project, sessionId: "s", event: "SessionStart", model: "haiku" }), true);
  assert.equal(await context.beginTurn({ trusted: true, source: "host", cwd: project, sessionId: "s", promptId: "p", prompt: "/kiro-impl" }), true);
  const request = { requestId: "r1", role: "review", toolName: "Agent", toolInput: { subagent_type: "cc-sdd-review" } };
  const prepared = await context.trustedPreToolUse({ trusted: true, source: "host", cwd: project, sessionId: "s", promptId: "p", toolName: "Bash", toolUseId: "entry", command: "node .agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs enter kiro-impl" });
  const bound = await context.bindEntryReference({ cwd: project, reference: prepared.reference, skill: "kiro-impl" });
  assert.equal((await bound.issueSelectedNative(request)).ok, true);
  const host = (toolUseId, toolInput) => context.trustedNativePreToolUse({ trusted: true, source: "host", cwd: project, sessionId: "s", promptId: "p", toolUseId, toolName: "Agent", toolInput });
  assert.deepEqual(await host("launch-ok", request.toolInput), { action: "allow" });

  const overrideRequest = { ...request, requestId: "r2", toolInput: { subagent_type: "cc-sdd-review", model: "haiku", effort: "high" } };
  const mismatched = await bound.issueSelectedNative(overrideRequest);
  assert.equal(mismatched.ok, false); assert.match(mismatched.error.reason, /same-model|model-mismatch|effort-mismatch/);
  const effortMismatch = await bound.issueSelectedNative({ ...request, requestId: "r-effort", toolInput: { subagent_type: "cc-sdd-review", model: "sonnet", effort: "high" } });
  assert.equal(effortMismatch.ok, false); assert.match(effortMismatch.error.reason, /effort-mismatch/);

  await adapter.observe({ project, sessionId: "s", event: "PreModelSwitch", from_model: "haiku", to_model: "sonnet" });
  const third = { ...request, requestId: "r3" };
  assert.equal((await bound.issueSelectedNative(third)).ok, false);
  assert.equal(await adapter.observe({ project, sessionId: "s", event: "PostModelSwitch", from_model: "haiku", to_model: "sonnet" }), true);
  assert.equal((await adapter.collectEvidence({ context: { project, sessionId: "s" }, policy: { role: "review", client: "claude", agentName: "cc-sdd-review", modelId: "sonnet", effort: "medium", access: "read-only" }, settings, launch: { agentName: "cc-sdd-review" }, hostEvent: null })).parentModelId, "claude-sonnet-4-5-20250929");
  assert.equal((await bound.issueSelectedNative({ ...third, requestId: "r4" })).ok, false);
  const otherSession = { project, sessionId: "other" };
  assert.equal(await adapter.observe({ ...otherSession, event: "SessionStart", model: "haiku" }), true);
  const otherEvidence = await adapter.collectEvidence({ context: otherSession, policy: { role: "review", client: "claude", agentName: "cc-sdd-review", modelId: "sonnet", effort: "medium", access: "read-only" }, settings, launch: { agentName: "cc-sdd-review" }, hostEvent: null });
  assert.equal(otherEvidence.parentModelId, "claude-haiku-4-5-20251001");
});
