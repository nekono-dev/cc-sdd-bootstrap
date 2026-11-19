// cli.mjs の試験: 引数の解析と使い方の表示
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, buildUsage, runCli, formatSuccess, formatAbort, formatApplyFailure, formatReadFailure } from "../lib/cli.mjs";
import { configFields } from "../lib/config-schema.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { catalog, LEDGER_PATH } from "../lib/catalog.mjs";

const parse = (argv) => parseCliArgs(argv, configFields);

test("成功表示は作成・更新・削除と変更の注記を分ける", () => {
  const text = formatSuccess({ operation: "update", plan: { changes: [
    { action: "write", path: "new", note: "restored" },
    { action: "write", path: "old", existed: true, note: "overwritten" }, { action: "delete", path: "gone" },
  ], notices: [] }, defaulted: [], filled: [], unknown: [] });
  assert.match(text, /作成[\s\S]*new.*作り直した/); assert.match(text, /更新[\s\S]*old.*上書きした/); assert.match(text, /削除[\s\S]*gone/);
});
test("既定値・初期導入案内・変更なし・警告と知らせを表示する", () => {
  const text = formatSuccess({ operation: "init", plan: { changes: [], notices: ["残る導入物"] }, defaulted: ["ccSdd.lang"], config: { ccSdd: { lang: "ja" } }, filled: [], unknown: ["future"] });
  for (const s of ["変更はありません", "ccSdd.lang", "ja", "コミット", "次の Claude Code セッション", "#<タグ>", "future", "残る導入物"]) assert.ok(text.includes(s), s);
});
test("中止理由ごとに次の手を表示する", () => {
  const blocks = [{ kind: "modified", path: catalog.files[0].path, detail: "a" }, { kind: "markers", path: "CLAUDE.md", detail: "broken" }, { kind: "settings", path: ".claude/settings.json", detail: "bad" }];
  const update = formatAbort(blocks, "update"), uninstall = formatAbort(blocks, "uninstall");
  assert.match(update, /--force[\s\S]*上書き/); assert.match(uninstall, /--force[\s\S]*削除/);
  for (const s of ["CLAUDE.md", "目印", ".claude/settings.json", "直して"]) assert.ok(uninstall.includes(s), s);
});
test("更新中止はカタログ外のファイルを削除、カタログ内を上書きと案内する", () => {
  const text = formatAbort([{ kind: "modified", path: "outside", detail: "詳細" }, { kind: "modified", path: catalog.files[0].path, detail: "詳細" }], "update", catalog);
  assert.match(text, /outside[\s\S]*削除/);
  assert.match(text, new RegExp(`${catalog.files[0].path}[\\s\\S]*上書き`));
});
test("設定エラーは設定ファイル名・項目・理由・次の手を日本語で示す", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sdd-cli-config-error-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".git"));
  const invoke = async (contents) => {
    fs.writeFileSync(path.join(root, ".cc-sdd-bootstrap.json"), contents);
    const stderr = sink();
    await runCli(["update"], { cwd: root, packageRoot: path.resolve("."), interactive: false, stdout: sink(), stderr });
    return stderr.text();
  };
  await runCli(["init"], { cwd: root, packageRoot: path.resolve("."), interactive: false, stdout: sink(), stderr: sink() });
  const invalid = await invoke('{"format":1,"ccSdd":{"lang":"xxx"}}');
  for (const s of [".cc-sdd-bootstrap.json", "ccSdd.lang", "xx-YY", "直して", "再実行"]) assert.ok(invalid.includes(s), s);
  const unreadable = await invoke("{");
  assert.match(unreadable, /\.cc-sdd-bootstrap\.json[\s\S]*JSON として読めません/);
});

test("不正な設定でも uninstall は警告して設定値を使わず取り除き、update は無変更で失敗する", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sdd-cli-uninstall-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".git"));
  const originals = {
    ".claude/settings.json": '{"permissions":{"allow":["Read"]}}\n',
    ".gitignore": "# 利用者の設定\nnode_modules/\n",
    "CLAUDE.md": "# 利用者の指示\n\n元の文章です。\n",
  };
  for (const [file, contents] of Object.entries(originals)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  }
  const invoke = (args) => {
    const stdout = sink(), stderr = sink();
    return runCli(args, { cwd: root, packageRoot: path.resolve("."), interactive: false, stdout, stderr })
      .then((code) => ({ code, stdout: stdout.text(), stderr: stderr.text() }));
  };
  for (const [contents, reason] of [["{", "JSON として読めません"], ['{"format":1,"ccSdd":{"lang":123}}', "ccSdd.lang"]]) {
    assert.equal((await invoke(["init"])).code, 0);
    fs.writeFileSync(path.join(root, ".cc-sdd-bootstrap.json"), contents);
    const beforeUpdate = new Map([".cc-sdd-bootstrap.json", LEDGER_PATH, ...catalog.files.map((f) => f.path), ".claude/settings.json", ".gitignore", "CLAUDE.md"]
      .map((file) => [file, fs.readFileSync(path.join(root, file))]));
    const update = await invoke(["update"]);
    assert.equal(update.code, 1);
    for (const [file, bytes] of beforeUpdate) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes, file);

    const removed = await invoke(["uninstall"]);
    assert.equal(removed.code, 0, removed.stderr);
    assert.match(removed.stderr, /\.cc-sdd-bootstrap\.json/);
    assert.ok(removed.stderr.includes(reason), removed.stderr);
    for (const file of [".cc-sdd-bootstrap.json", LEDGER_PATH, ...catalog.files.map((f) => f.path)]) {
      assert.equal(fs.existsSync(path.join(root, file)), false, file);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8")), JSON.parse(originals[".claude/settings.json"]));
    for (const file of [".gitignore", "CLAUDE.md"]) assert.equal(fs.readFileSync(path.join(root, file), "utf8"), originals[file]);
  }
});
test("途中失敗は復旧手順と再実行する操作を示す", () => {
  const text = formatApplyFailure({ done: [{ path: ".cc-sdd-bootstrap.json" }], failed: { change: { path: ".claude/settings.json" }, message: "理由" }, pending: [{ path: "later" }] }, "init", false);
  for (const s of ["済んだ", ".cc-sdd-bootstrap.json", "失敗", ".claude/settings.json", "理由", "未処理", "later", "権限", "update"]) assert.ok(text.includes(s), s);
  const init = formatApplyFailure({ done: [], failed: { change: { path: "bad" }, message: "理由" }, pending: [] }, "init", false);
  assert.match(init, /init.*もう一度/);
  const uninstall = formatApplyFailure({ done: [], failed: { change: { path: "bad" }, message: "理由" }, pending: [] }, "uninstall", true);
  assert.match(uninstall, /uninstall.*もう一度/);
});

test("読み取り失敗は道筋と修正後の再実行を案内する", () => {
  const text = formatReadFailure(Object.assign(new Error("EACCES"), { path: ".claude/settings.json" }));
  assert.match(text, /\.claude\/settings\.json/);
  assert.match(text, /確認して直してから、同じ操作をもう一度実行してください/);
});

/** 書き込みを集める擬似の出力 */
function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join("") };
}

test("途中失敗後に uninstall を再実行できる", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sdd-cli-uninstall-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".git"));
  const invoke = (args) => runCli(args, {
    cwd: root,
    packageRoot: path.resolve("."),
    interactive: false,
    stdout: sink(),
    stderr: sink(),
  });
  assert.equal(await invoke(["init"]), 0);

  const targetSettings = path.join(root, ".claude/settings.json");
  const originalRmSync = fs.rmSync;
  fs.rmSync = function (target, options) {
    if (path.resolve(String(target)) === targetSettings) {
      const error = new Error("意図した削除失敗");
      error.code = "EACCES";
      throw error;
    }
    return originalRmSync.call(this, target, options);
  };
  let failed;
  try {
    failed = await invoke(["uninstall"]);
  } finally {
    fs.rmSync = originalRmSync;
  }
  assert.equal(failed, 1);
  assert.equal(fs.existsSync(path.join(root, ".cc-sdd-bootstrap.json")), true);
  assert.equal(fs.existsSync(path.join(root, ".agent-hooks/cc-sdd-bootstrap/installed.json")), true);
  assert.equal(await invoke(["uninstall"]), 0);
  assert.equal(fs.existsSync(path.join(root, ".cc-sdd-bootstrap.json")), false);
  assert.equal(fs.existsSync(path.join(root, ".agent-hooks/cc-sdd-bootstrap/installed.json")), false);
  for (const file of catalog.files) assert.equal(fs.existsSync(path.join(root, file.path)), false, file.path);
});

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

test("init・update・uninstall を対象リポジトリに適用する", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sdd-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".git"));
  const invoke = (args) => runCli(args, { cwd: root, packageRoot: path.resolve("."), interactive: false, stdout: sink(), stderr: sink() });
  assert.equal(await invoke(["init"]), 0);
  assert.ok(fs.existsSync(path.join(root, ".cc-sdd-bootstrap.json")));
  assert.ok(fs.existsSync(path.join(root, LEDGER_PATH)));
  for (const f of catalog.files) assert.ok(fs.existsSync(path.join(root, f.path)));
  for (const f of [".claude/settings.json", ".gitignore", "CLAUDE.md"]) assert.ok(fs.existsSync(path.join(root, f)));
  const before = Object.fromEntries([".cc-sdd-bootstrap.json", LEDGER_PATH, ...catalog.files.map((f) => f.path), ".claude/settings.json", ".gitignore", "CLAUDE.md"].map((f) => [f, fs.readFileSync(path.join(root, f))]));
  assert.equal(await invoke(["update"]), 0);
  for (const [f, contents] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(root, f)), contents);
  assert.equal(await invoke(["update", "--lang", "en"]), 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".cc-sdd-bootstrap.json"))).ccSdd.lang, "en");
  assert.equal(await invoke(["uninstall"]), 0);
  assert.ok(!fs.existsSync(path.join(root, ".cc-sdd-bootstrap.json")));
  assert.ok(!fs.existsSync(path.join(root, LEDGER_PATH)));
  for (const f of catalog.files) assert.ok(!fs.existsSync(path.join(root, f.path)));
});

test("状態の不一致と不正設定は操作を止める", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sdd-cli-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".git"));
  const invoke = (args) => runCli(args, { cwd: root, packageRoot: path.resolve("."), interactive: false, stdout: sink(), stderr: sink() });
  assert.equal(await invoke(["update"]), 1);
  assert.equal(await invoke(["uninstall"]), 1);
  assert.equal(await invoke(["init"]), 0);
  const snapshot = fs.readFileSync(path.join(root, ".cc-sdd-bootstrap.json"));
  assert.equal(await invoke(["init"]), 0);
  assert.deepEqual(fs.readFileSync(path.join(root, ".cc-sdd-bootstrap.json")), snapshot);
  fs.writeFileSync(path.join(root, ".cc-sdd-bootstrap.json"), '{"format":1,"ccSdd":"x"}\n');
  const invalid = fs.readFileSync(path.join(root, ".cc-sdd-bootstrap.json"));
  assert.equal(await invoke(["update"]), 1);
  assert.deepEqual(fs.readFileSync(path.join(root, ".cc-sdd-bootstrap.json")), invalid);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sdd-cli-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.equal(await runCli(["init"], { cwd: outside, packageRoot: path.resolve("."), interactive: false, stdout: sink(), stderr: sink() }), 1);
});

test("導入済みの init は配置物の道筋がディレクトリでも案内して変更しない", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sdd-cli-init-directory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".git"));
  const stdout = sink();
  const stderr = sink();
  const invoke = () => runCli(["init"], { cwd: root, packageRoot: path.resolve("."), interactive: false, stdout, stderr });
  assert.equal(await invoke(), 0);

  const replacedPath = ".agent-hooks/cc-sdd-bootstrap/install-cc-sdd.sh";
  fs.rmSync(path.join(root, replacedPath));
  fs.mkdirSync(path.join(root, replacedPath));
  fs.writeFileSync(path.join(root, replacedPath, "keep.txt"), "そのまま残す\n");
  const before = fs.readFileSync(path.join(root, ".cc-sdd-bootstrap.json"));

  assert.equal(await invoke(), 0);
  assert.match(stdout.text(), /update/);
  assert.equal(stderr.text(), "");
  assert.deepEqual(fs.readFileSync(path.join(root, ".cc-sdd-bootstrap.json")), before);
  assert.equal(fs.readFileSync(path.join(root, replacedPath, "keep.txt"), "utf8"), "そのまま残す\n");
});

test("導入済みの init は設定以外の管理対象がディレクトリでも案内して変更しない", async (t) => {
  for (const replacedPath of [LEDGER_PATH, ".claude/settings.json", ".gitignore", "CLAUDE.md"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sdd-cli-init-managed-directory-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, ".git"));
    const stdout = sink();
    const stderr = sink();
    const invoke = (args) => runCli(args, { cwd: root, packageRoot: path.resolve("."), interactive: false, stdout, stderr });
    assert.equal(await invoke(["init"]), 0);

    const targetPath = path.join(root, replacedPath);
    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.mkdirSync(targetPath, { recursive: true });
    fs.writeFileSync(path.join(targetPath, "keep.txt"), "そのまま残す\n");
    const before = fs.readdirSync(root, { recursive: true, withFileTypes: false }).sort();

    assert.equal(await invoke(["init"]), 0, replacedPath);
    assert.match(stdout.text(), /update/);
    assert.equal(stderr.text(), "");
    assert.deepEqual(fs.readdirSync(root, { recursive: true, withFileTypes: false }).sort(), before);
    assert.equal(fs.readFileSync(path.join(targetPath, "keep.txt"), "utf8"), "そのまま残す\n");
  }
});

test("設定ファイルの道筋がディレクトリなら update と uninstall は理由を示して失敗する", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sdd-cli-config-directory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".git"));
  const stderr = sink();
  const invoke = (args) => runCli(args, { cwd: root, packageRoot: path.resolve("."), interactive: false, stdout: sink(), stderr });
  fs.mkdirSync(path.join(root, ".cc-sdd-bootstrap.json"));

  assert.equal(await invoke(["update"]), 1);
  assert.match(stderr.text(), /設定ファイル.*読めません/);
  assert.equal(await invoke(["uninstall"]), 1);
  assert.match(stderr.text(), /設定ファイル.*読めません/);
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
