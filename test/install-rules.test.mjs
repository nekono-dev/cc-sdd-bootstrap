import { readInstallConfig, parseState, buildState, isFingerprintTarget, FAILURE_RECORD, STATE_PATH, RETRY_COMMAND, NPX_TIMEOUT_MS, STALE_LOCK_MS, decideInstall, removalTargets, buildManifest, npxArgs, RECORD_IN_PROGRESS, messageInstalled, messageSkipped, messageGuide, failureRecordText, messageFailed } from "../.agent-hooks/cc-sdd-bootstrap/install-rules.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const base = { format: 1, ccSdd: { version: "3.1.0", lang: "ja" } };
const ok = (obj) => readInstallConfig(JSON.stringify(obj));

test("有効な設定を読み、版・言語だけを返す（雛形の保持の項目は扱わない）", () => {
  const r = ok(base);
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, { version: "3.1.0", lang: "ja" });
});

test("ccSdd の項目が無いときは既定値で補う", () => {
  const r = ok({ format: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, { version: "3.1.0", lang: "ja" });
});

test("format 1 の設定は読める（format 以外は必須ではない）", () => {
  const r = ok({ format: 1, ccSdd: { version: "3.2.0" } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, { version: "3.2.0", lang: "ja" });
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

test("版が不正なときは理由に ccSdd.version・ファイル名・update を含める", () => {
  const r = ok({ ...base, ccSdd: { ...base.ccSdd, version: "x" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ccSdd\.version/);
  assert.match(r.reason, /\.cc-sdd-bootstrap\.json/);
  assert.match(r.reason, /update/);
});

test("言語が不正なときは理由に ccSdd.lang を含める", () => {
  const r = ok({ ...base, ccSdd: { ...base.ccSdd, lang: "JA" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ccSdd\.lang/);
});

test("雛形の保持の項目（keepTemplates）は読まず、真偽でなくても誤りにしない", () => {
  const r = ok({ ...base, ccSdd: { ...base.ccSdd, keepTemplates: "yes" } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, { version: "3.1.0", lang: "ja" });
});

test("ccSdd が文字列でも例外を投げず失敗にする", () => {
  const r = ok({ format: 1, ccSdd: "x" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ccSdd/);
});

test("buildState は format 2 と版・言語・導入物の道筋の一覧を作る", () => {
  const cfg = { version: "3.1.0", lang: "ja" };
  const s = buildState(cfg, [".claude/skills/kiro-impl/SKILL.md", ".kiro/settings/cc-sdd-guide.md"]);
  assert.deepEqual(s, { format: 2, version: "3.1.0", lang: "ja", files: [".claude/skills/kiro-impl/SKILL.md", ".kiro/settings/cc-sdd-guide.md"] });
});

test("buildState と parseState の往復", () => {
  const s = buildState({ version: "3.1.0", lang: "ja" }, [".claude/skills/kiro-impl/SKILL.md"]);
  assert.deepEqual(parseState(JSON.stringify(s)), s);
});

test("buildState は files を複製する", () => {
  const files = [".claude/skills/kiro-impl/SKILL.md"];
  const s = buildState({ version: "3.1.0", lang: "ja" }, files);
  files.push(".kiro/settings/cc-sdd-guide.md");
  assert.deepEqual(s.files, [".claude/skills/kiro-impl/SKILL.md"]);
});

test("parseState は読めない・オブジェクトでない入力に対し null", () => {
  assert.equal(parseState(null), null);
  assert.equal(parseState("{"), null);
  assert.equal(parseState("[]"), null);
  assert.equal(parseState("null"), null);
});

test("parseState は旧版の指紋つき（format 1）の記録を読めない扱いにする", () => {
  const H = "a".repeat(64);
  const old = { format: 1, version: "3.1.0", lang: "ja", keepTemplates: false, files: { ".claude/skills/kiro-impl/SKILL.md": H } };
  assert.equal(parseState(JSON.stringify(old)), null);
});

test("parseState は形が違う記録に対し null", () => {
  const good = { format: 2, version: "3.1.0", lang: "ja", files: [".claude/skills/kiro-impl/SKILL.md"] };
  const cases = [
    { ...good, format: 3 },
    { ...good, format: "2" },
    { ...good, version: "" },
    { ...good, lang: 1 },
    { ...good, files: {} },
    { ...good, files: "a.md" },
    { ...good, files: [1] },
    { ...good, files: [""] },
  ];
  for (const c of cases) {
    assert.equal(parseState(JSON.stringify(c)), null);
  }
});

test("parseState は相対でない道筋を含む記録に対し null", () => {
  const badPaths = ["/etc/passwd", "../x", "a/../b", "a\\b", "a//b", "./a"];
  for (const p of badPaths) {
    const obj = { format: 2, version: "3.1.0", lang: "ja", files: [p] };
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

const config = { version: "3.1.0", lang: "ja" };
const KIRO_SKILL = ".claude/skills/kiro-impl/SKILL.md";
const state = buildState(config, [KIRO_SKILL]);
// 判断の材料（InstallFacts）の既定値。試験ごとに上書きする
const facts = (overrides = {}) => ({
  config: { ok: true, config },
  state,
  lock: { present: false },
  failure: { present: false },
  missingFiles: [],
  sectionPresent: { claude: true, codex: true },
  ...overrides
});

test("導入記録の定数", () => {
  assert.equal(FAILURE_RECORD, ".cache/cc-sdd-install.failed");
  assert.equal(STATE_PATH, ".cache/cc-sdd-install.state.json");
  assert.equal(RETRY_COMMAND, "node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs");
  assert.equal(NPX_TIMEOUT_MS, 540000);
  assert.equal(STALE_LOCK_MS, 660000);
});

test("揃っていれば省く（skip）", () => {
  assert.deepEqual(decideInstall(facts()), { action: "skip" });
});

test("設定の誤りは fail にし、理由をそのまま返す", () => {
  const reason = ".cc-sdd-bootstrap.json が JSON として読めません。update で設定を新しくしてください。";
  assert.deepEqual(decideInstall(facts({ config: { ok: false, reason }, state: null })), { action: "fail", reason });
});

test("設定の誤りは導入中の印より先に判定する", () => {
  const reason = "設定の誤り";
  assert.deepEqual(decideInstall(facts({ config: { ok: false, reason }, lock: { present: true, ageMs: 0 } })), { action: "fail", reason });
});

test("導入中の印は busy にし、経過時間が STALE_LOCK_MS を超えたときだけ stale にする", () => {
  assert.deepEqual(decideInstall(facts({ lock: { present: true, ageMs: 1000 } })), { action: "busy", stale: false });
  assert.deepEqual(decideInstall(facts({ lock: { present: true, ageMs: STALE_LOCK_MS } })), { action: "busy", stale: false });
  assert.deepEqual(decideInstall(facts({ lock: { present: true, ageMs: STALE_LOCK_MS + 1 } })), { action: "busy", stale: true });
});

test("導入中の印は失敗の記録・状態の欠けより先に判定する", () => {
  assert.deepEqual(decideInstall(facts({ lock: { present: true, ageMs: 1 }, failure: { present: true, text: "x" }, state: null })), { action: "busy", stale: false });
});

test("失敗の記録があれば入れ直す（reason は failed）", () => {
  assert.deepEqual(decideInstall(facts({ failure: { present: true, text: "取得に失敗しました" } })), { action: "install", reason: "failed" });
  assert.deepEqual(decideInstall(facts({ failure: { present: true, text: null }, state: null })), { action: "install", reason: "failed" });
});

test("状態が無ければ入れ直す（reason は no-state）", () => {
  assert.deepEqual(decideInstall(facts({ state: null })), { action: "install", reason: "no-state" });
});

test("版・言語が設定と違えば入れ直す（reason は config-changed）", () => {
  assert.deepEqual(decideInstall(facts({ config: { ok: true, config: { ...config, lang: "en" } } })), { action: "install", reason: "config-changed" });
  assert.deepEqual(decideInstall(facts({ config: { ok: true, config: { ...config, version: "3.2.0" } } })), { action: "install", reason: "config-changed" });
});

test("記録した道筋のうち今は無いものがあれば入れ直す（reason は files-missing）", () => {
  assert.deepEqual(decideInstall(facts({ missingFiles: [KIRO_SKILL] })), { action: "install", reason: "files-missing" });
});

test("どちらかの文書に運用の区画が無ければ入れ直す（reason は section-missing）", () => {
  assert.deepEqual(decideInstall(facts({ sectionPresent: { claude: false, codex: true } })), { action: "install", reason: "section-missing" });
  assert.deepEqual(decideInstall(facts({ sectionPresent: { claude: true, codex: false } })), { action: "install", reason: "section-missing" });
});

test("内容だけが変わった導入物は道筋がある限り省く（内容は判断の材料に無い）", () => {
  // 内容の変更は InstallFacts に現れない。道筋・版・言語・区画が揃っていれば skip のまま
  assert.deepEqual(decideInstall(facts({ missingFiles: [] })), { action: "skip" });
});

test("removalTargets は kiro- のみを順に消し、保持時の雛形を残す", () => {
  assert.deepEqual(removalTargets({ skillEntries: ["kiro-a", "custom", "kiro-file", "kiro-link"], keepTemplates: false }), [".claude/skills/kiro-a", ".claude/skills/kiro-file", ".claude/skills/kiro-link", ".kiro/settings/cc-sdd-guide.md", ".kiro/settings/templates"]);
  assert.deepEqual(removalTargets({ skillEntries: ["custom", "kiro-a"], keepTemplates: true }), [".claude/skills/kiro-a", ".kiro/settings/cc-sdd-guide.md"]);
});

test("buildManifest は保持と雛形欠落に応じた3通りの一覧を作る", () => {
  const skills = { type: "templateDir", fromDir: "templates/agents/{{AGENT}}/skills", toDir: "{{AGENT_COMMANDS_DIR}}" };
  const doc = { type: "templateFile", from: "templates/agents/{{AGENT}}/docs/CLAUDE.md", toDir: "{{KIRO_DIR}}/settings", rename: "cc-sdd-guide.md" };
  const templates = { type: "templateDir", fromDir: "templates/shared/settings/templates", toDir: "{{KIRO_DIR}}/settings/templates" };
  const expected = (withTemplates) => ({ version: 1, artifacts: [{ id: "skills", source: skills }, { id: "doc_main", source: doc }, ...(withTemplates ? [{ id: "settings_templates", source: templates }] : [])] });
  assert.deepEqual(buildManifest({ keepTemplates: false, templatesMissing: false }), expected(true));
  assert.deepEqual(buildManifest({ keepTemplates: true, templatesMissing: false }), expected(false));
  assert.deepEqual(buildManifest({ keepTemplates: true, templatesMissing: true }), expected(true));
});

test("npxArgs はシェルを介さない引数配列を返す", () => {
  assert.deepEqual(npxArgs(config, ".cache/manifest.json"), ["--yes", "cc-sdd@3.1.0", "--yes", "--overwrite", "force", "--manifest", ".cache/manifest.json", "--claude-skills", "--lang", "ja"]);
});

test("利用者向けの成功・省略・案内の文に必要な情報がある", () => {
  const installed = messageInstalled(config);
  assert.ok(installed.split("\n").length >= 1 && installed.split("\n").length <= 3);
  for (const part of [config.version, config.lang, ".claude/skills/kiro-*", ".kiro/settings/", "CLAUDE.md は変更していません"]) assert.ok(installed.includes(part));
  const skipped = messageSkipped(config);
  assert.equal(skipped.split("\n").length, 1);
  for (const part of [config.version, config.lang]) assert.ok(skipped.includes(part));
  assert.match(skipped, /省/);
  const guide = messageGuide();
  assert.match(guide, /スキル一覧に載らないスキル/);
  assert.match(guide, /\.claude\/skills\/<名前>\/SKILL\.md/);
  assert.match(guide, /Read/);
});

test("失敗の記録と通知に理由および Claude の外での再試行方法がある", () => {
  const reason = "取得に失敗しました";
  assert.ok(RECORD_IN_PROGRESS.startsWith("cc-sdd の導入が完了していません（導入中、または中断）。"));
  assert.ok(RECORD_IN_PROGRESS.includes(RETRY_COMMAND));
  assert.match(RECORD_IN_PROGRESS, /Claude の外/);
  const record = failureRecordText(reason);
  assert.match(record, /^cc-sdd の導入に失敗しました。/);
  assert.ok(record.includes(`理由: ${reason}`));
  assert.ok(record.includes(`再試行: ${RETRY_COMMAND}`));
  assert.match(record, /Claude の外で実行する/);
  const failed = messageFailed(reason);
  assert.ok(failed.includes(reason));
  assert.ok(failed.includes(RETRY_COMMAND));
  assert.match(failed, /Claude の外/);
  assert.match(failed, /次の入力.*止/);
  assert.match(failed, /新しいセッション.*再試行/);
});
