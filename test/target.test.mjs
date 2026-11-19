// target.mjs の試験: 対象の読み取りと計画の適用
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isGitRoot,
  readSnapshot,
  readPackageFiles,
  applyPlan,
} from "../lib/target.mjs";
import { CONFIG_PATH, LEDGER_PATH } from "../lib/catalog.mjs";

/** 一時ディレクトリを作り、終わったら消す */
function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccsdd-target-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const put = (root, rel, content = "x") => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

const w = (p, s, executable = false) => ({ action: "write", path: p, content: Buffer.from(s), executable });
const plan = (changes, pruneDirs = []) => ({ changes, blocks: [], notices: [], pruneDirs });

test("isGitRoot: .git のディレクトリ・ファイル・無し", () => {
  withTmp((d) => {
    assert.equal(isGitRoot(d), false);
    fs.mkdirSync(path.join(d, ".git"));
    assert.equal(isGitRoot(d), true);
  });
  withTmp((d) => {
    fs.writeFileSync(path.join(d, ".git"), "gitdir: ../x");
    assert.equal(isGitRoot(d), true);
  });
});

test("readSnapshot: 読めるものは文字列・Buffer、無いものは null", () => {
  withTmp((d) => {
    put(d, CONFIG_PATH, "{}");
    put(d, ".gitignore", "a\n");
    put(d, "f/one.txt", "1");
    const s = readSnapshot(d, ["f/one.txt", "f/none.txt"], []);
    assert.equal(s.config, "{}");
    assert.equal(s.gitignore, "a\n");
    assert.equal(s.ledger, null);
    assert.equal(s.settings, null);
    assert.equal(s.claudeMd, null);
    assert.ok(Buffer.isBuffer(s.files["f/one.txt"]));
    assert.equal(s.files["f/one.txt"].toString(), "1");
    assert.equal(s.files["f/none.txt"], null);
    assert.deepEqual(s.ignoredPresent, []);
    put(d, LEDGER_PATH, "L");
    put(d, ".claude/settings.json", "S");
    put(d, "CLAUDE.md", "C");
    const t = readSnapshot(d, [], []);
    assert.deepEqual([t.ledger, t.settings, t.claudeMd], ["L", "S", "C"]);
  });
});

test("readSnapshot: ignoredPresent は実在する道筋だけ（glob・先頭と末尾の区切りの除去）", () => {
  withTmp((d) => {
    put(d, ".claude/skills/kiro-a/SKILL.md");
    put(d, ".claude/skills/kiro-b/SKILL.md");
    put(d, ".claude/skills/other/SKILL.md");
    put(d, ".cache/cc-sdd-install.failed");
    const s = readSnapshot(d, [], [
      ".claude/skills/kiro-*/",
      "/.cache/cc-sdd-install.failed",
      "/.kiro/settings/",
      ".nothing/*/",
      "../escape",
      ".cache/cc-sdd-install.failed",
    ]);
    assert.deepEqual(s.ignoredPresent, [
      ".cache/cc-sdd-install.failed",
      ".claude/skills/kiro-a",
      ".claude/skills/kiro-b",
    ]);
  });
});

test("readPackageFiles: カタログのファイルを読み、無ければ日本語の誤り", () => {
  withTmp((d) => {
    put(d, "a/b.txt", "hello");
    const cat = { files: [{ path: "a/b.txt" }] };
    assert.equal(readPackageFiles(d, cat)["a/b.txt"].toString(), "hello");
    assert.throws(() => readPackageFiles(d, { files: [{ path: "a/none.txt" }] }), /同梱/);
  });
});

test("applyPlan: 書き込み・削除・権限・上書き", () => {
  withTmp((d) => {
    put(d, "old.txt", "old");
    put(d, "keep.txt", "k");
    fs.chmodSync(path.join(d, "keep.txt"), 0o600);
    const r = applyPlan(d, plan([
      w("deep/dir/new.txt", "n"),
      w("deep/run.sh", "#!/bin/sh", true),
      w("keep.txt", "k2"),
      { action: "delete", path: "old.txt" },
      { action: "delete", path: "absent.txt" },
    ]));
    assert.equal(r.ok, true);
    assert.equal(r.done.length, 5);
    assert.deepEqual(r.pending, []);
    assert.equal(fs.readFileSync(path.join(d, "deep/dir/new.txt"), "utf8"), "n");
    assert.equal(fs.statSync(path.join(d, "deep/dir/new.txt")).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(d, "deep/run.sh")).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(d, "keep.txt")).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(d, "keep.txt"), "utf8"), "k2");
    assert.equal(fs.existsSync(path.join(d, "old.txt")), false);
    // 一時ファイルが残らない
    assert.deepEqual(fs.readdirSync(d).filter((n) => n.includes("tmp")), []);
  });
});

test("applyPlan: pruneDirs は空のときだけ消す", () => {
  withTmp((d) => {
    fs.mkdirSync(path.join(d, ".agent-hooks/cc-sdd-bootstrap"), { recursive: true });
    put(d, ".agent-hooks/other/x");
    put(d, "full/x");
    const r = applyPlan(d, plan([], [".agent-hooks/cc-sdd-bootstrap", ".agent-hooks", "full", "missing"]));
    assert.equal(r.ok, true);
    assert.deepEqual(r.prunedDirs, [".agent-hooks/cc-sdd-bootstrap"]);
    assert.equal(fs.existsSync(path.join(d, ".agent-hooks")), true);
    assert.equal(fs.existsSync(path.join(d, "full")), true);
  });
  withTmp((d) => {
    fs.mkdirSync(path.join(d, ".agent-hooks/cc-sdd-bootstrap"), { recursive: true });
    const r = applyPlan(d, plan([], [".agent-hooks/cc-sdd-bootstrap", ".agent-hooks"]));
    assert.deepEqual(r.prunedDirs, [".agent-hooks/cc-sdd-bootstrap", ".agent-hooks"]);
  });
});

test("applyPlan: 途中の失敗で done・failed・pending を返し、残りは書かない", () => {
  withTmp((d) => {
    put(d, "blocker", "i am a file");
    const c1 = w("a.txt", "1");
    const c2 = w("blocker/sub.txt", "2");
    const c3 = w("c.txt", "3");
    const r = applyPlan(d, plan([c1, c2, c3], ["a"]));
    assert.equal(r.ok, false);
    assert.deepEqual(r.done, [c1]);
    assert.equal(r.failed.change, c2);
    assert.match(r.failed.message, /[぀-ヿ一-鿿]/);
    assert.deepEqual(r.pending, [c3]);
    assert.deepEqual(r.prunedDirs, []);
    assert.equal(fs.existsSync(path.join(d, "c.txt")), false);
    assert.deepEqual(fs.readdirSync(d).sort(), ["a.txt", "blocker"]);
  });
});

test("applyPlan: 絶対パス・`..` は失敗として扱う", () => {
  withTmp((d) => {
    const outside = path.join(path.dirname(d), "ccsdd-escape.txt");
    for (const bad of ["../ccsdd-escape.txt", "a/../../ccsdd-escape.txt", outside]) {
      const c = w(bad, "x");
      const after = w("ok.txt", "y");
      const r = applyPlan(d, plan([c, after]));
      assert.equal(r.ok, false);
      assert.equal(r.failed.change, c);
      assert.deepEqual(r.pending, [after]);
      assert.equal(fs.existsSync(outside), false);
    }
    const r = applyPlan(d, plan([{ action: "delete", path: "../x" }]));
    assert.equal(r.ok, false);
  });
});
