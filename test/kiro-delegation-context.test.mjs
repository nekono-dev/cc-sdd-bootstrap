import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKiroDelegationContext } from "../.agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs";
import { generateNativeAgentDefinitions } from "../.agent-hooks/cc-sdd-bootstrap/native-agent-definitions.mjs";

async function fixture(client = "codex", options = {}) {
  const base = await mkdtemp(join(tmpdir(), "kiro-context-"));
  const project = join(base, "project"), runtimeRoot = join(base, "runtime"), writableRoot = join(base, "delegated-write"), skillsRoot = join(base, "skills");
  await Promise.all([mkdir(project), mkdir(writableRoot), mkdir(skillsRoot)]);
  await writeFile(join(project, ".cc-sdd-bootstrap.json"), JSON.stringify({ format: 1, ccSdd: { version: "3.1.0", lang: "ja", keepTemplates: false }, clients: client, codex: { enabled: false } }));
  await mkdir(join(skillsRoot, "kiro-impl"));
  const skillFile = join(skillsRoot, "kiro-impl", "SKILL.md");
  await writeFile(skillFile, "手順");
  const context = createKiroDelegationContext({ runtimeRoot, writableRoots: [writableRoot], skillsRoot, client, ...options });
  return { base, project, runtimeRoot, writableRoot, skillsRoot, skillFile, context };
}

const eventFor = (f, extra = {}) => ({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", toolName: "Bash", toolUseId: "tool-1", command: "node .agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs enter kiro-impl", ...extra });

test("通常文は非アクティブ、先頭の導入済みコマンドだけ開始し Codex turn_id を必須にする", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  assert.equal(await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", prompt: "普通の作業" }), true);
  assert.equal((await f.context.current({ cwd: f.project, sessionId: "session-a" })).active, false);
  assert.equal(await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-b", prompt: "$kiro-impl 実装" }), true);
  assert.equal((await f.context.current({ cwd: f.project, sessionId: "session-a" })).skill, "kiro-impl");
  assert.equal(await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", prompt: "/kiro-impl" }), false);
});

test("Claude は prompt_id がない場合に内部世代で自然文読み取りを照合し、通常起動は状態を書き換えない", async (t) => {
  const f = await fixture("claude"); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a" });
  const statePath = join(f.runtimeRoot, Buffer.from(`${f.project}\0claude\0session-a`).toString("base64url"), "state.json");
  const { lstat } = await import("node:fs/promises");
  const before = await lstat(statePath);
  assert.deepEqual(await f.context.trustedNativePreToolUse({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", toolUseId: "ordinary-tool", toolName: "Agent", toolInput: {} }), { action: "pass-through" });
  assert.equal((await lstat(statePath)).ino, before.ino);
  const event = { trusted: true, source: "host", success: true, toolName: "Read", cwd: f.project, sessionId: "session-a", toolUseId: "read-no-prompt", filePath: f.skillFile };
  assert.equal(await f.context.successfulSkillRead(event), true);
  assert.equal((await f.context.current({ cwd: f.project, sessionId: "session-a" })).active, true);
});

test("自然文の正規手順読み取りで有効化し、prompt_id が合わないイベントを拒否する", async (t) => {
  const f = await fixture("claude"); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", promptId: "prompt-a", prompt: "この実装を直して" });
  const base = { trusted: true, source: "host", success: true, toolName: "Read", cwd: f.project, sessionId: "session-a", toolUseId: "read-1", filePath: f.skillFile };
  assert.equal(await f.context.successfulSkillRead({ ...base, promptId: "prompt-b" }), false);
  assert.equal(await f.context.successfulSkillRead({ ...base, promptId: "prompt-a" }), true);
  assert.equal((await f.context.current({ cwd: f.project, sessionId: "session-a" })).active, true);
});

test("入口の発行では有効化せず、entry argv と cwd だけで一度消費する", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a" });
  const event = eventFor(f);
  const prepared = await f.context.trustedPreToolUse(event);
  assert.ok(prepared?.reference);
  assert.equal((await f.context.current({ cwd: f.project, sessionId: "session-a" })).active, false);
  const argv = ["enter", "kiro-impl", "--reference", prepared.reference];
  assert.deepEqual(await f.context.handleEntryArgv(argv, { cwd: f.project }), { client: "codex", sessionId: "session-a", turnId: "turn-a", skill: "kiro-impl", toolUseId: "tool-1" });
  assert.equal((await f.context.current({ cwd: f.project, sessionId: "session-a" })).active, true);
  assert.equal(await f.context.handleEntryArgv(argv, { cwd: f.project }), null);
});

test("固定コマンド、turn_id、使用済み toolUseId と ended turn を厳密に照合する", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a" });
  assert.equal(await f.context.trustedPreToolUse(eventFor(f, { command: "echo enter kiro-impl" })), null);
  assert.equal(await f.context.trustedPreToolUse(eventFor(f, { command: "node .agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs enter kiro-impl\n" })), null);
  assert.equal(await f.context.trustedPreToolUse(eventFor(f, { command: "node .agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs enter kiro-impl; true" })), null);
  assert.ok(await f.context.trustedPreToolUse(eventFor(f)));
  assert.equal(await f.context.trustedPreToolUse(eventFor(f)), null);
  assert.equal(await f.context.trustedPreToolUse(eventFor(f, { toolUseId: "tool-2", turnId: "turn-b" })), null);
  assert.equal(await f.context.endTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a" }), true);
  assert.equal(await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", prompt: "/kiro-impl" }), false);
});

test("同じターンの再開始と正規 skill 読み取りで有効状態を保持する", async (t) => {
  const f = await fixture("claude"); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", promptId: "prompt-a" });
  const before = await f.context.current({ cwd: f.project, sessionId: "session-a" });
  const base = { trusted: true, source: "host", success: true, toolName: "Read", cwd: f.project, sessionId: "session-a", promptId: "prompt-a", toolUseId: "read-1", filePath: f.skillFile };
  assert.equal(await f.context.successfulSkillRead(base), true);
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", promptId: "prompt-a" });
  const after = await f.context.current({ cwd: f.project, sessionId: "session-a" });
  assert.equal(after.generation, before.generation);
  assert.equal(after.active, true);
  assert.equal(after.skill, "kiro-impl");
  assert.deepEqual(after.usedToolUseIds, ["read-1"]);
});

test("参照消費は cwd と skill を照合し、保存済み呼び出し ID を一度だけ返す", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", prompt: "/kiro-impl" });
  const prepared = await f.context.trustedPreToolUse(eventFor(f));
  assert.equal(await f.context.consumeReference({ cwd: f.project, reference: prepared.reference, skill: "kiro-other" }), null);
  assert.equal(await f.context.consumeReference({ cwd: f.project, reference: prepared.reference, skill: "kiro-other" }), null);
  const state = await f.context.current({ cwd: f.project, sessionId: "session-a" });
  assert.deepEqual(await f.context.consumeReference({ cwd: f.project, reference: prepared.reference, skill: "kiro-impl" }), { project: f.project, client: "codex", sessionId: "session-a", turnId: "turn-a", generation: state.generation, skill: "kiro-impl", toolUseId: "tool-1" });
  assert.equal(await f.context.consumeReference({ cwd: f.project, reference: prepared.reference, skill: "kiro-impl" }), null);
});

test("現在ターンの束縛発行者だけが同じ引数指紋の起動を一度だけ許可する", async (t) => {
  const nativeAdapter = {
    normalizeLaunch: ({ toolName, toolInput }) => ({ ok: true, value: { toolName, agentName: toolInput.agent_type, argsFingerprint: "a".repeat(64) } }),
    loadSettings: async () => ({}),
    collectEvidence: async ({ policy }) => ({ role: policy.role, client: policy.client, agentName: policy.agentName, definitionVerified: true, parentModelId: "gpt-6-luna", childModelId: policy.modelId, effort: policy.effort, access: policy.access, historyInherited: false }),
  };
  const f = await fixture("codex", { nativeAdapter }); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", prompt: "/kiro-impl" });
  const prepared = await f.context.trustedPreToolUse(eventFor(f));
  const bound = await f.context.bindEntryReference({ cwd: f.project, reference: prepared.reference, skill: "kiro-impl" });
  assert.ok(bound);
  const request = { requestId: "request-a", role: "review", toolName: "spawn_agent", toolInput: { agent_type: "cc_sdd_review", model: "gpt-6.1-sol", fork_turns: "none" } };
  assert.equal((await bound.issueSelectedNative(request)).ok, true);
  assert.equal((await bound.issueSelectedNative(request)).ok, false);
  assert.equal((await f.context.trustedNativePreToolUse({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", toolUseId: "native-changed", toolName: "spawn_agent", toolInput: { ...request.toolInput, prompt: "異なる依頼" } })).action, "deny");
  assert.deepEqual(await f.context.trustedNativePreToolUse({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", toolUseId: "native-1", toolName: "spawn_agent", toolInput: request.toolInput }), { action: "allow" });
  assert.equal((await f.context.trustedNativePreToolUse({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", toolUseId: "native-2", toolName: "spawn_agent", toolInput: { ...request.toolInput, prompt: "異なる依頼" } })).action, "deny");
  assert.equal((await f.context.trustedNativePreToolUse({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", toolUseId: "native-1", toolName: "spawn_agent", toolInput: request.toolInput })).action, "deny");
});

test("設定対象外クライアントでは束縛発行者がネイティブ起動を拒否する", async (t) => {
  const nativeAdapter = {
    normalizeLaunch: ({ toolName, toolInput }) => ({ ok: true, value: { toolName, agentName: toolInput.agent_type } }),
    collectEvidence: async ({ policy }) => ({ role: policy.role, client: policy.client, agentName: policy.agentName, definitionVerified: true, parentModelId: "gpt-6-luna", childModelId: policy.modelId, effort: policy.effort, access: policy.access, historyInherited: false }),
  };
  const f = await fixture("codex", { nativeAdapter }); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", prompt: "/kiro-impl" });
  const prepared = await f.context.trustedPreToolUse(eventFor(f));
  const bound = await f.context.bindEntryReference({ cwd: f.project, reference: prepared.reference, skill: "kiro-impl" });
  const configPath = join(f.project, ".cc-sdd-bootstrap.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.clients = "claude";
  await writeFile(configPath, JSON.stringify(config));
  const request = { requestId: "wrong-client", role: "review", toolName: "spawn_agent", toolInput: { agent_type: "cc_sdd_review", model: "gpt-6.1-sol" } };
  assert.equal((await bound.issueSelectedNative(request)).ok, false);
});

test("設定対象外クライアントではホストのネイティブ起動イベントを拒否する", async (t) => {
  const nativeAdapter = {
    normalizeLaunch: ({ toolName, toolInput }) => ({ ok: true, value: { toolName, agentName: toolInput.agent_type } }),
    collectEvidence: async ({ policy }) => ({ role: policy.role, client: policy.client, agentName: policy.agentName, definitionVerified: true, parentModelId: "gpt-6-luna", childModelId: policy.modelId, effort: policy.effort, access: policy.access, historyInherited: false }),
  };
  const f = await fixture("codex", { nativeAdapter }); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", prompt: "/kiro-impl" });
  const prepared = await f.context.trustedPreToolUse(eventFor(f));
  const bound = await f.context.bindEntryReference({ cwd: f.project, reference: prepared.reference, skill: "kiro-impl" });
  const request = { requestId: "wrong-client-event", role: "review", toolName: "spawn_agent", toolInput: { agent_type: "cc_sdd_review", model: "gpt-6.1-sol" } };
  assert.equal((await bound.issueSelectedNative(request)).ok, true);
  const configPath = join(f.project, ".cc-sdd-bootstrap.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.clients = "claude";
  await writeFile(configPath, JSON.stringify(config));
  assert.equal((await f.context.trustedNativePreToolUse({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", toolUseId: "wrong-client-tool", toolName: "spawn_agent", toolInput: request.toolInput })).action, "deny");
});

test("同一の事前確認に対する同時の異なる tool ID は最大一件だけ許可する", async (t) => {
  const nativeAdapter = {
    normalizeLaunch: ({ toolName, toolInput }) => ({ ok: true, value: { toolName, agentName: toolInput.agent_type } }),
    collectEvidence: async ({ policy }) => ({ role: policy.role, client: policy.client, agentName: policy.agentName, definitionVerified: true, parentModelId: "gpt-6-luna", childModelId: policy.modelId, effort: policy.effort, access: policy.access, historyInherited: false }),
  };
  const f = await fixture("codex", { nativeAdapter }); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", prompt: "/kiro-impl" });
  const prep = await f.context.trustedPreToolUse(eventFor(f));
  const bound = await f.context.bindEntryReference({ cwd: f.project, reference: prep.reference, skill: "kiro-impl" });
  const req = { requestId: "same-args", role: "review", toolName: "spawn_agent", toolInput: { agent_type: "cc_sdd_review", model: "gpt-6.1-sol", fork_turns: "none" } };
  assert.equal((await bound.issueSelectedNative(req)).ok, true);
  const results = await Promise.all(["native-a", "native-b"].map((toolUseId) => f.context.trustedNativePreToolUse({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", toolUseId, toolName: "spawn_agent", toolInput: req.toolInput })));
  assert.equal(results.filter((value) => value.action === "allow").length, 1);
});

test("保留中の参照と使用済み ID は同一ターン再送後も維持し、一度だけ消費できる", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a" });
  const prepared = await f.context.trustedPreToolUse(eventFor(f));
  const before = await f.context.current({ cwd: f.project, sessionId: "session-a" });
  assert.equal(await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a" }), false);
  const after = await f.context.current({ cwd: f.project, sessionId: "session-a" });
  assert.equal(after.generation, before.generation);
  assert.deepEqual(after.usedToolUseIds, ["tool-1"]);
  assert.deepEqual(Object.keys(after.references), [prepared.reference]);
  assert.deepEqual(await f.context.handleEntryArgv(["enter", "kiro-impl", "--reference", prepared.reference], { cwd: f.project }), { client: "codex", sessionId: "session-a", turnId: "turn-a", skill: "kiro-impl", toolUseId: "tool-1" });
  assert.equal(await f.context.handleEntryArgv(["enter", "kiro-impl", "--reference", prepared.reference], { cwd: f.project }), null);
});

test("単独発行は固定設定・管理配置台帳・生成定義を内部で検証する", async (t) => {
  const nativeAdapter = {
    normalizeLaunch: ({ toolName, toolInput }) => ({ ok: true, value: { toolName, agentName: toolInput.agent_type } }),
    collectEvidence: async ({ policy }) => ({ role: policy.role, client: policy.client, agentName: policy.agentName, definitionVerified: true, parentModelId: "gpt-6-luna", childModelId: policy.modelId, effort: policy.effort, access: policy.access, historyInherited: false }),
  };
  const f = await fixture("codex", { nativeAdapter }); t.after(() => rm(f.base, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(join(f.project, ".cc-sdd-bootstrap.json"), "utf8"));
  const required = ["config-schema.mjs", "install-cc-sdd.mjs", "install-gate.mjs", "install-rules.mjs"];
  const files = {};
  for (const name of required) {
    const path = `.agent-hooks/cc-sdd-bootstrap/${name}`;
    const bytes = await readFile(new URL(`../.agent-hooks/cc-sdd-bootstrap/${name}`, import.meta.url));
    const dest = join(f.project, path); await mkdir(join(f.project, ".agent-hooks/cc-sdd-bootstrap"), { recursive: true }); await writeFile(dest, bytes);
    files[path] = { kind: "common", sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  const definition = generateNativeAgentDefinitions(config, "codex").find((entry) => entry.relativePath === ".codex/agents/cc_sdd_review.toml");
  await mkdir(join(f.project, ".codex/agents"), { recursive: true }); await writeFile(join(f.project, definition.relativePath), definition.content);
  files[definition.relativePath] = { kind: "project", sha256: createHash("sha256").update(definition.content).digest("hex") };
  await writeFile(join(f.project, ".agent-hooks/cc-sdd-bootstrap/installed.json"), JSON.stringify({ format: 1, bootstrapVersion: "0.1.0", clients: "codex", files }));
  await import("node:fs/promises").then(({ rm: remove }) => remove(join(f.project, definition.relativePath)));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", prompt: "/kiro-impl" });
  const prepared = await f.context.trustedPreToolUse(eventFor(f));
  const bound = await f.context.bindEntryReference({ cwd: f.project, reference: prepared.reference, skill: "kiro-impl" });
  const request = { requestId: "standalone-a", role: "review", toolName: "spawn_agent", toolInput: { agent_type: "cc_sdd_review", prompt: "レビュー", fork_turns: "none" } };
  assert.equal((await bound.issueStandaloneNative(request)).ok, false);
  await writeFile(join(f.project, definition.relativePath), definition.content);
  assert.equal((await bound.issueStandaloneNative(request)).ok, true);
  await writeFile(join(f.project, ".agent-hooks/cc-sdd-bootstrap/delegate.mjs"), "marker");
  assert.equal((await bound.issueStandaloneNative({ ...request, requestId: "standalone-b" })).ok, false);
});

test("全 writable roots を必要とし、祖先・子孫・同一領域とシンボリックリンクを拒否する", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  assert.throws(() => createKiroDelegationContext({ runtimeRoot: f.runtimeRoot, writableRoots: [], skillsRoot: f.skillsRoot, client: "codex" }));
  const nested = createKiroDelegationContext({ runtimeRoot: join(f.writableRoot, "runtime"), writableRoots: [f.writableRoot], skillsRoot: f.skillsRoot, client: "codex" });
  assert.equal(await nested.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a" }), false);
  const unsafe = createKiroDelegationContext({ runtimeRoot: f.runtimeRoot, writableRoots: [f.writableRoot, f.base], skillsRoot: f.skillsRoot, client: "codex" });
  assert.equal(await unsafe.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a" }), false);
  const symlink = join(f.base, "runtime-link");
  await import("node:fs/promises").then(({ symlink: makeLink }) => makeLink(f.runtimeRoot, symlink));
  const linked = createKiroDelegationContext({ runtimeRoot: symlink, writableRoots: [f.writableRoot], skillsRoot: f.skillsRoot, client: "codex" });
  assert.equal(await linked.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a" }), false);
});

test("ターン終了と次ターンで以前の参照を失効し、状態ファイルの hardlink を拒否する", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", prompt: "/kiro-impl" });
  const prepared = await f.context.trustedPreToolUse(eventFor(f));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-b" });
  assert.equal(await f.context.consumeReference({ cwd: f.project, reference: prepared.reference, toolUseId: "tool-1", skill: "kiro-impl" }), null);
  assert.equal(await f.context.endTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-b" }), true);
  assert.equal((await f.context.current({ cwd: f.project, sessionId: "session-a" })).active, false);
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-c" });
  const { readdir: list, link: hardlink } = await import("node:fs/promises");
  const [entry] = await list(f.runtimeRoot);
  await hardlink(join(f.runtimeRoot, entry, "state.json"), join(f.base, "state-copy.json"));
  assert.equal(await f.context.current({ cwd: f.project, sessionId: "session-a" }), null);
});
