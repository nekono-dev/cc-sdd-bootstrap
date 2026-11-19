// cli.mjs の試験: 引数の解析と使い方の表示
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, buildUsage, runCli } from "../lib/cli.mjs";
import { configFields } from "../lib/config-schema.mjs";

const parse = (argv) => parseCliArgs(argv, configFields);

/** 書き込みを集める擬似の出力 */
function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join("") };
}

test("init に全ての指定を正しい型で渡せる", () => {
  const r = parse(["init", "--cc-sdd-version", "3.2.0", "--lang", "en", "--codex", "YES", "--model", "impl=opus", "--force"]);
  assert.deepEqual(r, {
    kind: "run",
    operation: "init",
    given: { "ccSdd.version": "3.2.0", "ccSdd.lang": "en", "codex.enabled": true, models: { impl: "opus" } },
    force: true,
  });
});

test("真偽は yes/no/true/false を受け付ける", () => {
  for (const [v, exp] of [["yes", true], ["no", false], ["true", true], ["False", false]]) {
    assert.equal(parse(["init", "--codex", v]).given["codex.enabled"], exp);
  }
});

test("update で --model を 2 回指定できる", () => {
  const r = parse(["update", "--model", "impl=opus", "--model", "review=sonnet"]);
  assert.equal(r.kind, "run");
  assert.deepEqual(r.given.models, { impl: "opus", review: "sonnet" });
  assert.equal(r.force, false);
});

test("--force は 3 つの操作すべてで受け付ける", () => {
  for (const op of ["init", "update", "uninstall"]) {
    const r = parse([op, "--force"]);
    assert.equal(r.kind, "run");
    assert.equal(r.operation, op);
    assert.equal(r.force, true);
    assert.deepEqual(r.given, {});
  }
});

test("操作なし・--help・-h は使い方", () => {
  assert.deepEqual(parse([]), { kind: "help" });
  assert.deepEqual(parse(["--help"]), { kind: "help" });
  assert.deepEqual(parse(["-h"]), { kind: "help" });
  assert.deepEqual(parse(["init", "--help"]), { kind: "help" });
  assert.deepEqual(parse(["bogus", "-h"]), { kind: "help" });
});

test("未知の操作・未知の指定・余分な引数は使い方の誤り", () => {
  for (const argv of [["bogus"], ["init", "--bogus"], ["init", "extra"], ["init", "--lang"]]) {
    const r = parse(argv);
    assert.equal(r.kind, "usage-error", argv.join(" "));
    assert.ok(r.message.length > 0);
  }
  assert.match(parse(["bogus"]).message, /bogus/);
  assert.match(parse(["init", "--bogus"]).message, /--bogus/);
});

test("uninstall に設定の指定を渡すと使い方の誤り", () => {
  const r = parse(["uninstall", "--lang", "ja"]);
  assert.equal(r.kind, "usage-error");
  assert.match(r.message, /--lang/);
});

test("真偽の値の誤りは使い方の誤り", () => {
  const r = parse(["init", "--codex", "maybe"]);
  assert.equal(r.kind, "usage-error");
  assert.match(r.message, /maybe/);
});

test("--model の形の誤りは使い方の誤り", () => {
  for (const v of ["impl", "=opus", "impl=", "__proto__=x", "constructor=x", "prototype=x"]) {
    assert.equal(parse(["init", "--model", v]).kind, "usage-error", v);
  }
});

test("使い方は設定の定義から作られる", () => {
  const u = buildUsage(configFields);
  for (const f of configFields) {
    assert.ok(u.includes(`--${f.flag}`), f.flag);
    assert.ok(u.includes(f.question), f.flag);
  }
  for (const w of ["init", "update", "uninstall", "--force", "--help"]) assert.ok(u.includes(w), w);
});

test("runCli の終了コード: 使い方は 0、誤りは 2", async () => {
  const out = sink(), err = sink();
  assert.equal(await runCli(["--help"], { stdout: out, stderr: err }), 0);
  assert.match(out.text(), /使い方/);
  assert.equal(err.text(), "");

  const out2 = sink(), err2 = sink();
  assert.equal(await runCli(["bogus"], { stdout: out2, stderr: err2 }), 2);
  assert.match(err2.text(), /bogus/);
  assert.match(err2.text(), /使い方/);
  assert.equal(out2.text(), "");
});
