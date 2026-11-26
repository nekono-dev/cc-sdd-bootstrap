#!/usr/bin/env node
// 実機の確認（タスク 5.2）: 導入コマンドが書いた承認の記録で、実際の codex がフックを動かすかを、
// 一時の Codex の設定（CODEX_HOME・HOME を一時ディレクトリにしたもの）で確かめる。
// 利用者の実際の ~/.codex/config.toml は読まず、書かない（CODEX_HOME を必ず一時にする）。
// 使い方: node poc/codex-hook-trust/real-install.mjs
//   環境変数: POC_MODEL（既定 gpt-6-luna）、POC_KEEP=1（終了時に一時ディレクトリを残す）
//   認証済みの codex が要る。認証情報（auth.json）だけを、利用者の実際のホーム（~/.codex/auth.json）から
//   一時の CODEX_HOME（base/home）へ写す。写すのはファイルのコピーだけで、中身は読まず表示もしない。
//   そのあとの導入・codex の子プロセスはすべて、CODEX_HOME と HOME（base/h）を一時ディレクトリにした環境で動かす。
// 確かめること:
//   確認 1: 承認を省く指定なしの codex exec で、導入コマンドが書いた記録によりフックが動く（要件 1.5）
//   確認 2b: 取り除き後に update が書いた記録でも、承認を省く指定なしの codex exec でフックが動く（要件 1.5）
//   確認 2: 記録のハッシュを壊すと、フックは動かないが codex は回答する（要件 6.3）
//   確認 3: 承認を省く指定は設定に保存されず、記録が合わなくてもその回の起動だけフックが動く（要件 5.1・5.3）。
//           取り除き（uninstall）で記録の表が消える（要件 6.1）
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const here = import.meta.dirname;
const REPO_ROOT = path.resolve(here, "../../"); // このリポジトリ（bin/ と .agent-hooks/ がある場所）
const CLI = path.join(REPO_ROOT, "bin", "cc-sdd-bootstrap.mjs");
const MODEL = process.env.POC_MODEL ?? "gpt-6-luna";
const ZERO_HASH = "sha256:" + "0".repeat(64);
const HOOK_LINE = /hook: SessionStart/;

const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-trust-real-"));
const codexHome = path.join(base, "home");
const home = path.join(base, "h");
const repo = path.join(base, "repo");
const cfgPath = path.join(codexHome, "config.toml");
const results = [];

/** 確認の結果を 1 行ずつ出し、集計に加える */
function check(name, ok, evidence) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  console.log(`   根拠: ${evidence}`);
}

/** 一時の CODEX_HOME・HOME を指定した環境変数（利用者の ~/.codex を指さない） */
const envFor = (extra = {}) => ({ ...process.env, CODEX_HOME: codexHome, HOME: home, ...extra });

/** 出力のうち、確かめたい行だけを短く返す */
const pick = (text, re, max = 3) => {
  const lines = text.split("\n").filter((l) => re.test(l));
  return lines.length ? lines.slice(0, max).map((l) => l.trim()).join(" / ") : "（該当する行なし）";
};

/** 導入・取り除きの CLI を、一時の環境の中で実行する */
function runCli(operation, extraEnv = {}) {
  return spawnSync("node", [CLI, operation], {
    cwd: repo, env: envFor(extraEnv), encoding: "utf8", timeout: 300000,
  });
}

/** codex exec を一時の環境で実行する。承認を省く指定は extra で渡す */
function runCodex(extra = []) {
  const r = spawnSync("codex", ["-a", "never", "exec", ...extra, "--sandbox", "read-only",
    "--skip-git-repo-check", "--model", MODEL, "--config", 'model_reasoning_effort="low"',
    "--cd", repo, "OK とだけ答えて"], { env: envFor(), encoding: "utf8", timeout: 180000 });
  const stdout = r.stdout ?? "";
  const out = `${stdout}\n${r.stderr ?? ""}`;
  // 最終の回答は標準出力の末尾の空でない行（回答の本文の確認に使う）
  const lastAnswer = stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return { status: r.status, signal: r.signal, error: r.error, out, lastAnswer };
}

/** 記録の表（[hooks.state."<導入先の道筋>/.codex/hooks.json:…"]）の件数 */
const recordTables = (text) => text.split("\n").filter((l) => l.startsWith(`[hooks.state."${repoReal}/.codex/hooks.json:`)).length;
/** 記録の表の見出しの件数（導入先に限らず、すべての [hooks.state."…"]） */
const anyRecordTables = (text) => (text.match(/^\[hooks\.state\."/gm) ?? []).length;
/** 全 0 のハッシュの trusted_hash の行の件数 */
const zeroHashCount = (text) => text.split("\n").filter((l) => l.trim() === `trusted_hash = "${ZERO_HASH}"`).length;
/** trusted_hash の行を全部 0 のハッシュに書き換え、件数を返す */
function zeroAllHashes() {
  const text = fs.readFileSync(cfgPath, "utf8");
  let n = 0;
  const next = text.replace(/trusted_hash = "sha256:[0-9a-f]{64}"/g, () => { n++; return `trusted_hash = "${ZERO_HASH}"`; });
  fs.writeFileSync(cfgPath, next);
  return n;
}

let repoReal = repo;
let exitCode = 1;
try {
  // 1. 一時の基底ディレクトリを作る
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  // 認証情報だけを写す（内容は読まない・表示しない）
  fs.copyFileSync(path.join(os.homedir(), ".codex", "auth.json"), path.join(codexHome, "auth.json"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  repoReal = fs.realpathSync(repo);
  // プロジェクトの信頼は利用者が与える前提として、一時の設定にだけ書く
  fs.writeFileSync(cfgPath, `[projects.${JSON.stringify(repoReal)}]\ntrust_level = "trusted"\n`);
  console.log(`一時の基底ディレクトリ: ${base}`);
  console.log(`Codex CLI: ${spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout.trim()}`);
  console.log(`モデル: ${MODEL}`);

  // 2. 導入: 記録が 8 件書かれることを確かめる
  const init = runCli("init", { CC_SDD_BOOTSTRAP_NPX_TIMEOUT_MS: "5000" });
  const initOut = `${init.stdout ?? ""}${init.stderr ?? ""}`;
  const initWrote = (init.stdout ?? "").includes("Codex のフックの承認の記録を書きました");
  const cfgAfterInit = fs.readFileSync(cfgPath, "utf8");
  const initTables = recordTables(cfgAfterInit);
  check("導入: 承認の記録が書かれ、表が 8 件ある",
    init.status === 0 && initWrote && initTables === 8,
    `終了コード ${init.status}、標準出力の該当行「${pick(init.stdout ?? "", /承認の記録/)}」、導入先の表 ${initTables} 件`);
  if (!(init.status === 0 && initWrote && initTables === 8)) {
    console.log(`導入の出力（先頭）: ${initOut.slice(0, 600)}`);
    throw new Error("導入に失敗したため、以降の確認を中止します");
  }

  // 確認 1: 承認を省く指定なしで、記録によりフックが動く
  const c1 = runCodex();
  check("確認 1: 承認を省く指定なしで、フックが動く（要件 1.5）",
    c1.status === 0 && HOOK_LINE.test(c1.out),
    `終了コード ${c1.status}、該当行「${pick(c1.out, HOOK_LINE)}」`);

  // 確認 2: 記録のハッシュを壊すと、フックは動かないが codex は回答する
  const zeroed = zeroAllHashes();
  const zeroAfter = zeroHashCount(fs.readFileSync(cfgPath, "utf8"));
  const c2 = runCodex();
  // 判定: (a) 書き換えた件数が導入で書かれた 8 件ちょうど、(b) 書き換え後の全 0 の記録が 8 件、
  // (c) 最終の回答（標準出力の末尾）に OK がある、(d) 終了コード 0、(e) hook: SessionStart の行が無い
  const answered = /OK/.test(c2.lastAnswer);
  check("確認 2: 記録が合わないとフックは動かないが、codex は回答する（要件 6.3）",
    zeroed === 8 && zeroAfter === 8 && answered && c2.status === 0 && !HOOK_LINE.test(c2.out),
    `(a) 書き換えた記録 ${zeroed} 件（導入時は 8）、(b) 書き換え後の全 0 の記録 ${zeroAfter} 件、(c) 最終の回答「${c2.lastAnswer.slice(0, 80)}」、(d) 終了コード ${c2.status}、(e) フックの行 ${HOOK_LINE.test(c2.out) ? "あり" : "なし"}、関連行「${pick(c2.out, /hook|trust|承認/i)}」`);

  // 確認 3a: 取り除き（uninstall）で記録の表が消える。
  // 取り除きは、記録のハッシュが本体の hooks.json と一致するものだけを外すため、
  // 確認 2 で壊した記録を、update で正しいハッシュに戻してから実行する（壊したままでは外れない）
  const restore = runCli("update", { CC_SDD_BOOTSTRAP_NPX_TIMEOUT_MS: "5000" });
  const restoreOk = restore.status === 0 && (restore.stdout ?? "").includes("承認の記録");
  check("確認 3 の準備: update で壊した記録を正しいハッシュに戻す",
    restoreOk && anyRecordTables(fs.readFileSync(cfgPath, "utf8")) === 8,
    `終了コード ${restore.status}、標準出力の該当行「${pick(restore.stdout ?? "", /承認の記録/)}」`);

  // 確認 2b: update が書いた記録（ハッシュを正しく戻した直後）でも、承認を省く指定なしでフックが動く
  const c2b = runCodex();
  check("確認 2b: update が書いた記録で、承認を省く指定なしでフックが動く（要件 1.5）",
    c2b.status === 0 && HOOK_LINE.test(c2b.out),
    `終了コード ${c2b.status}、該当行「${pick(c2b.out, HOOK_LINE)}」、最終の回答「${c2b.lastAnswer.slice(0, 80)}」`);

  const cfgBeforeUninstall = fs.readFileSync(cfgPath, "utf8");
  const un = runCli("uninstall");
  const unOut = un.stdout ?? "";
  const cfgAfterUninstall = fs.readFileSync(cfgPath, "utf8");
  const unTables = anyRecordTables(cfgAfterUninstall);
  check("確認 3a: 取り除き（uninstall）で記録の表が 0 件になる（要件 6.1）",
    un.status === 0 && unOut.includes("取り除きました") && unTables === 0,
    `終了コード ${un.status}、標準出力の該当行「${pick(unOut, /承認の記録/)}」、取り除き後の記録の表 ${unTables} 件（取り除き前は ${anyRecordTables(cfgBeforeUninstall)} 件）`);

  // 確認 3b: 承認を省く指定は設定に保存されず、記録が合わなくてもその回だけフックが動く。
  // uninstall は .cc-sdd-bootstrap.json を残すため、再導入は init（CONFIG_EXISTS で失敗する）ではなく update で行う
  const reinit = runCli("update", { CC_SDD_BOOTSTRAP_NPX_TIMEOUT_MS: "5000" });
  const reinitOk = reinit.status === 0 && (reinit.stdout ?? "").includes("承認の記録");
  const zeroed2 = zeroAllHashes();
  const cfgBeforeRun = fs.readFileSync(cfgPath, "utf8");
  const c3 = runCodex(["--dangerously-bypass-hook-trust"]);
  const cfgAfterRun = fs.readFileSync(cfgPath, "utf8");
  check("確認 3b: 承認を省く指定で、記録が合わなくてもフックが動く（要件 5.3）",
    reinitOk && zeroed2 === 8 && c3.status === 0 && HOOK_LINE.test(c3.out),
    `再導入 ${reinitOk ? "成功" : "失敗"}、書き換えた記録 ${zeroed2} 件、終了コード ${c3.status}、該当行「${pick(c3.out, HOOK_LINE)}」`);
  check("確認 3c: 承認を省く指定の実行の前後で、config.toml の内容が変わらない（要件 5.1）",
    cfgBeforeRun === cfgAfterRun,
    cfgBeforeRun === cfgAfterRun ? "実行の前後で一致（バイト単位）" : "実行の後に内容が変わった");

  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (error) {
  console.log(`中断: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n結果: PASS ${pass} / ${results.length}`);
  if (process.env.POC_KEEP === "1") console.log(`一時ディレクトリを残しました: ${base}`);
  else fs.rmSync(base, { recursive: true, force: true });
}
process.exit(exitCode);
