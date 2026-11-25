#!/usr/bin/env node
// PoC（設計の前提の確認）: 承認の記録のキーの道筋・config.toml の書き方・フラグの検出を実機で確かめる。
// 使い方: node poc/codex-hook-trust/probe.mjs   認証済みの codex が要る。
//   場面 A: リポジトリをシンボリックリンク経由の道筋で開き、記録を「見かけの道筋」「実体の道筋」で書いたときに動くか
//   場面 B: `[hooks.state]` の見出しが無く、`[hooks.state."<キー>"]` だけを書いたときに動くか
//   場面 C: 他の表・コメントのある config.toml の末尾に追記したときに動くか（既存の表を壊さない）
//   場面 D: 承認を省く指定が `codex exec --help` に出るか、未知の指定の失敗の形（終了コードと文言）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { trustEntries } from "./run.mjs";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-trust-probe-"));
const real = path.join(base, "real-repo");
const link = path.join(base, "link-repo");
fs.mkdirSync(path.join(real, ".codex"), { recursive: true });
fs.symlinkSync(real, link);
const log = path.join(base, "log.txt");
const probe = path.join(real, "probe.cjs");
fs.writeFileSync(probe, `require("fs").appendFileSync(${JSON.stringify(log)}, "fired\\n");`);
fs.writeFileSync(path.join(real, ".codex", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
  type: "command", command: `node ${JSON.stringify(probe)}`, timeout: 10 }] }] } }));
spawnSync("git", ["init", "-q"], { cwd: real });

const table = (e) => `[hooks.state.${JSON.stringify(e.key)}]\ntrusted_hash = ${JSON.stringify(e.hash)}\n`;
function run(label, { cwd, config }) {
  const home = fs.mkdtempSync(path.join(base, "home-"));
  fs.copyFileSync(path.join(os.homedir(), ".codex", "auth.json"), path.join(home, "auth.json"));
  fs.writeFileSync(path.join(home, "config.toml"), config);
  fs.rmSync(log, { force: true });
  const r = spawnSync("codex", ["-a", "never", "exec", "--sandbox", "read-only", "--model", process.env.POC_MODEL ?? "gpt-6-luna",
    "--config", 'model_reasoning_effort="low"', "--cd", cwd, "--skip-git-repo-check", "OK とだけ答えて"],
    { env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", timeout: 180000 });
  const fired = fs.existsSync(log);
  console.log(`${label}: フック${fired ? "が動いた" : "は動かなかった"}`);
  const text = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  return { fired, text };
}
const proj = (p) => `[projects.${JSON.stringify(p)}]\ntrust_level = "trusted"\n\n`;
const realE = trustEntries(path.join(real, ".codex", "hooks.json"));
const linkE = trustEntries(path.join(link, ".codex", "hooks.json"));

// A: 見かけの道筋（link）で開く。記録のキーを実体 / 見かけで書き分ける
run("A1. link で開く・実体の道筋の記録", { cwd: link, config: proj(real) + proj(link) + realE.map(table).join("\n") });
run("A2. link で開く・見かけの道筋の記録", { cwd: link, config: proj(real) + proj(link) + linkE.map(table).join("\n") });
// B: [hooks.state] の見出し無し
run("B. [hooks.state] 見出し無し（表だけ）", { cwd: real, config: proj(real) + realE.map(table).join("\n") });
// C: 既存の設定（コメント・他の表）の末尾に追記
const existing = `# 利用者のコメント\nmodel = "gpt-6-luna"\n\n[sandbox_workspace_write]\nnetwork_access = false\n\n` + proj(real);
const c = run("C. 既存の設定の末尾に追記", { cwd: real, config: existing + "\n" + realE.map(table).join("\n") });
console.log("   既存の行が残っているか:", c.text.startsWith(existing));

// D: 承認を省く指定の検出
const help = spawnSync("codex", ["exec", "--help"], { encoding: "utf8" });
console.log("D1. `codex exec --help` に指定が出る:", help.stdout.includes("--dangerously-bypass-hook-trust"));
const bad = spawnSync("codex", ["exec", "--dangerously-bypass-hook-trust-no-such", "x"], { encoding: "utf8" });
console.log(`D2. 未知の指定: 終了コード ${bad.status}、文言: ${bad.stderr.split("\n")[0]}`);
fs.rmSync(base, { recursive: true, force: true });
