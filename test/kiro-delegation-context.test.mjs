import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKiroDelegationContext } from "../.agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs";

async function fixture(client = "codex", options = {}) {
  const base = await mkdtemp(join(tmpdir(), "kiro-context-"));
  const project = join(base, "project"), runtimeRoot = join(base, "runtime"), writableRoot = join(base, "delegated-write"), skillsRoot = join(base, "skills");
  await Promise.all([mkdir(project), mkdir(writableRoot), mkdir(skillsRoot)]);
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
