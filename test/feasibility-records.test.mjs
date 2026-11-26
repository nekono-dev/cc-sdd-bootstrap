// このリポジトリの spec の実現性の記録（.kiro/specs/<名前>/feasibility.md）が、関門の解析で通過と読めることを確かめる。
// 根拠として挙げた PoC 文書（spec のディレクトリの poc/<段階>_<2 桁>.md）が実在することも確かめる。
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decideInput, parseRecord } from "../.agent-hooks/cc-sdd-bootstrap/feasibility-gate-rules.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const specsDir = path.join(root, ".kiro/specs");

// 実現性の確認の導入より前に完了した 5 つの spec（要件 5.4）
const COMPLETED_SPECS = ["installer-core", "session-install", "kiro-gate", "subagent-delegation", "codex-hook-trust"];

/**
 * 記録の本文から、根拠として挙げた PoC 文書の参照を取り出す。
 * 取り出すのは `poc/<段階>_<2 桁>.md` と `../<spec 名>/poc/<段階>_<2 桁>.md` だけ。
 * リポジトリ直下の `poc/<名前>/` の形や、段階以外・番号が 2 桁でない名前は取り出さない。
 * @param {string} recordText
 * @returns {string[]}
 */
function pocDocumentRefs(recordText) {
  return [...recordText.matchAll(/`((?:\.\.\/[a-z0-9-]+\/)?poc\/(?:requirements|design|tasks|impl)_\d{2}\.md)`/g)].map(
    ([, ref]) => ref,
  );
}

/**
 * 参照を、記録のあるディレクトリからの相対パスで解決し、実在しないものを返す。
 * @param {string[]} refs
 * @param {string} baseDir - 記録のあるディレクトリ
 * @returns {string[]}
 */
function missingPocDocuments(refs, baseDir) {
  return refs.filter((ref) => !existsSync(path.resolve(baseDir, ref)));
}

/** .kiro/specs の直下にある、記録（feasibility.md）を持つ spec の一覧を返す（固定の一覧にしない）。 */
function recordedSpecs() {
  return readdirSync(specsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(specsDir, entry.name, "feasibility.md")))
    .map((entry) => entry.name);
}

for (const name of COMPLETED_SPECS) {
  test(`${name}: 実現性の記録が 3 つの判定を読め、通過と読める（5.4）`, () => {
    const file = path.join(specsDir, name, "feasibility.md");
    assert.ok(existsSync(file), `記録が無い: ${file}`);
    const record = parseRecord(readFileSync(file, "utf8"));
    assert.deepEqual(record, { need: "required", design: "pass", tasks: "pass" });
  });

  test(`${name}: 記録があるので、kiro-spec-tasks・kiro-impl の入力は止まらない（5.4・5.6）`, () => {
    const record = parseRecord(readFileSync(path.join(specsDir, name, "feasibility.md"), "utf8"));
    for (const skill of ["kiro-spec-tasks", "kiro-impl", "kiro-spec-quick", "kiro-spec-batch"]) {
      assert.notEqual(decideInput({ skill, spec: name }, true, record).kind, "block", `${skill} が止まる`);
    }
  });
}

// 2 つの spec 自身の記録（要件 5.4）。どちらも設計・タスク計画の確認が通過（未解決が無い）
const OWN_RECORDS = [
  { name: "work-branch-flow", expected: { need: "required", design: "pass", tasks: "pass" } },
  { name: "feasibility-review", expected: { need: "required", design: "pass", tasks: "pass" } },
];

for (const { name, expected } of OWN_RECORDS) {
  test(`${name}: 自身の実現性の記録を読め、通過と読める（5.4）`, () => {
    const file = path.join(specsDir, name, "feasibility.md");
    assert.ok(existsSync(file), `記録が無い: ${file}`);
    assert.deepEqual(parseRecord(readFileSync(file, "utf8")), expected);
  });
}

test("記録が挙げた PoC 文書は、記録のあるディレクトリからの相対パスで実在する（5.2・5.3）", () => {
  const specs = recordedSpecs();
  assert.ok(specs.length > 0, "記録のある spec が 1 つも見つからない");
  for (const name of specs) {
    const specDir = path.join(specsDir, name);
    const text = readFileSync(path.join(specDir, "feasibility.md"), "utf8");
    const missing = missingPocDocuments(pocDocumentRefs(text), specDir);
    assert.deepEqual(missing, [], `${name}: PoC 文書が無い`);
  }
});

test("存在しない PoC 文書を挙げた記録は、実在の確認で失敗する（否定）", () => {
  const text = [
    "## 設計の確認",
    "- 判定: 通過",
    "- 根拠:",
    "  | 前提 | 根拠の種別 | 出典・PoC |",
    "  |---|---|---|",
    "  | 存在しない前提 | 実機の PoC | `poc/design_99.md`（2026-11-26、Claude Code 2.1.329） |",
  ].join("\n");
  const specDir = path.join(specsDir, "poc-records");
  assert.deepEqual(missingPocDocuments(pocDocumentRefs(text), specDir), ["poc/design_99.md"]);
});

test("別の spec を指す参照（../<spec 名>/poc/…）を取り出す", () => {
  const text = "| 前提 | `../kiro-gate/poc/design_01.md` |";
  assert.deepEqual(pocDocumentRefs(text), ["../kiro-gate/poc/design_01.md"]);
});

test("別の spec を指す参照は、記録のあるディレクトリから解決して実在を確かめる", () => {
  const refs = pocDocumentRefs("| 前提 | `../poc-records/poc/design_01.md` |");
  assert.deepEqual(refs, ["../poc-records/poc/design_01.md"]);
  assert.deepEqual(missingPocDocuments(refs, path.join(specsDir, "feasibility-review")), []);
});

test("リポジトリ直下の形（poc/<名前>/）は取り出さない", () => {
  const text = "`poc/foo/` と `poc/foo/result.md` と `poc/kiro-gate/`";
  assert.deepEqual(pocDocumentRefs(text), []);
});

test("段階以外の名前・番号が 2 桁でないものは取り出さない", () => {
  const text = "`poc/other_01.md` と `poc/design_1.md` と `poc/design_001.md`";
  assert.deepEqual(pocDocumentRefs(text), []);
});

test("段階と 2 桁の番号の PoC 文書の形は取り出す", () => {
  const text = "`poc/requirements_01.md` `poc/design_02.md` `poc/tasks_10.md` `poc/impl_01.md`";
  assert.deepEqual(pocDocumentRefs(text), [
    "poc/requirements_01.md",
    "poc/design_02.md",
    "poc/tasks_10.md",
    "poc/impl_01.md",
  ]);
});

test("導入先の古い記録（poc/ の場所を根拠に挙げたまま、判定が通過）は、入力で止まらない", () => {
  const text = [
    "## 実機検証の要否",
    "- 判定: 必要",
    "- 理由: 実機の確認が必要。",
    "",
    "## 設計の確認",
    "- 判定: 通過",
    "- 根拠:",
    "  | 前提 | 根拠の種別 | 出典・PoC |",
    "  |---|---|---|",
    "  | 入力の検出 | 実機の PoC | `poc/old/result.md`（2026-10-01、Claude Code 2.0.0） |",
    "- 未確認: なし",
    "",
    "## タスク計画の確認",
    "- 判定: 通過",
    "- 未解決: なし",
  ].join("\n");
  const record = parseRecord(text);
  assert.deepEqual(record, { need: "required", design: "pass", tasks: "pass" });
  for (const skill of ["kiro-spec-tasks", "kiro-impl"]) {
    assert.notEqual(decideInput({ skill, spec: "x" }, true, record).kind, "block", `${skill} が止まる`);
  }
});
