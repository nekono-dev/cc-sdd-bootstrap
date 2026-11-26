#!/usr/bin/env node
// 実機の確認（タスク 1.7）: 実際の `npx github:…#<ブランチ>` で導入し、記録のコミットが配布元の先頭と一致するか、
// 記録を壊したときに入口が案内を出すか、実際の claude・codex のセッション開始で案内の文脈が届くかを確かめる。
// 使い方: node poc/install-freshness/e2e.mjs [ブランチ]   （既定 dev/base-branch-sync。事前に実装を push しておく）
// 必要なもの: node・npx・git、GitHub への通信、認証済みの claude・codex。導入先は使い捨ての一時のリポジトリで、終了時に消す。
//   ① init・update で記録が作られ、記録のコミットが配布元のブランチの先頭と一致する（記録の files が配置物と運用の区画に一致する）
//   ② 一致の状態では入口が何も出さない
//   ③ 記録のコミットが古い／ファイルを書き換え／ファイルを消す／記録を消す、の各場面（場面ごとに一致へ戻す）で入口が案内を出す
//   ④ 同じ各場面で、実際の claude -p・codex exec のセッション開始に案内の文脈が届く（一致のときは届かない）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const branch = process.argv[2] ?? "dev/base-branch-sync";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "install-freshness-e2e-"));
const repo = path.join(base, "target");
const env = { ...process.env, npm_config_cache: path.join(base, "npm-cache"), CODEX_HOME: path.join(base, "codex-home"), HOME: path.join(base, "home") };
fs.mkdirSync(env.CODEX_HOME, { recursive: true });
fs.mkdirSync(env.HOME, { recursive: true });
let ok = 0, ng = 0;
const check = (label, cond, detail = "") => { console.log(`${cond ? "OK  " : "NG  "} ${label}${detail ? ` — ${detail}` : ""}`); cond ? ok++ : ng++; };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: repo, env, encoding: "utf8", timeout: 240000, ...opts });
const RECORD = ".agent-hooks/cc-sdd-bootstrap/install-record.json";
const readRecord = () => JSON.parse(fs.readFileSync(path.join(repo, RECORD), "utf8"));
const entry = () => run("node", [path.join(repo, ".agent-hooks/cc-sdd-bootstrap/freshness.mjs"), "session-start", "--tool", "claude"]);

fs.mkdirSync(repo, { recursive: true });
run("git", ["init", "-q"]);
const remoteHead = spawnSync("git", ["ls-remote", "https://github.com/nekono-dev/cc-sdd-bootstrap", `refs/heads/${branch}`], { encoding: "utf8" }).stdout.split(/\s/)[0];
console.log(`検証対象: ブランチ ${branch}、先頭 ${remoteHead}`);

// ① init・update
for (const op of ["init", "update"]) {
  const r = run("npx", ["-y", `github:nekono-dev/cc-sdd-bootstrap#${branch}`, op]);
  check(`① npx ${op} が成功する`, r.status === 0, `終了コード ${r.status}${r.status === 0 ? "" : ` ${r.stderr.slice(0, 200)}`}`);
}
const rec = readRecord();
check("① 記録のコミットが配布元のブランチの先頭と一致する", rec.source.commit === remoteHead, `${rec.source.commit}`);
check("① 記録の ref が取得時の指定（ブランチ名）と一致する", rec.source.ref === branch, `${rec.source.ref}`);
const keys = Object.keys(rec.files);
check("① 記録の files に入口・純粋部品・運用の区画が入り、記録自身は入らない", ["freshness.mjs", "freshness-rules.mjs", "agent-section-claude.md", "agent-section-codex.md"].every((n) => keys.includes(`.agent-hooks/cc-sdd-bootstrap/${n}`)) && !keys.includes(RECORD), `${keys.length} 件`);
const settings = JSON.parse(fs.readFileSync(path.join(repo, ".claude/settings.json"), "utf8"));
const hooks = JSON.stringify(settings.hooks);
check("① セッション開始に freshness.mjs のフックが登録され、他のイベントには無い", /freshness\.mjs\\?" session-start/.test(hooks) && Object.entries(settings.hooks).every(([event, list]) => event === "SessionStart" || !JSON.stringify(list).includes("freshness.mjs")));

// 場面の定義。各場面は一致の状態から作り、終わったら戻す
const original = fs.readFileSync(path.join(repo, RECORD), "utf8");
const victim = ".agent-hooks/cc-sdd-bootstrap/kiro-gate-rules.mjs";
const victimText = fs.readFileSync(path.join(repo, victim), "utf8");
const restore = () => { fs.writeFileSync(path.join(repo, RECORD), original); fs.writeFileSync(path.join(repo, victim), victimText); };
const scenes = {
  "behind（記録のコミットが古い）": () => { const r = readRecord(); r.source.commit = "0".repeat(40); fs.writeFileSync(path.join(repo, RECORD), JSON.stringify(r, null, 2) + "\n"); },
  "changed（ファイルを書き換え）": () => fs.appendFileSync(path.join(repo, victim), "\n// 書き換え\n"),
  "missing（ファイルを消す）": () => fs.rmSync(path.join(repo, victim)),
  "記録なし（記録を消す）": () => fs.rmSync(path.join(repo, RECORD)),
};

// ② 一致のとき
{
  const r = entry();
  check("② 一致の状態では入口が何も出さず終了コード 0", r.status === 0 && r.stdout === "", `stdout=${JSON.stringify(r.stdout.slice(0, 80))}`);
}
// ③ 入口の直接の確認
for (const [name, apply] of Object.entries(scenes)) {
  apply();
  const r = entry();
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* 出力なし */ }
  check(`③ ${name}: 入口が案内（systemMessage と additionalContext）を出す`, r.status === 0 && out?.systemMessage && out?.hookSpecificOutput?.additionalContext?.includes("npx -y github:nekono-dev/cc-sdd-bootstrap"), out ? out.systemMessage.slice(0, 80) : "出力なし");
  restore();
}

// ④ 実際のエージェント。フックは freshness だけの設定にして、導入先の配置物をそのまま使う
const hookOnly = (tool) => {
  const cmd = tool === "claude" ? `node "$CLAUDE_PROJECT_DIR/.agent-hooks/cc-sdd-bootstrap/freshness.mjs" session-start --tool claude` : `node ${JSON.stringify(path.join(repo, ".agent-hooks/cc-sdd-bootstrap/freshness.mjs"))} session-start --tool codex`;
  return { hooks: { SessionStart: [{ hooks: [{ type: "command", command: cmd, timeout: 10 }] }] } };
};
fs.writeFileSync(path.join(repo, ".claude/settings.json"), JSON.stringify(hookOnly("claude")));
fs.writeFileSync(path.join(repo, ".codex/hooks.json"), JSON.stringify(hookOnly("codex")));
fs.copyFileSync(path.join(os.homedir(), ".codex", "auth.json"), path.join(env.CODEX_HOME, "auth.json"));
fs.writeFileSync(path.join(env.CODEX_HOME, "config.toml"), `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`);
const question = "セッション開始のフックから受け取った、cc-sdd-bootstrap の導入に関する案内があれば、その内容を 1 文で答えてください。案内が無ければ NONE とだけ答えてください。";
const ask = {
  claude: () => run("claude", ["-p", question, "--model", process.env.POC_CLAUDE_MODEL ?? "haiku", "--output-format", "stream-json", "--verbose"], { env: { ...env, HOME: process.env.HOME } }),
  codex: () => run("codex", ["-a", "never", "exec", "--dangerously-bypass-hook-trust", "--sandbox", "read-only", "--model", process.env.POC_CODEX_MODEL ?? "gpt-6-luna", "--config", 'model_reasoning_effort="low"', "--cd", repo, question]),
};
// claude は stream-json の hook_response（フックの出力がセッションへ渡された記録）と、モデルの回答（観測）を取り出す
const claudeParts = (text) => {
  let hook = "", answer = "";
  for (const line of text.split("\n")) {
    try { const e = JSON.parse(line); if (e.type === "system" && e.subtype === "hook_response" && String(e.hook_name).startsWith("SessionStart")) hook += e.output ?? ""; if (e.type === "result") answer = e.result ?? ""; } catch { /* 無視 */ }
  }
  return { hook, answer };
};
const knows = (text) => /更新|古い|欠け|内容が違|記録|最新|npx/.test(text) && !/^\s*NONE\s*$/m.test(text);
for (const tool of ["claude", "codex"]) {
  if (spawnSync("which", [tool]).status !== 0) { console.log(`SKIP ④(${tool}): ${tool} が無い`); continue; }
  const match = ask[tool]();
  const view = (r) => tool === "claude" ? claudeParts(r.stdout) : { hook: r.stdout, answer: r.stdout };
  check(`④ ${tool}: 一致のとき案内の文脈は届かない（フックの出力が空）`, match.status === 0 && (tool === "claude" ? !view(match).hook.includes("systemMessage") : /NONE/.test(match.stdout)), view(match).answer.trim().slice(0, 100).replace(/\n/g, " "));
  for (const [name, apply] of Object.entries(scenes)) {
    apply();
    const r = ask[tool]();
    const v = view(r);
    // claude: フックの出力がセッションへ渡されたこと（hook_response）を条件にし、モデルの回答は観測として併記する。codex: 回答に案内が現れること
    const delivered = tool === "claude" ? v.hook.includes("cc-sdd-bootstrap の導入") && v.hook.includes("additionalContext") : knows(r.stdout);
    check(`④ ${tool}: ${name} で案内の文脈が届く`, r.status === 0 && delivered, `回答: ${v.answer.trim().slice(0, 90).replace(/\n/g, " ")}`);
    restore();
  }
}

fs.rmSync(base, { recursive: true, force: true });
console.log(`結果: OK ${ok} 件、NG ${ng} 件`);
process.exitCode = ng === 0 ? 0 : 1;
