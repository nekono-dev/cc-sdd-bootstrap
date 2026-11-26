// 版と指紋の記録（freshness-rules.mjs）の単体試験。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  RECORD_PATH,
  DISTRIBUTION_REPO,
  fingerprint,
  buildRecord,
  parseRecord,
  inspectFiles,
  isPinnedRef,
  remoteQuery,
  pickRemoteCommit,
  compareLatest,
  updateCommand,
  decideNotice,
  messageNotice,
} from "../.agent-hooks/cc-sdd-bootstrap/freshness-rules.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("記録の場所と配布元の定数を持つ", () => {
  assert.equal(RECORD_PATH, ".agent-hooks/cc-sdd-bootstrap/install-record.json");
  assert.equal(DISTRIBUTION_REPO, "https://github.com/nekono-dev/cc-sdd-bootstrap");
});

test("指紋は内容の SHA-256 の 16 進（文字列と Buffer で同じ値）", () => {
  const expected = createHash("sha256").update("hello").digest("hex");
  assert.equal(fingerprint("hello"), expected);
  assert.equal(fingerprint(Buffer.from("hello")), expected);
  assert.match(fingerprint("hello"), /^[0-9a-f]{64}$/);
});

test("同じ入力からは同じ記録の文字列になる", () => {
  const input = {
    source: { commit: COMMIT, ref: "dev/x" },
    files: { "b.mjs": "bbb", "a.mjs": "aaa" },
  };
  assert.equal(buildRecord(input), buildRecord(input));
});

test("記録はキー昇順・インデント 2・末尾改行で、指紋は内容から計算される", () => {
  const text = buildRecord({
    source: { commit: COMMIT, ref: "main" },
    files: { "z/last.mjs": "zzz", ".agent-hooks/a.md": "aaa" },
  });

  assert.ok(text.endsWith("\n"));
  assert.equal(text.endsWith("\n\n"), false);
  // トップレベルのキーの順: files, format, source
  assert.ok(text.indexOf('"files"') < text.indexOf('"format"'));
  assert.ok(text.indexOf('"format"') < text.indexOf('"source"'));
  // files の中も昇順（".agent-hooks/..." が "z/..." より前）
  assert.ok(text.indexOf(".agent-hooks/a.md") < text.indexOf("z/last.mjs"));
  // source の中も昇順（commit が ref より前）
  assert.ok(text.indexOf('"commit"') < text.indexOf('"ref"'));
  // インデント 2
  assert.match(text, /^\{\n  "files": \{\n    "\.agent-hooks\/a\.md": "/);

  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, {
    files: {
      ".agent-hooks/a.md": fingerprint("aaa"),
      "z/last.mjs": fingerprint("zzz"),
    },
    format: 1,
    source: { commit: COMMIT, ref: "main" },
  });
});

test("取り出せなかった版は commit: null のまま記録する（1.3）", () => {
  const text = buildRecord({
    source: { commit: null, ref: null },
    files: { "a.mjs": "aaa" },
  });
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.source, { commit: null, ref: null });
  assert.equal(parseRecord(text).state, "ok");
  assert.equal(parseRecord(text).record.source.commit, null);
});

test("作った記録は parseRecord で ok と判定され、内容が戻る", () => {
  const text = buildRecord({
    source: { commit: COMMIT, ref: null },
    files: { "a.mjs": "aaa" },
  });
  const result = parseRecord(text);
  assert.equal(result.state, "ok");
  assert.equal(result.record.files["a.mjs"], fingerprint("aaa"));
  assert.equal(result.record.source.commit, COMMIT);
});

test("記録が無い（null）は missing", () => {
  assert.deepEqual(parseRecord(null), { state: "missing" });
});

test("壊れた JSON は broken", () => {
  assert.deepEqual(parseRecord("{ not json"), { state: "broken" });
  assert.deepEqual(parseRecord(""), { state: "broken" });
});

test("format が 1 でないものは broken", () => {
  const text = JSON.stringify({ format: 2, files: {}, source: { commit: null, ref: null } });
  assert.deepEqual(parseRecord(text), { state: "broken" });
  const missingFormat = JSON.stringify({ files: {}, source: { commit: null, ref: null } });
  assert.deepEqual(parseRecord(missingFormat), { state: "broken" });
});

test("files の値が 64 桁の 16 進でないものは broken", () => {
  const short = JSON.stringify({ format: 1, files: { "a.mjs": "abc" }, source: { commit: null, ref: null } });
  assert.deepEqual(parseRecord(short), { state: "broken" });
  const upper = JSON.stringify({
    format: 1,
    files: { "a.mjs": "A".repeat(64) },
    source: { commit: null, ref: null },
  });
  assert.deepEqual(parseRecord(upper), { state: "broken" });
  const notString = JSON.stringify({ format: 1, files: { "a.mjs": 1 }, source: { commit: null, ref: null } });
  assert.deepEqual(parseRecord(notString), { state: "broken" });
});

test("source の形が違うものは broken", () => {
  const noSource = JSON.stringify({ format: 1, files: {} });
  assert.deepEqual(parseRecord(noSource), { state: "broken" });
  const stringSource = JSON.stringify({ format: 1, files: {}, source: "main" });
  assert.deepEqual(parseRecord(stringSource), { state: "broken" });
  const badCommit = JSON.stringify({ format: 1, files: {}, source: { commit: "xyz", ref: null } });
  assert.deepEqual(parseRecord(badCommit), { state: "broken" });
  const badRef = JSON.stringify({ format: 1, files: {}, source: { commit: null, ref: 3 } });
  assert.deepEqual(parseRecord(badRef), { state: "broken" });
});

test("正しい記録（files が空でもよい）は ok と記録本体を返す", () => {
  const text = JSON.stringify({ format: 1, files: {}, source: { commit: null, ref: "dev/x" } });
  assert.deepEqual(parseRecord(text), {
    state: "ok",
    record: { format: 1, files: {}, source: { commit: null, ref: "dev/x" } },
  });
});

test("inspectFiles: 一致・違い・欠けを分ける（2.1〜2.4、2.6）", () => {
  const record = {
    format: 1,
    files: { "c.mjs": HASH_A, "a.mjs": HASH_A, "b.mjs": HASH_B },
    source: { commit: COMMIT, ref: null },
  };
  const actual = {
    "c.mjs": HASH_B, // 内容が違う
    "a.mjs": HASH_A, // 一致
    "b.mjs": null, // 欠けている
  };
  assert.deepEqual(inspectFiles(record, actual), {
    missing: ["b.mjs"],
    changed: ["c.mjs"],
  });
});

test("inspectFiles: すべて一致なら両方空、結果はキー昇順", () => {
  const record = {
    format: 1,
    files: { "z.mjs": HASH_A, "m.mjs": HASH_A, "a.mjs": HASH_A },
    source: { commit: null, ref: null },
  };
  assert.deepEqual(inspectFiles(record, { "z.mjs": HASH_A, "m.mjs": HASH_A, "a.mjs": HASH_A }), {
    missing: [],
    changed: [],
  });

  const allGone = inspectFiles(record, { "z.mjs": null, "m.mjs": null, "a.mjs": null });
  assert.deepEqual(allGone, { missing: ["a.mjs", "m.mjs", "z.mjs"], changed: [] });
});

test("inspectFiles: actual に無い記録のキーは欠けとして扱う", () => {
  const record = {
    format: 1,
    files: { "a.mjs": HASH_A },
    source: { commit: null, ref: null },
  };
  assert.deepEqual(inspectFiles(record, {}), { missing: ["a.mjs"], changed: [] });
});

test("inspectFiles: 記録に無い actual のファイルは判定の対象にしない", () => {
  const record = {
    format: 1,
    files: { "a.mjs": HASH_A },
    source: { commit: null, ref: null },
  };
  assert.deepEqual(inspectFiles(record, { "a.mjs": HASH_A, "extra.mjs": HASH_B }), {
    missing: [],
    changed: [],
  });
});

test("buildRecord は整数形式のキーと __proto__ を欠落・並べ替えなしで昇順に書く", () => {
  const text = buildRecord({ source: { commit: null, ref: null }, files: JSON.parse('{"10":"a","2":"b","__proto__":"c"}') });
  const parsed = JSON.parse(text);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.files, "__proto__"), true);
  const filesBlock = text.slice(text.indexOf('"files"'), text.indexOf('"format"'));
  const order = [...filesBlock.matchAll(/^    "([^"]+)":/gm)].map((m) => m[1]);
  assert.deepEqual(order, ["10", "2", "__proto__"]);
});

// ---- 1.2: 最新との比較・更新コマンド・案内の判断と文面 ----

const LATEST = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";
const TAG_OBJECT = "3333333333333333333333333333333333333333";
const DEFAULT_CMD = "npx -y github:nekono-dev/cc-sdd-bootstrap update";

/** 記録の本体を手で作る（decideNotice などの入力用） */
function recordOf(commit, ref, files = {}) {
  return { format: 1, files, source: { commit, ref } };
}

test("isPinnedRef: 40 桁の小文字 16 進だけを固定のコミットとみなす", () => {
  assert.equal(isPinnedRef(COMMIT), true);
  assert.equal(isPinnedRef("0123456789abcdef0123456789abcdef0123456"), false); // 39 桁
  assert.equal(isPinnedRef("0123456789ABCDEF0123456789ABCDEF01234567"), false); // 大文字
  assert.equal(isPinnedRef("main"), false);
  assert.equal(isPinnedRef(null), false);
});

test("remoteQuery: ブランチ・タグは heads・tags・タグの ^{} の 3 パターン", () => {
  assert.deepEqual(remoteQuery({ commit: COMMIT, ref: "dev/x" }), [
    "refs/heads/dev/x",
    "refs/tags/dev/x",
    "refs/tags/dev/x^{}",
  ]);
});

test("remoteQuery: ref が無ければ HEAD、空文字も無い扱い", () => {
  assert.deepEqual(remoteQuery({ commit: COMMIT, ref: null }), ["HEAD"]);
  assert.deepEqual(remoteQuery({ commit: COMMIT, ref: "" }), ["HEAD"]);
});

test("remoteQuery: 固定のコミットは null（比較しない）", () => {
  assert.equal(remoteQuery({ commit: COMMIT, ref: COMMIT }), null);
});

test("pickRemoteCommit: ブランチは refs/heads/<ref> の行", () => {
  const out = `${LATEST}\trefs/heads/dev/x\n`;
  assert.equal(pickRemoteCommit(out, "dev/x"), LATEST);
});

test("pickRemoteCommit: 期待する refname 以外の行が 1 行でもあれば null", () => {
  assert.equal(pickRemoteCommit(`${LATEST}\trefs/heads/main\n${OTHER}\trefs/heads/other\n`, "main"), null);
  assert.equal(pickRemoteCommit(`${LATEST}\trefs/heads/dev/x\n${OTHER}\trefs/heads/other\n`, "dev/x"), null);
  assert.equal(pickRemoteCommit(`${LATEST}\tHEAD\n${OTHER}\trefs/heads/main\n`, null), null);
  assert.equal(pickRemoteCommit(`${TAG_OBJECT}\trefs/tags/v1.0.0\n${LATEST}\trefs/tags/v1.0.0^{}\n${OTHER}\trefs/heads/main\n`, "v1.0.0"), null);
});

test("pickRemoteCommit: 注釈つきタグは ^{} の行（指す先のコミット）を選ぶ", () => {
  const out = `${TAG_OBJECT}\trefs/tags/v1.0.0\n${LATEST}\trefs/tags/v1.0.0^{}\n`;
  assert.equal(pickRemoteCommit(out, "v1.0.0"), LATEST);
});

test("pickRemoteCommit: 軽いタグは refs/tags/<ref> の行", () => {
  const out = `${LATEST}\trefs/tags/v1.0.0\n`;
  assert.equal(pickRemoteCommit(out, "v1.0.0"), LATEST);
});

test("pickRemoteCommit: ref が無ければ HEAD の行（空文字も同じ）", () => {
  const out = `${LATEST}\tHEAD\n`;
  assert.equal(pickRemoteCommit(out, null), LATEST);
  assert.equal(pickRemoteCommit(out, ""), LATEST);
});

test("pickRemoteCommit: ブランチとタグが同名で両方ある・同じ refname が複数ある・HEAD が無いのは null", () => {
  const both = `${LATEST}\trefs/heads/dev/x\n${OTHER}\trefs/tags/dev/x\n`;
  assert.equal(pickRemoteCommit(both, "dev/x"), null);
  const bothPeeled = `${LATEST}\trefs/heads/v1\n${TAG_OBJECT}\trefs/tags/v1\n${OTHER}\trefs/tags/v1^{}\n`;
  assert.equal(pickRemoteCommit(bothPeeled, "v1"), null);
  const dup = `${LATEST}\tHEAD\n${OTHER}\tHEAD\n`;
  assert.equal(pickRemoteCommit(dup, null), null);
  const dupBranch = `${LATEST}\trefs/heads/x\n${OTHER}\trefs/heads/x\n`;
  assert.equal(pickRemoteCommit(dupBranch, "x"), null);
  assert.equal(pickRemoteCommit(`${LATEST}\trefs/heads/main\n`, null), null);
});

test("pickRemoteCommit: ^{} だけで本体の行が無いタグは null（対になっていない）", () => {
  assert.equal(pickRemoteCommit(`${OTHER}\trefs/tags/v2^{}\n`, "v2"), null);
});

test("pickRemoteCommit: 不正な行・空・対象が無い・固定のコミットは null", () => {
  assert.equal(pickRemoteCommit("", null), null);
  assert.equal(pickRemoteCommit("\n", null), null);
  assert.equal(pickRemoteCommit(`xyz\tHEAD\n`, null), null);
  assert.equal(pickRemoteCommit(`${LATEST} HEAD\n`, null), null); // タブでない
  assert.equal(pickRemoteCommit(`${COMMIT.toUpperCase()}\tHEAD\n`, null), null); // 大文字（英字を含む版で確かめる）
  assert.equal(pickRemoteCommit(`${LATEST}\tHEAD\nこれは不正\n`, null), null); // 一部だけ不正
  assert.equal(pickRemoteCommit(`${LATEST}\trefs/heads/main\n`, "nope"), null); // 見つからない
  assert.equal(pickRemoteCommit(`${LATEST}\tHEAD\n`, COMMIT), null); // 固定のコミットは比べない
});

test("pickRemoteCommit: 返すのは 40 桁の 16 進だけ", () => {
  const picked = pickRemoteCommit(`${LATEST}\tHEAD\n`, null);
  assert.match(picked, /^[0-9a-f]{40}$/);
});

test("compareLatest: 版が無い・最新が無い・固定のコミットは unknown", () => {
  assert.equal(compareLatest(recordOf(null, "dev/x"), LATEST), "unknown");
  assert.equal(compareLatest(recordOf(COMMIT, "dev/x"), null), "unknown");
  assert.equal(compareLatest(recordOf(COMMIT, COMMIT), LATEST), "unknown");
});

test("compareLatest: 同じなら same、異なれば behind", () => {
  assert.equal(compareLatest(recordOf(LATEST, "main"), LATEST), "same");
  assert.equal(compareLatest(recordOf(COMMIT, "main"), LATEST), "behind");
  assert.equal(compareLatest(recordOf(COMMIT, null), LATEST), "behind");
});

test("updateCommand: ブランチ・タグは #<ref> を付ける", () => {
  assert.equal(
    updateCommand({ commit: COMMIT, ref: "dev/x" }),
    "npx -y github:nekono-dev/cc-sdd-bootstrap#dev/x update",
  );
  assert.equal(
    updateCommand({ commit: null, ref: "v1.0.0" }),
    "npx -y github:nekono-dev/cc-sdd-bootstrap#v1.0.0 update",
  );
});

test("updateCommand: ref が無い・空・固定のコミットは付けない", () => {
  assert.equal(updateCommand({ commit: null, ref: null }), DEFAULT_CMD);
  assert.equal(updateCommand({ commit: null, ref: "" }), DEFAULT_CMD);
  assert.equal(updateCommand({ commit: COMMIT, ref: COMMIT }), DEFAULT_CMD);
});

test("decideNotice: 照合が一致し最新も同じなら null", () => {
  const parsed = { state: "ok", record: recordOf(LATEST, "main", { "a.mjs": HASH_A }) };
  assert.equal(decideNotice({ parsed, inspection: { missing: [], changed: [] }, latest: "same" }), null);
});

test("decideNotice: 最新が unknown で照合が一致なら案内しない", () => {
  const parsed = { state: "ok", record: recordOf(null, null, { "a.mjs": HASH_A }) };
  assert.equal(decideNotice({ parsed, inspection: { missing: [], changed: [] }, latest: "unknown" }), null);
  const parsed2 = { state: "ok", record: recordOf(COMMIT, COMMIT, { "a.mjs": HASH_A }) };
  assert.equal(decideNotice({ parsed: parsed2, inspection: { missing: [], changed: [] }, latest: "unknown" }), null);
});

test("decideNotice: 欠けがあれば案内（一覧と版の情報を持つ）", () => {
  const record = recordOf(LATEST, "main", { "a.mjs": HASH_A, "b.mjs": HASH_B });
  const notice = decideNotice({
    parsed: { state: "ok", record },
    inspection: { missing: ["b.mjs"], changed: [] },
    latest: "same",
  });
  assert.deepEqual(notice, {
    kind: "drift",
    missing: ["b.mjs"],
    changed: [],
    behind: false,
    versionUnknown: false,
    source: { commit: LATEST, ref: "main" },
  });
});

test("decideNotice: 内容の違いがあれば案内", () => {
  const record = recordOf(LATEST, null, { "a.mjs": HASH_A });
  const notice = decideNotice({
    parsed: { state: "ok", record },
    inspection: { missing: [], changed: ["a.mjs"] },
    latest: "same",
  });
  assert.equal(notice.kind, "drift");
  assert.deepEqual(notice.changed, ["a.mjs"]);
  assert.deepEqual(notice.missing, []);
  assert.equal(notice.behind, false);
});

test("decideNotice: 最新との差（behind）だけでも案内する", () => {
  const record = recordOf(COMMIT, "dev/x", { "a.mjs": HASH_A });
  const notice = decideNotice({
    parsed: { state: "ok", record },
    inspection: { missing: [], changed: [] },
    latest: "behind",
  });
  assert.equal(notice.kind, "drift");
  assert.equal(notice.behind, true);
  assert.deepEqual(notice.missing, []);
  assert.deepEqual(notice.changed, []);
  assert.equal(notice.versionUnknown, false);
});

test("decideNotice: 最新が unknown でも照合に差があれば案内する（3.4）", () => {
  const record = recordOf(COMMIT, "dev/x", { "a.mjs": HASH_A });
  const notice = decideNotice({
    parsed: { state: "ok", record },
    inspection: { missing: ["a.mjs"], changed: [] },
    latest: "unknown",
  });
  assert.equal(notice.kind, "drift");
  assert.deepEqual(notice.missing, ["a.mjs"]);
  assert.equal(notice.behind, false);
});

test("decideNotice: 版が取り出せない（commit: null）は、ほかの案内があるときだけ versionUnknown を添える", () => {
  const withDrift = decideNotice({
    parsed: { state: "ok", record: recordOf(null, null, { "a.mjs": HASH_A }) },
    inspection: { missing: ["a.mjs"], changed: [] },
    latest: "unknown",
  });
  assert.equal(withDrift.versionUnknown, true);

  const onlyVersion = decideNotice({
    parsed: { state: "ok", record: recordOf(null, null, { "a.mjs": HASH_A }) },
    inspection: { missing: [], changed: [] },
    latest: "unknown",
  });
  assert.equal(onlyVersion, null);
});

test("decideNotice: 記録が無い・壊れているは、それぞれの kind で案内する", () => {
  assert.deepEqual(decideNotice({ parsed: { state: "missing" }, inspection: null, latest: "unknown" }), {
    kind: "missing",
    missing: [],
    changed: [],
    behind: false,
    versionUnknown: false,
    source: { commit: null, ref: null },
  });
  assert.deepEqual(decideNotice({ parsed: { state: "broken" }, inspection: null, latest: "unknown" }), {
    kind: "broken",
    missing: [],
    changed: [],
    behind: false,
    versionUnknown: false,
    source: { commit: null, ref: null },
  });
});

test("decideNotice: 照合の結果が null（記録が ok でない）でも ok なら一致として扱う", () => {
  const parsed = { state: "ok", record: recordOf(LATEST, "main", { "a.mjs": HASH_A }) };
  assert.equal(decideNotice({ parsed, inspection: null, latest: "same" }), null);
});

/** 案内の文面の確認用に、決まった Notice を作る */
function notice(overrides) {
  return {
    kind: "drift",
    missing: [],
    changed: [],
    behind: false,
    versionUnknown: false,
    source: { commit: COMMIT, ref: "dev/x" },
    ...overrides,
  };
}

test("messageNotice: 戻り値は systemMessage と additionalContext の両方を持つ文字列", () => {
  const result = messageNotice(notice({ behind: true }));
  assert.equal(typeof result.systemMessage, "string");
  assert.equal(typeof result.additionalContext, "string");
  assert.ok(result.systemMessage.length > 0);
  assert.ok(result.additionalContext.length > 0);
});

test("messageNotice: 両方に更新コマンド（ref があれば #ref 付き）を含む", () => {
  const result = messageNotice(notice({ behind: true }));
  assert.ok(result.systemMessage.includes("npx -y github:nekono-dev/cc-sdd-bootstrap#dev/x update"));
  assert.ok(result.additionalContext.includes("npx -y github:nekono-dev/cc-sdd-bootstrap#dev/x update"));

  const plain = messageNotice(notice({ behind: true, source: { commit: COMMIT, ref: null } }));
  assert.ok(plain.systemMessage.includes(DEFAULT_CMD));
  assert.ok(plain.additionalContext.includes(DEFAULT_CMD));
});

test("messageNotice: additionalContext は回答より前に 1 文をそのまま出す指示を含む", () => {
  const result = messageNotice(notice({ behind: true }));
  assert.ok(result.additionalContext.includes("回答より前に"));
  assert.ok(result.additionalContext.includes("そのまま"));
  assert.ok(result.additionalContext.includes(result.systemMessage.split("\n")[0]));
});

test("messageNotice: 新しい版がある旨と、欠け・内容の違いを書く（断定しない）", () => {
  const behind = messageNotice(notice({ behind: true }));
  assert.ok(behind.systemMessage.includes("新しい版"));

  const changed = messageNotice(notice({ changed: ["a.mjs"] }));
  assert.ok(changed.additionalContext.includes("a.mjs"));
  // 編集したと断定せず、途中停止や版の混在の可能性として書く
  assert.ok(changed.additionalContext.includes("途中で止まった"));
  assert.ok(changed.additionalContext.includes("可能性"));
  assert.equal(changed.systemMessage.includes("編集しました"), false);
  assert.equal(changed.additionalContext.includes("編集しました"), false);

  const missing = messageNotice(notice({ missing: ["b.mjs"] }));
  assert.ok(missing.additionalContext.includes("b.mjs"));
  assert.ok(missing.systemMessage.includes("欠け"));
});

test("messageNotice: ファイル名は最大 5 件まで、残りは「ほか N 件」", () => {
  const names = ["f1.mjs", "f2.mjs", "f3.mjs", "f4.mjs", "f5.mjs", "f6.mjs", "f7.mjs"];
  const result = messageNotice(notice({ missing: names }));
  for (const name of names.slice(0, 5)) {
    assert.ok(result.additionalContext.includes(name), `${name} が無い`);
  }
  assert.equal(result.additionalContext.includes("f6.mjs"), false);
  assert.equal(result.additionalContext.includes("f7.mjs"), false);
  assert.ok(result.additionalContext.includes("ほか 2 件"));

  const five = messageNotice(notice({ changed: names.slice(0, 5) }));
  assert.equal(five.additionalContext.includes("ほか"), false);
});

test("messageNotice: 欠け4件と違い4件のとき、表示は合計 5 件で残りは「ほか 3 件」", () => {
  const missing = ["m1.mjs", "m2.mjs", "m3.mjs", "m4.mjs"];
  const changed = ["c1.mjs", "c2.mjs", "c3.mjs", "c4.mjs"];
  const result = messageNotice(notice({ missing, changed }));
  for (const name of [...missing, "c1.mjs"]) {
    assert.ok(result.additionalContext.includes(name), `${name} が無い`);
  }
  for (const name of ["c2.mjs", "c3.mjs", "c4.mjs"]) {
    assert.equal(result.additionalContext.includes(name), false, `${name} が表示されている`);
  }
  assert.ok(result.additionalContext.includes("ほか 3 件"));
});

test("messageNotice: additionalContext は systemMessage の全文を含む（版不明あり・なし）", () => {
  const unknown = { commit: null, ref: null };
  const cases = [
    notice({ behind: true }),
    notice({ missing: ["a.mjs"], versionUnknown: false }),
    notice({ missing: ["a.mjs"], versionUnknown: true, source: unknown }),
    notice({ changed: ["a.mjs"], versionUnknown: true, source: unknown }),
  ];
  for (const n of cases) {
    const result = messageNotice(n);
    const quoted = /:「(.*)」/.exec(result.additionalContext.split("\n")[0])?.[1];
    assert.equal(quoted, result.systemMessage, "引用符内が systemMessage の全文と一致しない");
  }
});

test("messageNotice: 版が不明なら、その旨の 1 文を両方に添える", () => {
  const sentence = "配布元の版を取り出せなかったため、最新との比較はできていません。";
  const result = messageNotice(notice({ missing: ["a.mjs"], versionUnknown: true, source: { commit: null, ref: null } }));
  assert.ok(result.systemMessage.includes(sentence));
  assert.ok(result.additionalContext.includes(sentence));

  const none = messageNotice(notice({ missing: ["a.mjs"], versionUnknown: false }));
  assert.equal(none.systemMessage.includes("取り出せなかった"), false);
  assert.equal(none.additionalContext.includes("取り出せなかった"), false);
});

test("messageNotice: 記録なし・壊れているは、古い導入に仕組みが無く初回は手で更新が必要と書く", () => {
  const missing = messageNotice({ kind: "missing", missing: [], changed: [], behind: false, versionUnknown: false, source: { commit: null, ref: null } });
  assert.ok(missing.systemMessage.includes("記録"));
  assert.ok(missing.systemMessage.includes("古い導入"));
  assert.ok(missing.systemMessage.includes("手で更新"));
  assert.ok(missing.systemMessage.includes(DEFAULT_CMD));
  assert.ok(missing.additionalContext.includes(DEFAULT_CMD));

  const broken = messageNotice({ kind: "broken", missing: [], changed: [], behind: false, versionUnknown: false, source: { commit: null, ref: null } });
  assert.ok(broken.systemMessage.includes("壊れ"));
  assert.ok(broken.additionalContext.includes("古い導入"));
  assert.ok(broken.additionalContext.includes(DEFAULT_CMD));
});
