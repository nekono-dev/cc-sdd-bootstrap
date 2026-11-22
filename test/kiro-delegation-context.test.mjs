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

test("入口の発行では有効化せず、entry argv と検証済み呼び出し情報で一度消費する", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a" });
  const event = eventFor(f);
  const prepared = await f.context.trustedPreToolUse(event);
  assert.ok(prepared?.reference);
  assert.equal((await f.context.current({ cwd: f.project, sessionId: "session-a" })).active, false);
  const argv = ["enter", "kiro-impl", "--reference", prepared.reference];
  assert.equal(await f.context.handleEntryArgv(argv, { cwd: f.project, reference: prepared.reference, skill: "kiro-impl", unexpected: true }), null);
  const processContext = { cwd: f.project, reference: prepared.reference, skill: "kiro-impl" };
  assert.deepEqual(await f.context.handleEntryArgv(argv, processContext), { client: "codex", sessionId: "session-a", turnId: "turn-a", skill: "kiro-impl", toolUseId: "tool-1" });
  assert.equal((await f.context.current({ cwd: f.project, sessionId: "session-a" })).active, true);
  assert.equal(await f.context.handleEntryArgv(argv, processContext), null);
});

test("handleEntryArgv は不正な公開入力を例外にせず拒否し、不正参照の後も正しい参照を消費できる", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a" });
  const prepared = await f.context.trustedPreToolUse(eventFor(f));
  assert.ok(prepared?.reference);
  const validArgv = ["enter", "kiro-impl", "--reference", prepared.reference];
  const validContext = { cwd: f.project, reference: prepared.reference, skill: "kiro-impl" };
  const safelyHandle = async (argv, context) => {
    try { return await f.context.handleEntryArgv(argv, context); } catch (error) { return error; }
  };

  assert.equal(await safelyHandle(["enter", { toString: null }, "--reference", prepared.reference], validContext), null,
    "不正な skill 型は例外でなく拒否結果にする");
  assert.equal(await safelyHandle(["enter", "kiro-impl", "--reference", ""], { ...validContext, reference: "" }), null,
    "空の参照を拒否する");
  assert.equal(await safelyHandle(validArgv, validContext) && (await f.context.current({ cwd: f.project, sessionId: "session-a" })).active, true,
    "不正入力を拒否した後も有効な参照を消費する");
  assert.equal(await safelyHandle(validArgv, validContext), null, "消費済み参照の再使用を拒否する");
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
  assert.deepEqual(await f.context.handleEntryArgv(["enter", "kiro-impl", "--reference", prepared.reference], { cwd: f.project, reference: prepared.reference, skill: "kiro-impl" }), { client: "codex", sessionId: "session-a", turnId: "turn-a", skill: "kiro-impl", toolUseId: "tool-1" });
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

test("参照なし・明示 null の入口引数・終了済みターン・次ターンの参照を拒否する", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", prompt: "/kiro-impl" });
  const prepared = await f.context.trustedPreToolUse(eventFor(f));
  const validEntry = { entryType: "enter", entryArguments: { skill: "kiro-impl" } };
  const safeConsume = async (input) => { try { return await f.context.consumeReference(input); } catch (error) { return error; } };
  assert.equal(await safeConsume(null), null, "null の公開入力を拒否する");
  assert.equal(await safeConsume([]), null, "配列の公開入力を拒否する");
  assert.equal(await safeConsume({ cwd: f.project, reference: prepared.reference, ...validEntry, unexpected: true }), null, "未知キーを含む公開入力を拒否する");
  assert.equal(await safeConsume({ cwd: f.project, ...validEntry }), null, "参照を省略した入口は拒否する");
  assert.equal(await safeConsume({ cwd: f.project, reference: prepared.reference, skill: { toString: null } }), null, "不正な skill 型を例外にせず拒否する");
  assert.equal(await safeConsume({ cwd: f.project, reference: prepared.reference, skill: "kiro-impl", entryType: null, entryArguments: { skill: "kiro-impl" } }), null, "明示 null の入口種別を省略扱いにしない");
  assert.equal(await safeConsume({ cwd: f.project, reference: prepared.reference, skill: "kiro-impl", entryType: "enter", entryArguments: null }), null, "明示 null の引数を省略扱いにしない");
  assert.equal(await f.context.endTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a" }), true);
  assert.equal(await f.context.consumeReference({ cwd: f.project, reference: prepared.reference, ...validEntry }), null, "終了直後のターン参照を拒否する");
  assert.equal((await f.context.current({ cwd: f.project, sessionId: "session-a" })).active, false);
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-b" });
  assert.equal(await f.context.consumeReference({ cwd: f.project, reference: prepared.reference, ...validEntry }), null, "次ターンでも前のターン参照を拒否する");
  const next = await f.context.trustedPreToolUse(eventFor(f, { turnId: "turn-b", toolUseId: "tool-next" }));
  assert.ok(next?.reference);
  assert.equal(await f.context.endTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-b" }), true);
  assert.equal(await f.context.consumeReference({ cwd: f.project, reference: next.reference, ...validEntry }), null, "別参照も終了後に拒否する");
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-c" });
  const { readdir: list, link: hardlink } = await import("node:fs/promises");
  const [entry] = await list(f.runtimeRoot);
  await hardlink(join(f.runtimeRoot, entry, "state.json"), join(f.base, "state-copy.json"));
  assert.equal(await f.context.current({ cwd: f.project, sessionId: "session-a" }), null);
});

test("管理入口の参照は操作種別と正規化引数に結び付き、一度だけ消費する", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", prompt: "/kiro-impl" });
  assert.equal(await f.context.trustedPreToolUse(null), null);
  assert.equal(await f.context.trustedPreToolUse([...Object.values(eventFor(f))]), null);
  assert.equal(await f.context.trustedPreToolUse({ ...eventFor(f), unrecognized: true }), null);
  const command = "node .agent-hooks/cc-sdd-bootstrap/delegate.mjs start --skill kiro-impl --task-id 2.3 --request-id req-a --role manufacture --work-dir /tmp/project --instruction-file /tmp/instruction.md";
  const prepared = await f.context.trustedPreToolUse(eventFor(f, { command }));
  assert.ok(prepared?.reference);
  const state = await f.context.current({ cwd: f.project, sessionId: "session-a" });
  const item = state.references[prepared.reference];
  assert.equal(item.entryType, "delegate-start");
  assert.match(item.argsFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await f.context.consumeReference({ cwd: f.project, reference: prepared.reference, entryType: "delegate-control", entryArguments: { operation: "status", skill: "kiro-impl", taskId: "2.3", requestId: "req-a", workDir: "/tmp/project" } }), null);
  assert.equal(await f.context.consumeReference({ cwd: f.project, entryType: "delegate-start", entryArguments: item.entryArguments }), null);
  assert.equal(await f.context.consumeReference({ cwd: f.project, reference: prepared.reference, entryType: "delegate-start", entryArguments: { operation: "start", skill: "kiro-impl", taskId: "2.3", requestId: "req-b", role: "manufacture", workDir: "/tmp/project", instructionFile: "/tmp/instruction.md", readOnly: false } }), null);
  const consumed = await f.context.consumeReference({ cwd: f.project, reference: prepared.reference, entryType: "delegate-start", entryArguments: { operation: "start", skill: "kiro-impl", taskId: "2.3", requestId: "req-a", role: "manufacture", workDir: "/tmp/project", instructionFile: "/tmp/instruction.md", readOnly: false } });
  assert.equal(consumed?.entryType, "delegate-start");
  assert.equal(await f.context.consumeReference({ cwd: f.project, reference: prepared.reference, entryType: "delegate-start", entryArguments: { operation: "start", skill: "kiro-impl", taskId: "2.3", requestId: "req-a", role: "manufacture", workDir: "/tmp/project", instructionFile: "/tmp/instruction.md", readOnly: false } }), null);
});

test("preflight の参照も固定 schema の正規化済み依頼に結び付き、不正入力を拒否する", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a" });
  const request = { requestId: "request-a", role: "review", toolName: "spawn_agent", toolInput: { agent_type: "cc_sdd_review", model: "gpt-6.1-sol", prompt: "秘密の依頼本文 sentinel-body-42" } };
  const payload = Buffer.from(JSON.stringify(request)).toString("base64url");
  const command = `node .agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs preflight kiro-impl ${payload}`;
  const prepared = await f.context.trustedPreToolUse(eventFor(f, { command }));
  assert.ok(prepared?.reference);
  const state = await f.context.current({ cwd: f.project, sessionId: "session-a" });
  const item = state.references[prepared.reference];
  assert.equal(item.entryType, "preflight");
  assert.equal(Object.hasOwn(item, "entryArguments"), false);
  assert.equal(Object.hasOwn(item, "command"), false);
  assert.equal(JSON.stringify(state).includes(request.toolInput.prompt), false, "依頼本文を実行時記録に保存しない");
  assert.equal(JSON.stringify(state).includes(payload), false, "依頼本文を復元できるコマンドを実行時記録に保存しない");
  assert.equal(await f.context.consumeReference(null), null);
  assert.equal(await f.context.consumeReference({ cwd: f.project, reference: prepared.reference, entryType: "preflight", entryArguments: { skill: "kiro-impl", request: { ...request, readOnly: false, unknown: true } } }), null);
  const consumed = await f.context.consumeReference({ cwd: f.project, reference: prepared.reference, entryType: "preflight", entryArguments: { skill: "kiro-impl", request: { ...request, readOnly: false } } });
  assert.equal(consumed?.entryType, "preflight");
  assert.equal(Object.hasOwn(consumed, "entryArguments"), false);
  assert.equal(await f.context.trustedPreToolUse(eventFor(f, { toolUseId: "bad-preflight", command: `node .agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs preflight kiro-impl ${Buffer.from(JSON.stringify({ ...request, unexpected: true })).toString("base64url")}` })), null);
});

test("delegate-start は一致する手順の管理範囲を開始し、delegate-control は開始せず新しいターンで使える", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a" });
  const startCommand = "node .agent-hooks/cc-sdd-bootstrap/delegate.mjs start --skill kiro-impl --task-id 2.3 --request-id req-a --role manufacture --work-dir /tmp/project --instruction-file /tmp/instruction.md";
  const start = await f.context.trustedPreToolUse(eventFor(f, { command: startCommand }));
  assert.ok(start?.reference);
  assert.equal((await f.context.current({ cwd: f.project, sessionId: "session-a" })).active, false);
  assert.ok(await f.context.consumeReference({ cwd: f.project, reference: start.reference, entryType: "delegate-start", entryArguments: { operation: "start", skill: "kiro-impl", taskId: "2.3", requestId: "req-a", role: "manufacture", workDir: "/tmp/project", instructionFile: "/tmp/instruction.md", readOnly: false } }));
  assert.equal((await f.context.current({ cwd: f.project, sessionId: "session-a" })).active, true);
  await f.context.endTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a" });
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-b" });
  assert.equal(await f.context.consumeReference({ cwd: f.project, reference: start.reference, entryType: "delegate-start", entryArguments: { operation: "start", skill: "kiro-impl", taskId: "2.3", requestId: "req-a", role: "manufacture", workDir: "/tmp/project", instructionFile: "/tmp/instruction.md", readOnly: false } }), null);
  const controlCommand = "node .agent-hooks/cc-sdd-bootstrap/delegate.mjs status --skill kiro-impl --task-id 2.3 --request-id req-a --work-dir /tmp/project";
  const control = await f.context.trustedPreToolUse(eventFor(f, { turnId: "turn-b", toolUseId: "tool-control", command: controlCommand }));
  assert.ok(control?.reference);
  const consumed = await f.context.consumeReference({ cwd: f.project, reference: control.reference, entryType: "delegate-control", entryArguments: { operation: "status", skill: "kiro-impl", taskId: "2.3", requestId: "req-a", workDir: "/tmp/project" } });
  assert.equal(consumed?.entryType, "delegate-control");
  assert.equal(Object.hasOwn(consumed, "entryArguments"), false);
  assert.equal((await f.context.current({ cwd: f.project, sessionId: "session-a" })).active, false);
});

test("delegate-control の status と stop は対象手順を返し、現在の管理範囲を変更しない", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await mkdir(join(f.skillsRoot, "kiro-other"));
  await writeFile(join(f.skillsRoot, "kiro-other", "SKILL.md"), "別手順");

  for (const scenario of [
    { label: "非アクティブ", prompt: "", operation: "status", expectedActive: false, expectedScope: null },
    { label: "同じ手順がアクティブ", prompt: "/kiro-impl", operation: "stop", expectedActive: true, expectedScope: "kiro-impl" },
    { label: "別手順がアクティブ", prompt: "/kiro-other", operation: "status", expectedActive: true, expectedScope: "kiro-other" },
  ]) {
    const sessionId = `session-${scenario.label}`;
    const turnId = `turn-${scenario.label}`;
    await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId, turnId, prompt: scenario.prompt });
    const command = `node .agent-hooks/cc-sdd-bootstrap/delegate.mjs ${scenario.operation} --skill kiro-impl --task-id 2.3 --request-id req-${scenario.operation} --work-dir /tmp/project`;
    const prepared = await f.context.trustedPreToolUse(eventFor(f, { sessionId, turnId, toolUseId: `tool-${scenario.label}`, command }));
    assert.ok(prepared?.reference, `${scenario.label}: 制御参照を発行する`);
    const consumed = await f.context.consumeReference({
      cwd: f.project,
      reference: prepared.reference,
      entryType: "delegate-control",
      entryArguments: { operation: scenario.operation, skill: "kiro-impl", taskId: "2.3", requestId: `req-${scenario.operation}`, workDir: "/tmp/project" },
    });
    assert.equal(consumed?.skill, "kiro-impl", `${scenario.label}: 参照が指す対象手順を返す`);
    assert.equal(await f.context.consumeReference({
      cwd: f.project,
      reference: prepared.reference,
      entryType: "delegate-control",
      entryArguments: { operation: scenario.operation, skill: "kiro-impl", taskId: "2.3", requestId: `req-${scenario.operation}`, workDir: "/tmp/project" },
    }), null, `${scenario.label}: 消費済み参照を拒否する`);
    const state = await f.context.current({ cwd: f.project, sessionId });
    assert.equal(state.active, scenario.expectedActive, `${scenario.label}: active を保持する`);
    assert.equal(state.skill, scenario.expectedScope, `${scenario.label}: 管理範囲の手順を保持する`);
  }
});

test("現在の管理手順と一致しない delegate-start は参照を発行しない", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await mkdir(join(f.skillsRoot, "kiro-other"));
  await writeFile(join(f.skillsRoot, "kiro-other", "SKILL.md"), "別手順");
  await f.context.beginTurn({ trusted: true, source: "host", cwd: f.project, sessionId: "session-a", turnId: "turn-a", prompt: "/kiro-impl" });
  const command = "node .agent-hooks/cc-sdd-bootstrap/delegate.mjs start --skill kiro-other --task-id 2.3 --request-id req-a --role manufacture --work-dir /tmp/project --instruction-file /tmp/instruction.md";
  assert.equal(await f.context.trustedPreToolUse(eventFor(f, { command })), null);
});
