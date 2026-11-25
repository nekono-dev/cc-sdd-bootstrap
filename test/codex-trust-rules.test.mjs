import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNED_MARKER, computeTrustEntries } from "../.agent-hooks/cc-sdd-bootstrap/codex-trust-rules.mjs";
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
