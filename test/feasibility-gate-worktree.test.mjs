// git worktree list の出力の解析（純粋な関数）の単体試験。-z の出力と、-z が使えない git のフォールバック（porcelain）を確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorktreeListPorcelain, parseWorktreeListZ } from "../.agent-hooks/cc-sdd-bootstrap/feasibility-gate-rules.mjs";

/**
 * git の -z の形を組み立てる。各行は NUL で終わり、worktree のまとまりの後ろに空のフィールド（NUL）が付く。
 * @param {string[][]} blocks - worktree ごとの行
 */
function zOf(blocks) {
  return blocks.map((block) => block.map((field) => `${field}\0`).join("") + "\0").join("");
}

/** porcelain の形を組み立てる。worktree のまとまりは空行で区切る */
function porcelainOf(blocks) {
  return blocks.map((block) => block.join("\n")).join("\n\n") + "\n\n";
}

test("-z: NUL 区切りの生のパスを、タブ・空白・日本語・改行を含むものも含めてそのまま返す", () => {
  const text = zOf([
    ["worktree /r", "HEAD 1", "branch refs/heads/main"],
    ["worktree /w/tab\tname", "HEAD 2", "detached"],
    ["worktree /w/space name", "HEAD 3", "detached"],
    ["worktree /w/日本語", "HEAD 4", "detached"],
    ["worktree /w/line\nname", "HEAD 5", "detached"],
  ]);
  assert.deepEqual(parseWorktreeListZ(text), ["/r", "/w/tab\tname", "/w/space name", "/w/日本語", "/w/line\nname"]);
});

test("-z: bare と prunable の worktree は外す", () => {
  const text = zOf([
    ["worktree /a", "HEAD 1", "detached"],
    ["worktree /b", "bare"],
    ["worktree /c", "HEAD 3", "detached", "prunable gitdir file points to non-existent location"],
    ["worktree /d", "HEAD 4", "detached"],
  ]);
  assert.deepEqual(parseWorktreeListZ(text), ["/a", "/d"]);
});

test("-z: 空の出力・想定外の型は空", () => {
  assert.deepEqual(parseWorktreeListZ(""), []);
  assert.deepEqual(parseWorktreeListZ(undefined), []);
});

test("porcelain（フォールバック）: 通常の worktree の根を順に返し、bare と prunable は外す", () => {
  const text = porcelainOf([
    ["worktree /a", "HEAD 1", "branch refs/heads/main"],
    ["worktree /b", "HEAD 2", "detached"],
    ["worktree /c", "bare"],
    ["worktree /d", "HEAD 4", "detached", "prunable gitdir file points to non-existent location"],
  ]);
  assert.deepEqual(parseWorktreeListPorcelain(text), ["/a", "/b"]);
});

test("porcelain（フォールバック）: 引用符で始まるパス（特殊文字を含む）は候補に入れない（誤った場所を作らない）", () => {
  const text = porcelainOf([
    ["worktree /a", "HEAD 1", "detached"],
    ['worktree "/x/with\\ttab"', "HEAD 2", "detached"],
    ['worktree "/x/with\\nline"', "HEAD 3", "detached"],
    ["worktree /b", "HEAD 4", "detached"],
  ]);
  assert.deepEqual(parseWorktreeListPorcelain(text), ["/a", "/b"]);
});

test("porcelain（フォールバック）: 空・worktree の行が無い出力は空", () => {
  assert.deepEqual(parseWorktreeListPorcelain(""), []);
  assert.deepEqual(parseWorktreeListPorcelain("HEAD 1\n\n"), []);
  assert.deepEqual(parseWorktreeListPorcelain(undefined), []);
});
