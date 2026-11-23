#!/usr/bin/env node
// PoC: subagent-delegation の役割定義（ファイルで置くエージェント定義）と、別の提供元の CLI の権限の指定が効くか。
//
// 対応する要件: subagent-delegation 2.1〜2.3（両ツールの役割定義）、4.4・4.5（書き込み可・読み取り専用）、3.2（定義のモデルの扱い）
// 確かめること
//   a. Claude Code: .claude/agents/<名前>.md の frontmatter（model・effort・tools）で定義した子を、Agent の subagent_type で起動できる。
//      PreToolUse の tool_input に subagent_type が入り、model は入らない（定義のモデルはフックから見えない）。tools を読み取りだけにした子は書けない
//   b. Codex: .codex/agents/<名前>.toml（model・model_reasoning_effort・sandbox_mode = "read-only"）で定義した子を agent_type で起動できるか。子が書けるか（観測）
//   c. claude -p: --tools Read,Grep,Glob で読み取り専用にすると書けない。--permission-mode acceptEdits なら書ける
//
// 使い方: node poc/subagent-defs/run.mjs [a b c]   （既定はすべて）
// 必要なもの: claude（認証済み）・codex（~/.codex/auth.json）・版管理の CLI。作業場所は ~/.cache/cc-sdd-bootstrap-scratch/subagent-defs。
// Codex のフックの信頼の承認は --dangerously-bypass-hook-trust で省く（検証専用）。認証の写しは終わったら消す。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const only = process.argv.slice(2);
const want = (k) => only.length === 0 || only.includes(k);
const base = path.join(os.homedir(), ".cache/cc-sdd-bootstrap-scratch/subagent-defs");
fs.rmSync(base, { recursive: true, force: true });
let pass = 0, fail = 0;
const check = (label, ok) => { console.log(`${ok ? "OK" : "NG"}   ${label}`); ok ? pass++ : fail++; };
const mkrepo = (name) => { const r = path.join(base, name); fs.mkdirSync(r, { recursive: true }); execFileSync("git", ["init", "-q"], { cwd: r }); return r; };
const hookScript = (repo, log) => {
  const f = path.join(repo, "observe.mjs");
  fs.writeFileSync(f, `import fs from "node:fs"; let i={}; try{i=JSON.parse(fs.readFileSync(0,"utf8")||"{}")}catch{}; fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({event:i.hook_event_name, tool:i.tool_name, input:i.tool_input})+"\\n");`);
  return f;
};
const readLog = (log) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const env = { ...process.env }; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;

if (want("a")) {
  console.log("== a. Claude Code のファイルの役割定義");
  const repo = mkrepo("a"); const log = path.join(base, "a.log");
  fs.mkdirSync(path.join(repo, ".claude/agents"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude/agents/cc-sdd-probe-reader.md"),
    "---\nname: cc-sdd-probe-reader\ndescription: PoC の読み取り専用の子。\nmodel: haiku\neffort: medium\ntools: Read, Grep, Glob\n---\n\n依頼されたら、Write で child.txt を作ろうとし、できたかどうかと合言葉 CCSDD-READER-CHILD を答える。\n");
  const hook = hookScript(repo, log);
  fs.writeFileSync(path.join(repo, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Agent", hooks: [{ type: "command", command: `node ${JSON.stringify(hook)}` }] }] } }));
  const r = spawnSync("claude", ["-p", "--model", "sonnet", "--effort", "medium", "--setting-sources", "project", "--permission-mode", "acceptEdits", "--output-format", "stream-json", "--verbose", "--max-turns", "6",
    "Agent ツールで subagent_type に cc-sdd-probe-reader を指定し、model は指定せずに子を 1 回だけ起動してください。子の答え（合言葉と、child.txt を作れたか）をそのまま答えてください。あなた自身はファイルを作らないでください。"],
    { cwd: repo, env, encoding: "utf8", input: "", timeout: 600000 });
  const out = r.stdout ?? "";
  const pre = readLog(log).find((e) => e.event === "PreToolUse" && e.tool === "Agent");
  check("a. PreToolUse に Agent が届き、tool_input に subagent_type が入る", pre?.input?.subagent_type === "cc-sdd-probe-reader");
  check("a. 定義のモデルは tool_input に入らない（model を指定しない起動）", pre && !("model" in (pre.input ?? {})));
  check("a. 子が起動し合言葉が返る", out.includes("CCSDD-READER-CHILD"));
  check("a. tools を読み取りだけにした子は child.txt を作れない", !fs.existsSync(path.join(repo, "child.txt")));
}

if (want("b")) {
  console.log("== b. Codex のファイルの役割定義（sandbox_mode）");
  const repo = mkrepo("b"); const home = path.join(base, "b-home"); const log = path.join(base, "b.log");
  fs.mkdirSync(path.join(repo, ".codex/agents"), { recursive: true }); fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(repo, ".codex/agents/cc_sdd_probe_reader.toml"),
    'name = "cc_sdd_probe_reader"\ndescription = "PoC の読み取り専用の子。"\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "medium"\nsandbox_mode = "read-only"\ndeveloper_instructions = "依頼されたら、シェルで echo x > child.txt を実行して child.txt を作ろうとし、できたかどうかと合言葉 CCSDD-READER-CHILD を答える。"\n');
  const hook = hookScript(repo, log);
  fs.writeFileSync(path.join(repo, ".codex/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `node ${JSON.stringify(hook)}` }] }] } }));
  fs.copyFileSync(path.join(os.homedir(), ".codex/auth.json"), path.join(home, "auth.json"));
  fs.writeFileSync(path.join(home, "config.toml"), `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`);
  let r;
  try {
    r = spawnSync("codex", ["-a", "never", "exec", "--json", "--dangerously-bypass-hook-trust", "-s", "workspace-write", "--model", "gpt-6.1-sol", "-c", 'model_reasoning_effort="low"', "--cd", repo,
      "spawn_agent を 1 回だけ使い、agent_type に cc_sdd_probe_reader、fork_turns に none を指定して子を起動し、子の答えを wait で待ってから、そのまま答えてください。model は指定しないでください。あなた自身はファイルを作らないでください。"],
      { env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", input: "", timeout: 600000 });
  } finally { fs.rmSync(path.join(home, "auth.json"), { force: true }); }
  fs.writeFileSync(path.join(base, "b.out.jsonl"), r.stdout ?? "");
  // 子の記録（CODEX_HOME の sessions）から、子のモデル・権限を拾う
  const childText = (() => { try { return execFileSync("grep", ["-rh", "-o", "CCSDD-READER-CHILD\\|sandbox[^,]*read-only[^,]*\\|gpt-6-luna", path.join(home, "sessions")], { encoding: "utf8" }); } catch { return ""; } })();
  console.log(`     観測: 子の記録の手がかり=${[...new Set(childText.split("\n").filter(Boolean))].slice(0, 6).join(" | ") || "（なし）"}`);
  for (const l of (r.stdout ?? "").split("\n")) { try { const e = JSON.parse(l); if (e.type === "item.completed" && ["agent_message", "collab_tool_call"].includes(e.item?.type)) console.log(`     観測: ${e.item.type} ${JSON.stringify(e.item).slice(0, 220)}`); } catch {} }
  const spawn = readLog(log).find((e) => /spawn_agent/.test(String(e.tool)));
  check("b. 子の起動の PreToolUse に agent_type が入る", spawn?.input?.agent_type === "cc_sdd_probe_reader");
  console.log(`     観測: 子の起動の tool_input のキー=${spawn ? Object.keys(spawn.input ?? {}).join(",") : "（届かない）"}`);
  check("b. 子の答え（合言葉）が返る", (r.stdout ?? "").includes("CCSDD-READER-CHILD"));
  // 2026-11-23（Codex 0.167.0）では、定義の sandbox_mode は効かず、子は親の権限（workspace-write）で書けた。合否ではなく観測として残す
  console.log(`     観測: sandbox_mode = "read-only" の子が child.txt を${fs.existsSync(path.join(repo, "child.txt")) ? "作れた（定義の権限は効かず、親の権限で動く）" : "作れなかった（定義の権限が効く）"}`);
}

if (want("c")) {
  console.log("== c. claude -p の権限の指定");
  const repo = mkrepo("c");
  const ask = (file) => `シェルかファイルの道具を使って ${file} を作り、中身を x にしてください。作れたかどうかを答えてください。`;
  spawnSync("claude", ["-p", "--model", "haiku", "--effort", "medium", "--setting-sources", "project", "--tools", "Read,Grep,Glob", "--max-turns", "4", ask("ro.txt")], { cwd: repo, env, encoding: "utf8", input: "", timeout: 300000 });
  check("c. --tools Read,Grep,Glob では書けない", !fs.existsSync(path.join(repo, "ro.txt")));
  spawnSync("claude", ["-p", "--model", "haiku", "--effort", "medium", "--setting-sources", "project", "--permission-mode", "acceptEdits", "--max-turns", "4", ask("rw.txt")], { cwd: repo, env, encoding: "utf8", input: "", timeout: 300000 });
  check("c. --permission-mode acceptEdits なら書ける", fs.existsSync(path.join(repo, "rw.txt")));
}

console.log(`結果: OK ${pass} 件、NG ${fail} 件`);
if (!process.env.POC_KEEP) fs.rmSync(base, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
