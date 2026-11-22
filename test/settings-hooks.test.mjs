// フックの登録の統合（純粋）の単体テスト
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalog, CODEX_OWNED_MARKER, OWNED_MARKER } from "../lib/catalog.mjs";
import { mergeHooks } from "../lib/settings-hooks.mjs";

const hooks = catalog.hooks;
const merge = (text, h = hooks, ownership = "claude") => mergeHooks({ text, hooks: h, ownership });
const own = (name) => `"$CLAUDE_PROJECT_DIR${OWNED_MARKER}${name}"`;

test("text が null なら新しいファイルの中身を作る（6.1）", () => {
  const r = merge(null);
  assert.equal(r.changed, true);
  const j = JSON.parse(r.text);
  assert.deepEqual(j.hooks.SessionStart, [
    { hooks: [{ type: "command", command: hooks[0].command, timeout: 600 }] },
    { hooks: [{ type: "command", command: hooks[2].command, timeout: 10 }] },
  ]);
  assert.equal(j.hooks.UserPromptSubmit[0].hooks[0].command, hooks[1].command);
  assert.ok(r.text.endsWith("}\n"));
  assert.ok(r.text.includes('\n  "hooks"'));
});

test("matcher と timeout は定義があるときだけ入る", () => {
  const r = merge(null, [
    { event: "PreToolUse", matcher: "Bash", command: own("a.sh") },
  ]);
  assert.deepEqual(JSON.parse(r.text).hooks.PreToolUse, [
    { matcher: "Bash", hooks: [{ type: "command", command: own("a.sh") }] },
  ]);
});

test("利用者のフック・permissions・プラグインを残し、鍵の順も保つ（6.2）", () => {
  const src = {
    permissions: { allow: ["Bash(ls)"] },
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "echo user" }] }],
      Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
    },
    enabledPlugins: { "a@b": true },
    extraKnownMarketplaces: { x: { source: "y" } },
  };
  const r = merge(JSON.stringify(src));
  const j = JSON.parse(r.text);
  assert.deepEqual(Object.keys(j), ["permissions", "hooks", "enabledPlugins", "extraKnownMarketplaces"]);
  assert.deepEqual(j.permissions, src.permissions);
  assert.deepEqual(j.enabledPlugins, src.enabledPlugins);
  assert.equal(j.hooks.Stop.length, 2);
  assert.deepEqual(j.hooks.Stop[0], src.hooks.Stop[0]);
  assert.equal(j.hooks.Stop[1].hooks[0].command, hooks.find((h) => h.event === "Stop").command);
  assert.equal(j.hooks.SessionStart.length, 3);
  assert.equal(j.hooks.SessionStart[0].hooks[0].command, "echo user");
  assert.equal(j.hooks.SessionStart[1].hooks[0].command, hooks[0].command);
});

test("前の版の一式のフックを置き換え、重複させない（6.3）", () => {
  const src = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: own("old.sh"), timeout: 1 }] },
        { hooks: [{ type: "command", command: "echo user" }] },
      ],
      PreToolUse: [{ hooks: [{ type: "command", command: own("gone.sh") }] }],
    },
  };
  const j = JSON.parse(merge(JSON.stringify(src)).text);
  const preToolUse = hooks.filter((h) => h.event === "PreToolUse");
  assert.equal(j.hooks.PreToolUse.length, preToolUse.length);
  assert.deepEqual(j.hooks.PreToolUse.map((group) => group.hooks[0].command), preToolUse.map((h) => h.command));
  assert.equal(j.hooks.SessionStart.length, 3);
  assert.equal(j.hooks.SessionStart[0].hooks[0].command, "echo user");
  assert.equal(j.hooks.SessionStart[1].hooks[0].command, hooks[0].command);
  assert.equal(JSON.stringify(j).split(OWNED_MARKER).length - 1, hooks.length);
});

test("Codex は正確な管理サフィックスがある登録だけを置き換える（6.6, 6.7, 6.8, 6.9, 9.2）", () => {
  const native = `node \"$repo_root${OWNED_MARKER}install-gate.mjs\" user-prompt-submit`;
  const oldManaged = `${native} ${CODEX_OWNED_MARKER}`;
  const codexHooks = [
    { event: "Stop", command: `node \"$repo_root${OWNED_MARKER}install-gate.mjs\" stop ${CODEX_OWNED_MARKER}` },
  ];
  const src = {
    version: 1,
    hooks: {
      Stop: [
        { matcher: "native", hooks: [{ type: "command", command: native }] },
        { matcher: "marker-only-user", hooks: [{ type: "command", command: `echo user ${CODEX_OWNED_MARKER}` }] },
        { matcher: "path-without-marker", hooks: [{ type: "command", command: `node \"$repo_root${OWNED_MARKER}user-script.mjs\"` }] },
        { matcher: "managed", hooks: [{ type: "command", command: oldManaged }] },
      ],
      Other: [{ hooks: [{ type: "mcp", server: "user-server" }] }],
    },
    extra: { preserve: true },
  };
  const first = merge(JSON.stringify(src), codexHooks, "codex");
  assert.equal(first.changed, true);
  const json = JSON.parse(first.text);
  assert.equal(json.version, 1);
  assert.deepEqual(json.extra, { preserve: true });
  assert.deepEqual(json.hooks.Other, src.hooks.Other);
  assert.equal(json.hooks.Stop.length, 4);
  assert.deepEqual(json.hooks.Stop[0], src.hooks.Stop[0]);
  assert.deepEqual(json.hooks.Stop[1], src.hooks.Stop[1]);
  assert.deepEqual(json.hooks.Stop[2], src.hooks.Stop[2]);
  assert.equal(json.hooks.Stop[3].hooks[0].command, codexHooks[0].command);

  const second = merge(first.text, codexHooks, "codex");
  assert.deepEqual(second, { text: first.text, changed: false });
  const removed = merge(first.text, [], "codex");
  const removedJson = JSON.parse(removed.text);
  assert.deepEqual(removedJson.hooks.Stop, src.hooks.Stop.slice(0, 3));
  assert.deepEqual(removedJson.hooks.Other, src.hooks.Other);
});

test("2 回続けても同じ内容で、2 回目は changed:false（6.4）", () => {
  const first = merge('{"permissions":{"allow":[]}}');
  assert.equal(first.changed, true);
  const second = merge(first.text);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test("変更が無いときは元の文字列をそのまま返す（整形が違っても）", () => {
  const first = merge(null);
  const reformatted = JSON.stringify(JSON.parse(first.text));
  const r = merge(reformatted);
  assert.equal(r.changed, false);
  assert.equal(r.text, reformatted);
});

test("hooks: [] は一式のものだけを取り除く", () => {
  const first = merge('{"permissions":{"a":1},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo s"}]}]}}');
  const r = merge(first.text, []);
  assert.equal(r.changed, true);
  const j = JSON.parse(r.text);
  assert.deepEqual(j, {
    permissions: { a: 1 },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo s" }] }] },
  });
});

test("取り除いた結果が空の {} なら text は null（ファイルを消す）", () => {
  const first = merge(null);
  const r = merge(first.text, []);
  assert.deepEqual(r, { text: null, changed: true });
});

test("元が無く hooks も空なら text null・changed:false", () => {
  assert.deepEqual(merge(null, []), { text: null, changed: false });
});

test("元が {} で hooks も空なら元のまま変更なし", () => {
  assert.deepEqual(merge("{}", []), { text: "{}", changed: false });
});

test("取り除いて空になったものだけ消し、元から空の利用者の組は残す", () => {
  const src = {
    hooks: {
      Empty: [],
      Mixed: [
        { hooks: [] },
        { hooks: [{ type: "command", command: own("x") }] },
      ],
    },
    other: 1,
  };
  const j = JSON.parse(merge(JSON.stringify(src), []).text);
  assert.deepEqual(j, { hooks: { Empty: [], Mixed: [{ hooks: [] }] }, other: 1 });
});

test("hooks が空になったら hooks の鍵を消す", () => {
  const src = { a: 1, hooks: { SessionStart: [{ hooks: [{ type: "command", command: own("x") }] }] } };
  const j = JSON.parse(merge(JSON.stringify(src), []).text);
  assert.deepEqual(j, { a: 1 });
});

test("利用者と一式が混ざった組では利用者のものを残す", () => {
  const src = {
    hooks: {
      SessionStart: [
        {
          matcher: "startup",
          hooks: [
            { type: "command", command: "echo user" },
            { type: "command", command: own("old") },
          ],
        },
      ],
    },
  };
  const j = JSON.parse(merge(JSON.stringify(src)).text);
  assert.deepEqual(j.hooks.SessionStart[0], {
    matcher: "startup",
    hooks: [{ type: "command", command: "echo user" }],
  });
  assert.equal(j.hooks.SessionStart[1].hooks[0].command, hooks[0].command);
});

test("読めない形式は SETTINGS_UNREADABLE（6.5）", () => {
  const bad = [
    "{",
    "",
    "[]",
    "null",
    '"x"',
    "1",
    '{"hooks":[]}',
    '{"hooks":null}',
    '{"hooks":"x"}',
    '{"hooks":{"SessionStart":{}}}',
    '{"hooks":{"SessionStart":["x"]}}',
    '{"hooks":{"SessionStart":[null]}}',
    '{"hooks":{"SessionStart":[[]]}}',
    '{"hooks":{"SessionStart":[{}]}}',
    '{"hooks":{"SessionStart":[{"hooks":{}}]}}',
  ];
  for (const t of bad) {
    const r = merge(t);
    assert.equal(r.code, "SETTINGS_UNREADABLE", `入力: ${t}`);
    assert.equal(typeof r.detail, "string");
    assert.ok(r.detail.length > 0);
  }
});

test("__proto__ の鍵があっても prototype を書き換えない", () => {
  const src = '{"__proto__":{"polluted":true},"hooks":{"__proto__":[{"hooks":[]}]}}';
  const r = merge(src);
  assert.equal(r.changed, true);
  assert.equal({}.polluted, undefined);
  const j = JSON.parse(r.text);
  assert.ok(Object.hasOwn(j, "__proto__"));
  assert.deepEqual(Object.getPrototypeOf(j), Object.prototype);
  assert.equal(Object.getPrototypeOf(j.hooks), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(j.hooks, "__proto__").value, [{ hooks: [] }]);
});
