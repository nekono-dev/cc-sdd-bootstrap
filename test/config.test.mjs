// 設定の定義と設定の処理（純粋）の単体テスト
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_FORMAT, configFields } from "../lib/config-schema.mjs";
import {
  parseConfig,
  validateConfig,
  findUnknownKeys,
  fillDefaults,
  resolveValues,
  serializeConfig,
} from "../lib/config.mjs";

const full = () => ({
  format: 1,
  ccSdd: { version: "3.1.0", lang: "ja", keepTemplates: false },
  codex: { enabled: false },
  models: {},
});

const field = (path, over = {}) => ({
  path,
  flag: path,
  kind: "map",
  defaultValue: {},
  question: "",
  validate: () => null,
  ...over,
});

test("定義は 5 項目で既定値が設計どおり", () => {
  assert.equal(CONFIG_FORMAT, 1);
  assert.deepEqual(
    configFields.map((f) => [f.path, f.flag, f.kind, f.defaultValue]),
    [
      ["ccSdd.version", "cc-sdd-version", "string", "3.1.0"],
      ["ccSdd.lang", "lang", "string", "ja"],
      ["ccSdd.keepTemplates", "keep-templates", "boolean", false],
      ["codex.enabled", "codex", "boolean", false],
      ["models", "model", "map", {}],
    ],
  );
});

test("parseConfig: 正しい設定を読む", () => {
  const r = parseConfig(JSON.stringify(full()));
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, full());
});

test("parseConfig: JSON でなければ CONFIG_UNREADABLE", () => {
  const r = parseConfig("{oops");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "CONFIG_UNREADABLE");
  assert.ok(r.error.messages.length > 0);
});

test("parseConfig: オブジェクトでなければ CONFIG_INVALID", () => {
  for (const t of ["[]", "1", "null"]) {
    const r = parseConfig(t);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "CONFIG_INVALID");
  }
});

test("parseConfig: format が無いと CONFIG_INVALID", () => {
  const r = parseConfig("{}");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "CONFIG_INVALID");
  assert.match(r.error.messages[0], /^format: /);
});

test("parseConfig: 新しい format は拒否し、導入コマンドの版を上げる案内を出す", () => {
  const r = parseConfig(JSON.stringify({ format: CONFIG_FORMAT + 1 }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "CONFIG_INVALID");
  assert.match(r.error.messages[0], /^format: /);
  assert.match(r.error.messages[0], /cc-sdd-bootstrap/);
});

test("validateConfig: 正しければ null、無い項目は問わない", () => {
  assert.equal(validateConfig(full(), configFields), null);
  assert.equal(validateConfig({ format: 1 }, configFields), null);
});

test("validateConfig: 項目ごとに「項目: 理由」を全て返す", () => {
  const c = full();
  c.ccSdd.version = "v3";
  c.ccSdd.lang = "japanese";
  c.codex.enabled = "yes";
  c.models = { a: "" };
  const e = validateConfig(c, configFields);
  assert.equal(e.code, "CONFIG_INVALID");
  assert.equal(e.messages.length, 4);
  assert.match(e.messages[0], /^ccSdd\.version: /);
  assert.match(e.messages[1], /^ccSdd\.lang: /);
  assert.match(e.messages[2], /^codex\.enabled: /);
  assert.match(e.messages[3], /^models: /);
});

test("validateConfig: 版・言語の形", () => {
  const ok = (v, l) => {
    const c = full();
    c.ccSdd.version = v;
    c.ccSdd.lang = l;
    return validateConfig(c, configFields) === null;
  };
  assert.equal(ok("3.1.0-beta.1", "pt-BR"), true);
  assert.equal(ok("3.1", "ja"), false);
  assert.equal(ok("3.1.0", "JA"), false);
});

test("validateConfig: 新しい format も拒否する", () => {
  const e = validateConfig({ ...full(), format: 2 }, configFields);
  assert.equal(e.code, "CONFIG_INVALID");
  assert.match(e.messages[0], /^format: /);
});

test("findUnknownKeys: 知らない葉の道筋を返す", () => {
  const c = { ...full(), extra: 1, ccSdd: { version: "3.1.0", lang: "ja", x: { y: 1 } } };
  assert.deepEqual(findUnknownKeys(c, configFields).sort(), ["ccSdd.x.y", "extra"]);
});

test("findUnknownKeys: map の下のキーと format は数えない", () => {
  const c = { ...full(), models: { reviewer: "m", other: "n" } };
  assert.deepEqual(findUnknownKeys(c, configFields), []);
});

test("fillDefaults: 無い項目を既定値で補い、補った道筋を返す", () => {
  const r = fillDefaults({ format: 1, ccSdd: { version: "3.0.0" } }, configFields);
  assert.deepEqual(r.config, {
    format: 1,
    ccSdd: { version: "3.0.0", lang: "ja", keepTemplates: false },
    codex: { enabled: false },
    models: {},
  });
  assert.deepEqual(r.filled, ["ccSdd.lang", "ccSdd.keepTemplates", "codex.enabled", "models"]);
});

test("fillDefaults: 既存の値は変えず、完全なら何も補わない", () => {
  const c = full();
  c.ccSdd.lang = "en";
  const r = fillDefaults(c, configFields);
  assert.deepEqual(r.config, c);
  assert.deepEqual(r.filled, []);
});

test("fillDefaults: 入力を書き換えない", () => {
  const c = { format: 1 };
  fillDefaults(c, configFields);
  assert.deepEqual(c, { format: 1 });
});

test("fillDefaults: map は無いキーだけを補い、既存のキーの値は変えない", () => {
  const fields = [field("models", { defaultValue: { b: "y", a: "z" } })];
  const r = fillDefaults({ format: 1, models: { a: "x" } }, fields);
  assert.deepEqual(r.config.models, { a: "x", b: "y" });
  assert.deepEqual(r.filled, ["models.b"]);
});

test("resolveValues: 優先順位は 引数 > 対話 > 既存 > 既定値", () => {
  const base = full();
  base.ccSdd.version = "3.0.0";
  base.ccSdd.lang = "en";
  base.codex.enabled = false;
  const r = resolveValues({
    base,
    given: { "ccSdd.version": "3.2.0" },
    prompted: { "ccSdd.version": "3.3.0", "ccSdd.lang": "fr", "codex.enabled": true },
    fields: configFields,
  });
  assert.equal(r.config.ccSdd.version, "3.2.0");
  assert.equal(r.config.ccSdd.lang, "fr");
  assert.equal(r.config.codex.enabled, true);
  assert.deepEqual(r.defaulted, []);
});

test("resolveValues: base が無ければ既定値で、既定値を使った項目を返す", () => {
  const r = resolveValues({ base: null, given: { "ccSdd.lang": "en" }, prompted: {}, fields: configFields });
  assert.deepEqual(r.config, {
    format: 1,
    ccSdd: { version: "3.1.0", lang: "en", keepTemplates: false },
    codex: { enabled: false },
    models: {},
  });
  assert.deepEqual(r.defaulted, ["ccSdd.version", "ccSdd.keepTemplates", "codex.enabled", "models"]);
});

test("resolveValues: 引数が無い項目の既存の値と、知らない項目を変えない", () => {
  const base = { ...full(), extra: { k: 1 } };
  base.ccSdd.lang = "en";
  const r = resolveValues({ base, given: {}, prompted: {}, fields: configFields });
  assert.deepEqual(r.config, base);
  assert.deepEqual(r.defaulted, []);
});

test("resolveValues: map はキーごとに重ね、既存の他のキーを残す", () => {
  const base = { ...full(), models: { a: "x", b: "y" } };
  const r = resolveValues({
    base,
    given: { models: { a: "g" } },
    prompted: { models: { a: "p", c: "q" } },
    fields: configFields,
  });
  assert.deepEqual(r.config.models, { a: "g", b: "y", c: "q" });
});

test("resolveValues: map の既定値のキーのうち無いものだけを補う", () => {
  const fields = [field("models", { defaultValue: { b: "d" } })];
  const r = resolveValues({ base: { format: 1, models: { a: "x" } }, given: {}, prompted: {}, fields });
  assert.deepEqual(r.config.models, { a: "x", b: "d" });
  assert.deepEqual(r.defaulted, ["models.b"]);
});

test("serializeConfig: 2 文字の字下げで末尾に改行", () => {
  const s = serializeConfig({ format: 1, codex: { enabled: false } });
  assert.equal(s, '{\n  "format": 1,\n  "codex": {\n    "enabled": false\n  }\n}\n');
});

test("validateConfig: 親が普通のオブジェクトでないと「項目: 理由」を返す", () => {
  for (const [c, head] of [
    [{ format: 1, ccSdd: "x" }, "ccSdd"],
    [{ format: 1, codex: true }, "codex"],
    [{ format: 1, models: "x" }, "models"],
    [{ format: 1, models: [] }, "models"],
  ]) {
    const e = validateConfig(c, configFields);
    assert.equal(e?.code, "CONFIG_INVALID", JSON.stringify(c));
    assert.ok(e.messages.some((m) => m.startsWith(`${head}: `)), JSON.stringify(c));
  }
});

test("fillDefaults: オブジェクトでない親や map を上書きしない", () => {
  for (const c of [
    { format: 1, ccSdd: "x" },
    { format: 1, codex: true },
    { format: 1, models: "x" },
    { format: 1, models: [] },
  ]) {
    const r = fillDefaults(c, configFields);
    for (const k of Object.keys(c)) assert.deepEqual(r.config[k], c[k]);
  }
});

test("resolveValues: オブジェクトでない親や map を上書きしない", () => {
  for (const c of [
    { format: 1, ccSdd: "x" },
    { format: 1, codex: true },
    { format: 1, models: "x" },
    { format: 1, models: [] },
  ]) {
    const r = resolveValues({
      base: c,
      given: { "ccSdd.lang": "en", "codex.enabled": true, models: { a: "m" } },
      prompted: {},
      fields: configFields,
    });
    for (const k of Object.keys(c)) assert.deepEqual(r.config[k], c[k]);
  }
});

test("validateConfig: map の危険なキー（__proto__ など）を拒否する", () => {
  const p = parseConfig('{"format":1,"models":{"__proto__":"x"}}');
  assert.equal(p.ok, true);
  const e = validateConfig(p.config, configFields);
  assert.equal(e?.code, "CONFIG_INVALID");
  assert.ok(e.messages.some((m) => m.startsWith("models: ")));
});

test("map の統合で __proto__ キーが prototype を変えない", () => {
  const given = JSON.parse('{"models":{"__proto__":{"polluted":"1"}}}');
  const r = resolveValues({ base: null, given, prompted: {}, fields: configFields });
  assert.equal(Object.getPrototypeOf(r.config.models), Object.prototype);
  assert.equal(r.config.models.polluted, undefined);
  assert.equal({}.polluted, undefined);
});

test("validateConfig: format が整数でない・0 は拒否", () => {
  for (const f of [1.5, 0, "1", -1]) {
    const e = validateConfig({ format: f }, configFields);
    assert.equal(e?.code, "CONFIG_INVALID");
    assert.match(e.messages[0], /^format: /);
  }
});
