import { readInstallConfig, parseState, buildState, isFingerprintTarget } from "../.agent-hooks/cc-sdd-bootstrap/install-rules.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const base = { format: 1, ccSdd: { version: "3.1.0", lang: "ja" } };
const ok = (obj) => readInstallConfig(JSON.stringify(obj));

test("有効な設定を読み、keepTemplates が無ければ false にする", () => {
  const r = ok(base);
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, { version: "3.1.0", lang: "ja", keepTemplates: false });
});

test("keepTemplates が true の設定を読む", () => {
  const r = ok({ ...base, ccSdd: { ...base.ccSdd, keepTemplates: true } });
  assert.equal(r.ok, true);
  assert.equal(r.config.keepTemplates, true);
});

test("設定ファイルが無いときは理由にファイル名と init を含める", () => {
  const r = readInstallConfig(null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /\.cc-sdd-bootstrap\.json/);
  assert.match(r.reason, /init/);
});

test("壊れた JSON は理由にファイル名・JSON・update を含める", () => {
  const r = readInstallConfig("{");
  assert.equal(r.ok, false);
  assert.match(r.reason, /\.cc-sdd-bootstrap\.json/);
  assert.match(r.reason, /JSON/);
  assert.match(r.reason, /update/);
});

test("オブジェクトでない JSON（配列・null）は失敗にする", () => {
  const r1 = readInstallConfig("[]");
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /\.cc-sdd-bootstrap\.json/);
  const r2 = readInstallConfig("null");
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /\.cc-sdd-bootstrap\.json/);
});

test("format が無いときは理由に format とファイル名を含める", () => {
  const r = ok({ ccSdd: base.ccSdd });
  assert.equal(r.ok, false);
  assert.match(r.reason, /format/);
  assert.match(r.reason, /\.cc-sdd-bootstrap\.json/);
});

test("format が新しすぎるときは理由に format と update を含める", () => {
  const r = ok({ format: 99, ccSdd: base.ccSdd });
  assert.equal(r.ok, false);
  assert.match(r.reason, /format/);
  assert.match(r.reason, /update/);
});

test("版が不正なときは理由に ccSdd.version と update を含める", () => {
  const r = ok({ ...base, ccSdd: { ...base.ccSdd, version: "x" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ccSdd\.version/);
  assert.match(r.reason, /update/);
});

test("言語が不正なときは理由に ccSdd.lang を含める", () => {
  const r = ok({ ...base, ccSdd: { ...base.ccSdd, lang: "JA" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ccSdd\.lang/);
});

test("keepTemplates が真偽でないときは理由に ccSdd.keepTemplates を含める", () => {
  const r = ok({ ...base, ccSdd: { ...base.ccSdd, keepTemplates: "yes" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ccSdd\.keepTemplates/);
});

test("ccSdd が文字列でも例外を投げず失敗にする", () => {
  const r = ok({ format: 1, ccSdd: "x" });
  assert.equal(r.ok, false);
});

test("buildState と parseState の往復", () => {
  const H = "a".repeat(64);
  const cfg = { version: "3.1.0", lang: "ja", keepTemplates: false };
  const files = { ".claude/skills/kiro-impl/SKILL.md": H };
  const s = buildState({ config: cfg, files });
  assert.deepEqual(parseState(JSON.stringify(s)), s);
});

test("buildState は files を複製する", () => {
  const H = "a".repeat(64);
  const cfg = { version: "3.1.0", lang: "ja", keepTemplates: false };
  const files = { ".claude/skills/kiro-impl/SKILL.md": H };
  const s = buildState({ config: cfg, files });
  files[".claude/skills/kiro-impl/SKILL.md"] = "b".repeat(64);
  assert.deepEqual(s.files, { ".claude/skills/kiro-impl/SKILL.md": H });
});

test("parseState は不正入力に対し null", () => {
  assert.equal(parseState(null), null);
  assert.equal(parseState("{"), null);
  assert.equal(parseState("[]"), null);
});

test("parseState は形式不正に対し null", () => {
  const H = "a".repeat(64);
  const cases = [
    { format: 2, version: "3.1.0", lang: "ja", keepTemplates: false, files: { ".claude/skills/kiro-impl/SKILL.md": H } },
    { format: 1, version: "", lang: "ja", keepTemplates: false, files: { ".claude/skills/kiro-impl/SKILL.md": H } },
    { format: 1, version: "3.1.0", lang: "ja", keepTemplates: "no", files: { ".claude/skills/kiro-impl/SKILL.md": H } },
    { format: 1, version: "3.1.0", lang: "ja", keepTemplates: false, files: { ".claude/skills/kiro-impl/SKILL.md": "xyz" } },
  ];
  for (const c of cases) {
    assert.equal(parseState(JSON.stringify(c)), null);
  }
});

test("parseState は相対でない files に対し null", () => {
  const H = "a".repeat(64);
  const badPaths = ["/etc/passwd", "../x", "a/../b", "a\\b", "a//b"];
  for (const p of badPaths) {
    const obj = { format: 1, version: "3.1.0", lang: "ja", keepTemplates: false, files: { [p]: H } };
    assert.equal(parseState(JSON.stringify(obj)), null);
  }
});

test("isFingerprintTarget の判定", () => {
  assert.equal(isFingerprintTarget(".claude/skills/kiro-impl/SKILL.md", true), true);
  assert.equal(isFingerprintTarget(".claude/skills/kiro-impl/SKILL.md", false), true);
  assert.equal(isFingerprintTarget(".kiro/settings/cc-sdd-guide.md", true), true);
  assert.equal(isFingerprintTarget(".kiro/settings/cc-sdd-guide.md", false), true);
  assert.equal(isFingerprintTarget(".kiro/settings/templates/specs/tasks.md", true), false);
  assert.equal(isFingerprintTarget(".kiro/settings/templates/specs/tasks.md", false), true);
  assert.equal(isFingerprintTarget(".claude/skills/other/x.md", true), false);
  assert.equal(isFingerprintTarget(".kiro/specs/a/spec.json", true), false);
  assert.equal(isFingerprintTarget("CLAUDE.md", true), false);
});
