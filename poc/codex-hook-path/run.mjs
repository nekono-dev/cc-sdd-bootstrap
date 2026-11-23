#!/usr/bin/env node
// PoC: Codex のプロジェクトのフック（.codex/hooks.json）で、配置物のスクリプトをどの書き方で呼べるか。
//
// 対応する要件: installer-core 4.1（Codex のフックの設定への登録）。要件の「設定の置き場所・形式は設計前に実際の動作で確認する」。
// 確かめること
//   a. コマンドを相対の道筋（node .agent-hooks/cc-sdd-bootstrap/probe.mjs）で書くと、リポジトリの最上位で起動した Codex から呼べるか
//   b. 下のディレクトリ（--cd sub）で起動したとき、.codex/hooks.json が見つかるか、相対の道筋で呼べるか、フックの作業場所はどこか
//   c. コマンドをシェルの展開で根から書く形（node "$(<版管理の CLI> rev-parse --show-toplevel)/..."）なら、どちらの起動場所でも呼べるか
//   d. フックの環境変数に、プロジェクトの根を表すもの（CLAUDE_PROJECT_DIR 相当）があるか（観測）
//
// 使い方: node poc/codex-hook-path/run.mjs
// 必要なもの: codex（~/.codex/auth.json で認証済み）・版管理の CLI。作業場所は ~/.cache/cc-sdd-bootstrap-scratch/codex-hook-path。
// フックの信頼の承認は --dangerously-bypass-hook-trust で省く（検証専用）。認証の写しは終わったら消す。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const work = path.join(os.homedir(), ".cache/cc-sdd-bootstrap-scratch/codex-hook-path");
fs.rmSync(work, { recursive: true, force: true });
const repo = path.join(work, "repo");
const home = path.join(work, "home");
fs.mkdirSync(path.join(repo, ".agent-hooks/cc-sdd-bootstrap"), { recursive: true });
fs.mkdirSync(path.join(repo, ".codex"), { recursive: true });
fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
fs.mkdirSync(home, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: repo });

// 呼ばれたら、作業場所・入力の cwd・関係しそうな環境変数を記録する
const log = path.join(work, "log.jsonl");
fs.writeFileSync(
  path.join(repo, ".agent-hooks/cc-sdd-bootstrap/probe.mjs"),
  `import fs from "node:fs";
let input = {}; try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /CODEX|PROJECT|ROOT|PWD/.test(k)));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tag: process.argv[2], event: input.hook_event_name, cwd: process.cwd(), inputCwd: input.cwd, env }) + "\\n");
`,
);
const probe = path.join(repo, ".agent-hooks/cc-sdd-bootstrap/probe.mjs");
const commands = {
  abs: `node ${JSON.stringify(probe)} abs`,
  rel: "node .agent-hooks/cc-sdd-bootstrap/probe.mjs rel",
  // シェルの展開で根を求める（Claude Code の $CLAUDE_PROJECT_DIR の代わり）
  top: 'node "$(git rev-parse --show-toplevel)/.agent-hooks/cc-sdd-bootstrap/probe.mjs" top',
};
const entry = (tag) => ({ type: "command", command: commands[tag], timeout: 30 });
// 相対の道筋・絶対の道筋・シェルの展開の 3 つを登録し、「設定が見つからない」と「相対の道筋が解けない」を見分ける
fs.writeFileSync(path.join(repo, ".codex/hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [entry("rel"), entry("abs"), entry("top")] }], UserPromptSubmit: [{ hooks: [entry("rel"), entry("abs"), entry("top")] }] } }, null, 1));

const run = (cd) => {
  fs.copyFileSync(path.join(os.homedir(), ".codex/auth.json"), path.join(home, "auth.json"));
  fs.writeFileSync(path.join(home, "config.toml"), `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`);
  try {
    const r = spawnSync("codex", ["-a", "never", "exec", "--json", "--dangerously-bypass-hook-trust", "-s", "read-only", "--model", "gpt-6-luna", "-c", 'model_reasoning_effort="low"', "--cd", cd, "「はい」とだけ答えてください。"], {
      env: { ...process.env, CODEX_HOME: home }, input: "", encoding: "utf8", timeout: 300000,
    });
    return r.status;
  } finally {
    fs.rmSync(path.join(home, "auth.json"), { force: true });
  }
};
const read = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
let pass = 0, fail = 0;
const check = (label, ok) => { console.log(`${ok ? "OK" : "NG"}   ${label}`); ok ? pass++ : fail++; };

console.log("== a. リポジトリの最上位で起動");
console.log(`     終了コード ${run(repo)}`);
const a = read();
check("a. 相対の道筋で SessionStart のフックが呼ばれる", a.some((e) => e.tag === "rel" && e.event === "SessionStart"));
check("a. 相対の道筋で UserPromptSubmit のフックが呼ばれる", a.some((e) => e.tag === "rel" && e.event === "UserPromptSubmit"));
check("a. シェルの展開（版管理の CLI で根を求める）で呼ばれる", a.some((e) => e.tag === "top"));
if (a[0]) console.log(`     観測: フックの作業場所=${a[0].cwd}、入力の cwd=${a[0].inputCwd}、環境変数=${JSON.stringify(a[0].env)}`);

console.log("== b. 下のディレクトリ（sub）で起動");
fs.rmSync(log, { force: true });
console.log(`     終了コード ${run(path.join(repo, "sub"))}`);
const b = read();
const babs = b.filter((e) => e.tag === "abs"), brel = b.filter((e) => e.tag === "rel");
console.log(`     観測: 絶対の道筋のフック ${babs.length} 回、相対の道筋のフック ${brel.length} 回`);
if (babs[0]) console.log(`     観測: 作業場所=${babs[0].cwd}、入力の cwd=${babs[0].inputCwd}`);
else console.log("     観測: 絶対の道筋でも呼ばれない → 下のディレクトリで起動すると .codex/hooks.json 自体が読まれない");
check("b. 下のディレクトリで起動しても .codex/hooks.json が読まれる（絶対の道筋のフックが呼ばれる）", babs.length > 0);
check("b. 下のディレクトリで起動しても、シェルの展開で根を求める書き方なら呼べる", b.some((e) => e.tag === "top"));

console.log(`結果: OK ${pass} 件、NG ${fail} 件`);
if (!process.env.POC_KEEP) fs.rmSync(work, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
