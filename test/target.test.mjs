import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { catalog, CONFIG_PATH, DEPLOY_DIR } from "../lib/catalog.mjs";
import { applyPlan, checkPathSafety, isGitRoot, readSnapshot } from "../lib/target.mjs";

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "target-"));
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

test("計画を所定の段階順に適用し、生成物を作成・更新・削除する", (t) => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, ".claude/agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude/agents/cc-sdd-old.md"), "旧");
  fs.writeFileSync(path.join(root, ".claude/agents/cc-sdd-update.md"), "更新前");
  const changes = [
    { kind: "write", path: ".gitignore", content: "ignore" },
    { kind: "write", path: ".claude/agents/cc-sdd-new.md", content: "新", created: true },
    { kind: "write", path: ".claude/agents/cc-sdd-update.md", content: "更新後", created: false },
    { kind: "write", path: ".claude/settings.json", content: "hooks" },
    { kind: "write", path: ".agent-hooks/cc-sdd-bootstrap/deploy", content: "配布" },
    { kind: "write", path: ".cc-sdd-bootstrap.json", content: "設定" },
    { kind: "delete", path: ".claude/agents/cc-sdd-old.md" },
  ];
  const result = applyPlan(root, changes);
  assert.equal(result.ok, true);
  assert.deepEqual(result.done.map(({ path }) => path), [
    ".cc-sdd-bootstrap.json",
    ".agent-hooks/cc-sdd-bootstrap/deploy",
    ".claude/agents/cc-sdd-old.md",
    ".claude/agents/cc-sdd-new.md",
    ".claude/agents/cc-sdd-update.md",
    ".claude/settings.json",
    ".gitignore",
  ]);
  assert.equal(fs.readFileSync(path.join(root, ".claude/agents/cc-sdd-new.md"), "utf8"), "新");
  assert.equal(fs.readFileSync(path.join(root, ".claude/agents/cc-sdd-update.md"), "utf8"), "更新後");
  assert.equal(fs.existsSync(path.join(root, ".claude/agents/cc-sdd-old.md")), false);
});

test("削除で空になった配置先のディレクトリを根まで残さず消す", (t) => {
  const root = temporary(t);
  const file = ".agent-hooks/cc-sdd-bootstrap/old";
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), "旧");
  const result = applyPlan(root, [{ kind: "delete", path: file }]);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(root, ".agent-hooks")), false);
  assert.equal(fs.existsSync(root), true);
});

test("適用前の安全確認と失敗位置、済んだ変更、未処理変更を返す", (t) => {
  const root = temporary(t);
  const first = { kind: "write", path: ".cc-sdd-bootstrap.json", content: "設定" };
  const failed = { kind: "write", path: "blocked/file", content: "失敗" };
  const pending = { kind: "write", path: ".gitignore", content: "後続" };
  fs.writeFileSync(path.join(root, "blocked"), "ファイルが親を塞ぐ");
  const result = applyPlan(root, [first, failed, pending]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.done, [first]);
  assert.equal(result.failed.change, failed);
  assert.match(result.failed.message, /blocked\/file/);
  assert.deepEqual(result.pending, [pending]);
  assert.equal(fs.existsSync(path.join(root, ".gitignore")), false);
  const unsafe = applyPlan(root, [{ kind: "write", path: "../outside", content: "禁止" }]);
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.failed.change.path, "../outside");
});

test("書き込み権限の失敗を記録して後続を適用しない", (t) => {
  const root = temporary(t);
  const first = { kind: "write", path: "first", content: "完了" };
  const denied = { kind: "write", path: "locked/file", content: "拒否" };
  const pending = { kind: "write", path: "last", content: "未処理" };
  const original = fs.writeFileSync;
  fs.writeFileSync = function (file, ...args) {
    if (path.resolve(String(file)) === path.join(root, "locked/file")) {
      const error = new Error("書き込み権限がありません");
      error.code = "EACCES";
      throw error;
    }
    return original.call(this, file, ...args);
  };
  let result;
  try { result = applyPlan(root, [first, denied, pending]); }
  finally { fs.writeFileSync = original; }
  assert.equal(result.ok, false);
  assert.deepEqual(result.done, [first]);
  assert.equal(result.failed.change, denied);
  assert.match(result.failed.message, /locked\/file/);
  assert.deepEqual(result.pending, [pending]);
  assert.equal(fs.existsSync(path.join(root, "last")), false);
});

test("生成物を消した後に空になった親ディレクトリも根まで消す", (t) => {
  const root = temporary(t);
  const file = ".claude/agents/cc-sdd-old.md";
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), "旧");
  const result = applyPlan(root, [{ kind: "delete", path: file }]);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(root, ".claude")), false);
  assert.equal(fs.existsSync(root), true);
});

test("空ディレクトリの片付けに失敗したら報告し、後続を止める", (t) => {
  const root = temporary(t);
  const file = ".agent-hooks/cc-sdd-bootstrap/old";
  const failed = { kind: "delete", path: file };
  const pending = { kind: "write", path: ".gitignore", content: "後続" };
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), "旧");
  const original = fs.rmdirSync;
  fs.rmdirSync = function (target, ...args) {
    if (path.resolve(String(target)) === path.join(root, ".agent-hooks/cc-sdd-bootstrap")) {
      const error = new Error("片付け権限がありません");
      error.code = "EACCES";
      throw error;
    }
    return original.call(this, target, ...args);
  };
  let result;
  try { result = applyPlan(root, [failed, pending]); }
  finally { fs.rmdirSync = original; }
  assert.equal(result.ok, false);
  assert.deepEqual(result.done, []);
  assert.equal(result.failed.change, failed);
  assert.match(result.failed.message, /片付け権限/);
  assert.deepEqual(result.pending, [pending]);
  assert.equal(fs.existsSync(path.join(root, ".gitignore")), false);
});

test("実際に書き込み権限を外したディレクトリで失敗を返す", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root では chmod の書き込み制限が効かない");
    return;
  }
  const root = temporary(t);
  const locked = path.join(root, "locked");
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o555);
  const first = { kind: "write", path: "first", content: "完了" };
  const denied = { kind: "write", path: "locked/file", content: "拒否" };
  const pending = { kind: "write", path: "last", content: "未処理" };
  const result = applyPlan(root, [first, denied, pending]);
  fs.chmodSync(locked, 0o755);
  assert.equal(result.ok, false);
  assert.deepEqual(result.done, [first]);
  assert.equal(result.failed.change, denied);
  assert.match(result.failed.message, /locked\/file/);
  assert.deepEqual(result.pending, [pending]);
  assert.equal(fs.existsSync(path.join(root, "last")), false);
});

test("導入と取り外しの適用順に両フックと文書を含める", (t) => {
  const root = temporary(t);
  const deploy = { kind: "delete", path: `${DEPLOY_DIR}/old` };
  const deployWrite = { kind: "write", path: `${DEPLOY_DIR}/new`, content: "配置" };
  const generatedDelete = { kind: "delete", path: ".claude/agents/cc-sdd-old.md" };
  const generatedWrite = { kind: "write", path: ".claude/agents/cc-sdd-new.md", content: "生成" };
  const changes = [
    { kind: "write", path: ".gitignore", content: "ignore" },
    { kind: "write", path: ".codex/hooks.json", content: "codex" },
    generatedWrite, deployWrite,
    { kind: "write", path: ".claude/settings.json", content: "claude" },
    generatedDelete, deploy,
    { kind: "write", path: ".cc-sdd-bootstrap.json", content: "設定" },
  ];
  const result = applyPlan(root, changes);
  assert.equal(result.ok, true);
  assert.deepEqual(result.done.map(({ path }) => path), [
    ".cc-sdd-bootstrap.json", `${DEPLOY_DIR}/old`, `${DEPLOY_DIR}/new`,
    ".claude/agents/cc-sdd-old.md", ".claude/agents/cc-sdd-new.md",
    ".claude/settings.json", ".codex/hooks.json", ".gitignore",
  ]);

  const uninstall = [
    { kind: "write", path: "AGENTS.md", content: "agents" },
    { kind: "write", path: ".codex/hooks.json", content: "codex" },
    { kind: "write", path: "CLAUDE.md", content: "claude doc" },
    { kind: "write", path: ".claude/settings.json", content: "claude hooks" },
  ];
  const removed = applyPlan(root, uninstall);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.done.map(({ path }) => path), [
    ".claude/settings.json", ".codex/hooks.json", "CLAUDE.md", "AGENTS.md",
  ]);
});

test("導入の読み取りは配布元の版を snapshot.source に入れ、node_modules の外では null を入れる（1.6）", (t) => {
  const root = temporary(t);
  const commit = "b".repeat(40);
  // 配布物: <base>/node_modules/cc-sdd-bootstrap/（取り出し元の .package-lock.json と package-lock.json を 1・2 つ上に置く）
  const base = temporary(t);
  const packageRoot = path.join(base, "node_modules", "cc-sdd-bootstrap");
  for (const file of catalog.files) {
    fs.mkdirSync(path.dirname(path.join(packageRoot, file.path)), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, file.path), `同梱:${file.path}`);
  }
  fs.writeFileSync(path.join(base, "node_modules", ".package-lock.json"), JSON.stringify({
    packages: { "node_modules/cc-sdd-bootstrap": { resolved: `git+https://example.invalid/r.git#${commit}` } },
  }));
  fs.writeFileSync(path.join(base, "package-lock.json"), JSON.stringify({
    packages: { "": { dependencies: { "cc-sdd-bootstrap": "github:example/r#main" } } },
  }));
  const installed = readSnapshot(root, packageRoot, catalog, "init");
  assert.deepEqual(installed.source, { commit, ref: "main" });

  // 手元の checkout 相当（node_modules の下ではない）
  const checkout = temporary(t);
  for (const file of catalog.files) {
    fs.mkdirSync(path.dirname(path.join(checkout, file.path)), { recursive: true });
    fs.writeFileSync(path.join(checkout, file.path), `同梱:${file.path}`);
  }
  const local = readSnapshot(root, checkout, catalog, "init");
  assert.deepEqual(local.source, { commit: null, ref: null });
});
