// 停止の案内（stop-notice-rules.mjs）の単体試験。
import { test } from "node:test";
import assert from "node:assert/strict";
import { messageStopNotice, stopOutput } from "../.agent-hooks/cc-sdd-bootstrap/stop-notice-rules.mjs";

const REASON = "実現性の確認が通っていないため止めました。\n次に、記録を作ってから同じ入力を送ってください。";

test("見出し・止める指示・区切り・止めた入力・止めたこと・理由がすべて含まれる", () => {
  const text = messageStopNotice({ prompt: "/kiro-spec-tasks foo -y", reason: REASON });
  assert.ok(text.includes("【入力の停止】"), "見出し");
  assert.ok(text.includes("この入力は止められています。ほかの作業はしないでください。"), "止める指示");
  assert.ok(text.includes("次の「停止の案内」を、そのまま利用者に伝えて終えてください。"), "伝えて終える指示");
  assert.ok(text.includes("ファイルの作成と編集、状態を変えるコマンドの実行、子のエージェントの起動、ブランチの切り替えはしないでください。"), "作業をしない指示");
  assert.ok(text.includes("手順書を先に読む案内"), "手順書を先に読む案内の語");
  assert.ok(text.includes("終了を止めて手順書を読むよう求める案内"), "終了の案内の語");
  assert.ok(text.includes("作業ブランチへの切り替えの案内"), "ブランチの案内の語");
  assert.ok(text.includes("この停止を優先"), "停止を優先する旨");
  assert.ok(text.includes("--- 停止の案内 ---"), "区切り");
  assert.ok(text.includes("止めた入力: /kiro-spec-tasks foo -y"), "止めた入力");
  assert.ok(text.includes("止めたこと: この入力を止めました。"), "止めたこと");
  assert.ok(text.includes(REASON), "理由");
});

test("各行は指定の順に並ぶ", () => {
  const lines = messageStopNotice({ prompt: "x", reason: "理由" }).split("\n");
  const order = [
    "【入力の停止】",
    "- 次の「停止の案内」",
    "- ファイルの作成と編集",
    "- 同じ入力に並んで届く",
    "--- 停止の案内 ---",
    "止めた入力: x",
    "止めたこと: この入力を止めました。",
    "理由",
  ];
  const indexes = order.map((head) => lines.findIndex((line) => line.startsWith(head)));
  for (const index of indexes) assert.ok(index >= 0);
  assert.deepEqual([...indexes].sort((a, b) => a - b), indexes);
});

test("理由の文面は改変されずに含まれる（複数行もそのまま）", () => {
  const reason = "1 行目\n  2 行目（字下げ）\n3 行目 `code` と「引用」";
  const text = messageStopNotice({ prompt: "p", reason });
  assert.ok(text.endsWith(reason), "理由が末尾にそのまま入る");
});

test("理由の前後の空白は除かれる", () => {
  const text = messageStopNotice({ prompt: "p", reason: "  理由  \n" });
  assert.ok(text.endsWith("\n理由"));
});

test("prompt が null のとき「（取得できませんでした）」を入れる", () => {
  const text = messageStopNotice({ prompt: null, reason: REASON });
  assert.ok(text.includes("止めた入力: （取得できませんでした）"));
});

test("prompt が空文字のときも「（取得できませんでした）」を入れる", () => {
  const text = messageStopNotice({ prompt: "", reason: REASON });
  assert.ok(text.includes("止めた入力: （取得できませんでした）"));
});

test("長い入力（300 文字）は先頭 200 文字に切られる", () => {
  const prompt = "a".repeat(200) + "b".repeat(100);
  const text = messageStopNotice({ prompt, reason: REASON });
  assert.ok(text.includes(`止めた入力: ${"a".repeat(200)}\n`));
  assert.ok(!text.includes("b"));
});

test("制御文字（改行・タブ・その他）は空白 1 つに置き換わる", () => {
  const text = messageStopNotice({ prompt: "/kiro-impl foo\n1.1\t-y\u0007", reason: REASON });
  assert.ok(text.includes("止めた入力: /kiro-impl foo 1.1 -y "), "制御文字が空白になる");
  const inputLine = text.split("\n").find((line) => line.startsWith("止めた入力: "));
  assert.ok(!/[\u0000-\u001f\u007f]/.test(inputLine), "止めた入力の行に制御文字が残らない");
});

test("stopOutput は UserPromptSubmit の追加の文脈を持ち、decision を含まない", () => {
  const notice = { prompt: "/kiro-spec-quick foo", reason: REASON };
  const out = stopOutput(notice);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(out.hookSpecificOutput.additionalContext, messageStopNotice(notice));
  assert.equal("decision" in out, false);
  assert.equal("decision" in out.hookSpecificOutput, false);
});

test("stopOutput の JSON は 1 行で、標準出力に書ける形", () => {
  const json = JSON.stringify(stopOutput({ prompt: "a\nb", reason: REASON }));
  assert.ok(!json.includes("\n"));
  assert.deepEqual(JSON.parse(json), stopOutput({ prompt: "a\nb", reason: REASON }));
});

test("reason が空・空白のみ・数値のとき TypeError", () => {
  assert.throws(() => messageStopNotice({ prompt: "p", reason: "" }), TypeError);
  assert.throws(() => messageStopNotice({ prompt: "p", reason: "   " }), TypeError);
  assert.throws(() => messageStopNotice({ prompt: "p", reason: 1 }), TypeError);
  assert.throws(() => messageStopNotice({ prompt: "p" }), TypeError);
  assert.throws(() => stopOutput({ prompt: "p", reason: "" }), TypeError);
});

test("prompt が数値のとき TypeError", () => {
  assert.throws(() => messageStopNotice({ prompt: 1, reason: REASON }), TypeError);
  assert.throws(() => stopOutput({ prompt: 1, reason: REASON }), TypeError);
});
