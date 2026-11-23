import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCommand, skillPath, isExpandedInvocation, decidePreToolUse, isReadCommand, isSkillRead, messageDeny } from "../.agent-hooks/cc-sdd-bootstrap/kiro-gate-rules.mjs";
import path from "node:path";

test("先頭の kiro コマンドと記号を取り出す", () => {
  assert.deepEqual(detectCommand("/kiro-spec-init x"), { skill: "kiro-spec-init", sigil: "/" });
  assert.deepEqual(detectCommand("  $kiro-impl"), { skill: "kiro-impl", sigil: "$" });
  assert.deepEqual(detectCommand("/kiro-steering"), { skill: "kiro-steering", sigil: "/" });
});

test("直後が空白か末尾でない場合や文中の言及は対象にしない", () => {
  assert.equal(detectCommand("/kiro-spec-init:"), null);
  assert.equal(detectCommand("文中の /kiro-impl"), null);
});

test("名前は kiro- に続く英小文字・数字・ハイフンで取り出す", () => {
  assert.deepEqual(detectCommand("/kiro-specx"), { skill: "kiro-specx", sigil: "/" });
});

test("ツールごとの手順書の場所を返す", () => {
  assert.equal(skillPath("claude", "kiro-impl"), ".claude/skills/kiro-impl/SKILL.md");
  assert.equal(skillPath("codex", "kiro-impl"), ".agents/skills/kiro-impl/SKILL.md");
});

test("本文が渡る形で一覧にあるスキルだけを読み取り済みとする", () => {
  const listed = ["kiro-x"];
  assert.equal(isExpandedInvocation("claude", "/", "kiro-x", listed), true);
  assert.equal(isExpandedInvocation("codex", "$", "kiro-x", listed), true);
  assert.equal(isExpandedInvocation("codex", "/", "kiro-x", listed), false);
  assert.equal(isExpandedInvocation("claude", "$", "kiro-x", listed), false);
  assert.equal(isExpandedInvocation("claude", "/", "kiro-y", listed), false);
});

test("未読の Claude Code では対象の Read と ToolSearch だけを通す", () => {
  const root = "/repo";
  const state = { skill: "kiro-x", skillPath: ".claude/skills/kiro-x/SKILL.md", read: false, stopBlocked: false };
  assert.deepEqual(decidePreToolUse(state, { toolName: "Read", toolInput: { file_path: "/repo/.claude/skills/kiro-x/SKILL.md" } }, root), { allow: true });
  assert.deepEqual(decidePreToolUse(state, { toolName: "ToolSearch", toolInput: {} }, root), { allow: true });
  for (const call of [
    { toolName: "Bash", toolInput: { command: "cat x" } },
    { toolName: "Edit", toolInput: { file_path: "/repo/x" } },
    { toolName: "Read", toolInput: { file_path: "/repo/other.md" } },
    { toolName: "Agent", toolInput: {} },
  ]) {
    const result = decidePreToolUse(state, call, root);
    assert.equal(result.allow, false);
    assert.match(result.reason, /\.claude\/skills\/kiro-x\/SKILL\.md/);
    assert.match(result.reason, /先に/);
  }
});

test("Codex は cwd から対象の手順書を読む cat・head・nl だけを通す", () => {
  const root = "/repo";
  const cwd = "/repo";
  const relative = ".agents/skills/kiro-x/SKILL.md";
  const absolute = path.join(root, relative);
  const state = { skill: "kiro-x", skillPath: relative, read: false, stopBlocked: false };
  for (const command of [`cat ${relative}`, `cat ${absolute}`, `head -n 2 ${relative}`, `nl ${relative}`, `cat ${relative} && ls`]) {
    assert.equal(isReadCommand(command, cwd, absolute), true, command);
    assert.deepEqual(decidePreToolUse(state, { toolName: "Bash", toolInput: { command } }, root, cwd), { allow: true });
  }
  for (const command of [
    `ls ${relative}`, `sed -i '1d' ${relative}`, `cat ${relative}`,
    "cat .agents/skills/kiro-x/SKILL.md", "ls", "echo hello",
  ]) {
    const otherCwd = command === `cat ${relative}` ? "/another-repo" : cwd;
    const result = decidePreToolUse(state, { toolName: "Bash", toolInput: { command } }, root, otherCwd);
    assert.equal(result.allow, false, command);
    assert.match(result.reason, /\.agents\/skills\/kiro-x\/SKILL\.md/);
  }
  assert.equal(isReadCommand(`sed -i '1d' ${relative}`, cwd, absolute), false);
});

test("対象なし・読み取り済みは通し、拒否理由には先読みの案内を含める", () => {
  const call = { toolName: "Edit", toolInput: {} };
  assert.deepEqual(decidePreToolUse(null, call, "/repo"), { allow: true });
  const readState = { skill: "kiro-x", skillPath: ".agents/skills/kiro-x/SKILL.md", read: true, stopBlocked: false };
  assert.deepEqual(decidePreToolUse(readState, call, "/repo"), { allow: true });
  assert.match(messageDeny(readState), /\.agents\/skills\/kiro-x\/SKILL\.md/);
  assert.match(messageDeny(readState), /先に/);
});

test("対象の読み取り応答に最初の行がある場合だけ読み取り済みとする", () => {
  const root = "/repo";
  const relative = ".agents/skills/kiro-x/SKILL.md";
  const state = { skill: "kiro-x", skillPath: relative, read: false, stopBlocked: false };
  const firstLine = "# 手順書";
  const bash = { toolName: "Bash", toolInput: { command: `cat ${relative}` }, toolResponse: `${firstLine}\n本文` };
  assert.equal(isSkillRead(state, bash, firstLine, root, root), true);
  assert.equal(isSkillRead(state, { ...bash, toolResponse: `cat: ${relative}: No such file or directory` }, firstLine, root, root), false);
  assert.equal(isSkillRead(state, { ...bash, toolName: "ToolSearch", toolInput: {}, toolResponse: firstLine }, firstLine, root, root), false);
  const claudeState = { ...state, skillPath: ".claude/skills/kiro-x/SKILL.md" };
  const claude = { toolName: "Read", toolInput: { file_path: `${root}/.claude/skills/kiro-x/SKILL.md` }, toolResponse: { content: firstLine } };
  assert.equal(isSkillRead(claudeState, claude, firstLine, root), true);
});
