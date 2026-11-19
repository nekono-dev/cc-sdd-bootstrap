// 共有の定数が設計の値どおりであることの確認
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  catalog,
  DEPLOY_DIR,
  OWNED_MARKER,
  CONFIG_PATH,
  LEDGER_PATH,
} from "../lib/catalog.mjs";

test("DEPLOY_DIR は配置先のディレクトリ", () => {
  assert.equal(DEPLOY_DIR, ".agent-hooks/cc-sdd-bootstrap");
});

test("OWNED_MARKER は一式のフックの見分けの文字列", () => {
  assert.equal(OWNED_MARKER, "/.agent-hooks/cc-sdd-bootstrap/");
});

test("CONFIG_PATH は設定ファイルの名前", () => {
  assert.equal(CONFIG_PATH, ".cc-sdd-bootstrap.json");
});

test("LEDGER_PATH は配置の記録の道筋で、配置先の下にある", () => {
  assert.equal(LEDGER_PATH, ".agent-hooks/cc-sdd-bootstrap/installed.json");
  assert.ok(LEDGER_PATH.startsWith(`${DEPLOY_DIR}/`));
});

// ---- カタログの不変条件 ----

// パッケージの根（このテストの 1 つ上）
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * .gitignore の 1 行が、リポジトリの根からの道筋に当たるかを返す簡易の判定。
 * 対応する書き方: 先頭の `/`（根に固定）、末尾の `/`（ディレクトリだけ）、
 * 1 つの区切りの中の `*`。
 * 対応しない書き方: `**`、`?`、`[...]`、`!`（打ち消し）、`\` の逃がし、コメント行。
 * 中ほどに `/` を含む行は、git と同じく根に固定して扱う。
 * 道筋の上位のディレクトリが当たれば、その下のファイルも当たるとみなす。
 */
function gitignoreMatches(line, target) {
  let pattern = line;
  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);
  let anchored = false;
  if (pattern.startsWith("/")) {
    anchored = true;
    pattern = pattern.slice(1);
  }
  if (pattern.includes("/")) anchored = true;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  const re = new RegExp(`^${source}$`);
  const segments = target.split("/");
  for (let i = 1; i <= segments.length; i++) {
    const isWhole = i === segments.length;
    if (dirOnly && isWhole) continue; // ディレクトリだけの行は、末尾の実体には当てない
    const subject = anchored ? segments.slice(0, i).join("/") : segments[i - 1];
    if (re.test(subject)) return true;
  }
  return false;
}

test("簡易の .gitignore 判定の自己確認", () => {
  assert.ok(gitignoreMatches(".kiro/settings/", ".kiro/settings/a.md"));
  assert.ok(!gitignoreMatches(".kiro/settings/", ".kiro/settings"));
  assert.ok(gitignoreMatches(".claude/skills/kiro-*/", ".claude/skills/kiro-x/SKILL.md"));
  assert.ok(!gitignoreMatches(".claude/skills/kiro-*/", ".claude/settings.json"));
  assert.ok(gitignoreMatches("/.cache/x", ".cache/x"));
  assert.ok(!gitignoreMatches("/.cache/x", "a/.cache/x"));
  assert.ok(gitignoreMatches("*.json", "a/b.json"));
});

test("files の道筋は DEPLOY_DIR の下にあり、.. を含まず、パッケージに実在する", () => {
  assert.ok(catalog.files.length > 0);
  for (const f of catalog.files) {
    assert.ok(f.path.startsWith(`${DEPLOY_DIR}/`), f.path);
    assert.ok(!f.path.split("/").includes(".."), f.path);
    assert.ok(fs.statSync(path.join(packageRoot, f.path)).isFile(), f.path);
    assert.ok(["common", "project"].includes(f.kind), f.path);
  }
});

test("files はセッション導入の 4 本で、全て実行権限なし", () => {
  assert.deepEqual(
    catalog.files.map((f) => [f.path, f.kind, f.executable]),
    [
      [`${DEPLOY_DIR}/install-cc-sdd.mjs`, "common", false],
      [`${DEPLOY_DIR}/install-rules.mjs`, "common", false],
      [`${DEPLOY_DIR}/config-schema.mjs`, "common", false],
      [`${DEPLOY_DIR}/install-gate.mjs`, "common", false],
    ],
  );
});

test("hooks の command は全て一式の見分けの文字列を含み、設計の 2 つである", () => {
  for (const h of catalog.hooks) {
    assert.ok(h.command.includes(OWNED_MARKER), h.command);
  }
  assert.deepEqual(catalog.hooks, [
    {
      event: "SessionStart",
      command: `node "$CLAUDE_PROJECT_DIR${OWNED_MARKER}install-cc-sdd.mjs" session-start`,
      timeout: 600,
    },
    {
      event: "UserPromptSubmit",
      command: `node "$CLAUDE_PROJECT_DIR${OWNED_MARKER}install-gate.mjs" user-prompt-submit`,
      timeout: 10,
    },
  ]);
});

test("gitignore は設計の 5 要素である", () => {
  assert.deepEqual(catalog.gitignore, [
    ".claude/skills/kiro-*/",
    { line: ".kiro/settings/", when: { path: "ccSdd.keepTemplates", equals: false } },
    { line: ".kiro/settings/*", when: { path: "ccSdd.keepTemplates", equals: true } },
    { line: "!.kiro/settings/templates/", when: { path: "ccSdd.keepTemplates", equals: true } },
    "/.cache/",
  ]);
});

test("gitignore は設定・配置物・配置の記録・.claude/settings.json に当たらない（7.4）", () => {
  const protectedPaths = [
    CONFIG_PATH,
    ...catalog.files.map((f) => f.path),
    LEDGER_PATH,
    ".claude/settings.json",
  ];
  for (const line of catalog.gitignore) {
    const pattern = typeof line === "string" ? line : line.line;
    if (pattern.startsWith("!")) continue;
    for (const p of protectedPaths) {
      assert.ok(!gitignoreMatches(pattern, p), `${pattern} が ${p} に当たる`);
    }
  }
});

const GUIDE_IMPORT = "@.kiro/settings/cc-sdd-guide.md";

test("claudeSections の id は重複しない", () => {
  const ids = catalog.claudeSections.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ["cc-sdd-session-install", "cc-sdd-guide"]);
  assert.ok(ids.includes("cc-sdd-guide"));
});

test("セッション導入の管理区画に運用案内がある", () => {
  const section = catalog.claudeSections.find((s) => s.id === "cc-sdd-session-install");
  assert.ok(section);
  for (const phrase of ["セッション", "install-cc-sdd.mjs", "SKILL.md", "止まる"]) {
    assert.ok(section.body.includes(phrase), phrase);
  }
});

test("cc-sdd-guide の区画は見出し・説明・取り込みの行だけで、標準の決まりの中身を書かない（8.2, 8.3）", () => {
  const section = catalog.claudeSections.find((s) => s.id === "cc-sdd-guide");
  const lines = section.body.split("\n");
  assert.equal(lines[0], "## cc-sdd の標準の決まり");
  assert.ok(lines.includes(GUIDE_IMPORT));
  assert.equal(lines[lines.length - 1], GUIDE_IMPORT);
  assert.equal(lines[lines.length - 2], "");
  // 標準の決まりの文書に出てくる語を、区画に写していないこと
  for (const phrase of [
    "Spec-Driven Development",
    "3-phase approval workflow",
    "/kiro-spec-init",
    "Steering vs Specification",
  ]) {
    assert.ok(!section.body.includes(phrase), phrase);
  }
  assert.ok(section.body.length < 400);
});

test("配置物は lib/ を import / require しない（配置先では lib/ が無い）", () => {
  for (const f of catalog.files) {
    const text = fs.readFileSync(path.join(packageRoot, f.path), "utf8");
    const importLike =
      /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'][^"']*\blib\/[^"']*["']/;
    assert.ok(!importLike.test(text), f.path);
  }
});
