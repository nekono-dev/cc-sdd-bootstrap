import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs, buildUsage, runCli, formatSuccess, formatAbort, formatApplyFailure } from "../lib/cli.mjs";
import { configFields } from "../lib/config-schema.mjs";

/**
 * 一時の CODEX_HOME と HOME を作る。利用者の実際の ~/.codex を読み書きしないための分離。
 * CODEX_HOME はディレクトリとして存在させる（既定では存在するとして扱う）。
 */
function codexIsolation(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cli-codex-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const codexHome = path.join(base, "codex");
  const home = path.join(base, "home");
  fs.mkdirSync(codexHome);
  fs.mkdirSync(home);
  return { codexHome, home, env: { ...process.env, CODEX_HOME: codexHome, HOME: home } };
}

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-modern-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}
/** 標準出力・標準エラーを集める入出力。iso の分離（env・home）を必ず渡す */
function io(cwd, iso, extra = {}) {
  let stdout = "";
  let stderr = "";
  return { value: { cwd, packageRoot: path.resolve("."), env: iso.env, home: iso.home, stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } }, ...extra }, output: () => ({ stdout, stderr }), iso };
}

const TRUST_NOTE = "信頼の承認が必要です";
const TRUST_WRITTEN = "Codex のフックの承認の記録を書きました";

test("受け付ける操作は init・update・uninstall と help だけ", () => {
  for (const operation of ["init", "update", "uninstall"]) assert.deepEqual(parseArgs([operation]), { kind: "run", operation });
  for (const args of [["--help"], ["-h"], ["help"]]) assert.deepEqual(parseArgs(args), { kind: "help" });
  for (const args of [["bogus"], ["init", "--force"], ["init", "--lang", "en"], ["init", "extra"]]) {
    assert.equal(parseArgs(args).kind, "usage-error");
  }
});

test("使い方は操作と設定ファイルの直接編集方法を示す", () => {
  const usage = buildUsage(configFields);
  for (const word of ["init", "update", "uninstall", ".cc-sdd-bootstrap.json", "直接編集"]) assert.ok(usage.includes(word), word);
  assert.ok(!usage.includes("--force"));
});

test("未知の指定は何も変えず、問題と使い方を表示して終了コード 1", async (t) => {
  const root = temporary(t);
  const streams = io(root, codexIsolation(t));
  assert.equal(await runCli(["init", "--force"], streams.value), 1);
  assert.match(streams.output().stderr, /--force/);
  assert.match(streams.output().stderr, /使い方/);
  assert.deepEqual(fs.readdirSync(root), [".git"]);
});

test("git の最上位でない場所では何も変えず失敗", async (t) => {
  const root = temporary(t);
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  const streams = io(nested, codexIsolation(t));
  assert.equal(await runCli(["init"], streams.value), 1);
  assert.match(streams.output().stderr, /最上位/);
  assert.deepEqual(fs.readdirSync(nested), []);
});

test("壊れた設定を読まずに uninstall し、登録と運用区画を外す", async (t) => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, ".cc-sdd-bootstrap.json"), "{");
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude/settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node /repo/.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs" }, { type: "command", command: "node user-hook.mjs" }] }] }, userSetting: true }));
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex/hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node /repo/.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs" }, { type: "command", command: "node user-hook.mjs" }] }] }, userSetting: true }));
  fs.mkdirSync(path.join(root, ".agent-hooks/cc-sdd-bootstrap"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent-hooks/cc-sdd-bootstrap/user.mjs"), "利用者の配置物");
  fs.writeFileSync(path.join(root, ".gitignore"), "# 利用者の除外設定\nsecret/\n");
  const marker = "<!-- cc-sdd-bootstrap:begin（この区画は cc-sdd の導入のたびに書き足される。編集しない） -->\n\n案内\n\n<!-- cc-sdd-bootstrap:end -->\n";
  fs.writeFileSync(path.join(root, "AGENTS.md"), "利用者の文書\n\n" + marker);
  fs.writeFileSync(path.join(root, "CLAUDE.md"), `標準文書\n\n${marker}`);
  const streams = io(root, codexIsolation(t));
  assert.equal(await runCli(["uninstall"], streams.value), 0);
  assert.equal(fs.readFileSync(path.join(root, ".cc-sdd-bootstrap.json"), "utf8"), "{");
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "標準文書\n");
  assert.equal(fs.readFileSync(path.join(root, ".cc-sdd-bootstrap.json"), "utf8"), "{");
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "利用者の文書\n");
  for (const file of [".claude/settings.json", ".codex/hooks.json"]) {
    const saved = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    assert.equal(saved.userSetting, true);
    assert.equal(saved.hooks.SessionStart[0].hooks.length, 1);
    assert.equal(saved.hooks.SessionStart[0].hooks[0].command, "node user-hook.mjs");
  }
  assert.equal(fs.readFileSync(path.join(root, ".agent-hooks/cc-sdd-bootstrap/user.mjs"), "utf8"), "利用者の配置物");
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), "# 利用者の除外設定\nsecret/\n");
  assert.match(streams.output().stdout, /成功|取り外し/);
});

test("help 併記時も未知の操作・指定を拒否して問題と使い方を表示", async (t) => {
  for (const args of [["bogus", "--help"], ["init", "--force", "--help"]]) {
    const root = temporary(t);
    const streams = io(root, codexIsolation(t));
    assert.equal(await runCli(args, streams.value), 1, args.join(" "));
    assert.match(streams.output().stderr, /使い方/);
    assert.match(streams.output().stderr, args[0] === "bogus" ? /bogus/ : /--force/);
    assert.deepEqual(fs.readdirSync(root), [".git"]);
  }
});

test("help は終了コード 0 で案内を出し、対象を変更しない", async (t) => {
  const root = temporary(t);
  const streams = io(root, codexIsolation(t));
  assert.equal(await runCli(["--help"], streams.value), 0);
  assert.match(streams.output().stdout, /init/);
  assert.match(streams.output().stdout, /\.cc-sdd-bootstrap\.json/);
  assert.match(streams.output().stdout, /直接編集/);
  assert.deepEqual(fs.readdirSync(root), [".git"]);
});

test("導入成功は変更一覧と通知を日本語で表示する", () => {
  const output = formatSuccess("init", {
    changes: [
      { kind: "write", path: ".cc-sdd-bootstrap.json", created: true },
      { kind: "write", path: ".agent-hooks/cc-sdd-bootstrap/a.mjs", created: false },
      { kind: "delete", path: ".agent-hooks/cc-sdd-bootstrap/old.mjs" },
    ],
    notices: [
      { code: "CONFIG_CREATED", defaults: ["ccSdd.version", "ccSdd.lang"] },
      { code: "CODEX_TRUST" },
      { code: "EXISTING_AGENT_DOCS", files: ["CLAUDE.md", "AGENTS.md"] },
      { code: "GENERATED_NOTICE", id: "agents", messages: ["設定から役割のファイルを作りました"] },
    ],
  });
  for (const text of ["作成: .cc-sdd-bootstrap.json", "更新: .agent-hooks/cc-sdd-bootstrap/a.mjs", "削除: .agent-hooks/cc-sdd-bootstrap/old.mjs", "ccSdd.version=3.1.0", "ccSdd.lang=ja", "直接編集", ".agent-hooks/cc-sdd-bootstrap/", "git", "信頼", "AGENTS.md", "CLAUDE.md", ".kiro/steering/", "追跡", "コミット", "session-install", "設定から役割のファイルを作りました", "対話", "codex exec", "worktree", "本体の checkout", "node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs"]) assert.ok(output.includes(text), text);
  assert.match(output, /未承認.*AGENTS\.md/);
});

test("update の成功にも Codex の承認・worktree 案内を表示する", () => {
  const output = formatSuccess("update", { changes: [{ kind: "write", path: ".codex/hooks.json", created: false }], notices: [] });
  for (const text of ["対話", "codex exec", "worktree", "本体の checkout", "node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs", "AGENTS.md"]) assert.ok(output.includes(text), text);
});

test("取り外しを再実行しても残る対象を runCli で表示する", async (t) => {
  const root = temporary(t);
  const iso = codexIsolation(t);
  const streams = io(root, iso);
  assert.equal(await runCli(["init"], streams.value), 0);
  assert.equal(await runCli(["uninstall"], streams.value), 0);
  const second = io(root, iso);
  assert.equal(await runCli(["uninstall"], second.value), 0);
  for (const text of ["取り外す登録・区画はありません", ".cc-sdd-bootstrap.json", ".agent-hooks/cc-sdd-bootstrap/", ".gitignore"]) assert.ok(second.output().stdout.includes(text), text);
});

test("変更なしと取り外し成功が状態と残る対象を表示する", () => {
  const unchanged = formatSuccess("update", { changes: [], notices: [] });
  assert.match(unchanged, /変更はありません/);
  for (const text of ["codex exec", "worktree", "node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs"]) assert.ok(!unchanged.includes(text), text);
  const removed = formatSuccess("uninstall", { changes: [{ kind: "delete", path: ".claude/settings.json" }], notices: [], removed: [".claude/settings.json", "CLAUDE.md"] });
  for (const text of ["外した", ".claude/settings.json", "CLAUDE.md", ".cc-sdd-bootstrap.json", ".agent-hooks/cc-sdd-bootstrap/", ".gitignore"]) assert.ok(removed.includes(text), text);
  for (const text of ["codex exec", "worktree", "node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs"]) assert.ok(!removed.includes(text), text);
});

test("中止理由ごとにファイル・問題・直し方を表示する", () => {
  for (const abort of [
    { code: "CONFIG_EXISTS" }, { code: "CONFIG_MISSING" },
    { code: "CONFIG_INVALID", file: ".cc-sdd-bootstrap.json", messages: ["language: 値が不正です"] },
    { code: "HOOKS_INVALID", file: ".codex/hooks.json", messages: ["JSON を読めません"] },
    { code: "BLOCK_INVALID", file: "AGENTS.md", messages: ["終了の目印がありません"] },
  ]) {
    const output = formatAbort(abort);
    assert.ok(output.length > 0);
    if (abort.file) for (const text of [abort.file, abort.messages[0], "直してください"]) assert.ok(output.includes(text), `${abort.code}: ${text}`);
  }
});

test("途中失敗は失敗・済み・未処理・再実行する操作を表示する", () => {
  const output = formatApplyFailure("init", {
    done: [{ path: ".cc-sdd-bootstrap.json" }],
    failed: { change: { path: ".codex/hooks.json" }, message: "書き込みに失敗しました: 権限がありません" },
    pending: [{ path: ".gitignore" }],
  });
  for (const text of [".codex/hooks.json", "権限がありません", ".cc-sdd-bootstrap.json", ".gitignore", "update"]) assert.ok(output.includes(text), text);
});


/** config.toml の承認の記録の数（trusted_hash の行の数） */
const recordCount = (text) => (text.match(/trusted_hash/g) ?? []).length;

test("init は自分のフック 8 件の承認の記録を書き、信頼の案内を出さない", async (t) => {
  const root = temporary(t);
  const iso = codexIsolation(t);
  const streams = io(root, iso);
  assert.equal(await runCli(["init"], streams.value), 0);
  const config = fs.readFileSync(path.join(iso.codexHome, "config.toml"), "utf8");
  assert.equal(recordCount(config), 8);
  const output = streams.output().stdout;
  assert.ok(output.includes(TRUST_WRITTEN), output);
  assert.ok(!output.includes(TRUST_NOTE), output);
});

test("計画の変更が 0 件の update（2 回目）でも承認の段階を呼び、最新の表示を出す", async (t) => {
  const root = temporary(t);
  const iso = codexIsolation(t);
  assert.equal(await runCli(["init"], io(root, iso).value), 0);
  const second = io(root, iso);
  assert.equal(await runCli(["update"], second.value), 0);
  const output = second.output().stdout;
  assert.match(output, /変更はありません。/);
  assert.ok(output.includes("Codex のフックの承認の記録は最新です"), output);
  assert.ok(!output.includes(TRUST_NOTE), output);
});

test("uninstall は承認の記録を取り除き、フックの登録も外す", async (t) => {
  const root = temporary(t);
  const iso = codexIsolation(t);
  assert.equal(await runCli(["init"], io(root, iso).value), 0);
  const removed = io(root, iso);
  assert.equal(await runCli(["uninstall"], removed.value), 0);
  assert.ok(removed.output().stdout.includes("Codex のフックの承認の記録を取り除きました"), removed.output().stdout);
  const config = path.join(iso.codexHome, "config.toml");
  assert.equal(recordCount(fs.readFileSync(config, "utf8")), 0);
  // 登録が 0 件になれば hooks.json は消える。残るなら自分の登録を含まない
  const hooks = path.join(root, ".codex/hooks.json");
  assert.ok(!fs.existsSync(hooks) || !fs.readFileSync(hooks, "utf8").includes(".agent-hooks/cc-sdd-bootstrap/"));
});

test("codex.trustHooks が false のとき、update と uninstall は config.toml を作らず、理由と手での承認の案内を出す", async (t) => {
  const root = temporary(t);
  const iso = codexIsolation(t);
  const config = path.join(iso.codexHome, "config.toml");
  const settingFile = path.join(root, ".cc-sdd-bootstrap.json");
  assert.equal(await runCli(["init"], io(root, iso).value), 0);
  // 記録が無い状態から始め、false のときに作られないことを確かめる
  fs.rmSync(config, { force: true });
  const current = JSON.parse(fs.readFileSync(settingFile, "utf8"));
  // 計画に変更を作る（子の上限を下げると上の系統の定義が消える）ため、update の成功の表示を通る
  fs.writeFileSync(settingFile, `${JSON.stringify({ ...current, codex: { trustHooks: false }, subagents: { maxModel: { claude: "sonnet" } } }, null, 2)}\n`);

  const updated = io(root, iso);
  assert.equal(await runCli(["update"], updated.value), 0);
  const updatedOutput = updated.output().stdout;
  assert.ok(updatedOutput.includes("処理が完了しました。"), updatedOutput);
  assert.ok(updatedOutput.includes("false"), updatedOutput);
  assert.ok(updatedOutput.includes(TRUST_NOTE), updatedOutput);
  assert.ok(!fs.existsSync(config), "update が config.toml を作りました");

  // 変更が 0 件の update でも、理由と手での承認の案内を出す
  const unchanged = io(root, iso);
  assert.equal(await runCli(["update"], unchanged.value), 0);
  assert.match(unchanged.output().stdout, /変更はありません。/);
  assert.ok(unchanged.output().stdout.includes("手で承認するには"), unchanged.output().stdout);
  assert.ok(!fs.existsSync(config), "変更の無い update が config.toml を作りました");

  const removed = io(root, iso);
  assert.equal(await runCli(["uninstall"], removed.value), 0);
  assert.ok(removed.output().stdout.includes("false"), removed.output().stdout);
  assert.ok(!fs.existsSync(config), "uninstall が config.toml を作りました");
});

test("CODEX_HOME のディレクトリが無いと、理由と案内を出し、終了コードは 0", async (t) => {
  const root = temporary(t);
  const iso = codexIsolation(t);
  fs.rmSync(iso.codexHome, { recursive: true, force: true });
  const streams = io(root, iso);
  assert.equal(await runCli(["init"], streams.value), 0);
  const output = streams.output().stdout;
  assert.ok(output.includes("設定ディレクトリ"), output);
  assert.ok(output.includes(TRUST_NOTE), output);
  assert.ok(!output.includes(TRUST_WRITTEN), output);
  assert.ok(!fs.existsSync(iso.codexHome));
});

test("設定ディレクトリに書けないと、終了コードは 0 のまま失敗の理由を出し、設定は変えない", async (t) => {
  // root では読み取り専用の権限が効かないため、その場合は試験しない
  if (process.getuid?.() === 0) { t.skip("root では読み取り専用の権限が効かない"); return; }
  const root = temporary(t);
  const iso = codexIsolation(t);
  const config = path.join(iso.codexHome, "config.toml");
  fs.writeFileSync(config, "# 利用者の設定\n");
  // 一時ファイルを作れないように、ディレクトリだけを読み取り専用にする
  fs.chmodSync(iso.codexHome, 0o555);
  try {
    const streams = io(root, iso);
    assert.equal(await runCli(["init"], streams.value), 0);
    const output = streams.output().stdout;
    assert.ok(output.includes("書けませんでした"), output);
    assert.ok(output.includes(TRUST_NOTE), output);
    assert.equal(fs.readFileSync(config, "utf8"), "# 利用者の設定\n");
  } finally {
    fs.chmodSync(iso.codexHome, 0o755);
  }
});

test("計画が中止されるとき（既存の設定で init）は承認の段階を呼ばず、config.toml は変わらない", async (t) => {
  const root = temporary(t);
  const iso = codexIsolation(t);
  const config = path.join(iso.codexHome, "config.toml");
  fs.writeFileSync(config, "# 利用者の設定\n");
  fs.writeFileSync(path.join(root, ".cc-sdd-bootstrap.json"), `${JSON.stringify({ format: 1, ccSdd: { version: "3.1.0", lang: "ja" } }, null, 2)}\n`);
  const streams = io(root, iso);
  assert.equal(await runCli(["init"], streams.value), 1);
  assert.equal(fs.readFileSync(config, "utf8"), "# 利用者の設定\n");
  assert.ok(!streams.output().stdout.includes("承認の記録"));
  assert.ok(!streams.output().stderr.includes("承認の記録"));
});

/** 承認の記録のハッシュを古い値（全部 0）に書き換える。承認の段階が適用より前に呼ばれると、この値は正しい値に更新される */
const staleHashes = (text) => text.replace(/trusted_hash = "sha256:[0-9a-f]{64}"/g, `trusted_hash = "sha256:${"0".repeat(64)}"`);

/** 記録を用意する準備。init の後に変更の無い update を行うと、承認の記録が確実に作られる（承認の段階の位置に依らない） */
async function primeRecords(root, iso) {
  assert.equal(await runCli(["init"], io(root, iso).value), 0);
  assert.equal(await runCli(["update"], io(root, iso).value), 0);
  const config = path.join(iso.codexHome, "config.toml");
  assert.equal(recordCount(fs.readFileSync(config, "utf8")), 8);
  return config;
}

/** 統合試験用の git。利用者の git の設定に依存しないよう、グローバル・システムの設定を空にする */
function gitRun(cwd, args) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "", GIT_CONFIG_SYSTEM: "" };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8", env });
  assert.equal(result.status, 0, `git ${args.join(" ")} が失敗: ${result.stderr}`);
  return result.stdout;
}

test("worktree の uninstall は承認の記録を外さず理由を出し、本体の uninstall で取り除く", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cli-wt-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const main = path.join(base, "main");
  fs.mkdirSync(main);
  gitRun(main, ["init", "-q"]);
  const iso = codexIsolation(t);
  const config = path.join(iso.codexHome, "config.toml");

  // 本体で init（記録 8 件）し、commit してから worktree を作る
  const initialized = io(main, iso);
  assert.equal(await runCli(["init"], initialized.value), 0, initialized.output().stderr);
  assert.equal(recordCount(fs.readFileSync(config, "utf8")), 8);
  gitRun(main, ["add", "-A"]);
  gitRun(main, ["commit", "-q", "-m", "導入"]);
  const wt = path.join(base, "wt");
  gitRun(main, ["worktree", "add", "-q", "--detach", wt]);
  const before = fs.readFileSync(config, "utf8");

  // worktree での uninstall
  const fromWorktree = io(wt, iso);
  assert.equal(await runCli(["uninstall"], fromWorktree.value), 0, fromWorktree.output().stderr);
  const output = fromWorktree.output().stdout;
  assert.ok(output.includes("worktree"), output);
  assert.ok(output.includes("変更していません"), output);
  assert.equal(fs.readFileSync(config, "utf8"), before, "worktree の uninstall が config.toml を変えました");
  const wtHooks = path.join(wt, ".codex/hooks.json");
  assert.ok(!fs.existsSync(wtHooks) || !fs.readFileSync(wtHooks, "utf8").includes(".agent-hooks/cc-sdd-bootstrap/"));

  // 本体での uninstall で記録が取り除かれる
  const fromMain = io(main, iso);
  assert.equal(await runCli(["uninstall"], fromMain.value), 0, fromMain.output().stderr);
  assert.ok(fromMain.output().stdout.includes("取り除きました"), fromMain.output().stdout);
  assert.equal(recordCount(fs.readFileSync(config, "utf8")), 0);
});

test("適用の途中で失敗した init は終了コード 1 で、承認の記録を書かない", async (t) => {
  // 導入先の配置物の置き場を読み取り専用にして、適用（applyPlan）を確実に失敗させる。root では権限が効かないため除外
  if (process.getuid?.() === 0) { t.skip("root では読み取り専用の権限が効かない"); return; }
  const root = temporary(t);
  const iso = codexIsolation(t);
  // 先の導入で自分のフックの登録を作ってから、記録と配置物の 1 つを消す。再導入の適用でその配置物を書けなくする
  const config = await primeRecords(root, iso);
  // 記録は古いハッシュのまま残す（承認の段階が適用より前に呼ばれると、正しいハッシュへ更新されて変わる）
  const current = fs.readFileSync(config, "utf8");
  const before = staleHashes(current);
  assert.notEqual(before, current);
  fs.writeFileSync(config, before);
  fs.rmSync(path.join(root, ".cc-sdd-bootstrap.json"));
  const blocked = path.join(root, ".agent-hooks/cc-sdd-bootstrap");
  fs.rmSync(path.join(blocked, "delegate.mjs"));
  fs.chmodSync(blocked, 0o555);
  try {
    const streams = io(root, iso);
    assert.equal(await runCli(["init"], streams.value), 1);
    assert.ok(streams.output().stderr.includes("失敗:"), streams.output().stderr);
    assert.equal(fs.readFileSync(config, "utf8"), before, "適用に失敗したのに config.toml が変わりました");
    assert.ok(!streams.output().stdout.includes("承認の記録"), streams.output().stdout);
  } finally {
    fs.chmodSync(blocked, 0o755);
  }
});

test("適用の途中で失敗した update は終了コード 1 で、既存の承認の記録を変えない", async (t) => {
  if (process.getuid?.() === 0) { t.skip("root では読み取り専用の権限が効かない"); return; }
  const root = temporary(t);
  const iso = codexIsolation(t);
  const config = await primeRecords(root, iso);
  // 古いハッシュの記録にしておく。承認の段階が適用より前に呼ばれると、正しいハッシュへ更新されて変わる
  const current = fs.readFileSync(config, "utf8");
  const before = staleHashes(current);
  assert.notEqual(before, current);
  fs.writeFileSync(config, before);
  // 変更を作る（子の上限を下げると上の系統の定義が消える）。その適用を読み取り専用の置き場で失敗させる
  const settingFile = path.join(root, ".cc-sdd-bootstrap.json");
  fs.writeFileSync(settingFile, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(settingFile, "utf8")), subagents: { maxModel: { claude: "sonnet" } } }, null, 2)}\n`);
  const blocked = path.join(root, ".claude/agents");
  fs.chmodSync(blocked, 0o555);
  try {
    const streams = io(root, iso);
    assert.equal(await runCli(["update"], streams.value), 1);
    assert.ok(streams.output().stderr.includes("失敗:"), streams.output().stderr);
    assert.equal(fs.readFileSync(config, "utf8"), before, "適用に失敗したのに config.toml が変わりました");
    assert.ok(!streams.output().stdout.includes("承認の記録"), streams.output().stdout);
  } finally {
    fs.chmodSync(blocked, 0o755);
  }
});
