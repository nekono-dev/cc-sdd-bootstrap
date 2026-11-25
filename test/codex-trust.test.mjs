// codex-trust.mjs（入出力）の試験。
// 一時ディレクトリだけを使い、CODEX_HOME と home は引数・env で渡す。利用者の ~/.codex や codex コマンドには触れない。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readTrustSetting, applyCodexTrust, resolveHooksTarget } from "../.agent-hooks/cc-sdd-bootstrap/codex-trust.mjs";
import { messageTrust } from "../.agent-hooks/cc-sdd-bootstrap/codex-trust-rules.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.join(here, "fixtures", "codex-hooks-sample.json");

/** 試験が作った一時ディレクトリ（後始末用）。読み取り専用に変えたものは戻してから消す */
const created = [];
after(() => {
  for (const dir of created) {
    try {
      fs.chmodSync(dir, 0o755);
    } catch {
      // 既に無い場合は無視する
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 一時ディレクトリを作る（実体の道筋を返す） */
function tmpDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  created.push(dir);
  return dir;
}

const DEFAULT_SETTING = { format: 1, ccSdd: { version: "3.1.0", lang: "ja" }, subagents: {} };

/**
 * 一時のリポジトリを作る。.cc-sdd-bootstrap.json と .codex/hooks.json（試験用の見本）を置く。
 * @param {object | string | null} setting 文字列なら本文をそのまま書く。null なら設定ファイルを作らない
 */
function makeRepo(setting = DEFAULT_SETTING) {
  const repo = tmpDir("codex-trust-repo");
  if (setting !== null) {
    const text = typeof setting === "string" ? setting : JSON.stringify(setting);
    fs.writeFileSync(path.join(repo, ".cc-sdd-bootstrap.json"), text);
  }
  fs.mkdirSync(path.join(repo, ".codex"));
  fs.copyFileSync(SAMPLE_PATH, path.join(repo, ".codex", "hooks.json"));
  return repo;
}

/**
 * 一時の home を作る。codexDir が true なら home/.codex を作る。
 * @returns {{ home: string, codexDir: string, configPath: string }}
 */
function makeHome({ codexDir = true } = {}) {
  const home = tmpDir("codex-trust-home");
  const dir = path.join(home, ".codex");
  if (codexDir) fs.mkdirSync(dir);
  return { home, codexDir: dir, configPath: path.join(dir, "config.toml") };
}

/** 設定ファイルの中の trusted_hash の行の数 */
const countTrusted = (text) => text.split("\n").filter((line) => /^\s*trusted_hash\s*=/.test(line)).length;

/** 試験の既定の env（CODEX_HOME を含めない。process.env を読ませない） */
const NO_ENV = {};

test("readTrustSetting: 設定ファイルが無い・読めない・不正・項目が無い・true のときは true", () => {
  const noFile = makeRepo(null);
  assert.equal(readTrustSetting(noFile), true);

  const badJson = makeRepo("{ 不正な JSON");
  assert.equal(readTrustSetting(badJson), true);

  const noItem = makeRepo({ format: 1, codex: {} });
  assert.equal(readTrustSetting(noItem), true);

  const enabled = makeRepo({ format: 1, codex: { trustHooks: true } });
  assert.equal(readTrustSetting(enabled), true);

  // false 以外（文字列の "false" など）は true の扱い
  const stringFalse = makeRepo({ format: 1, codex: { trustHooks: "false" } });
  assert.equal(readTrustSetting(stringFalse), true);
});

test("readTrustSetting: codex.trustHooks が false のときだけ false を返す", () => {
  const repo = makeRepo({ format: 1, codex: { trustHooks: false } });
  assert.equal(readTrustSetting(repo), false);
});

test("resolveHooksTarget: git のリポジトリではないディレクトリは実体の道筋で、notes は空・isWorktree は false", () => {
  const repo = makeRepo();
  const target = resolveHooksTarget(repo);
  assert.deepEqual(target, {
    hooksJsonPath: path.join(repo, ".codex", "hooks.json"),
    notes: [],
    isWorktree: false,
    mainRoot: repo,
  });
});

test("write: 初回は written、件数 8、設定ファイルに 8 件の記録が入る", () => {
  const repo = makeRepo();
  const { home, configPath } = makeHome();
  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });

  assert.equal(result.status, "written");
  assert.equal(result.configPath, configPath);
  assert.equal(result.counts.added, 8);
  assert.equal(result.reason, null);
  assert.ok(Array.isArray(result.notes));

  const text = fs.readFileSync(configPath, "utf8");
  assert.equal(countTrusted(text), 8);
  // キーは本体の hooks.json の道筋で書かれる
  assert.ok(text.includes(`[hooks.state."${path.join(repo, ".codex", "hooks.json")}:session_start:0:0"]`));
});

test("write: もう一度実行すると unchanged（件数の変更なし 8）で、本文は変わらない", () => {
  const repo = makeRepo();
  const { home, configPath } = makeHome();
  applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });
  const before = fs.readFileSync(configPath, "utf8");

  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });
  assert.equal(result.status, "unchanged");
  assert.equal(result.counts.unchanged, 8);
  assert.equal(result.counts.added, 0);
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
});

test("write: ハッシュを古い値にした記録は updated として更新される（written）", () => {
  const repo = makeRepo();
  const { home, configPath } = makeHome();
  applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });
  const original = fs.readFileSync(configPath, "utf8");

  // 1 件目の trusted_hash を古い値に差し替える
  const stale = original.replace(/trusted_hash = "sha256:[0-9a-f]+"/, `trusted_hash = "sha256:${"0".repeat(64)}"`);
  assert.notEqual(stale, original);
  fs.writeFileSync(configPath, stale);

  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });
  assert.equal(result.status, "written");
  assert.equal(result.counts.updated, 1);
  assert.equal(result.counts.unchanged, 7);
  assert.equal(fs.readFileSync(configPath, "utf8"), original);
});

test("remove: 取り除くと removed（8 件）、もう一度は skipped（取り除く記録がありません）", () => {
  const repo = makeRepo();
  const { home, configPath } = makeHome();
  applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });

  const removed = applyCodexTrust({ repoRoot: repo, mode: "remove", env: NO_ENV, home });
  assert.equal(removed.status, "removed");
  assert.equal(removed.counts.removed, 8);
  assert.equal(countTrusted(fs.readFileSync(configPath, "utf8")), 0);

  const again = applyCodexTrust({ repoRoot: repo, mode: "remove", env: NO_ENV, home });
  assert.equal(again.status, "skipped");
  assert.equal(again.reason, "取り除く記録がありません");
  assert.equal(again.configPath, configPath);
});

test("codex.trustHooks が false のとき write・remove とも disabled で、設定ファイルは変わらない", () => {
  const repo = makeRepo({ format: 1, codex: { trustHooks: false } });
  const { home, configPath } = makeHome();

  const w = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });
  assert.equal(w.status, "disabled");
  assert.equal(fs.existsSync(configPath), false, "設定ファイルを作らない");

  const r = applyCodexTrust({ repoRoot: repo, mode: "remove", env: NO_ENV, home });
  assert.equal(r.status, "disabled");
  assert.equal(fs.existsSync(configPath), false);

  // 既存の設定ファイルがあっても触らない
  const existing = "model = \"x\"\n";
  fs.writeFileSync(configPath, existing);
  applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });
  assert.equal(fs.readFileSync(configPath, "utf8"), existing);
});

test("設定ディレクトリが無いときは skipped、ディレクトリを作らない", () => {
  const repo = makeRepo();
  const { home, codexDir } = makeHome({ codexDir: false });

  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });
  assert.equal(result.status, "skipped");
  assert.ok(result.reason.includes("Codex の設定ディレクトリ"));
  assert.ok(result.reason.includes(codexDir));
  assert.equal(fs.existsSync(codexDir), false, "ディレクトリを作らない");
});

test("設定ファイルが無くディレクトリがあるときは、空の本文から新しく作る", () => {
  const repo = makeRepo();
  const { home, configPath } = makeHome();
  assert.equal(fs.existsSync(configPath), false);

  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });
  assert.equal(result.status, "written");
  assert.equal(result.counts.added, 8);
  assert.equal(countTrusted(fs.readFileSync(configPath, "utf8")), 8);
});

test("remove: 設定ファイルが無いときは skipped（取り除く記録がありません）", () => {
  const repo = makeRepo();
  const { home, configPath } = makeHome();
  const result = applyCodexTrust({ repoRoot: repo, mode: "remove", env: NO_ENV, home });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "取り除く記録がありません");
  assert.equal(fs.existsSync(configPath), false);
});

test("CODEX_HOME があれば home より優先し、home 側には何も作らない", () => {
  const repo = makeRepo();
  const { home, configPath: homeConfig } = makeHome();
  const custom = tmpDir("codex-trust-custom");

  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: { CODEX_HOME: custom }, home });
  assert.equal(result.status, "written");
  assert.equal(result.configPath, path.join(custom, "config.toml"));
  assert.equal(countTrusted(fs.readFileSync(path.join(custom, "config.toml"), "utf8")), 8);
  assert.equal(fs.existsSync(homeConfig), false);
});

test("CODEX_HOME が空文字なら home/.codex を使う", () => {
  const repo = makeRepo();
  const { home, configPath } = makeHome();
  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: { CODEX_HOME: "" }, home });
  assert.equal(result.status, "written");
  assert.equal(result.configPath, configPath);
});

test("シンボリックリンクの config.toml は、リンクを保ったまま実体へ書く", () => {
  const repo = makeRepo();
  const { home, codexDir, configPath } = makeHome({ codexDir: true });
  const elsewhere = tmpDir("codex-trust-real");
  const realPath = path.join(elsewhere, "real.toml");
  fs.writeFileSync(realPath, "model = \"x\"\n");
  fs.symlinkSync(realPath, configPath);

  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });
  assert.equal(result.status, "written");
  assert.ok(fs.lstatSync(configPath).isSymbolicLink(), "リンクが残っている");
  assert.equal(countTrusted(fs.readFileSync(realPath, "utf8")), 8);
  assert.ok(fs.readFileSync(realPath, "utf8").startsWith("model = \"x\"\n"));
  assert.ok(codexDir);
});

test("読み取り専用のディレクトリでは failed（理由とエラーコードつき）、本文は変わらない", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root では読み取り専用の試験が成り立たない");
    return;
  }
  const repo = makeRepo();
  const { home, codexDir, configPath } = makeHome();
  const existing = "model = \"x\"\n";
  fs.writeFileSync(configPath, existing);
  fs.chmodSync(codexDir, 0o555);
  try {
    const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /設定ファイルを書けません/);
    assert.match(result.reason, /（E[A-Z]+）/);
    assert.equal(fs.readFileSync(configPath, "utf8"), existing);
  } finally {
    fs.chmodSync(codexDir, 0o755);
  }
  assert.deepEqual(fs.readdirSync(codexDir).sort(), ["config.toml"], "一時ファイルが残らない");
});

test("複数行の文字列を含む不安全な本文では failed になり、設定は変更されない", () => {
  const repo = makeRepo();
  const { home, configPath } = makeHome();
  const unsafe = "note = \"\"\"\n複数行\n\"\"\"\n";
  fs.writeFileSync(configPath, unsafe);

  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });
  assert.equal(result.status, "failed");
  assert.equal(typeof result.reason, "string");
  assert.equal(fs.readFileSync(configPath, "utf8"), unsafe);
});

test("hooks.json が無いときは skipped（.codex/hooks.json がありません）", () => {
  const repo = makeRepo();
  fs.rmSync(path.join(repo, ".codex", "hooks.json"));
  const { home, configPath } = makeHome();

  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, ".codex/hooks.json がありません");
  assert.equal(fs.existsSync(configPath), false);
});

test("hooks.json が壊れた JSON のときは failed で、設定ファイルを作らない", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, ".codex", "hooks.json"), "{ 壊れた");
  const { home, configPath } = makeHome();

  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });
  assert.equal(result.status, "failed");
  assert.ok(result.reason.length > 0);
  assert.equal(fs.existsSync(configPath), false);
});

test("自分のフックが無い hooks.json は skipped（自分のフックの登録が見つかりません）", () => {
  const repo = makeRepo();
  const userOnly = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } };
  fs.writeFileSync(path.join(repo, ".codex", "hooks.json"), JSON.stringify(userOnly));
  const { home, configPath } = makeHome();

  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "自分のフックの登録が見つかりません");
  assert.equal(fs.existsSync(configPath), false);
});

test("beforeCommit で 1 回だけ本文が変わる → 再計算して written になる", () => {
  const repo = makeRepo();
  const { home, configPath } = makeHome();
  const initial = "model = \"x\"\n";
  fs.writeFileSync(configPath, initial);

  let calls = 0;
  const beforeCommit = () => {
    calls += 1;
    if (calls === 1) fs.appendFileSync(configPath, "# 同時の更新\n");
  };
  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home, beforeCommit });

  assert.equal(result.status, "written");
  const text = fs.readFileSync(configPath, "utf8");
  assert.ok(text.includes("# 同時の更新"), "読み直した新しい本文が残る");
  assert.equal(countTrusted(text), 8);
  assert.deepEqual(fs.readdirSync(path.dirname(configPath)).sort(), ["config.toml"], "一時ファイルが残らない");
});

test("beforeCommit で毎回本文が変わる → failed（同時の更新）、一時ファイルが残らない", () => {
  const repo = makeRepo();
  const { home, codexDir, configPath } = makeHome();
  const initial = "model = \"x\"\n";
  fs.writeFileSync(configPath, initial);

  let n = 0;
  const beforeCommit = () => {
    n += 1;
    fs.appendFileSync(configPath, `# 同時の更新 ${n}\n`);
  };
  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home, beforeCommit });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "設定ファイルが同時に更新されています。もう一度実行してください");
  assert.ok(n >= 2, "1 回だけ計算し直して、もう一度試す");
  assert.deepEqual(fs.readdirSync(codexDir).sort(), ["config.toml"], "一時ファイルが残らない");
});

test("既存の設定ファイルの権限（0o600）は書き換え後も保たれる", () => {
  const repo = makeRepo();
  const { home, configPath } = makeHome();
  fs.writeFileSync(configPath, "model = \"x\"\n");
  fs.chmodSync(configPath, 0o600);

  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });
  assert.equal(result.status, "written");
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test("messageTrust は例外を投げず、表示行の配列を返す", () => {
  const repo = makeRepo();
  const { home } = makeHome();
  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });

  const lines = messageTrust(result);
  assert.ok(Array.isArray(lines));
  assert.ok(lines.length >= 1);
  assert.ok(lines.every((line) => typeof line === "string"));
  assert.doesNotThrow(() => messageTrust(null));
});

test("applyCodexTrust は想定外の入力でも例外を投げず、結果の形（status・configPath・counts・reason・notes）を返す", () => {
  const { home } = makeHome();
  let result;
  assert.doesNotThrow(() => {
    result = applyCodexTrust({ repoRoot: path.join(home, "存在しない"), mode: "write", env: NO_ENV, home });
  });
  assert.ok(["skipped", "failed"].includes(result.status));
  for (const key of ["status", "configPath", "counts", "reason", "notes"]) {
    assert.ok(Object.hasOwn(result, key), `結果に ${key} がある`);
  }
});

test("書く直前にシンボリックリンクの向き先が変わったら failed になり、どちらの実体も変えず、一時ファイルも残さない", () => {
  const repo = makeRepo();
  const { home, codexDir, configPath } = makeHome({ codexDir: true });
  // 張り替え前の実体（A）と張り替え後の実体（B）を別のディレクトリに置く
  const dirA = tmpDir("codex-trust-link-a");
  const dirB = tmpDir("codex-trust-link-b");
  const realA = path.join(dirA, "a.toml");
  const realB = path.join(dirB, "b.toml");
  const originalA = "model = \"a\"\n";
  const originalB = "model = \"b\"\n";
  fs.writeFileSync(realA, originalA);
  fs.writeFileSync(realB, originalB);
  fs.symlinkSync(realA, configPath);

  // 一時ファイルを書いた後・読み直しの直前に、リンクの向き先を B へ張り替える
  let swapped = false;
  const beforeCommit = () => {
    if (swapped) return;
    swapped = true;
    fs.unlinkSync(configPath);
    fs.symlinkSync(realB, configPath);
  };
  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home, beforeCommit });

  assert.equal(swapped, true, "張り替えの差し込みが呼ばれた");
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "設定ファイルのリンク先が途中で変わりました。もう一度実行してください");
  // (b) 張り替え前後のどちらの実体の本文も変わらない
  assert.equal(fs.readFileSync(realA, "utf8"), originalA);
  assert.equal(fs.readFileSync(realB, "utf8"), originalB);
  // (c) 一時ファイルが残らない
  assert.deepEqual(fs.readdirSync(dirA).sort(), ["a.toml"]);
  assert.deepEqual(fs.readdirSync(dirB).sort(), ["b.toml"]);
  assert.ok(codexDir);
});

// ---- タスク 3.2: 本体の checkout の特定と worktree の扱い ----
// 以下の試験は一時ディレクトリで実際に git init・git worktree add を使う。
// コミットには利用者の git の設定を使わない（GIT_CONFIG_GLOBAL・GIT_CONFIG_SYSTEM を空にする）。

/** 試験用の git の実行環境（利用者の git の設定に依存しない） */
function gitEnv() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "", GIT_CONFIG_SYSTEM: "" };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

/** 試験用の git を実行する。失敗したら試験を失敗させる */
function git(cwd, args) {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} が失敗: ${result.stderr}`);
  return result.stdout;
}

/** 本体の checkout を一時の git リポジトリとして作り、設定と hooks.json を commit する */
function makeGitMain() {
  const main = tmpDir("codex-trust-main");
  git(main, ["init", "-q"]);
  fs.writeFileSync(path.join(main, ".cc-sdd-bootstrap.json"), JSON.stringify(DEFAULT_SETTING));
  fs.mkdirSync(path.join(main, ".codex"));
  fs.copyFileSync(SAMPLE_PATH, path.join(main, ".codex", "hooks.json"));
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "init"]);
  return main;
}

/** 本体から worktree（detach）を作る。作った worktree の実体の道筋を返す */
function addWorktree(main) {
  const wt = tmpDir("codex-trust-wt");
  git(main, ["worktree", "add", "-q", "--detach", wt]);
  return wt;
}

/** 本体の checkout の案内文（resolveHooksTarget の notes と同じ文） */
const mismatchNote = (mainRoot) =>
  `本体の checkout（${mainRoot}）の .codex/hooks.json が、この worktree のものと違う（または無い）ため、Codex が読むフックと承認の記録が合わない可能性があります。本体の checkout でも同じ導入（update）を実行してください。`;

test("resolveHooksTarget: 本体の checkout は実体の道筋・isWorktree は false・notes は空", () => {
  const main = makeGitMain();
  assert.deepEqual(resolveHooksTarget(main), {
    hooksJsonPath: path.join(main, ".codex", "hooks.json"),
    notes: [],
    isWorktree: false,
    mainRoot: main,
  });
});

test("resolveHooksTarget: worktree は本体の checkout を mainRoot にし、hooks.json が同じなら notes は空", () => {
  const main = makeGitMain();
  const wt = addWorktree(main);
  assert.deepEqual(resolveHooksTarget(wt), {
    hooksJsonPath: path.join(main, ".codex", "hooks.json"),
    notes: [],
    isWorktree: true,
    mainRoot: main,
  });
});

test("resolveHooksTarget: worktree 側だけ hooks.json が違うと notes に案内が出る", () => {
  const main = makeGitMain();
  const wt = addWorktree(main);
  const wtHooks = path.join(wt, ".codex", "hooks.json");
  fs.writeFileSync(wtHooks, fs.readFileSync(wtHooks, "utf8").replace('"timeout": 30', '"timeout": 31'));

  const target = resolveHooksTarget(wt);
  assert.equal(target.isWorktree, true);
  assert.equal(target.mainRoot, main);
  assert.deepEqual(target.notes, [mismatchNote(main)]);
});

test("resolveHooksTarget: 本体に .codex/hooks.json が無いと notes に案内が出る", () => {
  const main = makeGitMain();
  const wt = addWorktree(main);
  fs.rmSync(path.join(main, ".codex", "hooks.json"));

  assert.deepEqual(resolveHooksTarget(wt).notes, [mismatchNote(main)]);
});

test("resolveHooksTarget: worktree 側の自分のフックが 0 件でも「違う」とみなして notes に案内が出る", () => {
  const main = makeGitMain();
  const wt = addWorktree(main);
  fs.writeFileSync(path.join(wt, ".codex", "hooks.json"), JSON.stringify({ hooks: {} }));

  assert.deepEqual(resolveHooksTarget(wt).notes, [mismatchNote(main)]);
});

test("resolveHooksTarget: シンボリックリンク経由の repoRoot は実体の道筋を返す", () => {
  const main = makeGitMain();
  const link = path.join(tmpDir("codex-trust-link"), "repo-link");
  fs.symlinkSync(main, link);

  assert.deepEqual(resolveHooksTarget(link), {
    hooksJsonPath: path.join(main, ".codex", "hooks.json"),
    notes: [],
    isWorktree: false,
    mainRoot: main,
  });
});

test("resolveHooksTarget: ベアのリポジトリのそばの worktree は本体を特定できず、実体の道筋で動く（isWorktree は false）", () => {
  const source = makeGitMain();
  const base = tmpDir("codex-trust-bare");
  git(base, ["clone", "-q", "--bare", source, "bare.git"]);
  const wt = tmpDir("codex-trust-bare-wt");
  git(path.join(base, "bare.git"), ["worktree", "add", "-q", "--detach", wt]);

  assert.deepEqual(resolveHooksTarget(wt), {
    hooksJsonPath: path.join(wt, ".codex", "hooks.json"),
    notes: [],
    isWorktree: false,
    mainRoot: wt,
  });
});

test("write: 本体の checkout で書くと、キーの道筋は本体の .codex/hooks.json の実体の道筋になる", () => {
  const main = makeGitMain();
  const { home, configPath } = makeHome();
  const result = applyCodexTrust({ repoRoot: main, mode: "write", env: NO_ENV, home });

  assert.equal(result.status, "written");
  assert.equal(result.counts.added, 8);
  assert.deepEqual(result.notes, []);
  const text = fs.readFileSync(configPath, "utf8");
  assert.ok(text.includes(`[hooks.state."${path.join(main, ".codex", "hooks.json")}:session_start:0:0"]`));
});

test("write: worktree から書くと、本体の checkout の道筋のキーで書かれ、worktree の道筋のキーは書かれない", () => {
  const main = makeGitMain();
  const wt = addWorktree(main);
  const { home, configPath } = makeHome();
  const result = applyCodexTrust({ repoRoot: wt, mode: "write", env: NO_ENV, home });

  assert.equal(result.status, "written");
  assert.equal(result.counts.added, 8);
  const text = fs.readFileSync(configPath, "utf8");
  assert.ok(text.includes(`[hooks.state."${path.join(main, ".codex", "hooks.json")}:session_start:0:0"]`));
  assert.ok(!text.includes(path.join(wt, ".codex", "hooks.json")), "worktree の道筋のキーは書かれない");
  assert.deepEqual(result.notes, [], "本体と worktree の hooks.json が同じなら案内は出ない");
});

test("write: worktree で hooks.json が本体と違うと、結果の notes に案内が出て、本体の道筋で書かれる", () => {
  const main = makeGitMain();
  const wt = addWorktree(main);
  const wtHooks = path.join(wt, ".codex", "hooks.json");
  fs.writeFileSync(wtHooks, fs.readFileSync(wtHooks, "utf8").replace('"timeout": 30', '"timeout": 31'));
  const { home, configPath } = makeHome();
  const result = applyCodexTrust({ repoRoot: wt, mode: "write", env: NO_ENV, home });

  assert.equal(result.status, "written");
  assert.deepEqual(result.notes, [mismatchNote(main)]);
  assert.equal(result.configPath, configPath);
});

test("write: 本体に hooks.json が無い worktree は skipped になり、notes に案内が入る", () => {
  const main = makeGitMain();
  const wt = addWorktree(main);
  fs.rmSync(path.join(main, ".codex", "hooks.json"));
  const { home, configPath } = makeHome();
  const result = applyCodexTrust({ repoRoot: wt, mode: "write", env: NO_ENV, home });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, ".codex/hooks.json がありません");
  assert.deepEqual(result.notes, [mismatchNote(main)]);
  assert.ok(!fs.existsSync(configPath), "設定ファイルは作られない");
});

test("remove: worktree からは skipped（理由に worktree を含む）で、設定ファイルは変わらない", () => {
  const main = makeGitMain();
  const wt = addWorktree(main);
  const { home, configPath } = makeHome();
  assert.equal(applyCodexTrust({ repoRoot: main, mode: "write", env: NO_ENV, home }).status, "written");
  const before = fs.readFileSync(configPath, "utf8");

  const result = applyCodexTrust({ repoRoot: wt, mode: "remove", env: NO_ENV, home });
  assert.equal(result.status, "skipped");
  assert.ok(result.reason.includes("worktree"), `理由に worktree を含む: ${result.reason}`);
  assert.equal(result.configPath, null);
  assert.equal(result.counts, null);
  assert.equal(fs.readFileSync(configPath, "utf8"), before, "設定ファイルの本文は変わらない");
});

test("remove: worktree からで設定ファイルが無いときは skipped のままで、ファイルを作らない", () => {
  const main = makeGitMain();
  const wt = addWorktree(main);
  const { home, configPath } = makeHome();

  const result = applyCodexTrust({ repoRoot: wt, mode: "remove", env: NO_ENV, home });
  assert.equal(result.status, "skipped");
  assert.ok(result.reason.includes("worktree"));
  assert.ok(!fs.existsSync(configPath), "設定ファイルは作られない");
});

test("remove: 本体の checkout から取り除くと removed（8 件）になり、write → remove → write が成り立つ", () => {
  const main = makeGitMain();
  const { home, configPath } = makeHome();

  assert.equal(applyCodexTrust({ repoRoot: main, mode: "write", env: NO_ENV, home }).status, "written");
  const removed = applyCodexTrust({ repoRoot: main, mode: "remove", env: NO_ENV, home });
  assert.equal(removed.status, "removed");
  assert.equal(removed.counts.removed, 8);
  assert.equal(countTrusted(fs.readFileSync(configPath, "utf8")), 0);

  const again = applyCodexTrust({ repoRoot: main, mode: "write", env: NO_ENV, home });
  assert.equal(again.status, "written");
  assert.equal(again.counts.added, 8);
  assert.equal(countTrusted(fs.readFileSync(configPath, "utf8")), 8);
});

test("git のリポジトリではないディレクトリでは実体の道筋で書き、notes は空", () => {
  const repo = makeRepo();
  const { home, configPath } = makeHome();
  const result = applyCodexTrust({ repoRoot: repo, mode: "write", env: NO_ENV, home });

  assert.equal(result.status, "written");
  assert.deepEqual(result.notes, []);
  assert.ok(fs.readFileSync(configPath, "utf8").includes(`${path.join(repo, ".codex", "hooks.json")}:session_start:0:0`));
});

test("シンボリックリンク経由の repoRoot で書くと、キーは実体の道筋で書かれる", () => {
  const main = makeGitMain();
  const link = path.join(tmpDir("codex-trust-link"), "repo-link");
  fs.symlinkSync(main, link);
  const { home, configPath } = makeHome();
  const result = applyCodexTrust({ repoRoot: link, mode: "write", env: NO_ENV, home });

  assert.equal(result.status, "written");
  const text = fs.readFileSync(configPath, "utf8");
  assert.ok(text.includes(`[hooks.state."${path.join(main, ".codex", "hooks.json")}:session_start:0:0"]`));
  assert.ok(!text.includes(link), "リンク経由の道筋のキーは書かれない");
});
