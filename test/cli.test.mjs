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

// ---- promptValues（対話） ----
import { PassThrough } from "node:stream";
import { promptValues } from "../lib/cli.mjs";

/** 入力の行を流し込む擬似の入出力 */
function fakeIo(lines) {
  const stdin = new PassThrough();
  stdin.end(lines.map((l) => l + "\n").join(""));
  const stdout = sink();
  return { stdin, stdout, stderr: sink(), interactive: true };
}

const strField = {
  path: "a.b", flag: "x", kind: "string", defaultValue: "dflt", question: "質問A",
  validate: (v) => (v === "bad" ? "不正な値です" : null),
};
const boolField = {
  path: "flag", flag: "f", kind: "boolean", defaultValue: false, question: "質問B",
  validate: (v) => (typeof v === "boolean" ? null : "真偽で指定してください"),
};
const mapField = (mapKeys) => ({
  path: "models", flag: "m", kind: "map", defaultValue: { impl: "opus" }, question: "質問M", mapKeys,
  validate: (v) => (Object.values(v).some((s) => s.trim() === "") ? "空にできません" : null),
});

test("空の入力は既定値を採用し、既定値を示す", async () => {
  const io = fakeIo([""]);
  const r = await promptValues(io, [strField], {}, {});
  assert.deepEqual(r, { "a.b": "dflt" });
  assert.match(io.stdout.text(), /質問A \[dflt\]: /);
});

test("設定ファイルの既存の値を既定として示す", async () => {
  const io = fakeIo([""]);
  const r = await promptValues(io, [strField], { a: { b: "old" } }, {});
  assert.deepEqual(r, { "a.b": "old" });
  assert.match(io.stdout.text(), /\[old\]/);
});

test("不正な値は理由を示して尋ね直す", async () => {
  const io = fakeIo(["bad", "good"]);
  const r = await promptValues(io, [strField], {}, {});
  assert.deepEqual(r, { "a.b": "good" });
  assert.match(io.stdout.text(), /不正な値です/);
});

test("引数で渡した項目は尋ねない", async () => {
  const io = fakeIo([""]);
  const r = await promptValues(io, [strField, boolField], {}, { "a.b": "given" });
  assert.deepEqual(r, { flag: false });
  assert.doesNotMatch(io.stdout.text(), /質問A/);
});

test("真偽は yes/no/true/false/y/n を受け付け、既定を yes/no で示す", async () => {
  for (const [input, exp] of [["YES", true], ["n", false], ["True", true], ["no", false], ["y", true]]) {
    const io = fakeIo([input]);
    assert.deepEqual(await promptValues(io, [boolField], {}, {}), { flag: exp });
    assert.match(io.stdout.text(), /質問B \[no\]: /);
  }
  const io = fakeIo(["maybe", "yes"]);
  assert.deepEqual(await promptValues(io, [boolField], {}, {}), { flag: true });
  assert.match(io.stdout.text(), /yes・no/);
});

test("対応の項目は mapKeys のキーごとに尋ねる", async () => {
  const io = fakeIo(["", "sonnet"]);
  const r = await promptValues(io, [mapField(["impl", "review"])], {}, {});
  assert.deepEqual(r, { models: { impl: "opus", review: "sonnet" } });
  assert.match(io.stdout.text(), /impl/);
  assert.match(io.stdout.text(), /\[opus\]/);
});

test("mapKeys が空なら何も尋ねない", async () => {
  const io = fakeIo([]);
  const r = await promptValues(io, [mapField([])], {}, {});
  assert.deepEqual(r, {});
  assert.equal(io.stdout.text(), "");
});

test("入力が尽きたとき、既定値が正しければ既定値を返す", async () => {
  const io = fakeIo([]);
  const r = await promptValues(io, [strField, boolField], {}, {});
  assert.deepEqual(r, { "a.b": "dflt", flag: false });
});

test("入力が尽きたとき、既存の値が不正なら止まって失敗する", async () => {
  const io = fakeIo([]);
  const verField = { ...strField, validate: (v) => (v === "bad" ? "不正な値です" : null) };
  await assert.rejects(promptValues(io, [verField], { a: { b: "bad" } }, {}), /入力が終わりました/);
});

test("入力が尽きたとき、既定のない map のキーは止まって失敗する", async () => {
  const io = fakeIo([]);
  await assert.rejects(promptValues(io, [mapField(["review"])], {}, {}), /入力が終わりました/);
});
