import { test } from "node:test";
import assert from "node:assert/strict";
import { makePlan, GITIGNORE_BEGIN_LINE } from "../lib/plan.mjs";

const D = ".agent-hooks/cc-sdd-bootstrap";
const C = `${D}/c.txt`;
const lines = [
  ".claude/skills/kiro-*/",
  { line: ".kiro/settings/", when: { path: "ccSdd.keepTemplates", equals: false } },
  { line: ".kiro/settings/*", when: { path: "ccSdd.keepTemplates", equals: true } },
  { line: "!.kiro/settings/templates/", when: { path: "ccSdd.keepTemplates", equals: true } },
  "/.cache/",
];
const cfg = (keep) => ({ format: 1, ccSdd: { keepTemplates: keep } });
const body = (ls) => `${GITIGNORE_BEGIN_LINE}\n${ls.join("\n")}\n# <<< cc-sdd-bootstrap\n`;
const OFF = body([".claude/skills/kiro-*/", ".kiro/settings/", "/.cache/"]);
const ON = body([".claude/skills/kiro-*/", ".kiro/settings/*", "!.kiro/settings/templates/", "/.cache/"]);
function planInput(config, gitignoreText = null, operation = "init") {
  return {
    operation, config,
    snapshot: { config: null, ledger: null, settings: null, gitignore: gitignoreText, claudeMd: null, files: { [C]: null }, modes: {}, ignoredPresent: [] },
    catalog: { files: [{ path: C, kind: "common", executable: false }], hooks: [], gitignore: lines, claudeSections: [] },
    packageFiles: { [C]: Buffer.from("x") },
    bootstrapVersion: "0.1.0", force: false,
  };
}
const gi = (plan) => plan.changes.find((c) => c.path === ".gitignore");

test("keepTemplates が false の init は保持しない側の本文を書く", () => {
  const plan = makePlan(planInput(cfg(false), null, "init"));
  assert.equal(gi(plan).content.toString(), OFF);
});

test("keepTemplates が true の init は保持する側の本文を書く", () => {
  const plan = makePlan(planInput(cfg(true), null, "init"));
  assert.equal(gi(plan).content.toString(), ON);
});

test("同じ選択の update は変更せず、選択を変えた update は書き直す", () => {
  const plan1 = makePlan(planInput(cfg(true), ON, "update"));
  assert.equal(gi(plan1), undefined);
  const plan2 = makePlan(planInput(cfg(false), ON, "update"));
  assert.equal(gi(plan2).content.toString(), OFF);
});
