import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateNativeAgentDefinitions,
  verifyNativeAgentDefinition,
} from "../.agent-hooks/cc-sdd-bootstrap/native-agent-definitions.mjs";

test("Claude・Codex の予約定義を決定的に生成し、内容の改変を検出する", () => {
  for (const client of ["claude", "codex"]) {
    const definitions = generateNativeAgentDefinitions({}, client);
    assert.deepEqual(definitions, generateNativeAgentDefinitions({}, client));
    assert.ok(definitions.length > 0);
    for (const definition of definitions) {
      assert.equal(verifyNativeAgentDefinition({}, client, definition.relativePath, definition.content), true);
      assert.equal(verifyNativeAgentDefinition({}, client, definition.relativePath, `${definition.content}\nchanged`), false);
      assert.equal(verifyNativeAgentDefinition({}, client, `other/${definition.relativePath}`, definition.content), false);
    }
  }
});

test("Claude の読み取り専用定義は許可する読み取りツールだけを列挙する", () => {
  const defs = generateNativeAgentDefinitions({}, "claude");
  const review = defs.find(({ relativePath }) => relativePath.endsWith("cc-sdd-review.md"));
  const design = defs.find(({ relativePath }) => relativePath.endsWith("cc-sdd-design-read-only.md"));
  for (const { content } of [review, design]) {
    assert.match(content, /tools: Read, Glob, Grep/);
    assert.doesNotMatch(content, /\b(Edit|Write|Bash)\b/);
  }
  assert.ok(defs.some(({ relativePath }) => relativePath.endsWith("cc-sdd-design.md")));
});

test("Codex はモデルと推論量を TOML に安全に直列化し、サンドボックスを権限根拠にしない", () => {
  const model = 'quote" slash\\ DEL\u007f tab\t line\n snowman ☃';
  const settings = { subagents: { codexModels: { review: model } } };
  const definition = generateNativeAgentDefinitions(settings, "codex")
    .find(({ relativePath }) => relativePath.endsWith("cc_sdd_review.toml"));
  assert.ok(definition.content.startsWith(`name = "cc_sdd_review"\ndescription = `));
  assert.ok(definition.content.includes('\nmodel = "quote\\" slash\\\\ DEL\\u007f tab\\t line\\n snowman ☃"\n'));
  assert.equal(definition.content.match(/^model = /gm).length, 1);
  assert.match(definition.content, /model_reasoning_effort = "medium"/);
  assert.doesNotMatch(definition.content, /sandbox_mode|workspace-write/);
  assert.ok(generateNativeAgentDefinitions({}, "codex").some(({ relativePath }) => relativePath.endsWith("cc_sdd_design_read_only.toml")));
  assert.equal(verifyNativeAgentDefinition(settings, "codex", definition.relativePath, definition.content), true);
});

test("Codex は不正な Unicode のモデルを役割・項目・クライアント付きで拒否する", () => {
  for (const model of ["bad\uD800", "bad\uDC00"]) {
    assert.throws(
      () => generateNativeAgentDefinitions({ subagents: { codexModels: { review: model } } }, "codex"),
      /Codex.*review.*model.*Unicode/,
    );
  }
});

test("Claude の悪意あるモデル文字列も frontmatter を脱出できない", () => {
  const settings = { subagents: { claudeModels: { review: 'x"\nname: injected' } } };
  const definition = generateNativeAgentDefinitions(settings, "claude")
    .find(({ relativePath }) => relativePath.endsWith("cc-sdd-review.md"));
  assert.match(definition.content, /model: "x\\"\\nname: injected"/);
  assert.equal(verifyNativeAgentDefinition(settings, "claude", definition.relativePath, definition.content), true);
});
