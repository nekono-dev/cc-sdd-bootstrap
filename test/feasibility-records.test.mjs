// このリポジトリの spec の実現性の記録（.kiro/specs/<名前>/feasibility.md）が、関門の解析で通過と読めることを確かめる。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decideInput, parseRecord } from "../.agent-hooks/cc-sdd-bootstrap/feasibility-gate-rules.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 実現性の確認の導入より前に完了した 5 つの spec（要件 5.4）
const COMPLETED_SPECS = ["installer-core", "session-install", "kiro-gate", "subagent-delegation", "codex-hook-trust"];

for (const name of COMPLETED_SPECS) {
  test(`${name}: 実現性の記録が 3 つの判定を読め、通過と読める（5.4）`, () => {
    const file = path.join(root, ".kiro/specs", name, "feasibility.md");
    assert.ok(existsSync(file), `記録が無い: ${file}`);
    const record = parseRecord(readFileSync(file, "utf8"));
    assert.deepEqual(record, { need: "required", design: "pass", tasks: "pass" });
  });

  test(`${name}: 記録があるので、kiro-spec-tasks・kiro-impl の入力は止まらない（5.4・5.6）`, () => {
    const record = parseRecord(readFileSync(path.join(root, ".kiro/specs", name, "feasibility.md"), "utf8"));
    for (const skill of ["kiro-spec-tasks", "kiro-impl", "kiro-spec-quick", "kiro-spec-batch"]) {
      assert.notEqual(decideInput({ skill, spec: name }, true, record).kind, "block", `${skill} が止まる`);
    }
  });

  test(`${name}: 記録が根拠として挙げた PoC の場所が実在する`, () => {
    const text = readFileSync(path.join(root, ".kiro/specs", name, "feasibility.md"), "utf8");
    for (const [, dir] of text.matchAll(/`(poc\/[a-z0-9-]+)\/?[^`]*`/g)) {
      assert.ok(existsSync(path.join(root, dir)), `PoC の場所が無い: ${dir}`);
    }
  });
}
