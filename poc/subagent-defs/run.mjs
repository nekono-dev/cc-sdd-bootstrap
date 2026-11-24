#!/usr/bin/env node
// PoC: subagent-delegation の役割定義（ファイルで置くエージェント定義）と、別の提供元の CLI の権限の指定が効くか。
//
// 対応する要件: subagent-delegation 2.1〜2.3（両ツールの役割定義）、4.4・4.5（書き込み可・読み取り専用）、3.2（定義のモデルの扱い）
// 確かめること
//   a. Claude Code: .claude/agents/<名前>.md の frontmatter（model・effort・tools）で定義した子を、Agent の subagent_type で起動できる。
//      PreToolUse の tool_input に subagent_type が入り、model は入らない（定義のモデルはフックから見えない）。tools を読み取りだけにした子は書けない
//   b. Codex: .codex/agents/<名前>.toml（model・model_reasoning_effort・sandbox_mode = "read-only"）で定義した子を agent_type で起動できるか。子が書けるか（観測）
//   c. claude -p: --tools Read,Grep,Glob で読み取り専用にすると書けない。--permission-mode acceptEdits なら書け、--allowedTools Bash でシェルも使える
//
//   d. Claude Code（タスク 3.3）: 配置物のフック（subagent-check.mjs）を手で登録し、名前を付けない起動の拒否、Haiku の定義の通過、
//      Haiku の定義を model: sonnet で上書きした起動と推論量 xhigh の定義の起動の推論量の理由での拒否を確かめる
//   e. Codex（タスク 3.3）: モデルを持たない定義＋model 省略の拒否、--resolve-model で得たモデル・推論量の明示での通過と子の記録、
//      同じ組（Terra）で推論量 high は通り xhigh はフックの推論量の理由で拒否される、を確かめる
//   node run.mjs s は、e の判定を模擬の記録（わざと失敗させたもの）で自己検査する（実機を使わない）。
//   d・e は POC_NOHOOK=1 でフックを登録せずに動かせる（確かめる項目が未登録で NG になることの確認）。
//   拒否はフックの出力（理由の文言）で見分ける（ツール側の入力の拒否と区別するため、フックを包んで出力を記録する）
//
// 使い方: node poc/subagent-defs/run.mjs [a b c d e]   （既定はすべて）
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
// 呼び出し元の推論量の環境変数（CLAUDE_CODE_EFFORT_LEVEL・CLAUDE_EFFORT）は子の claude の --effort と定義を上書きするので外す
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_EFFORT"].includes(k)));
const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "../..");


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
  spawnSync("claude", ["-p", "--model", "haiku", "--effort", "medium", "--setting-sources", "project", "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "--max-turns", "4", "Bash ツールで echo ok > sh.txt を実行してください。結果を答えてください。"], { cwd: repo, env, encoding: "utf8", input: "", timeout: 300000 });
  check("c. --permission-mode acceptEdits --allowedTools Bash ならシェル（テストの実行）も使える", fs.existsSync(path.join(repo, "sh.txt")));
}

// ---- d・e 共通: 配置物のフックを一時のリポジトリに手で登録する ----
// POC_MODELIDS=1 は、Codex のサンドボックス内で --resolve-model がモデルの一覧を得られない場合の切り分け用（名前を設定で与える）
const SUBAGENTS_CFG = { maxEffort: { default: "high", sonnet: "medium" }, ...(process.env.POC_MODELIDS ? { modelIds: { terra: "gpt-6.1-terra" } } : {}) };
const setupDelegation = (repo, tool, log) => {
  // 配置物（役割の規則・フック・入口）と有効な設定を写す
  const dst = path.join(repo, ".agent-hooks/cc-sdd-bootstrap"); fs.mkdirSync(dst, { recursive: true });
  for (const f of ["subagent-roles.mjs", "subagent-check.mjs", "delegate.mjs", "config-schema.mjs"]) fs.copyFileSync(path.join(repoRoot, ".agent-hooks/cc-sdd-bootstrap", f), path.join(dst, f));
  fs.writeFileSync(path.join(repo, ".cc-sdd-bootstrap.json"), JSON.stringify({ format: 1, ccSdd: {}, subagents: SUBAGENTS_CFG }));
  // フックを包み、入力と出力を記録する（拒否の理由の文言を見分けるため）
  const wrap = path.join(repo, "wrap-hook.mjs");
  fs.writeFileSync(wrap, `import fs from "node:fs"; import { spawnSync } from "node:child_process";
const input = fs.readFileSync(0, "utf8"); let i = {}; try { i = JSON.parse(input); } catch {}
const r = spawnSync("node", [${JSON.stringify(path.join(dst, "subagent-check.mjs"))}, "pre-tool-use", "--tool", ${JSON.stringify(tool)}], { input, encoding: "utf8" });
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: i.tool_name, input: i.tool_input, model: i.model, stdout: r.stdout, stderr: r.stderr, status: r.status }) + "\\n");
process.stdout.write(r.stdout ?? ""); process.stderr.write(r.stderr ?? ""); process.exit(r.status ?? 0);`);
  return wrap;
};
const denyOf = (e) => { try { return JSON.parse(e.stdout).hookSpecificOutput; } catch { return null; } };
const isDeny = (e) => denyOf(e)?.permissionDecision === "deny";
const reasonOf = (e) => denyOf(e)?.permissionDecisionReason ?? "";
const awaitedRoles = await import(path.join(repoRoot, ".agent-hooks/cc-sdd-bootstrap/subagent-roles.mjs"));
const spawnsOf = (log, re) => readLog(log).filter((e) => re.test(String(e.tool)));
const codexSessions = (home) => { try { return execFileSync("find", [path.join(home, "sessions"), "-name", "*.jsonl"], { encoding: "utf8" }).split("\n").filter(Boolean).sort(); } catch { return []; } };
const turnContexts = (f) => fs.readFileSync(f, "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.type === "turn_context").map((e) => `${e.payload?.model}/${e.payload?.effort ?? e.payload?.reasoning_effort ?? "?"}`);
const lastClaudeResult = (out) => (out ?? "").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.type === "result").pop()?.result ?? "";

if (want("d")) {
  console.log("== d. Claude Code: フックによる子の起動の拒否と通過（3.1 のフックを手で登録）");
  const repo = mkrepo("d"); const log = path.join(base, "d.log");
  fs.mkdirSync(path.join(repo, ".claude/agents"), { recursive: true });
  const { renderDefinitions } = await import(path.join(repoRoot, ".agent-hooks/cc-sdd-bootstrap/subagent-roles.mjs"));
  for (const f of renderDefinitions(SUBAGENTS_CFG).files.filter((f) => f.path.startsWith(".claude/"))) fs.writeFileSync(path.join(repo, f.path), f.content);
  // 検証用: 手で書いた推論量 xhigh の定義（モデルは haiku。上限 high を超える）
  fs.writeFileSync(path.join(repo, ".claude/agents/probe-xhigh.md"), "---\nname: probe-xhigh\ndescription: PoC の子（haiku・xhigh）。\nmodel: haiku\neffort: xhigh\ntools: Read\n---\n\n合言葉 CCSDD-XHIGH を答える。\n");
  const wrap = setupDelegation(repo, "claude", log);
  const settings = process.env.POC_NOHOOK ? {} : { hooks: { PreToolUse: [{ matcher: "Agent", hooks: [{ type: "command", command: `node ${JSON.stringify(wrap)}` }] }] } };
  fs.writeFileSync(path.join(repo, ".claude/settings.json"), JSON.stringify(settings));
  const projDir = path.join(os.homedir(), ".claude/projects", repo.replace(/[\/.]/g, "-")); fs.rmSync(projDir, { recursive: true, force: true });
  const run = (model, prompt) => { const r = spawnSync("claude", ["-p", "--model", model, "--effort", "medium", "--setting-sources", "project", "--output-format", "stream-json", "--verbose", "--max-turns", "10", prompt], { cwd: repo, env, encoding: "utf8", input: "", timeout: 600000 }); return lastClaudeResult(r.stdout); };
  const common = "Agent ツールの起動は、拒否されたら言い換えや再試行をせず、拒否の文言をそのまま引用して次へ進んでください。";
  // d1: 指揮役 sonnet。名前なし（general-purpose）の拒否と Haiku の定義の通過
  const a1 = run("sonnet", `${common} 次を順に 1 回ずつ行ってください。(1) Agent ツールで subagent_type に general-purpose を指定して子を起動し「OK」と答えさせる。(2) Agent ツールで subagent_type に cc-sdd-implement-haiku を指定し（model は指定しない）、子を起動して「OK」と答えさせる。それぞれの結果（拒否か通ったか、拒否の文言）を答えてください。`);
  // d2: 指揮役 opus。Haiku の定義の model 上書き（sonnet）と推論量 xhigh の定義
  const a2 = run("opus", `${common} 次を順に 1 回ずつ行ってください。(1) Agent ツールで subagent_type に cc-sdd-implement-haiku、model に sonnet を指定して子を起動し「OK」と答えさせる。(2) Agent ツールで subagent_type に probe-xhigh を指定し（model は指定しない）、子を起動して「OK」と答えさせる。それぞれの結果（拒否か通ったか、拒否の文言）を答えてください。`);
  const ag = spawnsOf(log, /^Agent$/);
  for (const e of ag) console.log(`     観測: 起動 ${JSON.stringify({ ...e.input, prompt: "…" })} → ${isDeny(e) ? "フックが拒否: " + reasonOf(e).split("\n")[0] : "フックは通した"}`);
  console.log(`     観測: 指揮役 sonnet の答え=${JSON.stringify(a1).slice(0, 300)}`);
  console.log(`     観測: 指揮役 opus の答え=${JSON.stringify(a2).slice(0, 300)}`);
  const noName = ag.find((e) => e.input?.subagent_type === "general-purpose" || !e.input?.subagent_type);
  check("d. 名前を付けない起動（general-purpose）がフックで拒否される（理由は「子のモデルが未指定」系）", !!noName && isDeny(noName) && /子の起動を拒否しました。理由: 子のモデルが指定されていません/.test(reasonOf(noName)) && /delegate\.mjs --resolve-model/.test(reasonOf(noName)));
  const hk = ag.find((e) => e.input?.subagent_type === "cc-sdd-implement-haiku" && !e.input?.model);
  check("d. Haiku の定義（cc-sdd-implement-haiku）がフックを通る", !!hk && !isDeny(hk) && hk.status === 0);
  let subs = []; try { subs = execFileSync("find", [projDir, "-name", "*.meta.json"], { encoding: "utf8" }).split("\n").filter(Boolean).map((f) => JSON.parse(fs.readFileSync(f, "utf8")).agentType); } catch {}
  check("d. 通した Haiku の定義の子が実際に起動した（子の記録に agentType）", subs.includes("cc-sdd-implement-haiku"));
  const ov = ag.find((e) => e.input?.subagent_type === "cc-sdd-implement-haiku" && e.input?.model);
  check("d. Haiku（high）の定義を model: sonnet で上書きした起動が、フックの推論量の理由で拒否される", !!ov && isDeny(ov) && /推論量が子のモデルの系統の上限より上/.test(reasonOf(ov)) && /上限: medium/.test(reasonOf(ov)));
  const xh = ag.find((e) => e.input?.subagent_type === "probe-xhigh");
  check("d. 推論量 xhigh の定義の起動が上限 high で拒否され、理由に推論量の上限が出る", !!xh && isDeny(xh) && /子の推論量: xhigh（上限: high/.test(reasonOf(xh)));
  fs.rmSync(projDir, { recursive: true, force: true });
}

// ---- e の判定（実機の記録と模擬の入力のどちらにも使える純粋な関数） ----
// 子の記録から、(モデル/推論量) の組と、子（アシスタント）の発話の文字列を取り出す
const sessionInfo = (file) => {
  const ctxs = []; let said = ""; let id = null, parent = null, agentPath = null;
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e?.type === "session_meta") { id = e.payload?.id ?? null; parent = e.payload?.parent_thread_id ?? null; agentPath = e.payload?.source?.subagent?.thread_spawn?.agent_path ?? null; }
    else if (e?.type === "turn_context") ctxs.push(`${e.payload?.model}/${e.payload?.effort ?? e.payload?.reasoning_effort ?? "?"}`);
    else if (e?.type === "event_msg" && e.payload?.type === "agent_message") said += `${e.payload.message ?? ""}\n`;
    else if (e?.type === "response_item" && e.payload?.type === "message" && e.payload?.role === "assistant") said += `${JSON.stringify(e.payload.content ?? "")}\n`;
  }
  return { id, parent, agentPath, ctxs, said };
};
// 指定した spawn_agent の起動の子の記録だけを求める。対応づけは、起動の task_name から作られる子の記録の
// session_meta.source.subagent.thread_spawn.agent_path（/root/<task_name>）と、その parent_thread_id が親（指揮役）の記録の id であること。
// 一意に決まらなければ null（呼び出し側で NG にする）
const childOf = (spawn, sessions) => {
  const tn = spawn?.input?.task_name;
  if (typeof tn !== "string" || tn === "") return null;
  const roots = sessions.filter((x) => x.id && !x.parent);
  const m = sessions.filter((x) => x.agentPath === `/root/${tn}` && x.parent && roots.some((r) => r.id === x.parent));
  return m.length === 1 ? m[0] : null;
};
const sessionsOf = (home) => codexSessions(home).map(sessionInfo);
// codex exec --json の出力から、シェルで実行した --resolve-model の結果（終了コードと標準出力）を取り出す
const resolveCommands = (stdout) => (stdout ?? "").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((x) => x?.item?.type === "command_execution" && /--resolve-model/.test(String(x.item.command)) && x.type === "item.completed")
  .map((x) => ({ code: x.item.exit_code, out: String(x.item.aggregated_output ?? "").trim() }));
const MISSING = /子のモデルが指定されていません/;
// e1: モデル省略の拒否 → --resolve-model の結果 → その名前・推論量の明示の起動 → 子の記録
// d = { entries（フックの記録）, cmds（--resolve-model の結果）, sessions（子の記録）, phrase }
const judgeE1 = (d) => {
  const sp = d.entries.filter((e) => /spawn_agent/.test(String(e.tool)));
  const bare = sp.find((e) => e.input?.agent_type === "cc_sdd_implement" && !e.input?.model);
  const r = [["e. Codex: モデルを持たない定義＋model 省略の起動が、モデル未指定の理由と --resolve-model の案内で拒否される",
    !!bare && isDeny(bare) && MISSING.test(reasonOf(bare)) && /delegate\.mjs --resolve-model/.test(reasonOf(bare))]];
  const cmd = d.cmds.find((c) => c.code === 0 && /^\S+ \w+$/.test(c.out));
  const [model, effort] = cmd ? cmd.out.split(" ") : [];
  r.push(["e. workspace-write の中の --resolve-model が終了 0 で「モデル 推論量」の 1 行を返す", !!cmd]);
  const ex = cmd && sp.find((e) => e.input?.model === model && e.input?.reasoning_effort === effort && e.input?.agent_type === "cc_sdd_implement");
  r.push(["e. --resolve-model の出力と同じモデル・推論量を明示し fork_turns を none にした起動がフックを通る",
    !!ex && !isDeny(ex) && ex.status === 0 && ex.input.fork_turns === "none"]);
  // 指定した起動の子の記録だけを、親子の対応（task_name ↔ agent_path・parent_thread_id）で特定して照合する
  const child = ex ? childOf(ex, d.sessions) : null;
  r.push(["e. 指定した起動の子の記録が親子の対応で特定でき、その turn_context のモデル・推論量が明示した組と一致する",
    !!child && child.ctxs.length > 0 && child.ctxs.every((c) => c === `${model}/${effort}`)]);
  r.push(["e. 子の記録の中の子の発話に合言葉が返る", !!child && child.said.includes(d.phrase)]);
  return r;
};
// e2: 同じ組（Terra）で high は通り、xhigh は推論量の理由で拒否される
const judgeE2 = (d) => {
  const sp = d.entries.filter((e) => /spawn_agent/.test(String(e.tool)));
  const hi = sp.find((e) => e.input?.model === "gpt-6.1-terra" && e.input?.reasoning_effort === "high");
  const child = hi ? childOf(hi, d.sessions) : null;
  const xh = sp.find((e) => e.input?.model === "gpt-6.1-terra" && e.input?.reasoning_effort === "xhigh");
  return [
    ["e. 同じ組（子 Terra）で推論量 high の起動がフックを通る", !!hi && !isDeny(hi) && hi.status === 0],
    ["e. その子の記録が Terra/high で、子の発話に合言葉が返る", !!child && child.ctxs.length > 0 && child.ctxs.every((c) => c === "gpt-6.1-terra/high") && child.said.includes(d.phrase)],
    ["e. 推論量だけを xhigh に変えると、フックの推論量の理由（上限 high・系統 terra）で拒否される",
      !!xh && isDeny(xh) && /推論量が子のモデルの系統の上限より上/.test(reasonOf(xh)) && /子の推論量: xhigh（上限: high、系統: terra）/.test(reasonOf(xh))
      && !d.sessions.some((x) => x.ctxs.includes("gpt-6.1-terra/xhigh"))],
  ];
};

if (want("e")) {
  console.log("== e. Codex: フックによる子の起動の拒否と通過（3.1 のフックを手で登録。指揮役 gpt-6.1-sol・推論量 high）");
  const common = "spawn_agent が拒否されたら、言い換えや再試行をせず、拒否の文言をそのまま引用して次へ進んでください。";
  // e1・e2 は作業場所・CODEX_HOME・フックの記録を別にする（記録が混ざって判定が緩くならないように）
  const runCodex = (name, prompt) => {
    const repo = mkrepo(name); const home = path.join(base, `${name}-home`); const log = path.join(base, `${name}.log`);
    fs.mkdirSync(path.join(repo, ".codex/agents"), { recursive: true }); fs.mkdirSync(home, { recursive: true });
    const { renderDefinitions } = awaitedRoles;
    for (const f of renderDefinitions(SUBAGENTS_CFG).files.filter((f) => f.path.startsWith(".codex/"))) fs.writeFileSync(path.join(repo, f.path), f.content);
    const wrap = setupDelegation(repo, "codex", log);
    if (!process.env.POC_NOHOOK) fs.writeFileSync(path.join(repo, ".codex/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `node ${JSON.stringify(wrap)}` }] }] } }));
    fs.copyFileSync(path.join(os.homedir(), ".codex/auth.json"), path.join(home, "auth.json"));
    fs.writeFileSync(path.join(home, "config.toml"), `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`);
    try {
      const r = spawnSync("codex", ["-a", "never", "exec", "--json", "--dangerously-bypass-hook-trust", "-s", "workspace-write", "--model", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"', "--cd", repo, `${common} ${prompt}`],
        { env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", input: "", timeout: 900000 });
      return { r, entries: readLog(log), cmds: resolveCommands(r.stdout), sessions: sessionsOf(home) };
    } finally { fs.rmSync(path.join(home, "auth.json"), { force: true }); }
  };
  const show = (d) => { for (const e of d.entries) console.log(`     観測: ${e.tool} ${JSON.stringify({ ...e.input, message: "…" })} → ${isDeny(e) ? "フックが拒否: " + reasonOf(e).split("\n")[0] : "フックは通した"}`); };
  const e1 = runCodex("e1", "次を順に行ってください。(1) spawn_agent で agent_type に cc_sdd_implement、fork_turns に none を指定し、model と reasoning_effort は指定せずに子を起動し「OK」と答えさせる。(2) シェルで node .agent-hooks/cc-sdd-bootstrap/delegate.mjs --resolve-model --from codex --role implement --orchestrator-model gpt-6.1-sol を実行し、標準出力の 1 行（モデルと推論量）を得る。(3) spawn_agent で agent_type に cc_sdd_implement、fork_turns に none、(2) で得たモデルを model、推論量を reasoning_effort に明示して子を起動し、子に合言葉 CCSDD-RESOLVED を答えさせ、wait で待つ。");
  show(e1); console.log(`     観測: --resolve-model の結果=${JSON.stringify(e1.cmds)} 子の記録=${JSON.stringify(e1.sessions.map((x) => x.ctxs))}`);
  for (const [label, ok] of judgeE1({ ...e1, phrase: "CCSDD-RESOLVED" })) check(label, ok);
  const e2 = runCodex("e2", "次を順に行ってください。(1) spawn_agent で agent_type に cc_sdd_implement、fork_turns に none、model に gpt-6.1-terra、reasoning_effort に high を指定して子を起動し、合言葉 CCSDD-HIGH を答えさせ、wait で待つ。(2) spawn_agent で agent_type に cc_sdd_implement、fork_turns に none、model に gpt-6.1-terra、reasoning_effort に xhigh を指定して子を起動し「OK」と答えさせる。");
  show(e2); console.log(`     観測: 子の記録=${JSON.stringify(e2.sessions.map((x) => x.ctxs))}`);
  for (const [label, ok] of judgeE2({ ...e2, phrase: "CCSDD-HIGH" })) check(label, ok);
}

// ---- 判定の自己検査（実機を使わない）: わざと失敗させた記録で NG になることを確かめる。node run.mjs s ----
if (only.includes("s")) {
  console.log("== s. 判定の自己検査（模擬の記録。期待どおりなら「期待どおり」）");
  const deny = (reason) => ({ stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: reason } }), status: 0 });
  const MISS = "子の起動を拒否しました。理由: 子のモデルが指定されていません。\n使う定義の名前は node .agent-hooks/cc-sdd-bootstrap/delegate.mjs --resolve-model --from codex で求められます。";
  const sp = (input, ex) => ({ tool: "collaborationspawn_agent", input: { agent_type: "cc_sdd_implement", fork_turns: "none", ...input }, status: 0, stdout: "", ...ex });
  const ROOT = { id: "root", parent: null, agentPath: null, ctxs: ["gpt-6.1-sol/high"], said: "" };
  const kid = (task, ctxs, said, id = `k-${task}`) => ({ id, parent: "root", agentPath: `/root/${task}`, ctxs, said });
  const good1 = () => ({ phrase: "P", entries: [sp({}, deny(MISS)), sp({ task_name: "t1", model: "gpt-6.1-terra", reasoning_effort: "medium" })], cmds: [{ code: 0, out: "gpt-6.1-terra medium" }], sessions: [ROOT, kid("t1", ["gpt-6.1-terra/medium"], "P")] });
  const good2 = () => ({ phrase: "H", entries: [sp({ task_name: "t1", model: "gpt-6.1-terra", reasoning_effort: "high" }), sp({ task_name: "t2", model: "gpt-6.1-terra", reasoning_effort: "xhigh" }, deny("子の起動を拒否しました。理由: 子の推論量が子のモデルの系統の上限より上です。\n子の推論量: xhigh（上限: high、系統: terra）"))], sessions: [ROOT, kid("t1", ["gpt-6.1-terra/high"], "H")] });
  const expect = (label, results, okIdx) => { const bad = results.map(([, ok], i) => (ok ? -1 : i)).filter((i) => i >= 0); const as = JSON.stringify(bad) === JSON.stringify(okIdx); console.log(`${as ? "期待どおり" : "想定外"}: ${label} → NG の項目 ${JSON.stringify(bad)}`); if (!as) fail++; };
  expect("e1 正常な記録は全項目 OK", judgeE1(good1()), []);
  let d = good1(); d.cmds = [{ code: 2, out: "" }]; expect("e1 名前の解決が失敗（終了 2・出力なし）", judgeE1(d), [1, 2, 3, 4]);
  d = good1(); d.sessions = [ROOT, kid("t1", ["gpt-6.1-terra/high"], "P")]; expect("e1 子の記録の推論量が明示と違う", judgeE1(d), [3]);
  d = good1(); d.sessions = [ROOT, kid("t1", ["gpt-6.1-terra/medium"], "")]; expect("e1 子の発話に合言葉がない", judgeE1(d), [4]);
  d = good1(); d.entries[1] = sp({ model: "gpt-6.1-terra", reasoning_effort: "high" }); expect("e1 明示の推論量が解決の出力と違う", judgeE1(d), [2, 3, 4]);
  d = good1(); d.entries[0] = sp({}, deny("子の推論量が子のモデルの系統の上限より上です。")); expect("e1 モデル省略の拒否が別の理由", judgeE1(d), [0]);
  d = good1(); d.entries[0] = sp({}, deny("子の起動を拒否しました。理由: 子のモデルが指定されていません。")); expect("e1 拒否の理由に --resolve-model の案内がない", judgeE1(d), [0]);
  expect("e2 正常な記録は全項目 OK", judgeE2(good2()), []);
  d = good2(); d.entries[1] = sp({ model: "gpt-6.1-terra", reasoning_effort: "xhigh" }, deny(MISS)); expect("e2 xhigh の拒否が別の理由", judgeE2(d), [2]);
  d = good2(); d.sessions = [ROOT, kid("t1", ["gpt-6.1-terra/high"], "H"), kid("t2", ["gpt-6.1-terra/xhigh"], "")]; expect("e2 拒否のはずの xhigh の子が動いた", judgeE2(d), [2]);
  d = good1(); d.sessions = [ROOT, kid("t1", ["gpt-6.1-sol/high"], ""), kid("other", ["gpt-6.1-terra/medium"], "P")]; expect("e1 別の起動の子だけがモデル・推論量・合言葉を満たし、指定した起動の子は満たさない", judgeE1(d), [3, 4]);
  d = good1(); d.sessions = [ROOT, kid("other", ["gpt-6.1-terra/medium"], "P")]; expect("e1 指定した起動の子の記録が見つからない（別の子だけがある）", judgeE1(d), [3, 4]);
  d = good1(); d.entries[1] = sp({ model: "gpt-6.1-terra", reasoning_effort: "medium" }); expect("e1 起動に task_name がなく対応づけられない", judgeE1(d), [3, 4]);
  d = good1(); d.sessions = [ROOT, { ...kid("t1", ["gpt-6.1-terra/medium"], "P"), parent: "stranger" }]; expect("e1 親が指揮役の記録でない子（対応づけ不可）", judgeE1(d), [3, 4]);
}

console.log(`結果: OK ${pass} 件、NG ${fail} 件`);
if (!process.env.POC_KEEP) fs.rmSync(base, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
