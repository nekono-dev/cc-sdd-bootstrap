// 両ツールのフックの統合と取り外しを確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalog, OWNED_MARKER } from "../lib/catalog.mjs";
import { buildCommand, mergeHooks, removeHooks } from "../lib/hooks-merge.mjs";

const file = ".claude/settings.json";
const hooksFor = (tool) => {
  const hooks = catalog.agentHooks.filter((hook) => hook.tools.includes(tool));
  return hooks.length ? hooks : [{ tools: [tool], event: "SessionStart", script: "example.mjs", args: ["start"], matcher: "startup", timeout: 12 }];
};

test("Claude Code のコマンドを組み立てる", () => {
  assert.equal(buildCommand("claude", { script: "x.mjs", args: ["start", "--fast"] }),
    'node "$CLAUDE_PROJECT_DIR/.agent-hooks/cc-sdd-bootstrap/x.mjs" start --fast');
});

test("Codex のコマンドは git の最上位をシェルで求める", () => {
  assert.equal(buildCommand("codex", { script: "x.mjs", args: ["start"] }),
    'node "$(git rev-parse --show-toplevel)/.agent-hooks/cc-sdd-bootstrap/x.mjs" start');
});

for (const tool of ["claude", "codex"]) {
  test(`${tool}: 一式だけの既存設定を更新して hooks の位置を保つ`, () => {
    const owned = `node "$CLAUDE_PROJECT_DIR${OWNED_MARKER}old.mjs"`;
    const input = { before: 1, hooks: { OldEvent: [{ hooks: [{ type: "command", command: owned }] }] }, after: 2 };
    const result = mergeHooks({ file, text: JSON.stringify(input), tool, hooks: hooksFor(tool) });
    assert.equal(result.changed, true);
    assert.deepEqual(Object.keys(JSON.parse(result.text)), ["before", "hooks", "after"]);
  });

  test(`${tool}: 未作成設定で対象フックが0件でも設定文字列を返す`, () => {
    const result = mergeHooks({ file, text: null, tool, hooks: [] });
    assert.equal(typeof result.text, "string");
    assert.equal(result.changed, true);
    assert.deepEqual(JSON.parse(result.text), {});
  });

  test(`${tool}: 混在カタログから対象のフックだけを登録し hooks の位置を保つ`, () => {
    const input = { before: 1, hooks: { SessionStart: [] }, after: 2 };
    const result = mergeHooks({ file, text: JSON.stringify(input), tool, hooks: catalog.agentHooks });
    const output = JSON.parse(result.text);
    assert.deepEqual(Object.keys(output), ["before", "hooks", "after"]);
    const commands = Object.values(output.hooks).flat().flatMap((group) => group.hooks.map((handler) => handler.command));
    const expected = catalog.agentHooks.filter((hook) => hook.tools.includes(tool));
    assert.equal(commands.length, expected.length);
    assert.deepEqual(commands, expected.map((hook) => buildCommand(tool, hook)));
  });
}

for (const tool of ["claude", "codex"]) {
  test(`${tool}: 利用者の設定を保ち、一式を重複なく末尾に統合する`, () => {
    const input = {
      permissions: { allow: ["Bash(ls)"] },
      hooks: {
        SessionStart: [
          { matcher: "startup", custom: true, hooks: [
            { type: "command", command: "echo user" },
            { type: "command", command: `node ${OWNED_MARKER}old.mjs` },
          ] },
          { hooks: [{ type: "command", command: "echo another" }] },
        ],
        RemovedEvent: [{ hooks: [{ type: "command", command: `node ${OWNED_MARKER}gone.mjs` }] }],
        UserEvent: [{ hooks: [{ type: "command", command: "echo kept" }] }],
      },
      ["__proto__"]: { safe: true },
    };
    const result = mergeHooks({ file, text: JSON.stringify(input), tool, hooks: hooksFor(tool) });
    assert.equal(result.changed, true);
    const output = JSON.parse(result.text);
    assert.deepEqual(output.permissions, input.permissions);
    assert.deepEqual(output["__proto__"], { safe: true });
    assert.deepEqual(output.hooks.SessionStart[0], {
      matcher: "startup", custom: true, hooks: [{ type: "command", command: "echo user" }],
    });
    assert.equal(output.hooks.SessionStart[1].hooks[0].command, "echo another");
    const registered = hooksFor(tool);
    for (const hook of registered) {
      const groups = output.hooks[hook.event];
      const group = groups.at(-1);
      assert.equal(group.matcher, hook.matcher);
      assert.equal(group.hooks[0].command, buildCommand(tool, hook));
      assert.equal(group.hooks[0].timeout, hook.timeout);
      assert.equal(groups.filter((g) => g.hooks.some((h) => h.command === buildCommand(tool, hook))).length, 1);
    }
    assert.equal(output.hooks.RemovedEvent, undefined);
    assert.deepEqual(output.hooks.UserEvent, input.hooks.UserEvent);
    const again = mergeHooks({ file, text: result.text, tool, hooks: hooksFor(tool) });
    assert.equal(again.changed, false);
    assert.equal(again.text, result.text);
  });

  test(`${tool}: text が null なら設定を作り、取り外しは一式だけを消す`, () => {
    const merged = mergeHooks({ file, text: null, tool, hooks: hooksFor(tool) });
    assert.equal(typeof merged.text, "string");
    const source = JSON.parse(merged.text);
    source.hooks.SessionStart.unshift({ hooks: [{ type: "command", command: "echo user" }] });
    const removed = removeHooks({ file, text: JSON.stringify(source) });
    assert.equal(removed.changed, true);
    const output = JSON.parse(removed.text);
    assert.deepEqual(output.hooks.SessionStart, [{ hooks: [{ type: "command", command: "echo user" }] }]);
    for (const groups of Object.values(output.hooks)) {
      assert.ok(groups.every((group) => group.hooks.every((hook) => !hook.command?.includes(OWNED_MARKER))));
    }
  });
}

test("読めない JSON と不正な形はファイル名付き HOOKS_UNREADABLE", () => {
  for (const text of ["{", "[]", "{\"hooks\":null}",
    "{\"hooks\":{\"Start\":{}}}", "{\"hooks\":{\"Start\":[{}]}}",
    "{\"hooks\":{\"Start\":[{\"hooks\":{}}]}}"] ) {
    const result = mergeHooks({ file, text, tool: "claude", hooks: hooksFor("claude") });
    assert.equal(result.code, "HOOKS_UNREADABLE", text);
    assert.equal(result.file, file);
    assert.equal(typeof result.detail, "string");
  }
});

test("__proto__ を通常の鍵として扱う", () => {
  const text = '{"__proto__":{"safe":true},"hooks":{"__proto__":[{"hooks":[]}]}}';
  const result = removeHooks({ file, text });
  const output = JSON.parse(result.text);
  assert.equal({}.safe, undefined);
  assert.ok(Object.hasOwn(output, "__proto__"));
});
