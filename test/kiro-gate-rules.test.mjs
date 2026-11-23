import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCommand, skillPath, isExpandedInvocation } from "../.agent-hooks/cc-sdd-bootstrap/kiro-gate-rules.mjs";

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
