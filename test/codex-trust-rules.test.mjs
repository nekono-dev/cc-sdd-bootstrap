import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OWNED_MARKER, computeTrustEntries, planTrustEdit, messageTrust, trustIsEffective } from "../.agent-hooks/cc-sdd-bootstrap/codex-trust-rules.mjs";
import { OWNED_MARKER as CATALOG_MARKER } from "../lib/catalog.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.join(here, "fixtures", "codex-hooks-sample.json");
const sampleText = fs.readFileSync(SAMPLE_PATH, "utf8");
const ABS = "/abs/repo/.codex/hooks.json";

// 実機の Codex が確認画面で承認して config.toml に残した値（キーの道筋は任意の絶対パスなので、ハッシュだけを比べる）
const APPROVED = {
  "pre_tool_use:0:0": "sha256:3cbaf5fbe1354bbb360bb9ce91e9459dc74f5bd09c075e0ec482bf0b39e64611",
  "pre_tool_use:1:0": "sha256:654bd4b4efb5d82be2fc27b7b222f551495eb671d8afbc9af27ee0ca74d23295",
  "post_tool_use:0:0": "sha256:de6c5fe6b97f0beeb7f35ccb633b35d04ef773cd41cff6e06e799d8a6c3298cb",
  "session_start:0:0": "sha256:dae1248d3bfbde04c6994e47b28a87389bf5331cb5c35efdf713634c3ad1aa0e",
  "session_start:1:0": "sha256:bae2e859912a9fdda49c6f3cc7581afa383abaa27d8f4d9caaf9185fbcd8f58f",
  "user_prompt_submit:0:0": "sha256:38e09c4daa0ec07c80c1cc5dd1e8c99641372cc4dd86263ec128f07744ae5bf3",
  "user_prompt_submit:1:0": "sha256:991f4f5cc29e76a8e3cb143f073677afca9658d5ae087231a1c147e342dd2d16",
  "stop:0:0": "sha256:b788fa2a38dddc7935d5226d21eb20a97f293837cd6ec0125b644a23d5840c54",
};

/** キーの道筋を除き、「イベント:グループ:フック」の部分だけをキーにした辞書を返す */
function byShortKey(entries) {
  const out = {};
  for (const e of entries) {
    const short = e.key.slice(ABS.length + 1);
    out[short] = e.hash;
  }
  return out;
}

/** 試験用に hooks.json の文章を組み立てる */
const hooksText = (hooks) => JSON.stringify({ hooks });
const own = (extra = {}) => ({ type: "command", command: `node "$(git rev-parse --show-toplevel)${OWNED_MARKER}x.mjs" stop --tool codex`, ...extra });
const user = (command = "echo user") => ({ type: "command", command });

test("自分の印の定数が lib/catalog.mjs の値と一致する", () => {
  assert.equal(OWNED_MARKER, "/.agent-hooks/cc-sdd-bootstrap/");
  assert.equal(OWNED_MARKER, CATALOG_MARKER);
});

test("実機の Codex が承認した 8 件のハッシュと一致する", () => {
  const result = computeTrustEntries(sampleText, ABS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.entries.length, 8);
  assert.deepEqual(byShortKey(result.entries), APPROVED);
});

test("キーは hooks.json の道筋・イベント名・グループ番号・フック番号で組み立てる", () => {
  const result = computeTrustEntries(sampleText, ABS);
  assert.equal(result.entries[0].key, `${ABS}:session_start:0:0`);
});

test("利用者のフックが先にあると、自分のフックの番号がずれて求まる", () => {
  const text = hooksText({
    SessionStart: [
      { hooks: [user()] },
      { hooks: [user("echo a"), own()] },
    ],
  });
  const ownCommand = JSON.parse(text).hooks.SessionStart[1].hooks[1].command;
  const result = computeTrustEntries(text, ABS);
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 1);
  // 利用者のフックを含めて数えるので、グループ 1・フック 1 になる
  assert.equal(result.entries[0].key, `${ABS}:session_start:1:1`);
  assert.ok(ownCommand.includes(OWNED_MARKER));
});

test("印のない command フックは対象外になる", () => {
  const text = hooksText({ Stop: [{ hooks: [user("node other.mjs")] }] });
  const result = computeTrustEntries(text, ABS);
  assert.deepEqual(result, { ok: true, entries: [], skipped: [] });
});

test("matcher つきのフックはハッシュに matcher を含み、無いものと結果が違う", () => {
  const withMatcher = hooksText({ PreToolUse: [{ matcher: "Bash", hooks: [own()] }] });
  const withoutMatcher = hooksText({ PreToolUse: [{ hooks: [own()] }] });
  const a = computeTrustEntries(withMatcher, ABS).entries[0].hash;
  const b = computeTrustEntries(withoutMatcher, ABS).entries[0].hash;
  assert.notEqual(a, b);
});

test("timeout を省くと 600 として求まり、1 未満は 1 として求まる", () => {
  const omitted = hooksText({ Stop: [{ hooks: [own()] }] });
  const explicit600 = hooksText({ Stop: [{ hooks: [own({ timeout: 600 })] }] });
  const zero = hooksText({ Stop: [{ hooks: [own({ timeout: 0 })] }] });
  const one = hooksText({ Stop: [{ hooks: [own({ timeout: 1 })] }] });
  assert.equal(computeTrustEntries(omitted, ABS).entries[0].hash, computeTrustEntries(explicit600, ABS).entries[0].hash);
  assert.equal(computeTrustEntries(zero, ABS).entries[0].hash, computeTrustEntries(one, ABS).entries[0].hash);
});

test("type・command・timeout 以外の項目を持つ自分のフックは skipped に理由つきで除かれる", () => {
  const text = hooksText({
    Stop: [{ hooks: [own({ statusMessage: "確認中" })] }],
    SessionStart: [{ hooks: [own({ async: true }), user()] }],
  });
  const result = computeTrustEntries(text, ABS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries, []);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every((s) => typeof s === "string" && s.length > 0));
  assert.ok(result.skipped.some((s) => s.includes("statusMessage")));
  assert.ok(result.skipped.some((s) => s.includes("async")));
});

test("表にないイベントの自分のフックは skipped に除かれる", () => {
  const text = hooksText({ Unknown: [{ hooks: [own()] }] });
  const result = computeTrustEntries(text, ABS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries, []);
  assert.equal(result.skipped.length, 1);
  assert.ok(result.skipped[0].includes("Unknown"));
});

test("表にないイベントの利用者のフックは skipped に載らない", () => {
  const text = hooksText({ Unknown: [{ hooks: [user()] }] });
  assert.deepEqual(computeTrustEntries(text, ABS), { ok: true, entries: [], skipped: [] });
});

test("JSON として読めない文章は ok: false になる", () => {
  const result = computeTrustEntries("{ これは JSON ではない", ABS);
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason.length > 0);
});

test("形が違う文章は ok: false になる", () => {
  assert.equal(computeTrustEntries("[]", ABS).ok, false);
  assert.equal(computeTrustEntries(hooksText("x"), ABS).ok, false);
  assert.equal(computeTrustEntries(JSON.stringify({ hooks: { Stop: "x" } }), ABS).ok, false);
  assert.equal(computeTrustEntries(JSON.stringify({ hooks: { Stop: [{ hooks: "x" }] } }), ABS).ok, false);
});

test("Object.prototype の名前をイベント名に持つ自分のフックは、記録を作らず理由つきで skipped になる", () => {
  for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    // JSON.parse は __proto__ を通常のキーとして作るので、同じ文章で試す
    const text = `{"hooks":{${JSON.stringify(name)}:[{"hooks":[{"type":"command","command":"node \\"${OWNED_MARKER}x.mjs\\""}]}]}}`;
    const result = computeTrustEntries(text, ABS);
    assert.equal(result.ok, true, `イベント ${name} で ok が true にならない`);
    assert.deepEqual(result.entries, [], `イベント ${name} で記録が作られた`);
    assert.equal(result.skipped.length, 1, `イベント ${name} が skipped に入らない`);
    assert.ok(result.skipped[0].includes(name), `イベント ${name} の理由が無い`);
  }
});

test("Object.prototype の名前のイベントの利用者のフックは番号だけを数え、記録も skipped も作らない", () => {
  const text = `{"hooks":{"toString":[{"hooks":[{"type":"command","command":"echo user"}]}]}}`;
  assert.deepEqual(computeTrustEntries(text, ABS), { ok: true, entries: [], skipped: [] });
});

// ---- config.toml の差分（タスク 2.2: planTrustEdit の write） ----

const HASH_A = "sha256:" + "a".repeat(64);
const HASH_B = "sha256:" + "b".repeat(64);
const HASH_C = "sha256:" + "c".repeat(64);
const KEY = "/p/.codex/hooks.json:session_start:0:0";
const KEY2 = "/p/.codex/hooks.json:stop:0:0";
const HEAD = `[hooks.state."${KEY}"]`;
const HEAD2 = `[hooks.state."${KEY2}"]`;
const entry = (key, hash) => ({ key, hash });
const ZERO = { added: 0, updated: 0, unchanged: 0, removed: 0 };

test("write と remove 以外の mode は TypeError になる", () => {
  assert.throws(() => planTrustEdit("", [], "delete"), (e) => e instanceof TypeError && e.message.includes("未対応の mode です"));
  assert.throws(() => planTrustEdit("", [], undefined), TypeError);
});

test("空の本文に追加すると、見出しと trusted_hash の行だけになる", () => {
  const result = planTrustEdit("", [entry(KEY, HASH_A)], "write");
  assert.deepEqual(result, { ok: true, text: `${HEAD}\ntrusted_hash = "${HASH_A}"\n`, counts: { ...ZERO, added: 1 } });
});

test("既存の本文の末尾（改行で終わる）に、空行を 1 つ挟んで追加する", () => {
  const result = planTrustEdit(`model = "x"\n`, [entry(KEY, HASH_A)], "write");
  assert.equal(result.ok, true);
  assert.equal(result.text, `model = "x"\n\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`);
  assert.equal(result.counts.added, 1);
});

test("末尾が改行で終わらない本文には、改行を足さず、追加後も改行で終わらせない", () => {
  const result = planTrustEdit(`model = "x"`, [entry(KEY, HASH_A)], "write");
  assert.equal(result.text, `model = "x"\n\n${HEAD}\ntrusted_hash = "${HASH_A}"`);
});

test("末尾が既に空行で終わる本文には、空行を重ねずに追加する", () => {
  const result = planTrustEdit(`model = "x"\n\n`, [entry(KEY, HASH_A)], "write");
  assert.equal(result.text, `model = "x"\n\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`);
});

test("同じキーの trusted_hash が古いハッシュなら、その値だけを置き換えて updated に数える", () => {
  const text = `${HEAD}\ntrusted_hash = "${HASH_A}"\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_B)], "write");
  assert.deepEqual(result, { ok: true, text: `${HEAD}\ntrusted_hash = "${HASH_B}"\n`, counts: { ...ZERO, updated: 1 } });
});

test("表はあるが trusted_hash の行が無いなら、見出しの直後に行を足して updated に数える", () => {
  const text = `${HEAD}\nenabled = true\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "write");
  assert.equal(result.text, `${HEAD}\ntrusted_hash = "${HASH_A}"\nenabled = true\n`);
  assert.deepEqual(result.counts, { ...ZERO, updated: 1 });
});

test("ハッシュが同じなら、同じ文字列をそのまま返し unchanged に数える", () => {
  const text = `model = "x"\n\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "write");
  assert.equal(result.ok, true);
  assert.equal(result.text, text);
  assert.deepEqual(result.counts, { ...ZERO, unchanged: 1 });
});

test("変更が無いときは、空の本文でも入力と完全に同じ文字列を返す", () => {
  const result = planTrustEdit("", [], "write");
  assert.deepEqual(result, { ok: true, text: "", counts: ZERO });
});

test("コメント・他の表・見出しの行末のコメントと行頭の空白を保ち、値の行だけを変える", () => {
  const text = [
    "# 利用者の設定",
    'model = "x"  # 注釈',
    "",
    "[profiles.a]",
    "k = 1",
    "",
    `${HEAD}  # 承認`,
    `  trusted_hash = "${HASH_A}"  # 古い記録`,
    "",
    "[other]",
    `trusted_hash = "${HASH_C}"`,
    "",
  ].join("\n");
  const result = planTrustEdit(text, [entry(KEY, HASH_B)], "write");
  const expected = text.replace(`  trusted_hash = "${HASH_A}"  # 古い記録`, `  trusted_hash = "${HASH_B}"  # 古い記録`);
  assert.equal(result.ok, true);
  assert.equal(result.text, expected);
  assert.ok(result.text.startsWith("# 利用者の設定\n"));
  assert.deepEqual(result.counts, { ...ZERO, updated: 1 });
});

test("CRLF の本文には、追加する行も CRLF で書く", () => {
  const result = planTrustEdit(`model = "x"\r\n`, [entry(KEY, HASH_A)], "write");
  assert.equal(result.ok, true);
  assert.equal(result.text, `model = "x"\r\n\r\n${HEAD}\r\ntrusted_hash = "${HASH_A}"\r\n`);
});

test("CRLF の本文で値だけを置き換えるとき、改行コードを変えない", () => {
  const text = `${HEAD}\r\ntrusted_hash = "${HASH_A}"\r\nenabled = true\r\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_B)], "write");
  assert.equal(result.text, `${HEAD}\r\ntrusted_hash = "${HASH_B}"\r\nenabled = true\r\n`);
});

test("複数件を追加するとき、表と表の間に空行を 1 つ挟む", () => {
  const result = planTrustEdit("", [entry(KEY, HASH_A), entry(KEY2, HASH_B)], "write");
  assert.equal(result.text, `${HEAD}\ntrusted_hash = "${HASH_A}"\n\n${HEAD2}\ntrusted_hash = "${HASH_B}"\n`);
  assert.equal(result.counts.added, 2);
});

test("追加・更新・変更なしを混ぜたときの件数が正しい", () => {
  const text = `${HEAD}\ntrusted_hash = "${HASH_A}"\n\n${HEAD2}\ntrusted_hash = "${HASH_B}"\n`;
  const KEY3 = "/p/.codex/hooks.json:pre_tool_use:0:0";
  const result = planTrustEdit(
    text,
    [entry(KEY, HASH_C), entry(KEY2, HASH_B), entry(KEY3, HASH_A)],
    "write",
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { added: 1, updated: 1, unchanged: 1, removed: 0 });
  assert.ok(result.text.includes(`[hooks.state."${KEY3}"]`));
});

test("複数行の文字列（\"\"\"）がある本文は ok: false になり、理由が日本語で付く", () => {
  const text = `note = """\nabc\n"""\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "write");
  assert.equal(result.ok, false);
  assert.ok(typeof result.reason === "string" && result.reason.length > 0);
});

test("複数行の文字列（'''）がある本文も ok: false になる", () => {
  const result = planTrustEdit(`note = '''\nabc\n'''\n`, [entry(KEY, HASH_A)], "write");
  assert.equal(result.ok, false);
});

test("閉じていない見出しの行があると ok: false になる", () => {
  const result = planTrustEdit(`[hooks.state."x"\n`, [entry(KEY, HASH_A)], "write");
  assert.equal(result.ok, false);
});

test("複数行の配列の続きで [ で始まる行は見出しとみなさず、ok: true になる", () => {
  const text = `arr = [\n  [1, 2],\n]\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "write");
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.text, `${text}\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`);
});

test("最上位に hooks = や hooks.… の行があると ok: false になる", () => {
  assert.equal(planTrustEdit(`hooks.state."k".trusted_hash = "x"\n`, [entry(KEY, HASH_A)], "write").ok, false);
  assert.equal(planTrustEdit(`hooks = { state = {} }\n`, [entry(KEY, HASH_A)], "write").ok, false);
});

test("[hooks] の表の中に state のキーがあると ok: false になる", () => {
  const result = planTrustEdit(`[hooks]\nstate.x = 1\n`, [entry(KEY, HASH_A)], "write");
  assert.equal(result.ok, false);
  assert.equal(planTrustEdit(`[hooks]\nstate = {}\n`, [entry(KEY, HASH_A)], "write").ok, false);
});

test("同じキーの見出しが 2 つ以上あると ok: false になる", () => {
  const text = `${HEAD}\ntrusted_hash = "${HASH_A}"\n\n${HEAD}\ntrusted_hash = "${HASH_B}"\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_C)], "write");
  assert.equal(result.ok, false);
});

test("trusted_hash の行が 2 つ以上あると ok: false になる", () => {
  const text = `${HEAD}\ntrusted_hash = "${HASH_A}"\ntrusted_hash = "${HASH_B}"\n`;
  assert.equal(planTrustEdit(text, [entry(KEY, HASH_C)], "write").ok, false);
});

test("不正な hash（形式違い・大文字・長さ違い）は ok: false になり、理由が付く", () => {
  for (const bad of ["sha256:xyz", "sha1:" + "a".repeat(40), "sha256:" + "A".repeat(64), "sha256:" + "a".repeat(63), "", undefined]) {
    const result = planTrustEdit("", [entry(KEY, bad)], "write");
    assert.equal(result.ok, false, `hash ${String(bad)} を受け入れた`);
    assert.ok(typeof result.reason === "string" && result.reason.length > 0);
  }
});

test("同じキーの記録が entries に 2 つあると ok: false になる", () => {
  const result = planTrustEdit("", [entry(KEY, HASH_A), entry(KEY, HASH_B)], "write");
  assert.equal(result.ok, false);
});

// ---- レビュー指摘への対応: hooks.state の別の書式と、変更なしの末尾の改行 ----

test("[hooks.state] の本体に記録の行（キー・値）があると ok: false になる", () => {
  const inline = `[hooks.state]\n"${KEY}" = { trusted_hash = "${HASH_A}" }\n`;
  const plain = `[hooks.state]\nkey = 1\n`;
  assert.equal(planTrustEdit(inline, [entry(KEY, HASH_B)], "write").ok, false);
  assert.equal(planTrustEdit(plain, [entry(KEY, HASH_B)], "write").ok, false);
});

test("[hooks.state] の本体が空（空行・コメントだけ）なら、その表は許して追加できる", () => {
  const text = `[hooks.state]\n# 承認の記録\n\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "write");
  assert.equal(result.ok, true);
  assert.equal(result.counts.added, 1);
});

test("空白を挟んだ見出し・引用符の別の書式・裸のキーの見出しは ok: false になる", () => {
  const variants = [
    `[hooks.state . "${KEY}"]`,
    `[hooks.state.'${KEY}']`,
    `[hooks.state.${KEY}]`,
    `[ hooks . state . "${KEY}" ]`,
  ];
  for (const head of variants) {
    const result = planTrustEdit(`${head}\ntrusted_hash = "${HASH_A}"\n`, [entry(KEY, HASH_B)], "write");
    assert.equal(result.ok, false, `見出し ${head} を受け入れた`);
    assert.ok(typeof result.reason === "string" && result.reason.length > 0);
  }
});

test("正規の形の他のキーの表は許し、対象のキーの表だけを追加する", () => {
  const text = `${HEAD2}\ntrusted_hash = "${HASH_B}"\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "write");
  assert.equal(result.ok, true);
  assert.equal(result.text, `${text}\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`);
  assert.equal(result.counts.added, 1);
});

test("改行で終わらない本文で、ハッシュが一致するなら本文は完全に同じ", () => {
  const text = `${HEAD}\ntrusted_hash = "${HASH_A}"`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "write");
  assert.equal(result.ok, true);
  assert.equal(result.text, text);
  assert.deepEqual(result.counts, { ...ZERO, unchanged: 1 });
});

test("改行で終わらない本文で古いハッシュを更新しても、更新した行以外と末尾の改行の無さは保つ", () => {
  const text = `model = "x"\n${HEAD}\ntrusted_hash = "${HASH_A}"`;
  const result = planTrustEdit(text, [entry(KEY, HASH_B)], "write");
  assert.equal(result.ok, true);
  assert.equal(result.text, `model = "x"\n${HEAD}\ntrusted_hash = "${HASH_B}"`);
  assert.deepEqual(result.counts, { ...ZERO, updated: 1 });
});

// ---- レビュー指摘への対応（2 回目）: hooks・state の別表記をキー列にそろえて判定する ----

test("最上位の単一引用符のキー 'hooks' は ok: false になる", () => {
  assert.equal(planTrustEdit(`'hooks' = {}\n`, [entry(KEY, HASH_A)], "write").ok, false);
  assert.equal(planTrustEdit(`"hooks" = {}\n`, [entry(KEY, HASH_A)], "write").ok, false);
  assert.equal(planTrustEdit(`hooks . state = {}\n`, [entry(KEY, HASH_A)], "write").ok, false);
});

test("見出し ['hooks'] の本体の state は ok: false になる", () => {
  assert.equal(planTrustEdit(`['hooks']\nstate = {}\n`, [entry(KEY, HASH_A)], "write").ok, false);
});

test("見出し [hooks] の本体の単一引用符の 'state' は ok: false になる", () => {
  assert.equal(planTrustEdit(`[hooks]\n'state' = {}\n`, [entry(KEY, HASH_A)], "write").ok, false);
  assert.equal(planTrustEdit(`[hooks]\n"state".x = 1\n`, [entry(KEY, HASH_A)], "write").ok, false);
});

test("引用符・空白を含む [hooks] の見出し（[ \"hooks\" ]）の本体の state は ok: false になる", () => {
  assert.equal(planTrustEdit(`[ "hooks" ]\nstate = {}\n`, [entry(KEY, HASH_A)], "write").ok, false);
});

test("正規化できないキー（引用符の閉じ忘れ）は安全側で ok: false になる", () => {
  assert.equal(planTrustEdit(`'hooks = {}\n`, [entry(KEY, HASH_A)], "write").ok, false);
  assert.equal(planTrustEdit(`[projects."/a\n`, [entry(KEY, HASH_A)], "write").ok, false);
});

test("hooks を含むが無関係なキーは拒否しない（[projects.\"/a/hooks\"]・最上位の hooks_enabled・他の表の hooks・state）", () => {
  const texts = [
    `[projects."/a/hooks"]\nk = 1\n`,
    `hooks_enabled = true\n`,
    `[projects]\nhooks = 1\nstate = 2\n`,
    `[profiles.x]\nhooks = { a = 1 }\n`,
  ];
  for (const text of texts) {
    const result = planTrustEdit(text, [entry(KEY, HASH_A)], "write");
    assert.equal(result.ok, true, `誤って拒否した: ${JSON.stringify(text)} / ${result.reason ?? ""}`);
    assert.equal(result.counts.added, 1);
  }
});

// ---- 許可リスト方式（タスク 2.2 の修正）: 安全と確認できた書式だけを通す ----

/** 拒否の戻り値の形（理由が日本語の文字列で、本文（text）を含まない） */
const isRefusal = (r) => r.ok === false && typeof r.reason === "string" && r.reason.length > 0 && !("text" in r);
/** 対象の表の本体に行を並べた本文 */
const stateBody = (lines, head = HEAD) => `${head}\n${lines.join("\n")}\n`;

test("対象の表の本体で、ドット付き・引用符付きの trusted_hash は ok: false になる", () => {
  assert.ok(isRefusal(planTrustEdit(stateBody(["trusted_hash.foo = 1"]), [entry(KEY, HASH_A)], "write")));
  assert.ok(isRefusal(planTrustEdit(stateBody(['"trusted_hash".foo = 1']), [entry(KEY, HASH_A)], "write")));
  assert.ok(isRefusal(planTrustEdit(stateBody([`"trusted_hash" = "${HASH_A}"`]), [entry(KEY, HASH_A)], "write")));
});

test("表の本体で、引用符付きの単一キー（'enabled' など）は ok: false になる", () => {
  assert.ok(isRefusal(planTrustEdit(stateBody(["'enabled' = true"]), [entry(KEY, HASH_A)], "write")));
  assert.ok(isRefusal(planTrustEdit(stateBody(['"enabled" = true']), [entry(KEY, HASH_A)], "write")));
});

test("表の本体で、複数行の値やインライン表は ok: false になる", () => {
  assert.ok(isRefusal(planTrustEdit(stateBody(["enabled = [", "  1,", "]"]), [entry(KEY, HASH_A)], "write")));
  assert.ok(isRefusal(planTrustEdit(stateBody(["x = { a = 1 }"]), [entry(KEY, HASH_A)], "write")));
});

test("表の本体で、同じキーが 2 つあると ok: false になる", () => {
  assert.ok(isRefusal(planTrustEdit(stateBody(["enabled = true", "enabled = false"]), [entry(KEY, HASH_A)], "write")));
  assert.ok(isRefusal(planTrustEdit(stateBody([`trusted_hash = "${HASH_B}"`, `trusted_hash = "${HASH_C}"`]), [entry(KEY, HASH_A)], "write")));
});

test("trusted_hash の値が二重引用符の文字列ではない（数値・継続の行）は ok: false になる", () => {
  assert.ok(isRefusal(planTrustEdit(stateBody(["trusted_hash = 1"]), [entry(KEY, HASH_A)], "write")));
  assert.ok(isRefusal(planTrustEdit(stateBody([`trusted_hash = "${HASH_B}" "x"`]), [entry(KEY, HASH_A)], "write")));
  assert.ok(isRefusal(planTrustEdit(stateBody(['trusted_hash = "a', '  b"']), [entry(KEY, HASH_A)], "write")));
});

test("[[hooks]]（配列の表）は、どの本体でも ok: false になる", () => {
  assert.ok(isRefusal(planTrustEdit(`[[hooks]]\nname = "x"\n`, [entry(KEY, HASH_A)], "write")));
  assert.ok(isRefusal(planTrustEdit(`[[hooks]]\nstate = 1\n`, [entry(KEY, HASH_A)], "write")));
  assert.ok(isRefusal(planTrustEdit(`[[hooks]]\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`, [entry(KEY, HASH_B)], "write")));
});

test("hooks.state の配列の表（[[hooks.state]]・[[hooks.state.\"…\"]]）は ok: false になる", () => {
  assert.ok(isRefusal(planTrustEdit(`[[hooks.state]]\nk = 1\n`, [entry(KEY, HASH_A)], "write")));
  assert.ok(isRefusal(planTrustEdit(`[[hooks.state."${KEY2}"]]\ntrusted_hash = "${HASH_B}"\n`, [entry(KEY, HASH_A)], "write")));
});

test("別の表記の親表（[hooks.\"state\"]・[ \"hooks\" . \"state\" ]）の本体の記録は ok: false になる", () => {
  assert.ok(isRefusal(planTrustEdit(`[hooks."state"]\n"${KEY2}" = 1\n`, [entry(KEY, HASH_A)], "write")));
  assert.ok(isRefusal(planTrustEdit(`[ "hooks" . "state" ]\nk = 1\n`, [entry(KEY, HASH_A)], "write")));
  assert.ok(isRefusal(planTrustEdit(`[hooks.state]\nk = 1\n`, [entry(KEY, HASH_A)], "write")));
});

test("正規の形の見出しの下にさらに下の表（[hooks.state.\"…\".x]）があると ok: false になる", () => {
  assert.ok(isRefusal(planTrustEdit(`${HEAD2}\n[hooks.state."${KEY2}".x]\nk = 1\n`, [entry(KEY, HASH_A)], "write")));
});

test("複数のエントリーの途中の表が不安全なら、変更せず ok: false になる", () => {
  const text = `${HEAD}\ntrusted_hash = "${HASH_A}"\n\n${HEAD2}\ntrusted_hash.foo = 1\n`;
  assert.ok(isRefusal(planTrustEdit(text, [entry(KEY, HASH_B), entry(KEY2, HASH_C)], "write")));
});

test("対象でない別のキーの [hooks.state.\"別\"] の表の本体が不安全なら、対象のキーでも ok: false になる", () => {
  const text = `${HEAD2}\ntrusted_hash = "${HASH_B}"\n"enabled" = true\n`;
  assert.ok(isRefusal(planTrustEdit(text, [entry(KEY, HASH_A)], "write")));
});

test("キーに制御文字・改行・単独のサロゲートがあると、表を作らず ok: false になる", () => {
  for (const key of ["/p/a\u0001:stop:0:0", "/p/a\n:stop:0:0", "/p/a\u007f:stop:0:0", "/p/\ud800:stop:0:0", "/p/\udc00:stop:0:0"]) {
    const result = planTrustEdit("", [entry(key, HASH_A)], "write");
    assert.ok(isRefusal(result), `キー ${JSON.stringify(key)} を受け入れた`);
  }
});

test("キーに通常の文字（引用符・バックスラッシュ・絵文字）があるときは、表を作れる", () => {
  const key = '/p/"q"\\x:stop:0:0 😀';
  const result = planTrustEdit("", [entry(key, HASH_A)], "write");
  assert.equal(result.ok, true);
  assert.equal(result.text, `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "${HASH_A}"\n`);
});

test("他の表の中の、値の途中の行（複数行の配列）は検証せず、ok: true になる（旧: 一律に拒否していた）", () => {
  const text = `[projects]\nargs = [\n  "a",\n]\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "write");
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.text, `${text}\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`);
});

test("最上位の hooks.foo（ドット付き）も ok: false になる", () => {
  assert.ok(isRefusal(planTrustEdit(`hooks.foo = 1\n`, [entry(KEY, HASH_A)], "write")));
});

test("Codex の記録形式（enabled を持つ表）は、ハッシュだけ更新し enabled を残す", () => {
  const text = `${HEAD}\ntrusted_hash = "${HASH_A}"\nenabled = true\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_B)], "write");
  assert.equal(result.ok, true);
  assert.equal(result.text, `${HEAD}\ntrusted_hash = "${HASH_B}"\nenabled = true\n`);
  assert.deepEqual(result.counts, { ...ZERO, updated: 1 });
});

test("コメント・単一行の配列・引用符つきの他の表は拒否せず、追加できる", () => {
  const text = [
    "# 利用者の設定",
    'model = "x"  # 注釈',
    'list = ["a", "b"]',
    "",
    "[projects.\"/a\"]",
    "trust_level = 'trusted'",
    "",
    "[hooks]",
    "# 承認",
    "",
  ].join("\n");
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "write");
  assert.equal(result.ok, true);
  assert.equal(result.text, `${text}\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`);
  assert.equal(result.counts.added, 1);
});

test("拒否のとき、入力の文字列は変わらず、text も返さない", () => {
  const text = `${HEAD}\ntrusted_hash.foo = 1\n`;
  const before = text;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "write");
  assert.ok(isRefusal(result));
  assert.equal(text, before);
});

// ---- タスク 2.2 の修正（4 回目のレビュー指摘）: 対象の表の値の厳格な検査・改行の保持・他の表の複数行の値 ----

/** 他の表の中の複数行の配列（要素の中の [ # ] を含む文字列・値の途中で [ で始まる行・行末のコメント・末尾のカンマを含む） */
const MULTILINE_OTHER_TABLE = [
  "[mcp_servers.example]",
  "args = [",
  '  "--flag",',
  '  "[#]",            # 括弧と # を含む文字列',
  "  ['a]b', 'c#d'],",
  '  ["x", "y"],',
  '  "z" # ]',
  "]",
  "",
].join("\n");

test("対象の表の本体は trusted_hash・trusted_content_hash・enabled だけを許し、他のキー・値は ok: false になる", () => {
  for (const line of ["foo = 1garbage", 'foo = "\\q"', "foo = 1", "enabled = maybe", "enabled = 1", "enabled = true garbage"]) {
    const result = planTrustEdit(stateBody([line]), [entry(KEY, HASH_A)], "write");
    assert.ok(isRefusal(result), `対象の表の ${line} を受け入れた`);
  }
});

test("対象の表の enabled（true・false・行末コメント）と trusted_content_hash の文字列は許す", () => {
  for (const lines of [["enabled = true"], ["enabled = false  # 無効"], [`trusted_content_hash = "${HASH_B}"`, "enabled = true"]]) {
    const result = planTrustEdit(stateBody(lines), [entry(KEY, HASH_A)], "write");
    assert.equal(result.ok, true, `拒否された: ${lines.join(" / ")} / ${result.reason ?? ""}`);
    assert.equal(result.counts.updated, 1);
  }
});

test("対象の表の trusted_content_hash にエスケープを含む値は ok: false になる", () => {
  assert.ok(isRefusal(planTrustEdit(stateBody(['trusted_content_hash = "a\\"b"']), [entry(KEY, HASH_A)], "write")));
});

test("無関係な表の複数行の配列は検証せず、本文を保ったまま記録を追加する", () => {
  const text = MULTILINE_OTHER_TABLE;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "write");
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.text, `${text}\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`);
  assert.equal(result.counts.added, 1);
});

test("閉じていない括弧・引用符、対応の取れない閉じ括弧があると、他の表の中でも ok: false になる", () => {
  assert.ok(isRefusal(planTrustEdit(`[mcp_servers.example]\nargs = [\n  "a",\n`, [entry(KEY, HASH_A)], "write")));
  assert.ok(isRefusal(planTrustEdit(`[mcp_servers.example]\nargs = [\n  "a]\n]\n`, [entry(KEY, HASH_A)], "write")));
  assert.ok(isRefusal(planTrustEdit(`x = 1]\n`, [entry(KEY, HASH_A)], "write")));
});

test("CRLF の本文に追加・更新・変更なしをしても、LF だけの改行が混ざらず、末尾の改行の有無は入力と一致する", () => {
  const texts = [
    `model = "x"\r\n`,
    `model = "x"\r\nk = 1`,
    `model = "x"\r\n${HEAD}\r\ntrusted_hash = "${HASH_B}"\r\n`,
    `model = "x"\r\n${HEAD}\r\ntrusted_hash = "${HASH_B}"`,
    `${HEAD}\r\ntrusted_hash = "${HASH_B}"\r\n`,
    `${HEAD}\r\nenabled = true`,
    `${HEAD}\r\n`,
  ];
  for (const text of texts) {
    for (const hash of [HASH_A, HASH_B]) {
      const result = planTrustEdit(text, [entry(KEY, hash)], "write");
      assert.equal(result.ok, true, `拒否された: ${JSON.stringify(text)} / ${result.reason ?? ""}`);
      assert.equal(result.text.replace(/\r\n/g, "").includes("\n"), false, `LF が混ざった: ${JSON.stringify(result.text)}`);
      assert.equal(result.text.endsWith("\n"), text.endsWith("\n"), `末尾の改行の有無が変わった: ${JSON.stringify(result.text)}`);
    }
  }
});

test("CRLF の本文で複数件を追加しても、追加する行は CRLF だけで書く", () => {
  const text = `model = "x"\r\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A), entry(KEY2, HASH_B)], "write");
  assert.equal(result.ok, true);
  assert.equal(result.text.replace(/\r\n/g, "").includes("\n"), false);
  assert.equal(result.text, `${text}\r\n${HEAD}\r\ntrusted_hash = "${HASH_A}"\r\n\r\n${HEAD2}\r\ntrusted_hash = "${HASH_B}"\r\n`);
});

// ---- 5 回目のレビュー指摘: 基本文字列で許されない制御文字（タブは許す） ----

test("別の対象表の trusted_hash・trusted_content_hash に制御文字（U+0001・U+007F・U+001F）があると、ok: false になり本文は変わらない", () => {
  for (const ch of ["\u0001", "\u007f", "\u001f"]) {
    for (const name of ["trusted_hash", "trusted_content_hash"]) {
      const text = `${HEAD2}\n${name} = "a${ch}b"\n`;
      const before = text;
      const result = planTrustEdit(text, [entry(KEY, HASH_A)], "write");
      assert.ok(isRefusal(result), `${name} の制御文字 ${JSON.stringify(ch)} を受け入れた`);
      assert.equal(text, before);
    }
  }
});

test("対象の表の行末のコメントに制御文字があると ok: false になる", () => {
  assert.ok(isRefusal(planTrustEdit(stateBody(["enabled = true # a\u0001"]), [entry(KEY, HASH_A)], "write")));
});

test("値の中のタブは許す（TOML の基本文字列で許されるため）", () => {
  const text = `${HEAD2}\ntrusted_hash = "a\tb"\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "write");
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.counts.added, 1);
});

// ---- タスク 2.3: 承認の記録の取り除き（mode "remove"） ----

const REMOVE_NOTHING = { ...ZERO };

test("一致する記録だけを持つ表は、表ごと外れて removed に数える（前の空行も 1 つ外す）", () => {
  const text = `model = "x"\n\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "remove");
  assert.deepEqual(result, { ok: true, text: `model = "x"\n`, counts: { ...ZERO, removed: 1 } });
});

test("enabled を持つ表は表が残り、一致する trusted_hash の行だけが外れる", () => {
  const text = `${HEAD}\ntrusted_hash = "${HASH_A}"\nenabled = true\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "remove");
  assert.equal(result.ok, true);
  assert.equal(result.text, `${HEAD}\nenabled = true\n`);
  assert.deepEqual(result.counts, { ...ZERO, removed: 1 });
});

test("trusted_content_hash を持つ表も、trusted_hash の行だけが外れる", () => {
  const text = `${HEAD}\ntrusted_content_hash = "${HASH_C}"\ntrusted_hash = "${HASH_A}"\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "remove");
  assert.equal(result.ok, true);
  assert.equal(result.text, `${HEAD}\ntrusted_content_hash = "${HASH_C}"\n`);
  assert.deepEqual(result.counts, { ...ZERO, removed: 1 });
});

test("一致しない記録（別のハッシュ）は残り、unchanged に数える", () => {
  const text = `${HEAD}\ntrusted_hash = "${HASH_A}"\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_B)], "remove");
  assert.deepEqual(result, { ok: true, text, counts: { ...ZERO, unchanged: 1 } });
});

test("trusted_hash の行が無い表は残り、unchanged に数える", () => {
  const text = `${HEAD}\nenabled = true\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "remove");
  assert.deepEqual(result, { ok: true, text, counts: { ...ZERO, unchanged: 1 } });
});

test("表が無ければ何も起きず、どの件数にも数えない（入力と同じ文字列）", () => {
  const text = `model = "x"\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "remove");
  assert.deepEqual(result, { ok: true, text, counts: REMOVE_NOTHING });
});

test("他の表・コメント・他の記録は変わらず、対象の記録だけが外れる", () => {
  const lines = [
    "# 利用者の設定",
    'model = "x"  # 注釈',
    "",
    '[projects."/a"]',
    "trust_level = 'trusted'",
    "",
    HEAD2,
    `trusted_hash = "${HASH_C}"`,
    "enabled = true",
    "",
    HEAD,
    `trusted_hash = "${HASH_A}"`,
  ];
  const result = planTrustEdit(lines.join("\n") + "\n", [entry(KEY, HASH_A)], "remove");
  assert.equal(result.ok, true);
  // 対象の表とその前の空行だけが消え、残りは元の行のまま
  assert.equal(result.text, lines.slice(0, 9).join("\n") + "\n");
  assert.deepEqual(result.counts, { ...ZERO, removed: 1 });
});

test("複数件の混在（一致・不一致・表が無い）で、件数と本文が正しい", () => {
  const text = `${HEAD2}\ntrusted_hash = "${HASH_C}"\nenabled = true\n\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`;
  const absent = "/p/.codex/hooks.json:pre_tool_use:0:0";
  const result = planTrustEdit(
    text,
    [entry(KEY, HASH_A), entry(KEY2, HASH_A), entry(absent, HASH_A)],
    "remove",
  );
  assert.equal(result.ok, true);
  assert.equal(result.text, `${HEAD2}\ntrusted_hash = "${HASH_C}"\nenabled = true\n`);
  assert.deepEqual(result.counts, { added: 0, updated: 0, unchanged: 1, removed: 1 });
});

test("先頭の表を外すとき、後ろの表が空行の重なりなしで残る", () => {
  const text = `${HEAD}\ntrusted_hash = "${HASH_A}"\n\n[projects."/a"]\nx = 1\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "remove");
  assert.equal(result.text, `[projects."/a"]\nx = 1\n`);
});

test("途中の表を外すとき、前後の空行が 1 つだけ残る", () => {
  const text = `model = "x"\n\n${HEAD}\ntrusted_hash = "${HASH_A}"\n\n[projects."/a"]\nx = 1\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "remove");
  assert.equal(result.text, `model = "x"\n\n[projects."/a"]\nx = 1\n`);
});

test("空行の無い途中の表を外しても、前後の行をつなげて残す", () => {
  const text = `a = 1\n${HEAD}\ntrusted_hash = "${HASH_A}"\n[projects."/a"]\nx = 1\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "remove");
  assert.equal(result.text, `a = 1\n[projects."/a"]\nx = 1\n`);
});

test("末尾の表を外すとき、直前の空行も外して末尾に空行を残さない", () => {
  const text = `model = "x"\n\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`;
  assert.equal(planTrustEdit(text, [entry(KEY, HASH_A)], "remove").text, `model = "x"\n`);
  const noBlank = `model = "x"\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`;
  assert.equal(planTrustEdit(noBlank, [entry(KEY, HASH_A)], "remove").text, `model = "x"\n`);
});

test("本文の先頭の空行の後ろの表を外すと、空の本文になる", () => {
  const text = `\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`;
  assert.equal(planTrustEdit(text, [entry(KEY, HASH_A)], "remove").text, "");
});

test("(1) 本体にコメントのある表は表を残し、trusted_hash の行だけを外す（見出しとコメントが残る）", () => {
  const text = `model = "x"\n\n${HEAD}\n# 注釈\ntrusted_hash = "${HASH_A}"\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "remove");
  assert.deepEqual(result, { ok: true, text: `model = "x"\n\n${HEAD}\n# 注釈\n`, counts: { ...ZERO, removed: 1 } });
});

test("(2) 次の表の直前の説明コメント（空行をはさんで見出しの直前）は消えない", () => {
  const text = `${HEAD}\ntrusted_hash = "${HASH_A}"\n\n# 次の表の説明\n[projects."/a"]\nx = 1\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "remove");
  assert.equal(result.ok, true);
  assert.equal(result.text, `${HEAD}\n\n# 次の表の説明\n[projects."/a"]\nx = 1\n`);
  assert.deepEqual(result.counts, { ...ZERO, removed: 1 });
});

test("(3) 本体が trusted_hash の行と空行だけなら、空行を含めて表ごと外れる", () => {
  const text = `model = "x"\n\n${HEAD}\ntrusted_hash = "${HASH_A}"\n\n\n[projects."/a"]\nx = 1\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "remove");
  // 表の前の空行は残り、表の後ろの空行（表の本体）は外れる。直後が次の見出しなので空行は重ならない
  assert.equal(result.text, `model = "x"\n\n[projects."/a"]\nx = 1\n`);
  assert.deepEqual(result.counts, { ...ZERO, removed: 1 });
});

test("外した結果が空になるとき、末尾の改行の有無によらず空文字列になる", () => {
  assert.equal(planTrustEdit(`${HEAD}\ntrusted_hash = "${HASH_A}"\n`, [entry(KEY, HASH_A)], "remove").text, "");
  assert.equal(planTrustEdit(`${HEAD}\ntrusted_hash = "${HASH_A}"`, [entry(KEY, HASH_A)], "remove").text, "");
});

test("末尾が改行で終わらない本文で末尾の行を外すと、残る行も改行で終わらない", () => {
  const text = `${HEAD}\nenabled = true\ntrusted_hash = "${HASH_A}"`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A)], "remove");
  assert.equal(result.text, `${HEAD}\nenabled = true`);
  assert.deepEqual(result.counts, { ...ZERO, removed: 1 });
});

test("末尾が改行で終わらない本文で表ごと外すと、直前の空行を外し、改行で終わらせない", () => {
  const text = `model = "x"\n\n${HEAD}\ntrusted_hash = "${HASH_A}"`;
  assert.equal(planTrustEdit(text, [entry(KEY, HASH_A)], "remove").text, `model = "x"`);
});

test("CRLF の本文では、外した後も LF だけの行が混ざらない", () => {
  const text = `model = "x"\r\n\r\n${HEAD}\r\ntrusted_hash = "${HASH_A}"\r\n${HEAD2}\r\ntrusted_hash = "${HASH_B}"\r\nenabled = true\r\n`;
  const result = planTrustEdit(text, [entry(KEY, HASH_A), entry(KEY2, HASH_B)], "remove");
  assert.equal(result.ok, true);
  // 直後が次の見出し（空行ではない）なので、直前の空行は残る（空行が重ならない）
  assert.equal(result.text, `model = "x"\r\n\r\n${HEAD2}\r\nenabled = true\r\n`);
  assert.doesNotMatch(result.text, /(^|[^\r])\n/);
  assert.deepEqual(result.counts, { ...ZERO, removed: 2 });
});

test("CRLF の本文で表が残るとき、残る行は元の改行コードのまま", () => {
  const text = `${HEAD}\r\ntrusted_hash = "${HASH_A}"\r\nenabled = true\r\n`;
  assert.equal(planTrustEdit(text, [entry(KEY, HASH_A)], "remove").text, `${HEAD}\r\nenabled = true\r\n`);
});

test("不安全な本文は ok: false になり、text を返さない（write と同じ検査）", () => {
  const cases = [
    ['x = """', "abc", '"""', `${HEAD}\ntrusted_hash = "${HASH_A}"\n`].join("\n") + "\n",
    `model = "x\u0001"\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`,
    `${HEAD}\ntrusted_hash = "${HASH_A}"\nfoo = 1garbage\n`,
    `${HEAD}\ntrusted_hash = 1garbage\n`,
    `[hooks]\nstate = 1\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`,
    `[[hooks]]\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`,
    `model = [\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`,
  ];
  for (const text of cases) {
    const before = text;
    const result = planTrustEdit(text, [entry(KEY, HASH_A)], "remove");
    assert.ok(isRefusal(result), `拒否されなかった: ${JSON.stringify(text)}`);
    assert.equal(text, before);
  }
});

test("entries のハッシュが不正なら ok: false になる", () => {
  const text = `${HEAD}\ntrusted_hash = "${HASH_A}"\n`;
  for (const hash of ["sha256:XYZ", "sha256:" + "A".repeat(64), undefined]) {
    assert.ok(isRefusal(planTrustEdit(text, [entry(KEY, hash)], "remove")));
  }
});

test("write の後に remove をすると元の本文に戻る（表が最初から無い本文）", () => {
  const bases = [
    "",
    `model = "x"\n`,
    `model = "x"`,
    `model = "x"\r\n`,
    `# 注釈\n\n[projects."/a"]\ntrust_level = 'trusted'\n`,
    `[projects."/a"]\r\ntrust_level = 'trusted'\r\n`,
    `[projects."/a"]\ntrust_level = "x"`,
  ];
  const entries = [entry(KEY, HASH_A), entry(KEY2, HASH_B)];
  for (const base of bases) {
    const written = planTrustEdit(base, entries, "write");
    assert.equal(written.ok, true, `write が拒否された: ${JSON.stringify(base)}`);
    const removed = planTrustEdit(written.text, entries, "remove");
    assert.equal(removed.ok, true, `remove が拒否された: ${JSON.stringify(base)}`);
    assert.equal(removed.text, base, `往復で戻らない: ${JSON.stringify(base)}`);
    assert.deepEqual(removed.counts, { ...ZERO, removed: 2 });
  }
});

// ---- 検証用: 返された本文を Python の tomllib で解析する（Python 3.11 以上が無ければ省く。実行時の依存にはしない） ----

const PY_CHECK = spawnSync("python3", ["-I", "-c", "import tomllib"], { encoding: "utf8" });
const PY_SKIP =
  PY_CHECK.status === 0
    ? false
    : `python3 の tomllib が使えないため省く（${PY_CHECK.error ? PY_CHECK.error.message : PY_CHECK.stderr.trim().split("\n").pop()}）`;

/** 本文を tomllib で解析し、結果の辞書を返す（一時ディレクトリに書いて、すぐ消す） */
function parseWithTomllib(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-trust-toml-"));
  try {
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(file, text);
    const script = "import json, sys, tomllib\nwith open(sys.argv[1], 'rb') as f:\n    print(json.dumps(tomllib.load(f)))\n";
    const out = spawnSync("python3", ["-I", "-c", script, file], { encoding: "utf8" });
    if (out.status !== 0) throw new Error(`tomllib が解析できない: ${out.stderr}`);
    return JSON.parse(out.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("ok:true の本文は tomllib で解析でき、承認の記録と他の設定が保たれる", { skip: PY_SKIP }, () => {
  const cases = [
    [
      [
        "# 利用者の設定",
        'model = "x"  # 注釈',
        'list = ["a", "b"]',
        "",
        '[projects."/a"]',
        "trust_level = 'trusted'",
        "",
        `${HEAD2}`,
        `trusted_hash = "${HASH_C}"`,
        "enabled = true",
        "",
      ].join("\n"),
      [entry(KEY, HASH_A), entry(KEY2, HASH_B)],
    ],
    ["", [entry(KEY, HASH_A)]],
    [`model = "x"`, [entry(KEY, HASH_A)]],
    [`model = "x"\r\n[hooks]\r\n`, [entry(KEY, HASH_A)]],
    [`model = "x"\r\n${HEAD}\r\ntrusted_hash = "${HASH_B}"\r\n`, [entry(KEY, HASH_A)]],
    [MULTILINE_OTHER_TABLE, [entry(KEY, HASH_A), entry(KEY2, HASH_B)]],
    [`[projects."/a"]\r\nargs = [\r\n  "x",\r\n]\r\n${HEAD}\r\nenabled = true`, [entry(KEY, HASH_A)]],
  ];
  for (const [text, entries] of cases) {
    const result = planTrustEdit(text, entries, "write");
    assert.equal(result.ok, true, `拒否された: ${JSON.stringify(text)}`);
    const before = parseWithTomllib(text);
    const after = parseWithTomllib(result.text);
    for (const e of entries) {
      assert.equal(after.hooks.state[e.key].trusted_hash, e.hash, `記録が書けていない: ${e.key}`);
    }
    // 対象でない記録（enabled など）は残る
    for (const [k, v] of Object.entries(before.hooks?.state ?? {})) {
      if (entries.some((e) => e.key === k)) continue;
      assert.deepEqual(after.hooks.state[k], v, `対象でない記録が変わった: ${k}`);
    }
    // hooks.state 以外の設定は変わらない
    const strip = (d) => {
      const copy = { ...d };
      delete copy.hooks;
      return copy;
    };
    assert.deepEqual(strip(after), strip(before), "hooks 以外の設定が変わった");
  }
});

test("remove の出力も tomllib で解析でき、対象の記録だけが外れ、他の設定が保たれる", { skip: PY_SKIP }, () => {
  const cases = [
    {
      text: [
        "# 利用者の設定",
        'model = "x"  # 注釈',
        "",
        '[projects."/a"]',
        "trust_level = 'trusted'",
        "",
        HEAD,
        `trusted_hash = "${HASH_A}"`,
        "enabled = true",
        "",
        HEAD2,
        `trusted_hash = "${HASH_C}"`,
        "",
      ].join("\n"),
      entries: [entry(KEY, HASH_A), entry(KEY2, HASH_A)],
      // KEY は enabled を持つので表は残り、trusted_hash だけが外れる。KEY2 は一致しないので残る
      expectedState: { [KEY]: { enabled: true }, [KEY2]: { trusted_hash: HASH_C } },
    },
    {
      text: `model = "x"\n\n${HEAD}\ntrusted_hash = "${HASH_A}"\n\n[projects."/a"]\nx = 1\n`,
      entries: [entry(KEY, HASH_A)],
      expectedState: {},
    },
    {
      text: `model = "x"\r\n\r\n${HEAD}\r\ntrusted_hash = "${HASH_A}"\r\n${HEAD2}\r\ntrusted_hash = "${HASH_C}"\r\nenabled = false\r\n`,
      entries: [entry(KEY, HASH_A), entry(KEY2, HASH_C)],
      expectedState: { [KEY2]: { enabled: false } },
    },
    {
      text: `${MULTILINE_OTHER_TABLE}\n${HEAD}\ntrusted_hash = "${HASH_A}"\n`,
      entries: [entry(KEY, HASH_A)],
      expectedState: {},
    },
  ];
  const stateOf = (d) => d.hooks?.state ?? {};
  for (const { text, entries, expectedState } of cases) {
    const result = planTrustEdit(text, entries, "remove");
    assert.equal(result.ok, true, `拒否された: ${JSON.stringify(text)}`);
    const before = parseWithTomllib(text);
    const after = parseWithTomllib(result.text);
    assert.deepEqual(stateOf(after), expectedState, `記録の結果が想定と違う: ${JSON.stringify(text)}`);
    const strip = (d) => {
      const copy = { ...d };
      delete copy.hooks;
      return copy;
    };
    assert.deepEqual(strip(after), strip(before), "hooks 以外の設定が変わった");
  }
});

// ---- 結果の表示文（タスク 2.4・要件 1.6, 2.3, 4.3, 4.4） ----

const TRUST_LINE =
  "プロジェクトを Codex が信頼していないと、フックは読まれません。最初の確認画面か codex exec --trust で信頼してください。シンボリックリンク経由で開いたリポジトリでは、承認が効かない場合があります。";
const MANUAL_LINE =
  "手で承認するには、対話の codex を起動して「Hooks need review」の画面で承認してください（codex exec は未承認のフックを黙って飛ばします）。未承認の間は AGENTS.md の指示に従い、手順書を直接読んでください。";
const CONFIG_PATH = "/home/u/.codex/config.toml";

test("messageTrust: written は書いた場所・件数と、プロジェクトの信頼の行を返す", () => {
  const lines = messageTrust({
    status: "written",
    configPath: CONFIG_PATH,
    counts: { added: 2, updated: 1, unchanged: 5, removed: 0 },
    reason: null,
    notes: [],
  });
  assert.deepEqual(lines, [
    `Codex のフックの承認の記録を書きました: ${CONFIG_PATH}（追加 2・更新 1・変更なし 5）`,
    TRUST_LINE,
  ]);
});

test("messageTrust: unchanged は最新である旨・件数と、プロジェクトの信頼の行を返す", () => {
  const lines = messageTrust({
    status: "unchanged",
    configPath: CONFIG_PATH,
    counts: { added: 0, updated: 0, unchanged: 8, removed: 0 },
    reason: null,
    notes: [],
  });
  assert.deepEqual(lines, [
    `Codex のフックの承認の記録は最新です: ${CONFIG_PATH}（変更なし 8）`,
    TRUST_LINE,
  ]);
});

test("messageTrust: removed は取り除いた件数と残した件数を返し、案内を足さない", () => {
  const lines = messageTrust({
    status: "removed",
    configPath: CONFIG_PATH,
    counts: { added: 0, updated: 0, unchanged: 3, removed: 1 },
    reason: null,
    notes: [],
  });
  assert.deepEqual(lines, [
    `Codex のフックの承認の記録を取り除きました: ${CONFIG_PATH}（取り除き 1・残した 3）`,
  ]);
});

test("messageTrust: skipped は理由と手での承認の案内を返す", () => {
  const lines = messageTrust({
    status: "skipped",
    configPath: null,
    counts: null,
    reason: "Codex の設定ディレクトリがありません",
    notes: [],
  });
  assert.deepEqual(lines, [
    "Codex のフックの承認の記録は変更していません: Codex の設定ディレクトリがありません",
    MANUAL_LINE,
  ]);
});

test("messageTrust: failed は設定を変えていない旨・理由と手での承認の案内を返す", () => {
  const lines = messageTrust({
    status: "failed",
    configPath: CONFIG_PATH,
    counts: null,
    reason: "読み取り専用です",
    notes: [],
  });
  assert.deepEqual(lines, [
    "Codex のフックの承認の記録を書けませんでした（設定は変更していません）: 読み取り専用です",
    MANUAL_LINE,
  ]);
});

test("messageTrust: disabled は設定 codex.trustHooks が false である旨と手での承認の案内を返す", () => {
  const lines = messageTrust({
    status: "disabled",
    configPath: CONFIG_PATH,
    counts: null,
    reason: "設定で止めています",
    notes: [],
  });
  assert.deepEqual(lines, [
    "Codex のフックの承認の記録は変更していません: 設定 codex.trustHooks が false です。",
    MANUAL_LINE,
  ]);
});

test("messageTrust: notes は最後に「注意:」の行として並ぶ", () => {
  const lines = messageTrust({
    status: "written",
    configPath: CONFIG_PATH,
    counts: { added: 1, updated: 0, unchanged: 0, removed: 0 },
    reason: null,
    notes: ["本体の hooks.json が違います", "二つ目の注意"],
  });
  assert.deepEqual(lines.slice(-2), ["注意: 本体の hooks.json が違います", "注意: 二つ目の注意"]);
  assert.equal(lines.length, 4);
  assert.equal(lines[1], TRUST_LINE);

  const skipped = messageTrust({ status: "skipped", reason: "理由", notes: ["補足"] });
  assert.deepEqual(skipped.slice(-1), ["注意: 補足"]);
});

test("messageTrust: reason が無いときは「理由は不明です」とする", () => {
  for (const status of ["skipped", "failed"]) {
    const lines = messageTrust({ status, configPath: CONFIG_PATH, counts: null, reason: null, notes: [] });
    assert.ok(lines[0].endsWith("理由は不明です"), `${status}: ${lines[0]}`);
  }
  const noReason = messageTrust({ status: "failed" });
  assert.ok(noReason[0].endsWith("理由は不明です"));
});

test("messageTrust: configPath が無いときは「（設定ファイルの場所は不明）」とする", () => {
  const written = messageTrust({
    status: "written",
    configPath: null,
    counts: { added: 1, updated: 0, unchanged: 0, removed: 0 },
    reason: null,
    notes: [],
  });
  assert.equal(written[0], "Codex のフックの承認の記録を書きました: （設定ファイルの場所は不明）（追加 1・更新 0・変更なし 0）");

  const removed = messageTrust({ status: "removed", counts: { added: 0, updated: 0, unchanged: 0, removed: 2 } });
  assert.equal(removed[0], "Codex のフックの承認の記録を取り除きました: （設定ファイルの場所は不明）（取り除き 2・残した 0）");

  const unchanged = messageTrust({ status: "unchanged", counts: null });
  assert.equal(unchanged[0], "Codex のフックの承認の記録は最新です: （設定ファイルの場所は不明）");
});

test("messageTrust: counts が無いときは件数の括弧を省く", () => {
  const written = messageTrust({ status: "written", configPath: CONFIG_PATH, counts: null, notes: [] });
  assert.equal(written[0], `Codex のフックの承認の記録を書きました: ${CONFIG_PATH}`);
  const removed = messageTrust({ status: "removed", configPath: CONFIG_PATH });
  assert.equal(removed[0], `Codex のフックの承認の記録を取り除きました: ${CONFIG_PATH}`);
});

test("messageTrust: 想定外の status は 1 行の判別できない旨を返し、例外を投げない", () => {
  assert.deepEqual(messageTrust({ status: "bogus", configPath: CONFIG_PATH, counts: null, reason: null, notes: [] }), [
    "Codex のフックの承認の記録: 結果を判別できませんでした（bogus）",
  ]);
  assert.deepEqual(messageTrust({ status: undefined }), [
    "Codex のフックの承認の記録: 結果を判別できませんでした（undefined）",
  ]);
  assert.deepEqual(messageTrust(null), [
    "Codex のフックの承認の記録: 結果を判別できませんでした（undefined）",
  ]);
});

test("messageTrust: 行はどれも空でなく、改行を含まず、プロジェクトの信頼の行は written と unchanged だけにある", () => {
  const cases = [
    { status: "written", configPath: CONFIG_PATH, counts: { added: 1, updated: 0, unchanged: 0, removed: 0 }, notes: ["n"] },
    { status: "unchanged", configPath: CONFIG_PATH, counts: { added: 0, updated: 0, unchanged: 1, removed: 0 } },
    { status: "removed", configPath: CONFIG_PATH, counts: { added: 0, updated: 0, unchanged: 0, removed: 1 } },
    { status: "skipped", reason: "r" },
    { status: "failed", reason: "r" },
    { status: "disabled" },
    { status: "bogus" },
  ];
  for (const result of cases) {
    const lines = messageTrust(result);
    for (const line of lines) {
      assert.ok(line.length > 0, `空行がある: ${result.status}`);
      assert.ok(!line.includes("\n"), `改行を含む: ${result.status}`);
    }
    const hasTrust = lines.some((l) => l.includes("プロジェクトを Codex が信頼していない"));
    const expectTrust = result.status === "written" || result.status === "unchanged";
    assert.equal(hasTrust, expectTrust, `信頼の行の有無が違う: ${result.status}`);
  }
});

test("messageTrust: removed は手での承認の案内を含まず、skipped・failed・disabled は含む", () => {
  const removed = messageTrust({ status: "removed", configPath: CONFIG_PATH, counts: null });
  assert.ok(!removed.some((l) => l.includes("Hooks need review")));
  for (const status of ["skipped", "failed", "disabled"]) {
    const lines = messageTrust({ status, reason: "r", configPath: CONFIG_PATH, counts: null });
    assert.ok(lines.some((l) => l.includes("「Hooks need review」の画面で承認")), status);
  }
});

test("messageTrust: 入力を変更しない（純粋）", () => {
  const input = {
    status: "written",
    configPath: CONFIG_PATH,
    counts: { added: 1, updated: 2, unchanged: 3, removed: 0 },
    reason: null,
    notes: ["注意"],
  };
  const before = structuredClone(input);
  const first = messageTrust(input);
  const second = messageTrust(input);
  assert.deepEqual(input, before);
  assert.deepEqual(first, second);
});

test("trustIsEffective: written と unchanged だけ true", () => {
  assert.equal(trustIsEffective({ status: "written" }), true);
  assert.equal(trustIsEffective({ status: "unchanged" }), true);
  for (const status of ["removed", "skipped", "failed", "disabled", "bogus"]) {
    assert.equal(trustIsEffective({ status }), false, status);
  }
  assert.equal(trustIsEffective(null), false);
  assert.equal(trustIsEffective({}), false);
});
