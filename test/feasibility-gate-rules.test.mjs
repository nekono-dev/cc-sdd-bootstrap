// 実現性の確認の判定（feasibility-gate-rules.mjs）の単体試験。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPrompt,
  parseRecord,
  decideInput,
  messageBlock,
  messageContext,
} from "../.agent-hooks/cc-sdd-bootstrap/feasibility-gate-rules.mjs";

/** 3 つの判定から記録の本文を組み立てる（節の順序は既定どおり） */
function recordText({ need = "必要", design = "通過", tasks = "通過" } = {}) {
  return [
    "# 実現性の記録",
    "",
    "## 実機検証の要否",
    "表や理由は自由に書いてよい。",
    `- 判定: ${need}`,
    "",
    "## 設計の確認",
    `- 判定: ${design}`,
    "",
    "## タスク計画の確認",
    `- 判定: ${tasks}`,
    "",
  ].join("\n");
}

test("対象のコマンドと spec 名を取り出す（先頭のコマンドだけ見る）", () => {
  assert.deepEqual(classifyPrompt("/kiro-spec-tasks foo -y"), { skill: "kiro-spec-tasks", spec: "foo" });
  assert.deepEqual(classifyPrompt("$kiro-impl foo 1.1"), { skill: "kiro-impl", spec: "foo" });
  assert.deepEqual(classifyPrompt("/kiro-spec-requirements foo"), { skill: "kiro-spec-requirements", spec: "foo" });
  assert.deepEqual(classifyPrompt("/kiro-spec-design foo"), { skill: "kiro-spec-design", spec: "foo" });
  assert.deepEqual(classifyPrompt("/kiro-validate-design foo"), { skill: "kiro-validate-design", spec: "foo" });
  assert.deepEqual(classifyPrompt("/kiro-spec-quick foo --auto"), { skill: "kiro-spec-quick", spec: "foo" });
  assert.deepEqual(classifyPrompt("/kiro-spec-tasks   foo"), { skill: "kiro-spec-tasks", spec: "foo" });
  assert.deepEqual(classifyPrompt("  /kiro-impl foo 1.2"), { skill: "kiro-impl", spec: "foo" });
});

test("spec 名が無いとき・規則に合わないときは spec を null にする", () => {
  assert.deepEqual(classifyPrompt("/kiro-spec-batch"), { skill: "kiro-spec-batch", spec: null });
  assert.deepEqual(classifyPrompt("/kiro-spec-tasks"), { skill: "kiro-spec-tasks", spec: null });
  assert.deepEqual(classifyPrompt("/kiro-spec-quick 新しい機能を作る"), { skill: "kiro-spec-quick", spec: null });
  assert.deepEqual(classifyPrompt("/kiro-spec-tasks Foo"), { skill: "kiro-spec-tasks", spec: null });
  assert.deepEqual(classifyPrompt("/kiro-spec-tasks ../x"), { skill: "kiro-spec-tasks", spec: null });
  assert.deepEqual(classifyPrompt("/kiro-spec-tasks a/b"), { skill: "kiro-spec-tasks", spec: null });
  assert.deepEqual(classifyPrompt("/kiro-spec-tasks -x"), { skill: "kiro-spec-tasks", spec: null });
});

test("`-` で始まる引数は読み飛ばして次の語を spec 名にする", () => {
  assert.deepEqual(classifyPrompt("/kiro-spec-tasks -y foo"), { skill: "kiro-spec-tasks", spec: "foo" });
});

test("対象外のコマンド・コマンドなし・先頭以外の言及は null", () => {
  assert.equal(classifyPrompt("/kiro-spec-init x"), null);
  assert.equal(classifyPrompt("/kiro-discovery"), null);
  assert.equal(classifyPrompt("/kiro-validate-impl foo"), null);
  assert.equal(classifyPrompt("通常の依頼"), null);
  assert.equal(classifyPrompt("文中の /kiro-impl foo は対象外"), null);
  assert.equal(classifyPrompt(""), null);
});

test("想定外の型は例外にせず null を返す", () => {
  assert.equal(classifyPrompt(undefined), null);
  assert.equal(classifyPrompt(null), null);
  assert.equal(classifyPrompt(42), null);
});

test("記録の解析: 通過・未通過・必要・不要を読む", () => {
  assert.deepEqual(parseRecord(recordText()), { need: "required", design: "pass", tasks: "pass" });
  assert.deepEqual(parseRecord(recordText({ need: "不要", design: "未通過", tasks: "通過" })), {
    need: "unneeded",
    design: "fail",
    tasks: "pass",
  });
});

test("記録の解析: 判定の行が無い・語が違う・余計な語・2 つ以上は null", () => {
  const noJudgement = "## 実機検証の要否\n- 判定: 必要\n\n## 設計の確認\n説明だけ\n\n## タスク計画の確認\n- 判定: 通過\n";
  assert.deepEqual(parseRecord(noJudgement), { need: "required", design: null, tasks: "pass" });

  assert.deepEqual(parseRecord(recordText({ design: "OK" })), { need: "required", design: null, tasks: "pass" });
  assert.deepEqual(parseRecord(recordText({ design: "通過済み" })), { need: "required", design: null, tasks: "pass" });
  assert.deepEqual(parseRecord(recordText({ need: "必要 だが" })), { need: null, design: "pass", tasks: "pass" });

  const twoJudgements = "## 設計の確認\n- 判定: 通過\n- 判定: 未通過\n\n## タスク計画の確認\n- 判定: 通過\n";
  assert.deepEqual(parseRecord(twoJudgements), { need: null, design: null, tasks: "pass" });
});

test("記録の解析: 節が欠けるとその段階は null", () => {
  const onlyDesign = "## 設計の確認\n- 判定: 通過\n";
  assert.deepEqual(parseRecord(onlyDesign), { need: null, design: "pass", tasks: null });
});

test("記録の解析: コードブロックの中の見出しと判定の行は無視する", () => {
  const text = [
    "## 設計の確認",
    "```",
    "## タスク計画の確認",
    "- 判定: 通過",
    "```",
    "- 判定: 未通過",
    "",
    "## タスク計画の確認",
    "- 判定: 通過",
    "",
  ].join("\n");
  assert.deepEqual(parseRecord(text), { need: null, design: "fail", tasks: "pass" });
});

test("記録の解析: Windows の改行（\\r\\n）も読む", () => {
  const crlf = recordText({ design: "通過", tasks: "未通過" }).replace(/\n/g, "\r\n");
  assert.deepEqual(parseRecord(crlf), { need: "required", design: "pass", tasks: "fail" });
});

test("記録の解析: 節の順序が前後しても読む。語の前後の空白は許す", () => {
  const reordered = "## タスク計画の確認\n-  判定:   通過  \n\n## 設計の確認\n- 判定: 未通過\n\n## 実機検証の要否\n- 判定: 不要\n";
  assert.deepEqual(parseRecord(reordered), { need: "unneeded", design: "fail", tasks: "pass" });
});

test("記録の解析: 空文字と想定外の型は全て null", () => {
  assert.deepEqual(parseRecord(""), { need: null, design: null, tasks: null });
  assert.deepEqual(parseRecord(undefined), { need: null, design: null, tasks: null });
});

test("設計未通過で kiro-spec-tasks を止める（理由は not-passed）", () => {
  const decision = decideInput({ skill: "kiro-spec-tasks", spec: "foo" }, true, parseRecord(recordText({ design: "未通過" })));
  assert.equal(decision.kind, "block");
  assert.match(decision.reason, /設計/);
  assert.match(decision.reason, /判定が通過ではありません/);
});

test("設計が判定の無い（null）ときも kiro-spec-tasks を止める", () => {
  const record = { need: "required", design: null, tasks: "pass" };
  assert.equal(decideInput({ skill: "kiro-spec-tasks", spec: "foo" }, true, record).kind, "block");
});

test("設計通過なら kiro-spec-tasks を通す", () => {
  assert.deepEqual(
    decideInput({ skill: "kiro-spec-tasks", spec: "foo" }, true, parseRecord(recordText({ design: "通過", tasks: "未通過" }))),
    { kind: "context", text: messageContext("kiro-spec-tasks", "foo") },
  );
});

test("タスク計画未通過で kiro-impl を止め、通過なら通す", () => {
  const blocked = decideInput({ skill: "kiro-impl", spec: "foo" }, true, parseRecord(recordText({ tasks: "未通過" })));
  assert.equal(blocked.kind, "block");
  assert.match(blocked.reason, /タスク計画/);
  assert.deepEqual(decideInput({ skill: "kiro-impl", spec: "foo" }, true, parseRecord(recordText({ tasks: "通過" }))), { kind: "context", text: messageContext("kiro-impl", "foo") });
});

test("kiro-impl は設計だけ通過していても、タスク計画が通らなければ止める", () => {
  const record = parseRecord(recordText({ design: "通過", tasks: "未通過" }));
  assert.equal(decideInput({ skill: "kiro-impl", spec: "foo" }, true, record).kind, "block");
});

test("記録が無い・読めない（null）ときは止める（理由は no-record）", () => {
  const decision = decideInput({ skill: "kiro-impl", spec: "foo" }, true, null);
  assert.equal(decision.kind, "block");
  assert.match(decision.reason, /記録がありません/);
  assert.equal(decideInput({ skill: "kiro-spec-tasks", spec: "foo" }, true, null).kind, "block");
});

test("need が unneeded でも、段階が未通過なら止める（要否は停止の条件に使わない）", () => {
  const record = parseRecord(recordText({ need: "不要", design: "未通過" }));
  assert.equal(decideInput({ skill: "kiro-spec-tasks", spec: "foo" }, true, record).kind, "block");
});

test("spec 名が無い・spec のディレクトリが特定できないときは止めず追加の指示を返す", () => {
  assert.deepEqual(decideInput({ skill: "kiro-impl", spec: null }, true, null), { kind: "context", text: messageContext("kiro-impl", null) });
  assert.deepEqual(decideInput({ skill: "kiro-impl", spec: "foo" }, false, null), { kind: "context", text: messageContext("kiro-impl", null) });
});

test("停止の対象外のコマンドは止めない", () => {
  const record = parseRecord(recordText({ design: "未通過", tasks: "未通過" }));
  assert.deepEqual(decideInput({ skill: "kiro-spec-requirements", spec: "foo" }, true, record), { kind: "context", text: messageContext("kiro-spec-requirements", "foo") });
  assert.deepEqual(decideInput({ skill: "kiro-spec-design", spec: "foo" }, true, null), { kind: "context", text: messageContext("kiro-spec-design", "foo") });
  assert.deepEqual(decideInput({ skill: "kiro-validate-design", spec: "foo" }, true, null), { kind: "context", text: messageContext("kiro-validate-design", "foo") });
});

test("command が null など想定外の型は通す", () => {
  assert.deepEqual(decideInput(null, true, null), { kind: "none" });
  assert.deepEqual(decideInput(undefined, true, null), { kind: "none" });
  assert.deepEqual(decideInput("kiro-impl", true, null), { kind: "none" });
});

test("messageBlock: 設計の停止は spec 名・段階・手順・記録の場所・no-record の違いを含む", () => {
  const text = messageBlock("foo", "design", "no-record", "kiro-spec-tasks");
  assert.match(text, /spec `foo`/);
  assert.match(text, /設計/);
  assert.match(text, /記録がありません/);
  assert.match(text, /\/kiro-spec-design/);
  assert.match(text, /\/kiro-validate-design/);
  assert.match(text, /\.kiro\/specs\/foo\/feasibility\.md/);
  assert.match(text, /## 設計の確認/);
  assert.match(text, /- 判定: 不要/);
});

test("messageBlock: タスク計画の not-passed は段階と記録の節を変え、判定が通過ではないと示す", () => {
  const text = messageBlock("foo", "tasks", "not-passed", "kiro-impl");
  assert.match(text, /タスク計画/);
  assert.match(text, /判定が通過ではありません/);
  assert.match(text, /## タスク計画の確認/);
  assert.match(text, /\/kiro-spec-tasks/);
  assert.doesNotMatch(text, /記録がありません/);
});

test("記録の解析: ~~~ で囲んだコードの中の判定は読まない", () => {
  const text = "## 設計の確認\n~~~\n- 判定: 通過\n~~~\n\n## タスク計画の確認\n- 判定: 通過\n";
  assert.deepEqual(parseRecord(text), { need: null, design: null, tasks: "pass" });
});

test("記録の解析: 長いフェンスの中に短いフェンスがあっても、外側の閉じ行までがコード", () => {
  const text = "## 設計の確認\n````\n```\n- 判定: 通過\n```\n````\n- 判定: 未通過\n";
  assert.deepEqual(parseRecord(text), { need: null, design: "fail", tasks: null });
});

test("記録の解析: 短いフェンスは長いフェンスを閉じられない（~~~~ の中の ~~~）", () => {
  const text = "## 設計の確認\n~~~~\n~~~\n- 判定: 通過\n~~~~\n";
  assert.deepEqual(parseRecord(text), { need: null, design: null, tasks: null });
});

test("記録の解析: 閉じていないフェンスは文書の終わりまでコード", () => {
  const text = "## 設計の確認\n- 判定: 未通過\n\n## タスク計画の確認\n```\n- 判定: 通過\n";
  assert.deepEqual(parseRecord(text), { need: null, design: "fail", tasks: null });
});

test("記録の解析: 閉じ行の後ろに文字があるとフェンスは閉じない", () => {
  const text = "## 設計の確認\n```\n- 判定: 通過\n``` x\n";
  assert.deepEqual(parseRecord(text), { need: null, design: null, tasks: null });
});

test("記録の解析: フェンスの外の正しい判定は、フェンスの中の判定に邪魔されず読める", () => {
  const text = "## 設計の確認\n```\n- 判定: 通過\n```\n- 判定: 未通過\n";
  assert.deepEqual(parseRecord(text), { need: null, design: "fail", tasks: null });
});

test("記録の解析: 情報文字列にバッククォートを含む行はフェンスではない", () => {
  const text = "## 設計の確認\n```js`x\n- 判定: 通過\n";
  assert.deepEqual(parseRecord(text), { need: null, design: "pass", tasks: null });
});

test("記録の解析: 0〜3 個の空白の後ろのフェンスは有効、4 個以上は無効", () => {
  assert.deepEqual(parseRecord("## 設計の確認\n   ```\n- 判定: 通過\n   ```\n"), { need: null, design: null, tasks: null });
  assert.deepEqual(parseRecord("## 設計の確認\n    ```\n- 判定: 未通過\n"), { need: null, design: "fail", tasks: null });
});

test("記録の解析: レベル 1 の見出し（# 別の章）で設計の節が終わり、後の判定は設計に入らない", () => {
  const text = "## 設計の確認\n説明\n\n# 別の章\n- 判定: 通過\n";
  assert.deepEqual(parseRecord(text), { need: null, design: null, tasks: null });
});

test("記録の解析: 対象外のレベル 2 の見出し（## 備考）で直前の節が終わる", () => {
  assert.deepEqual(parseRecord("## 設計の確認\n\n## 備考\n- 判定: 通過\n"), { need: null, design: null, tasks: null });
  const text = "## タスク計画の確認\n- 判定: 通過\n## 備考\n- 判定: 未通過\n";
  assert.deepEqual(parseRecord(text), { need: null, design: null, tasks: "pass" });
});

test("記録の解析: レベル 3 以上の見出し（### 小見出し）は節の中に含まれる", () => {
  assert.deepEqual(parseRecord("## 設計の確認\n### 詳細\n- 判定: 通過\n"), { need: null, design: "pass", tasks: null });
});

test("記録の解析: 小見出しの下に判定が 2 つあれば、節の判定が 2 つとして null", () => {
  assert.deepEqual(parseRecord("## 設計の確認\n### 詳細\n- 判定: 通過\n- 判定: 未通過\n"), { need: null, design: null, tasks: null });
});

test("記録の解析: 判定の行が無い節は null（小見出しがあっても）", () => {
  assert.deepEqual(parseRecord("## 設計の確認\n### 詳細\n説明だけ\n"), { need: null, design: null, tasks: null });
});

/** 設計の判定だけを確かめるための短い記録（節の境界の試験用） */
function designOf(text) {
  return parseRecord(text).design;
}

test("見出し: 先頭に空白つきの ` # 別の章` で設計の節が終わる", () => {
  assert.equal(designOf("## 設計の確認\n\n # 別の章\n- 判定: 通過\n"), null);
});

test("見出し: 3 個の空白つきの `   ## 別の章` で設計の節が終わる", () => {
  assert.equal(designOf("## 設計の確認\n   ## 別の章\n- 判定: 通過\n"), null);
});

test("見出し: `##` の後ろがタブの `##\\t別の章` で設計の節が終わる", () => {
  assert.equal(designOf("## 設計の確認\n##\t別の章\n- 判定: 通過\n"), null);
});

test("見出し: 閉じの `#` つきの `## x ##` で設計の節が終わる", () => {
  assert.equal(designOf("## 設計の確認\n## x ##\n- 判定: 通過\n"), null);
});

test("見出し: 閉じの `#` つきでも節の名前は読める（## 設計の確認 ##）", () => {
  assert.equal(designOf("## 設計の確認 ##\n- 判定: 通過\n"), "pass");
});

test("見出し: レベル 3 以上（### 〜 ######）は節の中に含まれる", () => {
  assert.equal(designOf("## 設計の確認\n#### 詳細\n- 判定: 通過\n"), "pass");
});

test("下線つきの見出し: `===` の行で設計の節が終わる", () => {
  assert.equal(designOf("## 設計の確認\n説明\n===\n- 判定: 通過\n"), null);
});

test("水平線: `---` の行で設計の節が終わる", () => {
  assert.equal(designOf("## 設計の確認\n説明\n---\n- 判定: 通過\n"), null);
});

test("水平線: `***` と `___` の行で設計の節が終わる", () => {
  assert.equal(designOf("## 設計の確認\n***\n- 判定: 通過\n"), null);
  assert.equal(designOf("## 設計の確認\n___\n- 判定: 通過\n"), null);
});

test("判定の行: 先頭に空白やタブがあるインデントされた判定は数えない", () => {
  assert.equal(designOf("## 設計の確認\n  - 判定: 通過\n"), null);
  assert.equal(designOf("## 設計の確認\n\t- 判定: 通過\n"), null);
});

test("判定の行: 引用（> ）・`*`・`+` の箇条書き・表の行の判定は数えない", () => {
  assert.equal(designOf("## 設計の確認\n> - 判定: 通過\n"), null);
  assert.equal(designOf("## 設計の確認\n* 判定: 通過\n"), null);
  assert.equal(designOf("## 設計の確認\n+ 判定: 通過\n"), null);
  assert.equal(designOf("## 設計の確認\n| 判定: 通過 |\n"), null);
  assert.equal(designOf("## 設計の確認\n| - 判定: 通過 |\n"), null);
});

test("判定の行: 全角コロン（判定：）は数えない", () => {
  assert.equal(designOf("## 設計の確認\n- 判定：通過\n"), null);
});

test("HTML コメント: 単一行のコメントの中の判定は読まない", () => {
  assert.equal(designOf("## 設計の確認\n<!-- - 判定: 通過 -->\n"), null);
});

test("HTML コメント: 複数行のコメントの中の判定と見出しは読まない", () => {
  assert.equal(designOf("## 設計の確認\n<!--\n- 判定: 通過\n-->\n"), null);
  assert.equal(designOf("## 設計の確認\n<!--\n## 別の章\n-->\n- 判定: 通過\n"), "pass");
});

test("HTML コメント: 閉じの無いコメントは文書の終わりまで読まない", () => {
  assert.equal(designOf("## 設計の確認\n<!--\n- 判定: 通過\n"), null);
});

test("インデントされたコード: 4 個の空白の判定行は読まない", () => {
  assert.equal(designOf("## 設計の確認\n    - 判定: 通過\n"), null);
});

test("インデントされたコード: 4 個の空白の見出しは節の境界として扱う（保守的に終わらせる）", () => {
  assert.equal(designOf("## 設計の確認\n    ## 別の章\n- 判定: 通過\n"), null);
});

test("回帰: 3 節に表・箇条書き・### 小見出し・コードブロックがある典型的な記録が正しく読める", () => {
  const text = [
    "# 実現性の記録",
    "",
    "## 実機検証の要否",
    "",
    "| 前提 | 理由 |",
    "|---|---|",
    "| A | B |",
    "",
    "- 判定: 必要",
    "",
    "## 設計の確認",
    "",
    "### 前提ごとの根拠",
    "",
    "- 前提1: 根拠",
    "",
    "```",
    "- 判定: 未通過",
    "## 別の章",
    "```",
    "",
    "- 判定: 通過",
    "",
    "## タスク計画の確認",
    "",
    "- 判定: 通過",
    "",
  ].join("\n");
  assert.deepEqual(parseRecord(text), { need: "required", design: "pass", tasks: "pass" });
});

/** 追加の指示の文言に、必要な要点がすべて含まれることを確かめる */
function assertAll(text, phrases) {
  for (const phrase of phrases) assert.ok(text.includes(phrase), `要点が含まれていません: ${phrase}`);
}

/** 段階ごとの指示に共通する、実現性の記録の書式の要点 */
const COMMON_PHRASES = [
  "`.kiro/specs/foo/feasibility.md`",
  "## 実機検証の要否",
  "## 設計の確認",
  "## タスク計画の確認",
  "- 判定:",
  "必要",
  "不要",
  "通過",
  "未通過",
  "水平線",
  "まず `未通過` に戻してから",
];

test("messageContext: 要件の段階は、実機検証の要否の判定・外部の動作・PoC を基本・不要の条件・理由の記録を含む", () => {
  assertAll(messageContext("kiro-spec-requirements", "foo"), [
    ...COMMON_PHRASES,
    "外部の動作",
    "1 つでも",
    "PoC",
    "実機で前提を確かめる試作",
    "PoC 文書",
    "前提と理由",
    "判定と理由",
  ]);
  assert.ok(!messageContext("kiro-spec-requirements", "foo").includes("再実行"), "要件の段階に再実行を含んではならない");
});

test("messageContext: 設計の段階（kiro-spec-design・kiro-validate-design）は、前提ごとの根拠・一次資料・PoC・未確認・レビュー役の観点を含む", () => {
  for (const skill of ["kiro-spec-design", "kiro-validate-design"]) {
    assertAll(messageContext(skill, "foo"), [
      ...COMMON_PHRASES,
      "前提ごと",
      "一次資料",
      "出典",
      "PoC",
      "PoC 文書",
      "位置付けと結果が文書で追える",
      "実施日",
      "未確認",
      "設計の承認",
      "レビュー役",
      "前提ごとの根拠が一次資料か、PoC 文書で位置付けと結果が追える PoC で確かめられているか",
    ]);
    assert.ok(!messageContext(skill, "foo").includes("再実行"), `${skill} に再実行を含んではならない`);
  }
});

test("messageContext: タスク計画の段階は、根拠と段取り・最初の実装タスクに実機の確認・未解決・レビュー役の観点を含む", () => {
  assertAll(messageContext("kiro-spec-tasks", "foo"), [
    ...COMMON_PHRASES,
    "根拠",
    "PoC 文書の場所",
    "段取り",
    "最初の実装タスク",
    "実機",
    "未解決",
    "レビュー役の依頼文",
  ]);
});

test("messageContext: 実装の段階は、requirements.md・design.md を書き換えない・Blocked で戻す・記録を更新し直す", () => {
  assertAll(messageContext("kiro-impl", "foo"), [
    ...COMMON_PHRASES,
    "requirements.md",
    "design.md",
    "書き換え",
    "Blocked",
    "戻",
  ]);
});

test("messageContext: spec 名が分からないときは `<spec 名>` のまま書き、特定の仕組みの名前を含まない", () => {
  const text = messageContext("kiro-spec-tasks", null);
  assert.ok(text.includes(".kiro/specs/<spec 名>/feasibility.md"));
  for (const skill of ["kiro-spec-requirements", "kiro-spec-design", "kiro-validate-design", "kiro-spec-tasks", "kiro-impl"]) {
    assert.doesNotMatch(messageContext(skill, "foo"), /brw|branch-release-workflow/);
  }
});

test("decideInput: 要件・設計・設計の確認は、spec が特定できなくても追加の指示を返す", () => {
  assert.deepEqual(decideInput({ skill: "kiro-spec-requirements", spec: null }, false, null), {
    kind: "context",
    text: messageContext("kiro-spec-requirements", null),
  });
  assert.deepEqual(decideInput({ skill: "kiro-spec-design", spec: "foo" }, false, null), {
    kind: "context",
    text: messageContext("kiro-spec-design", null),
  });
  assert.deepEqual(decideInput({ skill: "kiro-validate-design", spec: null }, true, null), {
    kind: "context",
    text: messageContext("kiro-validate-design", null),
  });
});

test("decideInput: kiro-spec-tasks は設計が通過・spec が特定できない・spec 名なしのとき追加の指示、それ以外は止める", () => {
  const pass = parseRecord(recordText({ design: "通過", tasks: "未通過" }));
  assert.deepEqual(decideInput({ skill: "kiro-spec-tasks", spec: "foo" }, true, pass), {
    kind: "context",
    text: messageContext("kiro-spec-tasks", "foo"),
  });
  assert.deepEqual(decideInput({ skill: "kiro-spec-tasks", spec: null }, true, null), {
    kind: "context",
    text: messageContext("kiro-spec-tasks", null),
  });
  assert.deepEqual(decideInput({ skill: "kiro-spec-tasks", spec: "foo" }, false, null), {
    kind: "context",
    text: messageContext("kiro-spec-tasks", null),
  });
  const blocked = decideInput({ skill: "kiro-spec-tasks", spec: "foo" }, true, null);
  assert.equal(blocked.kind, "block");
  assert.equal(blocked.text, undefined);
});

test("decideInput: kiro-impl はタスク計画が通過・spec が特定できない・spec 名なしのとき追加の指示、それ以外は止める", () => {
  const pass = parseRecord(recordText({ tasks: "通過" }));
  assert.deepEqual(decideInput({ skill: "kiro-impl", spec: "foo" }, true, pass), {
    kind: "context",
    text: messageContext("kiro-impl", "foo"),
  });
  assert.equal(decideInput({ skill: "kiro-impl", spec: "foo" }, true, parseRecord(recordText({ tasks: "未通過" }))).kind, "block");
  assert.equal(decideInput({ skill: "kiro-impl", spec: "foo" }, true, null).kind, "block");
});


test("messageContext（要件 1.1・1.6）: 判定が必要でも不要でも、判定と理由を記録に残すと明示する", () => {
  assertAll(messageContext("kiro-spec-requirements", "foo"), ["必要でも不要でも", "判定と理由を"]);
});

test("messageContext（要件 2.4・4.3）: 設計の確認は、出典・PoC の場所・根拠の無い前提の有無（無ければ「なし」）と、通過にしてよい条件を含む", () => {
  for (const skill of ["kiro-spec-design", "kiro-validate-design"]) {
    assertAll(messageContext(skill, "foo"), [
      "根拠の無い前提の有無",
      "「なし」と明記",
      "出典",
      "PoC 文書の場所",
      "通過にしてよいのは、根拠の無い前提が無いときだけ",
    ]);
  }
});

test("messageContext（要件 3.3・3.4）: タスク計画の確認は、各前提の根拠の有無・実機の確認の位置・未解決・通過の条件を含む", () => {
  assertAll(messageContext("kiro-spec-tasks", "foo"), [
    "各前提の根拠の有無",
    "実機の確認が最初に置かれているか",
    "最初の実装タスクの番号",
    "未解決",
    "通過にしてよいのは、根拠の無い前提と未解決が無いときだけ",
  ]);
});

test("kiro-spec-quick・kiro-spec-batch: spec が特定でき記録が無い・設計が未通過なら止め、理由に個別の段階のコマンドの案内を含む（5.10）", () => {
  for (const skill of ["kiro-spec-quick", "kiro-spec-batch"]) {
    const missing = decideInput({ skill, spec: "foo" }, true, null);
    assert.equal(missing.kind, "block");
    assert.match(missing.reason, /記録がありません/);
    assert.match(missing.reason, /個別の段階のコマンド（`\/kiro-spec-design`・`\/kiro-spec-tasks` など）で確認を済ませてから送ってください/);
    const failed = decideInput({ skill, spec: "foo" }, true, parseRecord(recordText({ design: "未通過" })));
    assert.equal(failed.kind, "block");
    assert.match(failed.reason, /判定が通過ではありません/);
  }
});

test("kiro-spec-quick・kiro-spec-batch: 設計が通過なら何も返さない（5.10）", () => {
  const pass = parseRecord(recordText({ design: "通過", tasks: "未通過" }));
  for (const skill of ["kiro-spec-quick", "kiro-spec-batch"]) {
    assert.deepEqual(decideInput({ skill, spec: "foo" }, true, pass), { kind: "none" });
  }
});

test("kiro-spec-quick・kiro-spec-batch: spec 名なし・特定できないときは止めず、5.12 の案内を追加の指示として返す", () => {
  const cases = [
    ["kiro-spec-batch", null, true],
    ["kiro-spec-quick", "新しい機能を作る", false],
    ["kiro-spec-quick", "newfeature", false],
  ];
  for (const [skill, spec, found] of cases) {
    const decision = decideInput({ skill, spec }, found, null);
    assert.equal(decision.kind, "context");
    assert.equal(decision.text, messageContext(skill, null));
    assertAll(decision.text, [
      "設計とタスクを続けて作る",
      "個別の段階のコマンド",
      "記録（`.kiro/specs/<spec 名>/feasibility.md`）",
      "名前なしの一括作成は入力を止められない",
    ]);
  }
});

test("messageBlock: kiro-spec-quick・kiro-spec-batch の理由は、続けて作るコマンドだと示し、個別の段階のコマンドを案内する（5.10・5.11）", () => {
  for (const skill of ["kiro-spec-quick", "kiro-spec-batch"]) {
    assertAll(messageBlock("foo", "design", "no-record", skill), [
      "これらは設計とタスクを続けて作るコマンドなので",
      "個別の段階のコマンド（`/kiro-spec-design`・`/kiro-spec-tasks` など）で確認を済ませてから送ってください",
    ]);
  }
});
