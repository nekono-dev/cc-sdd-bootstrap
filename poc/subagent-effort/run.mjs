#!/usr/bin/env node
// PoC: 組み込みの子の起動で推論量を起動ごとに指定できるか、それが起動前のフック（PreToolUse）から見えるか、子が実際にどの推論量で動くか。
//
// 対応する要件: subagent-delegation 1.13（推論量の上限）、3.10（組み込みの子の起動で上限より上の推論量を拒否）、2.1（定義の推論量）
// 確かめること
//   a. Claude Code: Agent の起動の入力（tool_input）に推論量の項目があるか。定義の effort が無い子・ある子が、どの推論量で動くか（子の記録から観測）
//   b. Codex: spawn_agent の tool_input に推論量の項目があるか。定義（model_reasoning_effort = "low"）の子を、起動で xhigh を指定して起動したとき、子がどの推論量で動くか。定義なしで推論量を指定した・しない子、推論量の無い定義に推論量を指定した子がどの推論量で動くか（子の記録から観測。指揮役は medium）
//
// 使い方: node poc/subagent-effort/run.mjs [a b]   （既定はすべて）。POC_KEEP=1 で作業場所を残す。POC_CODEX_PARENT_EFFORT で Codex の指揮役の推論量を変える（既定 medium）
// 必要なもの: claude（認証済み）・codex（~/.codex/auth.json）・git。作業場所は ~/.cache/cc-sdd-bootstrap-scratch/subagent-effort
// Codex のフックの信頼の承認は --dangerously-bypass-hook-trust で省く（検証専用）。認証の写しは終わったら消す。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const only = process.argv.slice(2);
const want = (k) => only.length === 0 || only.includes(k);
const base = path.join(os.homedir(), ".cache/cc-sdd-bootstrap-scratch/subagent-effort");
fs.rmSync(base, { recursive: true, force: true });
const note = (label, value) => console.log(`観測  ${label}: ${value}`);
const mkrepo = (name) => { const r = path.join(base, name); fs.mkdirSync(r, { recursive: true }); execFileSync("git", ["init", "-q"], { cwd: r }); return r; };
const hookScript = (repo, log) => {
  const f = path.join(repo, "observe.mjs");
  fs.writeFileSync(f, `import fs from "node:fs"; let i={}; try{i=JSON.parse(fs.readFileSync(0,"utf8")||"{}")}catch{}; fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({event:i.hook_event_name, tool:i.tool_name, input:i.tool_input})+"\\n");`);
  return f;
};
const readLog = (log) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const grepAll = (dir, re) => { try { return execFileSync("grep", ["-rhoE", re, dir], { encoding: "utf8" }).split("\n").filter(Boolean); } catch { return []; } };
const uniq = (a) => [...new Set(a)];
// 呼び出し元のセッションの推論量の環境変数（CLAUDE_CODE_EFFORT_LEVEL・CLAUDE_EFFORT）は子の claude に引き継がれ、--effort と定義を上書きするので外す
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_EFFORT"].includes(k)));

const claudeRun = (name, extraEnv) => {
  const repo = mkrepo(name); const log = path.join(base, `${name}.log`);
  const projDir = path.join(os.homedir(), ".claude/projects", repo.replace(/[\/.]/g, "-"));
  fs.rmSync(projDir, { recursive: true, force: true }); // 前の実行の記録を混ぜない
  fs.mkdirSync(path.join(repo, ".claude/agents"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude/agents/probe-noeffort.md"),
    "---\nname: probe-noeffort\ndescription: PoC の子（effort 無し）。\nmodel: haiku\ntools: Read\n---\n\n合言葉 CCSDD-NOEFFORT を答える。\n");
  fs.writeFileSync(path.join(repo, ".claude/agents/probe-low.md"),
    "---\nname: probe-low\ndescription: PoC の子（effort low）。\nmodel: haiku\neffort: low\ntools: Read\n---\n\n合言葉 CCSDD-LOW を答える。\n");
  fs.writeFileSync(path.join(repo, ".claude/agents/probe-xhigh.md"),
    "---\nname: probe-xhigh\ndescription: PoC の子（effort xhigh）。\nmodel: haiku\neffort: xhigh\ntools: Read\n---\n\n合言葉 CCSDD-XHIGH を答える。\n");
  const hook = hookScript(repo, log);
  fs.writeFileSync(path.join(repo, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Agent", hooks: [{ type: "command", command: `node ${JSON.stringify(hook)}` }] }] } }));
  const r = spawnSync("claude", ["-p", "--model", "sonnet", "--effort", "high", "--setting-sources", "project", "--output-format", "stream-json", "--verbose", "--max-turns", "8",
    "Agent ツールで、subagent_type に probe-noeffort・probe-low・probe-xhigh をそれぞれ指定して子を 1 回ずつ起動し（model は指定しない）、3 つの子の合言葉を答えてください。最後に、Agent ツールが受け付ける引数の名前をすべて列挙してください。"],
    { cwd: repo, env: { ...env, ...extraEnv }, encoding: "utf8", input: "", timeout: 600000 });
  fs.writeFileSync(path.join(base, `${name}.out.jsonl`), r.stdout ?? "");
  for (const p of readLog(log).filter((e) => e.event === "PreToolUse" && e.tool === "Agent")) note(`${name} Agent の tool_input のキー（${p.input?.subagent_type}）`, Object.keys(p.input ?? {}).join(","));
  const result = (r.stdout ?? "").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.type === "result").pop();
  note(`${name} 指揮役の答え`, JSON.stringify(result?.result ?? "").slice(0, 400));
  // 子の記録から、API へ送った推論量（output_config.effort）をファイルごとに拾う
  let files = []; try { files = execFileSync("find", [projDir, "-name", "*.jsonl"], { encoding: "utf8" }).split("\n").filter(Boolean); } catch {}
  for (const f of files) {
    const meta = f.replace(/\.jsonl$/, ".meta.json");
    const who = fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, "utf8")).agentType : "指揮役";
    const efforts = uniq(grepAll(f, '"output_config":\\{"effort":"[a-z]+"').map((x) => x.replace(/.*"effort":"/, "").replace(/"$/, "")));
    note(`${name} ${who} の送った推論量`, efforts.join(",") || "（なし）");
  }
  if (!process.env.POC_KEEP) fs.rmSync(projDir, { recursive: true, force: true });
};
if (want("a")) {
  console.log("== a. Claude Code の Agent（推論量の環境変数なし。指揮役は --effort high）");
  claudeRun("a", {});
  console.log("== a2. 同じ起動に CLAUDE_CODE_EFFORT_LEVEL=low を付ける");
  claudeRun("a2", { CLAUDE_CODE_EFFORT_LEVEL: "low" });
}

if (want("b")) {
  console.log("== b. Codex の spawn_agent");
  const repo = mkrepo("b"); const home = path.join(base, "b-home"); const log = path.join(base, "b.log");
  fs.mkdirSync(path.join(repo, ".codex/agents"), { recursive: true }); fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(repo, ".codex/agents/cc_sdd_probe_low.toml"),
    'name = "cc_sdd_probe_low"\ndescription = "PoC の子（推論量 low）。"\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "low"\ndeveloper_instructions = "合言葉 CCSDD-LOW を答える。"\n');
  fs.writeFileSync(path.join(repo, ".codex/agents/cc_sdd_probe_noeffort.toml"),
    'name = "cc_sdd_probe_noeffort"\ndescription = "PoC の子（推論量の指定なし）。"\nmodel = "gpt-6-luna"\ndeveloper_instructions = "合言葉 CCSDD-NOEFFORT2 を答える。"\n');
  const hook = hookScript(repo, log);
  fs.writeFileSync(path.join(repo, ".codex/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `node ${JSON.stringify(hook)}` }] }] } }));
  fs.copyFileSync(path.join(os.homedir(), ".codex/auth.json"), path.join(home, "auth.json"));
  fs.writeFileSync(path.join(home, "config.toml"), `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`);
  let r;
  try {
    r = spawnSync("codex", ["-a", "never", "exec", "--json", "--dangerously-bypass-hook-trust", "-s", "workspace-write", "--model", "gpt-6.1-sol", "-c", `model_reasoning_effort="${process.env.POC_CODEX_PARENT_EFFORT ?? "medium"}"`, "--cd", repo,
      "次の 2 つを順に行ってください。(1) spawn_agent で agent_type に cc_sdd_probe_low、fork_turns に none を指定し、もし spawn_agent に推論量を指定する引数があれば xhigh を指定して子を起動し、wait で答えを待つ。(2) spawn_agent で agent_type を指定せず、fork_turns に none、model に gpt-6-luna を指定し、推論量の引数があれば high を指定して子を起動し、合言葉 CCSDD-DEFAULT を答えさせ、wait で待つ。(3) spawn_agent で agent_type を指定せず、fork_turns に none、model に gpt-6-luna を指定し、推論量の引数は指定せずに子を起動し、合言葉 CCSDD-NOEFFORT を答えさせ、wait で待つ。(4) spawn_agent で agent_type に cc_sdd_probe_noeffort、fork_turns に none を指定し、推論量の引数に high を指定して子を起動し、wait で待つ。最後に、spawn_agent が受け付ける引数の名前をすべて列挙し、4 つの子の答えを答えてください。"],
      { env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", input: "", timeout: 900000 });
  } finally { fs.rmSync(path.join(home, "auth.json"), { force: true }); }
  fs.writeFileSync(path.join(base, "b.out.jsonl"), r.stdout ?? "");
  const spawns = readLog(log).filter((e) => /spawn_agent/.test(String(e.tool)));
  for (const s of spawns) note(`spawn_agent の tool_input`, JSON.stringify(s.input ?? {}).slice(0, 300));
  if (!spawns.length) note("spawn_agent の PreToolUse", "届かない");
  const last = (r.stdout ?? "").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.item?.type === "agent_message").pop();
  note("指揮役の答え", JSON.stringify(last?.item?.text ?? "").slice(0, 600));
  // 子と親の記録（CODEX_HOME/sessions）の turn_context から、モデルと推論量の組を拾う
  note("記録のモデルと推論量", uniq(grepAll(path.join(home, "sessions"), '"model":"[^"]+"|"effort":"[^"]+"|"reasoning_effort":"[^"]+"')).join(" | ") || "（なし）");
  const files = grepAll(path.join(home, "sessions"), "") && (() => { try { return execFileSync("find", [path.join(home, "sessions"), "-name", "*.jsonl"], { encoding: "utf8" }).split("\n").filter(Boolean); } catch { return []; } })();
  for (const f of files) {
    const ctx = fs.readFileSync(f, "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.type === "turn_context").map((e) => `${e.payload?.model}/${e.payload?.effort ?? e.payload?.reasoning_effort ?? "?"}`);
    note(`記録 ${path.basename(f).slice(0, 40)} の turn_context`, uniq(ctx).join(",") || "（なし）");
  }
}
if (!process.env.POC_KEEP) fs.rmSync(base, { recursive: true, force: true });
