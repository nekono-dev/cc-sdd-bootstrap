import { readInstallConfig, parseState, buildState, FAILURE_RECORD, STATE_PATH, LOCK_PATH, RETRY_COMMAND, NPX_TIMEOUT_MS, STALE_LOCK_MS, decideInstall, removalTargets, buildManifest, npxArgs, messageInstalled, messageSkipped, messageReadSkillDirectly, messageBlocked, messageUsage, SECTION_BEGIN_MARKER, SECTION_END_MARKER, inspectSection, replaceSection, validateSectionText, messageSectionRewritten } from "../.agent-hooks/cc-sdd-bootstrap/install-rules.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const base = { format: 1, ccSdd: { version: "3.1.0", lang: "ja" } };
const ok = (obj) => readInstallConfig(JSON.stringify(obj));

test("有効な設定を読み、版・言語だけを返す（雛形の保持の項目は扱わない）", () => {
  const r = ok(base);
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, { version: "3.1.0", lang: "ja" });
});

test("役割表の誤りでは失敗せず、版の誤りでは失敗する（役割表は導入に使わない）", () => {
  const r = ok({ ...base, subagents: { maxModel: { claude: "fable" } } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, { version: "3.1.0", lang: "ja" });
  assert.equal(ok({ format: 1, ccSdd: { version: "bad" }, subagents: {} }).ok, false);
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
  assert.equal(LOCK_PATH, ".cache/cc-sdd-install.lock");
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

test("removalTargets は両ツールの kiro- で始まるスキルと .kiro/settings を消す対象にする", () => {
  assert.deepEqual(
    removalTargets({ claude: ["kiro-a", "custom", "kiro-file"], codex: ["kiro-b", "mine"] }),
    [".claude/skills/kiro-a", ".claude/skills/kiro-file", ".agents/skills/kiro-b", ".kiro/settings"]
  );
});

test("removalTargets は独自のスキル・仕様・方針・.codex/agents を消す対象に含めない", () => {
  assert.deepEqual(removalTargets({ claude: ["custom"], codex: ["other"] }), [".kiro/settings"]);
  for (const target of removalTargets({ claude: ["kiro-a"], codex: ["kiro-b"] })) {
    assert.doesNotMatch(target, /\.kiro\/(specs|steering)|\.codex/);
  }
});

test("removalTargets は空の一覧なら .kiro/settings だけを返す", () => {
  assert.deepEqual(removalTargets({ claude: [], codex: [] }), [".kiro/settings"]);
});

test("buildManifest(claude) は Claude Code 向けの出力先と中身を作る（CLAUDE.md を直下へ）", () => {
  assert.deepEqual(buildManifest("claude"), {
    version: 1,
    artifacts: [
      { id: "skills", source: { type: "templateDir", fromDir: "templates/agents/{{AGENT}}/skills", toDir: "{{AGENT_COMMANDS_DIR}}" } },
      { id: "doc_main", source: { type: "templateFile", from: "templates/agents/{{AGENT}}/docs/CLAUDE.md", toDir: "." } },
      { id: "settings_templates", source: { type: "templateDir", fromDir: "templates/shared/settings/templates", toDir: "{{KIRO_DIR}}/settings/templates" } }
    ]
  });
});

test("buildManifest(codex) は Codex 向けの出力先と中身を作り、既定のエージェント定義を含めない", () => {
  const manifest = buildManifest("codex");
  assert.deepEqual(manifest, {
    version: 1,
    artifacts: [
      { id: "skills", source: { type: "templateDir", fromDir: "templates/agents/{{AGENT}}/skills", toDir: "{{AGENT_COMMANDS_DIR}}" } },
      { id: "doc_main", source: { type: "templateFile", from: "templates/agents/{{AGENT}}/docs/AGENTS.md", toDir: "." } },
      { id: "settings_templates", source: { type: "templateDir", fromDir: "templates/shared/settings/templates", toDir: "{{KIRO_DIR}}/settings/templates" } }
    ]
  });
  assert.equal(manifest.artifacts.some((a) => a.id === "codex_agents"), false);
});

test("npxArgs は版・言語・manifest・強制上書きを、ツールごとのスキル指定で組み立てる", () => {
  assert.deepEqual(npxArgs(config, "claude", ".cache/manifest.json"), ["--yes", "cc-sdd@3.1.0", "--yes", "--overwrite", "force", "--manifest", ".cache/manifest.json", "--claude-skills", "--lang", "ja"]);
  assert.deepEqual(npxArgs(config, "codex", ".cache/manifest.json"), ["--yes", "cc-sdd@3.1.0", "--yes", "--overwrite", "force", "--manifest", ".cache/manifest.json", "--codex-skills", "--lang", "ja"]);
});

test("導入したときの文は、両ツールの導入物と両文書を書き換えたことを含む（旧版の「CLAUDE.md は変更していません」は含めない）", () => {
  const installed = messageInstalled(config);
  assert.ok(installed.split("\n").length >= 1 && installed.split("\n").length <= 3);
  for (const part of [config.version, config.lang, ".claude/skills/kiro-*", ".agents/skills/kiro-*", ".kiro/settings/", "CLAUDE.md", "AGENTS.md", "Claude Code", "Codex", "書き換え"]) assert.ok(installed.includes(part));
  assert.doesNotMatch(installed, /変更していません/);
});

test("利用者向けの省略の文に版・言語がある", () => {
  const skipped = messageSkipped(config);
  assert.equal(skipped.split("\n").length, 1);
  for (const part of [config.version, config.lang]) assert.ok(skipped.includes(part));
  assert.match(skipped, /省/);
});

test("停止の通知に理由と再試行方法がある", () => {
  const reason = "取得に失敗しました";
  const failed = messageBlocked({ kind: "failed", detail: reason });
  assert.ok(failed.includes(reason));
  assert.ok(failed.includes(RETRY_COMMAND));
  assert.match(failed, /Claude の外/);
  const fresh = messageBlocked({ kind: "busy", stale: false });
  assert.match(fresh, /別のセッション/);
  assert.ok(fresh.includes(RETRY_COMMAND));
  const stale = messageBlocked({ kind: "busy", stale: true });
  assert.match(stale, /rm \.cache\/cc-sdd-install\.lock/);
  assert.ok(stale.includes(RETRY_COMMAND));
});

test("手順書を直接読む文は、ツールごとの手順書の置き場所と読み方を示す", () => {
  const claude = messageReadSkillDirectly("claude", "何か頼む");
  assert.match(claude, /\.claude\/skills\/<名前>\/SKILL\.md/);
  assert.doesNotMatch(claude, /\.agents\/skills/);
  assert.match(claude, /Read/);
  assert.match(claude, /最後まで/);
  const codex = messageReadSkillDirectly("codex", "何か頼む");
  assert.match(codex, /\.agents\/skills\/<名前>\/SKILL\.md/);
  assert.doesNotMatch(codex, /\.claude\/skills/);
  assert.match(codex, /Read/);
  assert.match(codex, /最後まで/);
});

test("入力が /kiro-xxx または $kiro-xxx で始まるなら、その手順書の道筋を名指しする", () => {
  assert.match(messageReadSkillDirectly("claude", "/kiro-impl 1.4"), /\.claude\/skills\/kiro-impl\/SKILL\.md/);
  assert.match(messageReadSkillDirectly("claude", "  \n/kiro-spec-tasks x"), /\.claude\/skills\/kiro-spec-tasks\/SKILL\.md/);
  assert.match(messageReadSkillDirectly("codex", "$kiro-impl"), /\.agents\/skills\/kiro-impl\/SKILL\.md/);
  assert.match(messageReadSkillDirectly("codex", "  $kiro-spec-init 説明"), /\.agents\/skills\/kiro-spec-init\/SKILL\.md/);
});

test("入力が kiro- の依頼で始まらないときは道筋を名指ししない", () => {
  const t = messageReadSkillDirectly("claude", "文章で頼む /kiro-impl");
  assert.doesNotMatch(t, /kiro-impl\/SKILL\.md/);
  assert.doesNotMatch(messageReadSkillDirectly("claude", ""), /kiro-[a-z]+\/SKILL\.md/);
});

test("止めた理由（失敗）は詳細と再試行のコマンドを示す。詳細が無ければ完了を確認できない旨を示す", () => {
  const withDetail = messageBlocked({ kind: "failed", detail: "取得に失敗しました" });
  assert.ok(withDetail.includes("取得に失敗しました"));
  assert.ok(withDetail.includes(RETRY_COMMAND));
  assert.match(withDetail, /通常の端末/);
  const noDetail = messageBlocked({ kind: "failed", detail: null });
  assert.match(noDetail, /導入の完了を確認できない/);
  assert.ok(noDetail.includes(RETRY_COMMAND));
  assert.match(noDetail, /通常の端末/);
});

test("止めた理由（導入中・新しい印）は別のセッションで導入中の旨と再試行のコマンドを示し、印の削除は示さない", () => {
  const m = messageBlocked({ kind: "busy", stale: false });
  assert.match(m, /別のセッションで導入中/);
  assert.ok(m.includes(RETRY_COMMAND));
  assert.doesNotMatch(m, /rm /);
});

test("止めた理由（導入中・古い印）は中断の可能性と、印を消して再試行する 1 行を示す", () => {
  const m = messageBlocked({ kind: "busy", stale: true });
  assert.match(m, /中断した可能性/);
  assert.match(m, /ほかに導入が進んでいないことを確かめてから/);
  const command = `rm ${LOCK_PATH} && ${RETRY_COMMAND}`;
  assert.equal(command, "rm .cache/cc-sdd-install.lock && node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs");
  assert.ok(m.split("\n").some((line) => line.trim() === command));
});

test("利用手順は準備スクリプトの 1 行・手元の初回の始め方・未導入の /kiro-* の扱いを含む", () => {
  const u = messageUsage();
  assert.ok(u.includes("if [ -d <リポジトリ> ]; then (cd <リポジトリ> && node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs); fi"));
  assert.match(u, /最初の入力/);
  assert.match(u, /起動前/);
  assert.match(u, /\/kiro-/);
  assert.match(u, /Unknown command/);
  assert.match(u, /通常の文章/);
});


// 区画だけの書き直し（subagent-delegation 5.15）
const SECTION_TEXT = `${SECTION_BEGIN_MARKER}\n\n新しい文章\n\n${SECTION_END_MARKER}\n`;
const OLD_SECTION = `${SECTION_BEGIN_MARKER}\n\n古い文章\n\n${SECTION_END_MARKER}\n`;

test("区画の終わりの目印は installer-core と同じ値", async () => {
  const { AGENT_SECTION_MARKERS } = await import("../lib/catalog.mjs");
  assert.equal(SECTION_END_MARKER, AGENT_SECTION_MARKERS.end);
});

test("inspectSection: 区画が無ければ present=false、同じなら stale=false、違えば stale=true", () => {
  assert.deepEqual(inspectSection("利用者の文章\n", SECTION_TEXT), { present: false, stale: false });
  assert.deepEqual(inspectSection(`先頭\n${SECTION_TEXT}`, SECTION_TEXT), { present: true, stale: false });
  assert.deepEqual(inspectSection(`先頭\n${OLD_SECTION}末尾\n`, SECTION_TEXT), { present: true, stale: true });
  assert.deepEqual(inspectSection(`先頭\n${OLD_SECTION}`.replace(SECTION_END_MARKER, ""), SECTION_TEXT), { present: true, stale: true });
});

test("replaceSection: 区画の外を保って区画だけを置き換える。終わりの目印が無ければ末尾まで置き換える", () => {
  assert.equal(replaceSection(`先頭\n${OLD_SECTION}末尾\n`, SECTION_TEXT), `先頭\n${SECTION_TEXT}末尾\n`);
  assert.equal(replaceSection(`先頭\n${SECTION_BEGIN_MARKER}\n古い`, SECTION_TEXT), `先頭\n${SECTION_TEXT}`);
});

test("区画が古ければ区画だけ書き直す（rewrite-section）。導入が要る場合は導入を優先する", () => {
  assert.deepEqual(decideInstall(facts({ sectionStale: { claude: false, codex: false } })), { action: "skip" });
  assert.deepEqual(decideInstall(facts({ sectionStale: { claude: true, codex: false } })), { action: "rewrite-section", tools: ["claude"] });
  assert.deepEqual(decideInstall(facts({ sectionStale: { claude: true, codex: true } })), { action: "rewrite-section", tools: ["claude", "codex"] });
  assert.equal(decideInstall(facts({ sectionStale: { claude: true, codex: true }, sectionPresent: { claude: false, codex: true } })).action, "install");
  assert.equal(decideInstall(facts({ sectionStale: { claude: true, codex: true }, failure: { present: true, text: "x" } })).action, "install");
  assert.equal(decideInstall(facts({ sectionStale: { claude: true, codex: true }, state: null })).action, "install");
  assert.equal(decideInstall(facts({ sectionStale: { claude: true, codex: true }, missingFiles: ["a"] })).action, "install");
  assert.equal(decideInstall(facts({ sectionStale: { claude: true, codex: true }, lock: { present: true, ageMs: 1 } })).action, "busy");
});

test("区画の書き直しの文言", () => {
  assert.match(messageSectionRewritten(["claude", "codex"]), /CLAUDE\.md.*AGENTS\.md|区画だけ/);
  const blocked = messageBlocked({ kind: "section", detail: "書けない" });
  assert.match(blocked, /書けない/);
  assert.ok(blocked.includes(RETRY_COMMAND));
});

test("validateSectionText: 開始と終わりの目印が 1 つずつ正しい順であること", () => {
  assert.equal(validateSectionText(SECTION_TEXT), null);
  assert.equal(typeof validateSectionText(`${SECTION_BEGIN_MARKER}\n本文\n`), "string");
  assert.equal(typeof validateSectionText(`${SECTION_END_MARKER}\n${SECTION_BEGIN_MARKER}\n`), "string");
  assert.equal(typeof validateSectionText(`${SECTION_BEGIN_MARKER}\n${SECTION_BEGIN_MARKER}\n${SECTION_END_MARKER}\n`), "string");
  assert.equal(typeof validateSectionText(`${SECTION_BEGIN_MARKER}\n${SECTION_END_MARKER}\n${SECTION_END_MARKER}\n`), "string");
  assert.equal(typeof validateSectionText("本文のみ"), "string");
});
