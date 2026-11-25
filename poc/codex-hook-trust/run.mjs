#!/usr/bin/env node
// PoC: Codex のフックの信頼の承認の記録（trusted_hash）を、導入側で計算して書けるかを確かめる。
// 使い方: node poc/codex-hook-trust/run.mjs [--e2e]
//   既定: 利用者の ~/.codex/config.toml にある承認済みの記録（読むだけ）と、計算したハッシュを突き合わせる。
//   --e2e: 一時の CODEX_HOME に計算したハッシュを書き、`codex exec` でフックが動くかを 3 場面で確かめる
//          （記録なし / 記録あり / --dangerously-bypass-hook-trust）。認証済みの codex が要る。
// 計算式の出典: openai/codex の codex-rs/hooks/src/engine/discovery.rs（hook_hash）と
//   codex-rs/config/src/fingerprint.rs（version_for_toml）。
//   識別情報 {event_name, matcher?, hooks:[{type,command,timeout,async,...}]} を、キーを辞書順に並べた JSON にして sha256。
//   null になる項目（command_windows・statusMessage など未指定のもの）は TOML に無いので含めない。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const LABELS = {
  SessionStart: "session_start", UserPromptSubmit: "user_prompt_submit",
  PreToolUse: "pre_tool_use", PostToolUse: "post_tool_use", Stop: "stop",
};
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const hashOf = (o) => "sha256:" + crypto.createHash("sha256").update(JSON.stringify(sortKeys(o))).digest("hex");

/** hooks.json の command フックごとに、設定のキーと承認のハッシュを求める */
export function trustEntries(hooksJsonPath) {
  const hooks = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8")).hooks ?? {};
  const out = [];
  for (const [ev, groups] of Object.entries(hooks)) {
    const label = LABELS[ev];
    if (!label) continue;
    groups.forEach((g, gi) => (g.hooks ?? []).forEach((x, hi) => {
      if (x.type !== "command") return;
      const handler = { type: "command", command: x.command, timeout: x.timeout ?? 600, async: x.async === true };
      if (x.statusMessage !== undefined) handler.statusMessage = x.statusMessage;
      const id = { event_name: label, hooks: [handler] };
      if (g.matcher !== undefined && g.matcher !== null) id.matcher = g.matcher;
      out.push({ key: `${hooksJsonPath}:${label}:${gi}:${hi}`, hash: hashOf(id) });
    }));
  }
  return out;
}
const toToml = (entries) => entries.map((e) =>
  `[hooks.state.${JSON.stringify(e.key)}]\ntrusted_hash = ${JSON.stringify(e.hash)}\n`).join("\n");

function compare(hooksJsonPath) {
  const cfg = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
  let ok = 0, ng = 0, none = 0;
  for (const e of trustEntries(hooksJsonPath)) {
    const m = cfg.match(new RegExp(`\\[hooks\\.state\\.${JSON.stringify(e.key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*trusted_hash = "([^"]+)"`));
    if (!m) { none++; continue; }
    if (m[1] === e.hash) ok++; else { ng++; console.log("不一致", e.key); }
  }
  console.log(`承認済みの記録との突き合わせ: 一致 ${ok} / 不一致 ${ng} / 記録なし ${none}`);
  return ng === 0 && ok > 0;
}

function e2e() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-trust-"));
  const repo = path.join(base, "repo"); fs.mkdirSync(path.join(repo, ".codex"), { recursive: true });
  const log = path.join(base, "log.txt");
  const probe = path.join(repo, "probe.cjs");
  fs.writeFileSync(probe, `require("fs").appendFileSync(${JSON.stringify(log)}, "fired\\n");`);
  const hooksJson = path.join(repo, ".codex", "hooks.json");
  fs.writeFileSync(hooksJson, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
    type: "command", command: `node ${JSON.stringify(probe)}`, timeout: 10 }] }] } }));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  const real = fs.realpathSync(repo);
  const entries = trustEntries(path.join(real, ".codex", "hooks.json"));
  const run = (label, extra, withTrust) => {
    const home = fs.mkdtempSync(path.join(base, "home-"));
    fs.copyFileSync(path.join(os.homedir(), ".codex", "auth.json"), path.join(home, "auth.json"));
    fs.writeFileSync(path.join(home, "config.toml"),
      `[projects.${JSON.stringify(real)}]\ntrust_level = "trusted"\n\n[hooks.state]\n\n` + (withTrust ? toToml(entries) : ""));
    fs.rmSync(log, { force: true });
    spawnSync("codex", ["-a", "never", "exec", ...extra, "--sandbox", "read-only", "--model", process.env.POC_MODEL ?? "gpt-6-luna",
      "--config", 'model_reasoning_effort="low"', "--cd", real, "--skip-git-repo-check", "OK とだけ答えて"],
      { env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", timeout: 180000 });
    const fired = fs.existsSync(log);
    console.log(`${label}: フック${fired ? "が動いた" : "は動かなかった"}`);
    return fired;
  };
  const a = run("1. 記録なし", [], false);
  const b = run("2. 計算した記録を書いた", [], true);
  const c = run("3. --dangerously-bypass-hook-trust（記録なし）", ["--dangerously-bypass-hook-trust"], false);
  console.log(!a && b && c ? "結果: 期待どおり（1=動かない、2・3=動く）" : "結果: 期待と違う");
  return !a && b && c;
}

// 承認済みの本体側の道筋を POC_HOOKS_JSON で指定できる（worktree には承認の記録が無いため）
const hooksJson = process.env.POC_HOOKS_JSON ?? path.resolve(import.meta.dirname, "../../.codex/hooks.json");
if (process.argv[1] === import.meta.filename) {
  let ok = true;
  if (fs.existsSync(path.join(os.homedir(), ".codex", "config.toml"))) ok = compare(hooksJson) && ok;
  if (process.argv.includes("--e2e")) ok = e2e() && ok;
  process.exit(ok ? 0 : 1);
}
