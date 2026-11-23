import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { catalog, CONFIG_PATH, DEPLOY_DIR } from "../lib/catalog.mjs";
import { checkPathSafety, isGitRoot, readSnapshot } from "../lib/target-new.mjs";

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "target-new-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("導入では計画に必要な項目と型に合う生成物を読む", (t) => {
  const root = temporary(t);
  const packageRoot = temporary(t);
  fs.writeFileSync(path.join(root, CONFIG_PATH), "設定");
  fs.mkdirSync(path.join(root, DEPLOY_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, DEPLOY_DIR, "old.mjs"), "配置物");
  fs.mkdirSync(path.join(root, ".claude/agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude/agents/cc-sdd-a.md"), "生成物");
  fs.writeFileSync(path.join(root, ".claude/agents/other.md"), "対象外");
  for (const file of catalog.files) {
    fs.mkdirSync(path.dirname(path.join(packageRoot, file.path)), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, file.path), `同梱:${file.path}`);
  }
  const custom = { ...catalog, generated: [{ owns: [".claude/agents/cc-sdd-*.md"] }] };
  const result = readSnapshot(root, packageRoot, custom, "init");
  assert.equal(result.config, "設定");
  assert.deepEqual(Object.keys(result.deployDirFiles), [`${DEPLOY_DIR}/old.mjs`]);
  assert.deepEqual(Object.keys(result.generatedFiles), [".claude/agents/cc-sdd-a.md"]);
  assert.deepEqual(Object.keys(result.sourceFiles), catalog.files.map((file) => file.path));
  assert.deepEqual(result.agentDocs, { claude: null, codex: null });
});

test("取り外しでは設定や配置先に触れず、設定が壊れていても成功する", (t) => {
  const root = temporary(t);
  const packageRoot = temporary(t);
  fs.writeFileSync(path.join(root, CONFIG_PATH), "{");
  fs.mkdirSync(path.join(root, DEPLOY_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, DEPLOY_DIR, "broken"), "");
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude/settings.json"), "Claude");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "案内");
  const result = readSnapshot(root, packageRoot, catalog, "uninstall");
  assert.equal(result.config, null);
  assert.deepEqual(result.deployDirFiles, {});
  assert.deepEqual(result.sourceFiles, {});
  assert.equal(result.claudeSettings, "Claude");
  assert.deepEqual(result.agentDocs, { claude: null, codex: "案内" });
});

test("すべての対象道筋を読む前にシンボリックリンクを拒み対象と理由を返す", (t) => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.symlinkSync(os.tmpdir(), path.join(root, ".claude/settings.json"));
  assert.deepEqual(checkPathSafety(root, ".claude/settings.json"), {
    ok: false, reason: "SYMLINK", at: ".claude/settings.json",
  });
  assert.deepEqual(readSnapshot(root, temporary(t), catalog, "uninstall"), {
    ok: false, reason: "SYMLINK", at: ".claude/settings.json",
  });
  assert.deepEqual(checkPathSafety(root, "../outside"), { ok: false, reason: "OUTSIDE", at: "../outside" });
});

test("git の最上位は直下の .git の有無で判定する", (t) => {
  const root = temporary(t);
  assert.equal(isGitRoot(root), false);
  fs.writeFileSync(path.join(root, ".git"), "gitdir: elsewhere");
  assert.equal(isGitRoot(root), true);
});

test("配置先の祖先リンクは列挙する前に対象付きで拒否する", (t) => {
  const root = temporary(t);
  fs.symlinkSync(os.tmpdir(), path.join(root, ".agent-hooks"));
  assert.deepEqual(readSnapshot(root, temporary(t), catalog, "init"), {
    ok: false, reason: "SYMLINK", at: DEPLOY_DIR,
  });
});

test("根自身がシンボリックリンクなら拒否する", (t) => {
  const parent = temporary(t);
  const actual = path.join(parent, "actual");
  fs.mkdirSync(actual);
  fs.symlinkSync(actual, path.join(parent, "linked"));
  assert.deepEqual(checkPathSafety(path.join(parent, "linked"), "CLAUDE.md"), {
    ok: false, reason: "SYMLINK", at: "CLAUDE.md",
  });
});

test("根直下の generated owns 対象も読み取る", (t) => {
  const root = temporary(t);
  const packageRoot = temporary(t);
  fs.writeFileSync(path.join(root, "package.json"), "既存");
  const result = readSnapshot(root, packageRoot, { files: [], generated: [{ owns: ["package*.json"] }] }, "update");
  assert.equal(result.generatedFiles["package.json"].toString(), "既存");
});

test("generated owns は親直下だけを調べ、対象外の下位ディレクトリを列挙しない", (t) => {
  const root = temporary(t);
  const packageRoot = temporary(t);
  fs.writeFileSync(path.join(root, "package.json"), "既存");
  fs.mkdirSync(path.join(root, "test"));
  const original = fs.readdirSync;
  fs.readdirSync = function (target, ...args) {
    if (path.resolve(String(target)) === path.join(root, "test")) {
      const error = new Error("対象外ディレクトリは読めません");
      error.code = "EACCES";
      throw error;
    }
    return original.call(this, target, ...args);
  };
  let result;
  try {
    result = readSnapshot(root, packageRoot, { files: [], generated: [{ owns: ["package*.json"] }] }, "update");
  } finally {
    fs.readdirSync = original;
  }
  assert.equal(result.generatedFiles["package.json"].toString(), "既存");
});

test("owns の型は親直下の通常ファイルだけを読み、リンクは対象付きで拒否する", (t) => {
  const root = temporary(t);
  const packageRoot = temporary(t);
  fs.writeFileSync(path.join(root, "cc-sdd-root.json"), "根のファイル");
  fs.mkdirSync(path.join(root, "cc-sdd-directory.json"));
  fs.mkdirSync(path.join(root, "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "nested/cc-sdd-child.json"), "階層のファイル");
  fs.mkdirSync(path.join(root, "nested/cc-sdd-folder.json"));
  const catalogForTest = { files: [], generated: [{ owns: ["cc-sdd-*.json", "nested/cc-sdd-*.json"] }] };
  const result = readSnapshot(root, packageRoot, catalogForTest, "update");
  assert.deepEqual(Object.fromEntries(Object.entries(result.generatedFiles).map(([name, value]) => [name, value.toString()])), {
    "cc-sdd-root.json": "根のファイル",
    "nested/cc-sdd-child.json": "階層のファイル",
  });

  for (const [name, target] of [["cc-sdd-link.json", "cc-sdd-root.json"], ["nested/cc-sdd-link.json", "cc-sdd-child.json"]]) {
    fs.symlinkSync(target, path.join(root, name));
    assert.deepEqual(readSnapshot(root, packageRoot, catalogForTest, "update"), {
      ok: false, reason: "SYMLINK", at: name,
    });
    fs.unlinkSync(path.join(root, name));
  }

  fs.symlinkSync("cc-sdd-folder.json", path.join(root, "nested/cc-sdd-link.json"));
  assert.deepEqual(readSnapshot(root, packageRoot, catalogForTest, "update"), {
    ok: false, reason: "SYMLINK", at: "nested/cc-sdd-link.json",
  });
});
