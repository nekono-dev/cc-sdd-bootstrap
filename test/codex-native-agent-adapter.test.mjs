import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexNativeAgentAdapter } from "../.agent-hooks/cc-sdd-bootstrap/codex-native-agent-adapter.mjs";
import { resolveNative } from "../.agent-hooks/cc-sdd-bootstrap/role-policy.mjs";
import { generateNativeAgentDefinitions } from "../.agent-hooks/cc-sdd-bootstrap/native-agent-definitions.mjs";
import { createKiroDelegationContext } from "../.agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs";

const settings = { subagents: { codexModels: { review: "gpt-6.1-sol" } } };
const policy = { role: "review", client: "codex", agentName: "cc_sdd_review", modelId: "gpt-6.1-sol", effort: "medium", access: "read-only" };
const ro = { type: "restricted", entries: [{ path: { type: "special", value: { kind: "root" } }, access: "read" }] };

async function fixture(t, profile = ro, sandbox = { type: "read-only" }, approval = "never", cwd) {
  const dir = await mkdtemp(join(tmpdir(), "codex-agent-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".codex", "agents"), { recursive: true });
  const definition = generateNativeAgentDefinitions(settings, "codex").find((x) => x.relativePath.endsWith("cc_sdd_review.toml"));
  await writeFile(join(dir, definition.relativePath), definition.content);
  const transcriptPath = join(dir, "transcript.jsonl");
  const turn = { type: "turn_context", payload: { turn_id: "turn-1", cwd: cwd ?? dir, model: "gpt-6-luna", effort: "high", sandbox_policy: sandbox, approval_policy: approval, permission_profile: { type: "managed", file_system: profile, network: "restricted" } } };
  await writeFile(transcriptPath, JSON.stringify(turn) + "\n");
  const hookProof = { trusted: true, source: "host", turnId: "turn-1", model: "gpt-6-luna", transcriptPath };
  return { dir, transcriptPath, adapter: createCodexNativeAgentAdapter(), context: { project: dir, sessionId: "s", turnId: "turn-1", hookProof }, launch: { toolName: "collaborationspawn_agent", agentName: "cc_sdd_review", toolInput: { agent_type: "cc_sdd_review", fork_turns: "none" } } };
}

test("Codex trusted turn proof binds model/transcript and verifies role launch end-to-end", async (t) => {
  const f = await fixture(t);
  const evidence = await f.adapter.collectEvidence({ context: f.context, policy, settings, launch: f.launch, hostEvent: { trusted: true, source: "host", turnId: "turn-1", model: "gpt-6-luna", transcriptPath: f.transcriptPath, toolName: "collaborationspawn_agent", toolInput: f.launch.toolInput } });
  assert.deepEqual({ parent: evidence.parentModelId, child: evidence.childModelId, effort: evidence.effort, access: evidence.access, inherited: evidence.historyInherited }, { parent: "gpt-6-luna", child: "gpt-6.1-sol", effort: "medium", access: "read-only", inherited: false });
});

test("entry reference → issue → actual PreToolUse consume は同じターンの実効権限を再確認する", async (t) => {
  const f = await fixture(t);
  const skills = join(f.dir, "skills"), runtime = join(f.dir, "runtime"), writable = join(f.dir, "write");
  await Promise.all([mkdir(join(skills, "kiro-impl"), { recursive: true }), mkdir(writable)]);
  await writeFile(join(skills, "kiro-impl", "SKILL.md"), "手順");
  const fullSettings = { format: 1, ccSdd: { version: "3.1.0", lang: "ja", keepTemplates: false }, clients: "codex", codex: { enabled: true }, subagents: { codexModels: { review: "gpt-6.1-sol" } } };
  await writeFile(join(f.dir, ".cc-sdd-bootstrap.json"), JSON.stringify(fullSettings));
  const definition = generateNativeAgentDefinitions(fullSettings, "codex").find((x) => x.relativePath.endsWith("cc_sdd_review.toml"));
  await writeFile(join(f.dir, definition.relativePath), definition.content);
  const context = createKiroDelegationContext({ runtimeRoot: runtime, writableRoots: [writable], skillsRoot: skills, client: "codex", nativeAdapter: f.adapter });
  await context.beginTurn({ trusted: true, source: "host", cwd: f.dir, sessionId: "s", turnId: "turn-1", prompt: "/kiro-impl" });
  const entry = await context.trustedPreToolUse({ trusted: true, source: "host", cwd: f.dir, sessionId: "s", turnId: "turn-1", toolName: "Bash", toolUseId: "entry", command: "node .agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs enter kiro-impl", model: "gpt-6-luna", transcriptPath: f.transcriptPath });
  const bound = await context.bindEntryReference({ cwd: f.dir, reference: entry.reference, skill: "kiro-impl" });
  const toolInput = { agent_type: "cc_sdd_review", fork_turns: "none" };
  assert.equal((await bound.issueSelectedNative({ requestId: "r", role: "review", toolName: "collaborationspawn_agent", toolInput })).ok, true);
  const consumed = await context.trustedNativePreToolUse({ trusted: true, source: "host", cwd: f.dir, sessionId: "s", turnId: "turn-1", toolUseId: "launch", toolName: "collaborationspawn_agent", toolInput, model: "gpt-6-luna", transcriptPath: f.transcriptPath });
  assert.deepEqual(consumed, { action: "allow" });
});

test("製造役の entry reference → issue → PreToolUse は workspace-write を確認し、変更後は拒否する", async (t) => {
  const f = await fixture(t);
  const skills = join(f.dir, "skills"), runtime = join(f.dir, "runtime"), writable = join(f.dir, "write");
  await Promise.all([mkdir(join(skills, "kiro-impl"), { recursive: true }), mkdir(writable)]);
  await writeFile(join(skills, "kiro-impl", "SKILL.md"), "手順");
  const fullSettings = { format: 1, ccSdd: { version: "3.1.0", lang: "ja", keepTemplates: false }, clients: "codex", codex: { enabled: true }, subagents: { codexModels: { manufacture: "gpt-6.1-sol" } } };
  await writeFile(join(f.dir, ".cc-sdd-bootstrap.json"), JSON.stringify(fullSettings));
  const policyManufacture = resolveNative(fullSettings, "codex", "manufacture").value;
  const definition = generateNativeAgentDefinitions(fullSettings, "codex").find(x => x.relativePath.endsWith(`${policyManufacture.agentName}.toml`));
  await writeFile(join(f.dir, definition.relativePath), definition.content);
  const entries = [
    { path: { type: "special", value: { kind: "root" } }, access: "read" },
    { path: { type: "path", value: f.dir }, access: "write" },
  ];
  const turn = { type: "turn_context", payload: { turn_id: "turn-1", cwd: f.dir, model: "gpt-6-luna", sandbox_policy: { type: "workspace-write", writable_roots: [f.dir] }, approval_policy: "on-request", permission_profile: { type: "managed", file_system: { type: "restricted", entries }, network: "restricted" } } };
  await writeFile(f.transcriptPath, JSON.stringify(turn) + "\n");
  const context = createKiroDelegationContext({ runtimeRoot: runtime, writableRoots: [writable], skillsRoot: skills, client: "codex", nativeAdapter: f.adapter });
  await context.beginTurn({ trusted: true, source: "host", cwd: f.dir, sessionId: "s", turnId: "turn-1", prompt: "/kiro-impl" });
  const entry = await context.trustedPreToolUse({ trusted: true, source: "host", cwd: f.dir, sessionId: "s", turnId: "turn-1", toolName: "Bash", toolUseId: "entry", command: "node .agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs enter kiro-impl", model: "gpt-6-luna", transcriptPath: f.transcriptPath });
  const bound = await context.bindEntryReference({ cwd: f.dir, reference: entry.reference, skill: "kiro-impl" });
  const toolInput = { agent_type: policyManufacture.agentName, fork_turns: "none" };
  assert.equal((await bound.issueSelectedNative({ requestId: "manufacture-1", role: "manufacture", toolName: "collaborationspawn_agent", toolInput })).ok, true);
  const launch = { trusted: true, source: "host", cwd: f.dir, sessionId: "s", turnId: "turn-1", toolUseId: "launch-1", toolName: "collaborationspawn_agent", toolInput, model: "gpt-6-luna", transcriptPath: f.transcriptPath };
  assert.deepEqual(await context.trustedNativePreToolUse(launch), { action: "allow" });

  assert.equal((await bound.issueSelectedNative({ requestId: "manufacture-2", role: "manufacture", toolName: "collaborationspawn_agent", toolInput })).ok, true);
  turn.payload.sandbox_policy.writable_roots = [f.dir + "/outside"];
  await writeFile(f.transcriptPath, JSON.stringify(turn) + "\n");
  const denied = await context.trustedNativePreToolUse({ ...launch, toolUseId: "launch-2" });
  assert.equal(denied.action, "deny");
});

test("Codex adapter rejects inherited, wrong turn/model, malformed permissions and unsafe RO elevation", async (t) => {
  const f = await fixture(t);
  for (const [input, reason] of [
    [{ ...f.launch, toolInput: { agent_type: "cc_sdd_review" } }, /履歴/],
    [{ ...f.launch, toolInput: { agent_type: "cc_sdd_review", fork_turns: "all" } }, /履歴/],
  ]) await assert.rejects(f.adapter.collectEvidence({ context: f.context, policy, settings, launch: input, hostEvent: null }), reason);
  const host = { trusted: true, source: "host", turnId: "turn-1", model: "gpt-6-luna", transcriptPath: f.transcriptPath, toolName: "collaborationspawn_agent", toolInput: f.launch.toolInput };
  await assert.rejects(f.adapter.collectEvidence({ context: { ...f.context, turnId: "turn-2" }, policy, settings, launch: f.launch, hostEvent: host }));
  await assert.rejects(f.adapter.collectEvidence({ context: f.context, policy, settings, launch: { ...f.launch, toolInput: { ...f.launch.toolInput, model: "gpt-6-luna" } }, hostEvent: host }));
  await assert.rejects(f.adapter.collectEvidence({ context: f.context, policy, settings, launch: { ...f.launch, toolInput: { ...f.launch.toolInput, reasoning_effort: "high" } }, hostEvent: host }));
  const elevated = await fixture(t, ro, { type: "read-only" }, "on-request");
  await assert.rejects(elevated.adapter.collectEvidence({ context: elevated.context, policy, settings, launch: elevated.launch, hostEvent: { ...host, transcriptPath: elevated.transcriptPath } }));
  const bad = await fixture(t, { type: "restricted", entries: [{ path: { type: "special", value: { kind: "root" } }, access: "write" }] });
  await assert.rejects(bad.adapter.collectEvidence({ context: bad.context, policy, settings, launch: bad.launch, hostEvent: { ...host, transcriptPath: bad.transcriptPath } }));
  await writeFile(join(f.dir, ".codex", "agents", "cc_sdd_review.toml"), "# altered");
  await assert.rejects(f.adapter.collectEvidence({ context: f.context, policy, settings, launch: f.launch, hostEvent: null }), /管理された Codex 定義/);
});

test("Codex validates real sandbox objects, exact cwd, aliases, and permission consistency", async (t) => {
  const f = await fixture(t);
  const host = { trusted: true, source: "host", turnId: "turn-1", model: "gpt-6-luna", transcriptPath: f.transcriptPath, toolName: "collaborationspawn_agent", toolInput: f.launch.toolInput };
  const verify = (context = f.context, h = host) => f.adapter.collectEvidence({ context, policy, settings, launch: f.launch, hostEvent: h });
  assert.equal((await verify()).access, "read-only");
  await assert.rejects(verify({ ...f.context, project: f.dir + "/elsewhere" }));
  const missingCwd = await fixture(t, ro, { type: "read-only" }, "never", undefined);
  const missingText = await (await import("node:fs/promises")).readFile(missingCwd.transcriptPath, "utf8");
  const missingTurn = JSON.parse(missingText);
  delete missingTurn.payload.cwd;
  await writeFile(missingCwd.transcriptPath, JSON.stringify(missingTurn) + "\n");
  await assert.rejects(missingCwd.adapter.collectEvidence({ context: missingCwd.context, policy, settings, launch: missingCwd.launch, hostEvent: { ...host, transcriptPath: missingCwd.transcriptPath } }), /作業先/);
  const mismatch = await fixture(t, ro, { type: "read-only" }, "never", "/tmp");
  await assert.rejects(mismatch.adapter.collectEvidence({ context: mismatch.context, policy, settings, launch: mismatch.launch, hostEvent: { ...host, transcriptPath: mismatch.transcriptPath } }));
  const stringSandbox = await fixture(t, ro, "read-only");
  await assert.rejects(stringSandbox.adapter.collectEvidence({ context: stringSandbox.context, policy, settings, launch: stringSandbox.launch, hostEvent: { ...host, transcriptPath: stringSandbox.transcriptPath } }));
  const designPolicy = resolveNative({}, "codex", "design", { readOnly: true }).value;
  const designSettings = { subagents: { codexModels: { design: "gpt-6.1-sol" } } };
  const designDir = await mkdtemp(join(tmpdir(), "codex-design-")); t.after(() => rm(designDir, { recursive: true, force: true }));
  await mkdir(join(designDir, ".codex", "agents"), { recursive: true });
  const generated = generateNativeAgentDefinitions({ format: 1, subagents: { codexModels: { design: "gpt-6.1-sol" } } }, "codex").find(x => x.relativePath.endsWith("cc_sdd_design_read_only.toml"));
  await writeFile(join(designDir, generated.relativePath), generated.content);
  const designTranscript = join(designDir, "transcript.jsonl");
  await writeFile(designTranscript, JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-1", cwd: designDir, model: "gpt-6-luna", sandbox_policy: { type: "read-only" }, approval_policy: "never", permission_profile: { type: "managed", file_system: ro, network: "restricted" } } }) + "\n");
  const designLaunch = { ...f.launch, agentName: designPolicy.agentName, toolInput: { agent_type: designPolicy.agentName, fork_turns: "none" } };
  const designEvidence = await f.adapter.collectEvidence({ context: { ...f.context, project: designDir }, policy: designPolicy, settings: designSettings, launch: designLaunch, hostEvent: { ...host, transcriptPath: designTranscript, toolInput: designLaunch.toolInput } });
  assert.equal(designEvidence.access, "read-only");
});

test("Codex workspace-write proof rejects approval escalation and write roots containing private evidence", async (t) => {
  const f = await fixture(t);
  const manufactureSettings = { subagents: { codexModels: { manufacture: "gpt-6.1-sol" } } };
  const manufacture = resolveNative(manufactureSettings, "codex", "manufacture").value;
  const def = generateNativeAgentDefinitions(manufactureSettings, "codex").find(x => x.relativePath.endsWith(`${manufacture.agentName}.toml`));
  await writeFile(join(f.dir, def.relativePath), def.content);
  const policy = manufacture;
  const entries = [
    { path: { type: "special", value: { kind: "root" } }, access: "read" },
    { path: { type: "path", value: f.dir }, access: "write" },
  ];
  const turn = { type: "turn_context", payload: { turn_id: "turn-1", cwd: f.dir, model: "gpt-6-luna", sandbox_policy: { type: "workspace-write", writable_roots: [f.dir] }, approval_policy: "never", permission_profile: { type: "managed", file_system: { type: "restricted", entries }, network: "restricted" } } };
  await writeFile(f.transcriptPath, JSON.stringify(turn) + "\n");
  const launch = { toolName: "collaborationspawn_agent", agentName: manufacture.agentName, toolInput: { agent_type: manufacture.agentName, fork_turns: "none" } };
  const hostEvent = { trusted: true, source: "host", turnId: "turn-1", model: "gpt-6-luna", transcriptPath: f.transcriptPath, toolName: launch.toolName, toolInput: launch.toolInput };
  const adapter = createCodexNativeAgentAdapter({ runtimeRoot: join(f.dir, "private-runtime"), tempRoot: tmpdir() });
  await assert.rejects(adapter.collectEvidence({ context: f.context, policy, settings: manufactureSettings, launch, hostEvent }), /approval|承認|隔離|書き込み/i);
  turn.payload.approval_policy = "never";
  turn.payload.permission_profile.file_system.entries.push({ path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" });
  turn.payload.sandbox_policy.exclude_slash_tmp = false;
  await writeFile(f.transcriptPath, JSON.stringify(turn) + "\n");
  await assert.rejects(adapter.collectEvidence({ context: f.context, policy, settings: manufactureSettings, launch, hostEvent }), /承認|隔離|書き込み|transcript/i);
});

test("Codex workspace-write evidence permits managed manufacture and design only inside project roots", async (t) => {
  const f = await fixture(t);
  const host = { trusted: true, source: "host", turnId: "turn-1", model: "gpt-6-luna", transcriptPath: f.transcriptPath };
  const roles = ["manufacture", "design"];
  for (const role of roles) {
    const roleSettings = { subagents: { codexModels: { [role]: "gpt-6.1-sol" } } };
    const rolePolicy = resolveNative(roleSettings, "codex", role).value;
    const def = generateNativeAgentDefinitions(roleSettings, "codex").find(x => x.relativePath.endsWith(`${rolePolicy.agentName}.toml`));
    await writeFile(join(f.dir, def.relativePath), def.content);
    const entries = [
      { path: { type: "special", value: { kind: "root" } }, access: "read" },
      { path: { type: "path", value: f.dir }, access: "write" },
      { path: { type: "path", value: "/outside" }, access: "read" },
    ];
    const turn = { type: "turn_context", payload: { turn_id: "turn-1", cwd: f.dir, model: "gpt-6-luna", sandbox_policy: { type: "workspace-write", writable_roots: [f.dir] }, approval_policy: "on-request", permission_profile: { type: "managed", file_system: { type: "restricted", entries }, network: "restricted" } } };
    await writeFile(f.transcriptPath, JSON.stringify(turn) + "\n");
    const toolInput = { agent_type: rolePolicy.agentName, fork_turns: "none" };
    const launch = { toolName: "collaborationspawn_agent", agentName: rolePolicy.agentName, toolInput };
    const evidence = await f.adapter.collectEvidence({ context: f.context, policy: rolePolicy, settings: roleSettings, launch, hostEvent: { ...host, toolName: launch.toolName, toolInput } });
    assert.equal(evidence.access, "workspace-write");
    turn.payload.sandbox_policy.writable_roots = [f.dir + "/elsewhere"];
    await writeFile(f.transcriptPath, JSON.stringify(turn) + "\n");
    await assert.rejects(f.adapter.collectEvidence({ context: f.context, policy: rolePolicy, settings: roleSettings, launch, hostEvent: { ...host, toolName: launch.toolName, toolInput } }));
  }
});
