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

// ---- p. 配置による確認（タスク 4.3）: init・update で配置したフックと生成した定義を、手で登録せずに通して確かめる ----
// 判定は、実機の記録から取り出した「起動の呼び出し」の一覧（正規化したもの）だけを見る純粋な関数にする（自己検査 s で模擬の記録を使う）。
// 起動の呼び出し c = { name, input, denied（フックの拒否か）, text（結果の文字列）, isError }。拒否の見分け:
//   Claude Code: tool_result が is_error で「PreToolUse:Agent hook error: 」で始まる。Codex: 結果が「Tool call blocked by PreToolUse hook: 」で始まる
const parseLines = (t) => (t ?? "").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const CL_DENY = /^PreToolUse:Agent hook error: /;
const CX_DENY = /^Tool call blocked by PreToolUse hook: /;
const claudeCalls = (stdout) => {
  const calls = []; const byId = new Map();
  for (const e of parseLines(stdout)) {
    if (e.parent_tool_use_id) continue; // 子の中の呼び出しは含めない
    if (e.type === "assistant") for (const c of e.message?.content ?? []) if (c.type === "tool_use") { const x = { name: c.name, input: c.input ?? {}, denied: false, text: "", isError: false }; calls.push(x); byId.set(c.id, x); }
    if (e.type === "user" && Array.isArray(e.message?.content)) for (const c of e.message.content) if (c.type === "tool_result" && byId.has(c.tool_use_id)) {
      const x = byId.get(c.tool_use_id); x.text = typeof c.content === "string" ? c.content : JSON.stringify(c.content); x.isError = !!c.is_error; x.denied = x.isError && CL_DENY.test(x.text);
    }
  }
  return calls;
};
const claudeSpawn = (c) => c.name === "Agent";
const claudeSpawnType = (c) => c.input?.subagent_type;
// 親（指揮役）の記録から、起動（spawn_agent）とほかの呼び出しを順に取り出す
const codexRoot = (home) => codexSessions(home).find((f) => { const first = parseLines(fs.readFileSync(f, "utf8").split("\n")[0])[0]; return first?.type === "session_meta" && !first.payload?.parent_thread_id; });
const codexCalls = (home) => {
  const f = codexRoot(home); if (!f) return [];
  const calls = []; const byId = new Map();
  for (const e of parseLines(fs.readFileSync(f, "utf8"))) {
    if (e.type !== "response_item") continue;
    const p = e.payload;
    // 子から親へ届いた応答（宛先 /root）。呼び出しと同じ順序の列に「@agent_message」として入れ、起動・待機との前後を判定できるようにする
    if (p?.type === "agent_message" && p.recipient === "/root") calls.push({ name: "@agent_message", input: { author: p.author }, denied: false, text: JSON.stringify(p.content ?? ""), isError: false });
    if (p?.type === "function_call") { let input = {}; try { input = JSON.parse(p.arguments); } catch {} const x = { name: p.name, input, denied: false, text: "", isError: false }; calls.push(x); byId.set(p.call_id, x); }
    if (p?.type === "custom_tool_call") { const x = { name: p.name, input: { input: p.input }, denied: false, text: "", isError: false }; calls.push(x); byId.set(p.call_id, x); }
    if ((p?.type === "function_call_output" || p?.type === "custom_tool_call_output") && byId.has(p.call_id)) { const x = byId.get(p.call_id); x.text = typeof p.output === "string" ? p.output : JSON.stringify(p.output); x.denied = CX_DENY.test(x.text); }
  }
  return calls;
};
const codexSpawn = (c) => c.name === "spawn_agent";
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
// 起動の成功: フックに拒否されず、結果に起動した子の名前（/root/<task_name>）が返っている（Codex）
const cxOk = (c) => !!c && codexSpawn(c) && !c.denied && (() => { try { return JSON.parse(c.text).task_name === `/root/${c.input?.task_name}`; } catch { return false; } })();
// 指定した起動の子（agent_path /root/<task_name>）から、その起動より後に親へ届いた応答。さらにその間に wait_agent があること
const cxReply = (calls, spawn) => {
  const i = calls.indexOf(spawn); if (i < 0 || typeof spawn.input?.task_name !== "string") return "";
  const after = calls.slice(i + 1);
  if (!after.some((c) => c.name === "wait_agent")) return "";
  return after.filter((c) => c.name === "@agent_message" && c.input.author === `/root/${spawn.input.task_name}`).map((c) => c.text).join("\n");
};
// 手順書の「本当の読み取り」: 成功し、手順書の中身（frontmatter の name）が結果に入っている。読み取りの道具（Read）か cat・head・nl の実行に限る（echo などは含めない）
const SKILL_NAME = /name:\s*kiro-spec-status/;
const isSkillRead = (c) => {
  if (!c || c.isError || c.denied || !JSON.stringify(c.input ?? {}).includes("kiro-spec-status/SKILL.md") || !SKILL_NAME.test(c.text)) return false;
  if (c.name === "Read") return true;
  const cmd = String(c.input?.command ?? c.input?.cmd ?? c.input?.input ?? "");
  return /(^|[\s"'`;&|(]|cmd:)(cat|head|nl)\s/.test(cmd) && !/\becho\b/.test(cmd);
};
const SUB = "子の起動を拒否しました。理由: ";
const isSubDeny = (c, label) => !!c && c.denied && c.text.includes(`${SUB}${label}`);
const NOT_SKILL_GATE = (c) => !c.text.includes(SUB);
const GATE_RE = /先に手順書 \S*kiro-spec-status\/SKILL\.md を読んでから、作業を進めてください。/;
const BROKEN = "subagents の設定に問題があるため、直るまで子を起動しません。";
// Claude Code の指揮役 sonnet: 名前なしの拒否・--resolve-model の名前の起動の通過・同系統と上の格の定義の拒否
const judgeCl1 = (d) => {
  const sp = d.calls.filter(claudeSpawn);
  const gp = sp.find((c) => claudeSpawnType(c) === "general-purpose" || !claudeSpawnType(c));
  // 名前の解決: 成功した Bash の結果が、ちょうど 1 行「定義の名前 推論量」（推論量は有効な値）。その名前を使う起動より前であること
  const bashIdx = d.calls.findIndex((c) => c.name === "Bash" && /--resolve-model/.test(String(c.input?.command)) && !c.isError && /^cc-sdd-\S+ (low|medium|high|xhigh|max|ultra)$/.test(c.text.trim()));
  const name = bashIdx >= 0 ? d.calls[bashIdx].text.trim().split(" ")[0] : null;
  const ok = name && sp.find((c) => claudeSpawnType(c) === name && !c.input?.model && d.calls.indexOf(c) > bashIdx);
  return [
    ["p. Claude Code: 名前を付けない起動（general-purpose）が、フックの理由（子のモデル未指定・--resolve-model の案内）で拒否される", !!gp && isSubDeny(gp, "子のモデルが指定されていません") && /delegate\.mjs --resolve-model/.test(gp.text)],
    ["p. Claude Code: --resolve-model（指揮役 sonnet）が成功し、ちょうど 1 行の「定義の名前 推論量」（有効な推論量）を出す", !!name],
    ["p. Claude Code: --resolve-model が出した先頭の名前を、その出力の後に subagent_type に入れた起動が通り、その定義の子が実際に起動した", !!ok && !ok.isError && !ok.denied && d.subs.some((s) => s.agentType === name)],
    ["p. Claude Code: 指揮役と同じ系統の定義（cc-sdd-implement-sonnet）の起動が、フックの「同じ系統」の理由で拒否される", isSubDeny(sp.find((c) => claudeSpawnType(c) === "cc-sdd-implement-sonnet"), "子が指揮役と同じ系統のモデルです")],
    ["p. Claude Code: 上の格の定義（cc-sdd-implement-opus）の起動が、フックの「上の格」の理由で拒否される", isSubDeny(sp.find((c) => claudeSpawnType(c) === "cc-sdd-implement-opus"), "子が指揮役より上の格のモデルです")],
    ["p. Claude Code: 拒否された子は起動していない（子の記録に sonnet・opus の定義が無い）", !d.subs.some((s) => ["cc-sdd-implement-sonnet", "cc-sdd-implement-opus", "general-purpose"].includes(s.agentType))],
  ];
};
// Claude Code の指揮役 opus: Haiku（high）の定義を model sonnet で上書き → 推論量の理由
const judgeCl2 = (d) => {
  const ov = d.calls.filter(claudeSpawn).find((c) => claudeSpawnType(c) === "cc-sdd-implement-haiku" && c.input?.model === "sonnet");
  return [["p. Claude Code: Haiku（high）の定義を model sonnet で上書きした起動が、フックの推論量の理由（上限 medium・系統 sonnet）で拒否される（指揮役 opus）",
    isSubDeny(ov, "子の推論量が子のモデルの系統の上限より上です") && /子の推論量: high（上限: medium、系統: sonnet）/.test(ov.text)]];
};
// Codex の指揮役 sol: model 省略の拒否 → --resolve-model の出力の明示 → 子の記録
// d = { calls（親の呼び出しと子の応答の順序つきの列）, cmds, sessions, phrase }
const IMPL = (c) => c.input?.agent_type === "cc_sdd_implement" && c.input?.fork_turns === "none";
const judgeCx1 = (d) => {
  const sp = d.calls.filter(codexSpawn);
  const bare = sp.find((c) => IMPL(c) && !c.input?.model);
  const cmd = d.cmds.find((c) => c.code === 0 && /^\S+ (low|medium|high|xhigh|max|ultra)$/.test(c.out)); const [model, effort] = cmd ? cmd.out.split(" ") : [];
  const ex = cmd && sp.find((c) => IMPL(c) && c.input?.model === model && c.input?.reasoning_effort === effort);
  // 名前の解決の実行（親の列の中）が、その値を使う起動より前にあること
  const resolveIdx = cmd ? d.calls.findIndex((c) => c.name === "exec" && /--resolve-model/.test(JSON.stringify(c.input)) && c.text.includes(cmd.out)) : -1;
  const child = ex ? childOf(ex, d.sessions) : null;
  return [
    ["p. Codex: 実装の定義＋model 省略の起動が、フックの理由（子のモデル未指定・--resolve-model の案内）で拒否される", isSubDeny(bare, "子のモデルが指定されていません") && /delegate\.mjs --resolve-model/.test(bare.text)],
    ["p. Codex: workspace-write の中の --resolve-model が終了 0 で「モデル 推論量」（有効な推論量）の 1 行を返す", !!cmd],
    ["p. Codex: その出力のモデルを model・推論量を reasoning_effort に明示し fork_turns を none にした起動（agent_type は実装の定義）が、解決の実行の後に通り、起動の結果に子の名前が返る", !!ex && cxOk(ex) && resolveIdx >= 0 && resolveIdx < d.calls.indexOf(ex)],
    ["p. Codex: 指定した起動の子の記録が親子の対応で特定でき、turn_context のモデル・推論量が明示した組と一致する", !!child && child.ctxs.length > 0 && child.ctxs.every((x) => x === `${model}/${effort}`)],
    ["p. Codex: 子の応答（合言葉）が子の記録にあり、その起動の子から wait の後に親へ届いた（別の子・起動の失敗では成り立たない）", !!child && child.said.includes(d.phrase) && !!ex && cxOk(ex) && cxReply(d.calls, ex).includes(d.phrase)],
  ];
};
// Codex の指揮役 sol: 同じ組（Terra・上限 high）で high は通り xhigh だけ推論量の理由で拒否
const judgeCx2 = (d) => {
  const sp = d.calls.filter(codexSpawn);
  const T = (c, e) => IMPL(c) && c.input?.model === "gpt-6.1-terra" && c.input?.reasoning_effort === e;
  const hi = sp.find((c) => T(c, "high"));
  const xh = sp.find((c) => T(c, "xhigh"));
  const child = hi ? childOf(hi, d.sessions) : null;
  return [
    ["p. Codex: 3.3 と同じ組（指揮役 sol・子 Terra・上限 high）で推論量 high の起動が通り、子の記録が Terra/high で、その子の応答が wait の後に親へ返る", !!hi && cxOk(hi) && !!child && child.ctxs.length > 0 && child.ctxs.every((x) => x === "gpt-6.1-terra/high") && child.said.includes(d.phrase) && cxReply(d.calls, hi).includes(d.phrase)],
    ["p. Codex: 同じ定義・fork_turns none・Terra のまま推論量だけを xhigh にした起動が、フックの推論量の理由（上限 high・系統 terra）で拒否され、xhigh の子は動かない", !!xh && !!hi && isSubDeny(xh, "子の推論量が子のモデルの系統の上限より上です") && /子の推論量: xhigh（上限: high、系統: terra）/.test(xh.text) && !d.sessions.some((x) => x.ctxs.includes("gpt-6.1-terra/xhigh"))],
  ];
};
// Codex の指揮役 terra: 上限と推論量の上限に収まる sol の明示が、上の格の理由で拒否される
const judgeCx3 = (d) => {
  const sol = d.calls.filter(codexSpawn).find((c) => IMPL(c) && c.input?.model === "gpt-6.1-sol" && c.input?.reasoning_effort === "medium");
  return [["p. Codex: 指揮役 Terra で、子の上限・推論量の上限に収まる Sol（medium）を model に明示した起動（実装の定義・fork_turns none）が、フックの「上の格」の理由だけで拒否され、Sol の子は動かない",
    isSubDeny(sol, "子が指揮役より上の格のモデルです") && /指揮役のモデル: gpt-6\.1-terra/.test(sol.text) && !d.sessions.some((x) => x.parent && x.ctxs.some((c) => c.startsWith("gpt-6.1-sol/")))]];
};
// 設定の誤り: 入力は止まらず（答えが返る）、子の起動だけが設定の誤りの理由で拒否される
const judgeBroken = (tool, d) => {
  const sp = d.calls.filter(tool === "claude" ? claudeSpawn : codexSpawn);
  const s = sp[0];
  return [
    [`p. ${tool}: 設定を有効な JSON のまま subagents だけ不正にした次の入力は止まらず、答え（合言葉）が返る`, d.ok && d.answer.includes(d.phrase)],
    [`p. ${tool}: 子の起動だけが、設定の誤りの理由（問題の項目に maxModel）で拒否され、ツール側の拒否ではない`, !!s && s.denied && s.text.includes(BROKEN) && /maxModel/.test(s.text) && !s.text.includes(SUB)],
  ];
};
// kiro-gate と同時: 許される起動でも手順書が未読なら kiro-gate の理由で拒否、本当に読んだ後に同じ起動が成功する
const judgeGate = (tool, d) => {
  const isSp = tool === "claude" ? claudeSpawn : codexSpawn;
  const first = d.calls.findIndex((c) => isSp(c));
  const readIdx = d.calls.findIndex((c, i) => i > first && first >= 0 && !isSp(c) && isSkillRead(c));
  const second = d.calls.findIndex((c, i) => i > readIdx && readIdx >= 0 && isSp(c));
  const a = d.calls[first], b = d.calls[second];
  // フックの判定に効く項目（定義・モデル・推論量・引き継ぎ）だけを比べる。task_name は起動ごとに一意、message は起動ごとに暗号化の値が変わる
  const norm = (x) => JSON.stringify(["agent_type", "subagent_type", "model", "reasoning_effort", "fork_turns"].map((k) => x?.[k] ?? null));
  const same = !!a && !!b && norm(a.input) === norm(b.input);
  // 2 回目の成功: Claude Code は結果が成功で子の記録が増えた、Codex は結果に子の名前が返り、その子の記録があり応答が親へ届いた
  const succeeded = !b ? false : tool === "claude"
    ? !b.denied && !b.isError && d.subs.length > (d.subsBefore ?? 0)
    : cxOk(b) && !!childOf(b, d.sessions) && cxReply(d.calls, b) !== "";
  return [
    [`p. ${tool}: 手順書が未読のときの起動が、kiro-gate の理由（手順書を先に読む）で拒否され、subagent-check の理由ではない`, !!a && a.denied && GATE_RE.test(a.text) && NOT_SKILL_GATE(a)],
    [`p. ${tool}: 手順書を実際に読んだ（成功し手順書の中身が返った）後に、同じ引数の起動が成功する（子が動き応答が返る）`, readIdx > first && same && succeeded],
  ];
};

const readBeforeSpawn = (tool, calls) => { const isSp = tool === "claude" ? claudeSpawn : codexSpawn; const f = calls.findIndex(isSp); const r = calls.findIndex((c) => !isSp(c) && isSkillRead(c)); return r >= 0 && (f < 0 || r < f); };

if (want("p")) {
  console.log("== p. 配置による確認（init・update で配置したフックと定義を通す。手で登録しない）");
  const cli = path.join(repoRoot, "bin/cc-sdd-bootstrap.mjs");
  const CFG = { maxModel: { claude: "opus", codex: "sol" }, maxEffort: { default: "high", sonnet: "medium" } };
  const sh = (cmd, args, repo, extraEnv = {}) => spawnSync(cmd, args, { cwd: repo, env: { ...env, ...extraEnv }, encoding: "utf8", input: "", timeout: 900000 });
  const readCfg = (repo) => JSON.parse(fs.readFileSync(path.join(repo, ".cc-sdd-bootstrap.json"), "utf8"));
  const writeCfg = (repo, mutate) => { const c = readCfg(repo); mutate(c); fs.writeFileSync(path.join(repo, ".cc-sdd-bootstrap.json"), `${JSON.stringify(c, null, 2)}\n`); };
  const slugOf = (repo) => path.join(os.homedir(), ".claude/projects", repo.replace(/[\/.]/g, "-"));
  const claudeSubs = (repo) => {
    const out = [];
    try { for (const f of execFileSync("find", [slugOf(repo), "-name", "*.meta.json"], { encoding: "utf8" }).split("\n").filter(Boolean)) {
      let m = {}; try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
      const models = parseLines(fs.existsSync(f.replace(/\.meta\.json$/, ".jsonl")) ? fs.readFileSync(f.replace(/\.meta\.json$/, ".jsonl"), "utf8") : "").map((e) => e.message?.model).filter(Boolean);
      out.push({ agentType: m.agentType, models: [...new Set(models)] });
    } } catch {}
    return out;
  };
  const claudeRun = (repo, model, prompt) => {
    const r = sh("claude", ["-p", "--model", model, "--effort", "medium", "--setting-sources", "project", "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "--output-format", "stream-json", "--verbose", "--max-turns", "16", prompt], repo);
    const res = parseLines(r.stdout).filter((e) => e.type === "result").pop();
    return { r, calls: claudeCalls(r.stdout), subs: claudeSubs(repo), ok: r.status === 0 && res && !res.is_error, answer: String(res?.result ?? "") };
  };
  const codexRun = (repo, home, model, prompt, sandbox = "workspace-write", extra = []) => {
    fs.mkdirSync(home, { recursive: true });
    fs.copyFileSync(path.join(os.homedir(), ".codex/auth.json"), path.join(home, "auth.json"));
    fs.writeFileSync(path.join(home, "config.toml"), `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`);
    try {
      const r = sh("codex", ["-a", "never", "exec", "--json", "--dangerously-bypass-hook-trust", "-s", sandbox, "--model", model, "-c", 'model_reasoning_effort="high"', ...extra, "--cd", repo, prompt], repo, { CODEX_HOME: home });
      const ev = parseLines(r.stdout);
      const answer = ev.filter((e) => e.item?.type === "agent_message").map((e) => String(e.item.text ?? "")).at(-1) ?? "";
      const failed = ev.some((e) => e.type === "turn.failed");
      return { r, calls: codexCalls(home), cmds: resolveCommands(r.stdout), sessions: sessionsOf(home), ok: r.status === 0 && !failed && answer !== "", answer };
    } finally { fs.rmSync(path.join(home, "auth.json"), { force: true }); }
  };
  const show = (calls, isSp) => { for (const c of calls.filter(isSp)) console.log(`     観測: 起動 ${JSON.stringify({ ...c.input, prompt: "…", message: "…", description: undefined })} → ${c.denied ? "フックが拒否: " + c.text.split("\n")[0].slice(0, 120) : c.isError ? "ツール側の失敗: " + c.text.slice(0, 80) : "通った"}`); };
  const common = "Agent ツールの起動は、拒否されたら言い換えや再試行をせず、拒否の文言をそのまま引用して次へ進んでください。";
  const commonX = "spawn_agent が拒否されたら、言い換えや再試行をせず、拒否の文言をそのまま引用して次へ進んでください。";
  // 配置: init → 設定（子の上限・推論量の上限）→ update。配置物を確かめる
  const place = (name) => {
    const repo = mkrepo(name);
    const i = sh("node", [cli, "init"], repo);
    check(`p. ${name}: init が通り設定ファイルができる`, i.status === 0 && fs.existsSync(path.join(repo, ".cc-sdd-bootstrap.json")));
    writeCfg(repo, (c) => { c.subagents = CFG; });
    const u = sh("node", [cli, "update"], repo);
    check(`p. ${name}: 設定（subagents の maxModel・maxEffort の両方）を書いてから update が通り、設定に両方が残る`, u.status === 0 && JSON.stringify(readCfg(repo).subagents) === JSON.stringify(CFG) && !!readCfg(repo).subagents.maxModel && !!readCfg(repo).subagents.maxEffort);
    const cs = JSON.parse(fs.readFileSync(path.join(repo, ".claude/settings.json"), "utf8")); const cx = JSON.parse(fs.readFileSync(path.join(repo, ".codex/hooks.json"), "utf8"));
    const pre = (x) => (x.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks.map((h) => ({ matcher: g.matcher, command: h.command })));
    check(`p. ${name}: Claude Code のフック（PreToolUse・Agent）に subagent-check が配置される`, pre(cs).some((h) => h.matcher === "Agent" && /subagent-check\.mjs.* pre-tool-use --tool claude/.test(h.command)));
    check(`p. ${name}: Codex のフック（PreToolUse）に subagent-check が配置される`, pre(cx).some((h) => /subagent-check\.mjs.* pre-tool-use --tool codex/.test(h.command)));
    const defs = ["haiku", "sonnet", "opus"].map((m) => path.join(repo, `.claude/agents/cc-sdd-implement-${m}.md`));
    check(`p. ${name}: 役割定義が配置される（Claude Code は系統ごと、Codex は cc_sdd_implement）。sonnet の推論量が上限 medium`, defs.every((f) => fs.existsSync(f)) && fs.existsSync(path.join(repo, ".codex/agents/cc_sdd_implement.toml"))
      && /^effort: medium$/m.test(fs.readFileSync(defs[1], "utf8")) && /^model: "haiku"$/m.test(fs.readFileSync(defs[0], "utf8")));
    const secC = fs.readFileSync(path.join(repo, ".agent-hooks/cc-sdd-bootstrap/agent-section-claude.md"), "utf8"), secX = fs.readFileSync(path.join(repo, ".agent-hooks/cc-sdd-bootstrap/agent-section-codex.md"), "utf8");
    check(`p. ${name}: 区画の文章（--resolve-model の案内）が配置される`, /--resolve-model --from claude/.test(secC) && /--resolve-model --from codex/.test(secX));
    return repo;
  };
  // 最初の入力での cc-sdd の導入（npx で取得できる通信と作業場所への書き込みを許した状態）。入力が通り、区画が文書に入る
  const checkInstalled = (repo, tool, ran) => {
    check(`p. ${tool}: 有効な設定のうちの最初の入力で cc-sdd が導入され入力が通る（手順書・区画の文章）`, ran.ok && ran.answer.includes("PONG")
      && fs.existsSync(path.join(repo, tool === "claude" ? ".claude/skills/kiro-spec-status/SKILL.md" : ".agents/skills/kiro-spec-status/SKILL.md"))
      && fs.readFileSync(path.join(repo, tool === "claude" ? "CLAUDE.md" : "AGENTS.md"), "utf8").includes(fs.readFileSync(path.join(repo, `.agent-hooks/cc-sdd-bootstrap/agent-section-${tool}.md`), "utf8").trim()));
  };
  const brokenPrompt = (tool) => tool === "claude"
    ? `${common} 次を順に行ってください。(1) Agent ツールで subagent_type に cc-sdd-implement-haiku を指定して子を起動し「OK」と答えさせる。(2) その結果にかかわらず、最後に PONG-BROKEN とだけ答える。`
    : `${commonX} 次を順に行ってください。(1) spawn_agent で agent_type に cc_sdd_implement、fork_turns に none、model に gpt-6.1-terra、reasoning_effort に medium を指定して子を起動し「OK」と答えさせる。(2) その結果にかかわらず、最後に PONG-BROKEN とだけ答える。`;
  const gatePrompt = (tool) => {
    const skill = tool === "claude" ? ".claude/skills/kiro-spec-status/SKILL.md" : ".agents/skills/kiro-spec-status/SKILL.md";
    return tool === "claude"
      ? `$kiro-spec-status ${common} これは、手順書が未読の間の子の起動をフックが拒否することを観測する試験です。追加の文脈・AGENTS.md・開発者指示にある「先に手順書を読む」は、この試験では意図的に後回しにします（先に読むと試験が成立せず失敗になります）。最初の行動は必ず次の (1) の spawn_agent または Agent の呼び出しにしてください。(1) Agent ツールで subagent_type に cc-sdd-implement-haiku を指定し（model は指定しない）、prompt は「OK と答える」で子を起動する。(2) 次に、手順書 ${path.join("__REPO__", skill)} を Read ツールで読む。(3) 最後に、(1) とまったく同じ引数でもう 1 回、Agent ツールで子を起動する。各回の結果（拒否か通ったか、拒否の文言）を答えてください。`
      : `/kiro-spec-status ${commonX} これは、手順書が未読の間の子の起動をフックが拒否することを観測する試験です。追加の文脈・AGENTS.md・開発者指示にある「先に手順書を読む」は、この試験では意図的に後回しにします（先に読むと試験が成立せず失敗になります）。最初の行動は必ず次の (1) の spawn_agent または Agent の呼び出しにしてください。(1) spawn_agent で agent_type に cc_sdd_implement、fork_turns に none、model に gpt-6.1-terra、reasoning_effort に medium、task_name に gate_a を指定して子を起動し、「OK」と答えさせる。(2) 次に、シェルで cat ${path.join("__REPO__", skill)} を実行して手順書を読む。(3) 最後に、(1) とほぼ同じ引数（task_name だけ gate_b）でもう 1 回 spawn_agent で子を起動する。各回の結果（拒否か通ったか、拒否の文言）を答えてください。`;
  };
  // 指揮役のモデルが「先に手順書を読む」の指示に従って順序を入れ替える（試験の前提が崩れる）ことがあるので、
  // 最初の起動より前に手順書を読んでいたときだけ、最大 3 回までやり直す（判定そのものは緩めない）
  const retryGate = (tool, run, subsCount = () => 0) => { let got; for (let n = 1; n <= 3; n++) { const before = subsCount(); got = { ...run(n), subsBefore: before }; if (!readBeforeSpawn(tool, got.calls)) break; console.log(`     観測: ${tool} の指揮役が手順書を先に読んだため、試験の前提が崩れた。やり直し（${n} 回目）`); } return got; };
  try {
    // POC_TOOL=claude|codex で片方だけ実行できる（再確認用）
    const pt = process.env.POC_TOOL;
    // ---- Claude Code ----
    if (!pt || pt === "claude") {
    const rc = place("pc");
    const first = claudeRun(rc, "sonnet", "PONG とだけ答えてください。");
    checkInstalled(rc, "claude", first);
    const rs = sh("node", [".agent-hooks/cc-sdd-bootstrap/delegate.mjs", "--resolve-model", "--from", "claude", "--role", "implement", "--orchestrator-model", "sonnet"], rc);
    console.log(`     観測: --resolve-model（claude・sonnet）= ${JSON.stringify(rs.stdout.trim())}`);
    const c1 = claudeRun(rc, "sonnet", `${common} 次を順に 1 回ずつ行ってください。(1) シェルで node .agent-hooks/cc-sdd-bootstrap/delegate.mjs --resolve-model --from claude --role implement --orchestrator-model sonnet を実行し、標準出力の 1 行の先頭の名前を得る。(2) Agent ツールで subagent_type に (1) の名前（model は指定しない）で子を起動し「OK」と答えさせる。(3) Agent ツールで subagent_type に general-purpose を指定して子を起動し「OK」と答えさせる。(4) Agent ツールで subagent_type に cc-sdd-implement-sonnet を指定して子を起動し「OK」と答えさせる。(5) Agent ツールで subagent_type に cc-sdd-implement-opus を指定して子を起動し「OK」と答えさせる。それぞれの結果（拒否か通ったか、拒否の文言）を答えてください。`);
    show(c1.calls, claudeSpawn); console.log(`     観測: 子の記録=${JSON.stringify(c1.subs)}`);
    for (const [l, ok] of judgeCl1(c1)) check(l, ok);
    const c2 = claudeRun(rc, "opus", `${common} Agent ツールで subagent_type に cc-sdd-implement-haiku、model に sonnet を指定して子を起動し「OK」と答えさせてください。結果（拒否か通ったか、拒否の文言）を答えてください。`);
    show(c2.calls, claudeSpawn);
    for (const [l, ok] of judgeCl2(c2)) check(l, ok);
    // 設定の誤り（有効な JSON のまま subagents だけ不正）。次の入力は止まらず、子の起動だけが拒否される
    writeCfg(rc, (c) => { c.subagents = { ...CFG, maxModel: { claude: "fable" } }; });
    const cb = claudeRun(rc, "sonnet", brokenPrompt("claude"));
    show(cb.calls, claudeSpawn); console.log(`     観測: 答え=${JSON.stringify(cb.answer.slice(0, 120))}`);
    for (const [l, ok] of judgeBroken("claude", { ...cb, phrase: "PONG-BROKEN" })) check(l, ok);
    // kiro-gate と同時: 設定を有効に戻し、導入済みの状態で、未読の手順書の kiro-gate の理由と、読んだ後の通過
    writeCfg(rc, (c) => { c.subagents = CFG; });
    const cg = retryGate("claude", () => claudeRun(rc, "sonnet", gatePrompt("claude").replaceAll("__REPO__", rc)), () => claudeSubs(rc).length);
    show(cg.calls, claudeSpawn); console.log(`     観測: 答え=${JSON.stringify(cg.answer.slice(0, 160))}`);
    for (const [l, ok] of judgeGate("claude", cg)) check(l, ok);
    fs.rmSync(slugOf(rc), { recursive: true, force: true });
    }

    // ---- Codex ----
    if (!pt || pt === "codex") {
    const rx = place("px");
    const hx = (n) => path.join(base, `px-home-${n}`);
    const first2 = codexRun(rx, hx("first"), "gpt-6.1-sol", "PONG とだけ答えてください。");
    checkInstalled(rx, "codex", first2);
    const x1 = codexRun(rx, hx(1), "gpt-6.1-sol", `${commonX} 次を順に行ってください。(1) spawn_agent で agent_type に cc_sdd_implement、fork_turns に none を指定し、model と reasoning_effort は指定せずに子を起動し「OK」と答えさせる。(2) シェルで node .agent-hooks/cc-sdd-bootstrap/delegate.mjs --resolve-model --from codex --role implement --orchestrator-model gpt-6.1-sol を実行し、標準出力の 1 行（モデルと推論量）を得る。(3) spawn_agent で agent_type に cc_sdd_implement、fork_turns に none、(2) で得たモデルを model、推論量を reasoning_effort に明示して子を起動し、子に合言葉 CCSDD-RESOLVED を答えさせ、wait で待つ。`);
    show(x1.calls, codexSpawn); console.log(`     観測: 親の呼び出し=${JSON.stringify(x1.calls.map((c) => [c.name, c.text.slice(0, 80)]))}`); console.log(`     観測: --resolve-model の結果=${JSON.stringify(x1.cmds)} 子の記録=${JSON.stringify(x1.sessions.map((x) => x.ctxs))}`);
    for (const [l, ok] of judgeCx1({ ...x1, phrase: "CCSDD-RESOLVED" })) check(l, ok);
    const x2 = codexRun(rx, hx(2), "gpt-6.1-sol", `${commonX} 次を順に行ってください。(1) spawn_agent で agent_type に cc_sdd_implement、fork_turns に none、task_name に t_high、model に gpt-6.1-terra、reasoning_effort に high を指定して子を起動し、合言葉 CCSDD-HIGH を答えさせ、wait で待つ。(2) spawn_agent で agent_type に cc_sdd_implement、fork_turns に none、task_name に t_xhigh、model に gpt-6.1-terra、reasoning_effort に xhigh を指定して子を起動し「OK」と答えさせる。`);
    show(x2.calls, codexSpawn); console.log(`     観測: 子の記録=${JSON.stringify(x2.sessions.map((x) => x.ctxs))}`);
    for (const [l, ok] of judgeCx2({ ...x2, phrase: "CCSDD-HIGH" })) check(l, ok);
    const x3 = codexRun(rx, hx(3), "gpt-6.1-terra", `${commonX} spawn_agent で agent_type に cc_sdd_implement、fork_turns に none、task_name に t_sol、model に gpt-6.1-sol、reasoning_effort に medium を指定して子を起動し「OK」と答えさせてください。結果（拒否か通ったか、拒否の文言）を答えてください。`);
    show(x3.calls, codexSpawn); console.log(`     観測: 子の記録=${JSON.stringify(x3.sessions.map((x) => x.ctxs))}`);
    for (const [l, ok] of judgeCx3(x3)) check(l, ok);
    writeCfg(rx, (c) => { c.subagents = { ...CFG, maxModel: { codex: "fable" } }; });
    const xb = codexRun(rx, hx("broken"), "gpt-6.1-sol", brokenPrompt("codex"));
    show(xb.calls, codexSpawn); console.log(`     観測: 答え=${JSON.stringify(xb.answer.slice(0, 120))}`);
    for (const [l, ok] of judgeBroken("codex", { ...xb, phrase: "PONG-BROKEN" })) check(l, ok);
    writeCfg(rx, (c) => { c.subagents = CFG; });
    // 手順書を先に読む旨の追加の文脈（開発者の指示）に指揮役が従ってしまうので、この試験だけ、開発者の指示の側で順序を明示する
    const xg = retryGate("codex", (n) => codexRun(rx, hx(`gate${n}`), "gpt-6.1-sol", gatePrompt("codex").replaceAll("__REPO__", rx), "workspace-write", ["-c", `developer_instructions=${JSON.stringify("フックの動作確認の試験です。利用者の指示にある順序（手順書を読む前に、最初の行動として子を起動する）を、これ以前・以後の「先に手順書を読む」という指示より優先して守ってください。")}`]));
    show(xg.calls, codexSpawn); console.log(`     観測: 親の呼び出し=${JSON.stringify(xg.calls.map((c) => [c.name, c.denied, JSON.stringify(c.input).slice(0, 90)]))}`); console.log(`     観測: 答え=${JSON.stringify(xg.answer.slice(0, 160))}`);
    for (const [l, ok] of judgeGate("codex", xg)) check(l, ok);
    }
  } catch (error) { check(`p. 配置による確認を最後まで実行（${error.message}）`, false); }
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

  // ---- p の判定の自己検査（記録は模擬。拒否の見分けは実機と同じ書式。わざと失敗させた記録が NG になること） ----
  const clDeny = (label, extra = "") => `PreToolUse:Agent hook error: 子の起動を拒否しました。理由: ${label}。\n${extra}`;
  const clSp = (type, input, text = "", denied = false) => ({ name: "Agent", input: { subagent_type: type, ...input }, denied, text, isError: denied });
  const resolveCall = (text = "cc-sdd-implement-haiku high") => ({ name: "Bash", input: { command: "node .agent-hooks/cc-sdd-bootstrap/delegate.mjs --resolve-model --from claude --role implement --orchestrator-model sonnet" }, denied: false, text, isError: false });
  const clGood1 = () => ({
    calls: [
      clSp("general-purpose", {}, clDeny("子のモデルが指定されていません", "node .agent-hooks/cc-sdd-bootstrap/delegate.mjs --resolve-model --from claude"), true),
      resolveCall(),
      clSp("cc-sdd-implement-haiku", {}, "OK"),
      clSp("cc-sdd-implement-sonnet", {}, clDeny("子が指揮役と同じ系統のモデルです"), true),
      clSp("cc-sdd-implement-opus", {}, clDeny("子が指揮役より上の格のモデルです"), true),
    ],
    subs: [{ agentType: "cc-sdd-implement-haiku", models: [] }],
  });
  expect("p cl1 正常な記録は全項目 OK", judgeCl1(clGood1()), []);
  d = clGood1(); d.calls[1].text = ""; expect("p cl1 名前の解決の出力が空（以降の通過も成り立たない）", judgeCl1(d), [1, 2]);
  d = clGood1(); d.calls.splice(1, 1); d.calls.push(resolveCall()); expect("p cl1 解決が名前を使う起動より後", judgeCl1(d), [2]);
  d = clGood1(); d.calls[1].text = "cc-sdd-implement-haiku high\ncc-sdd-implement-opus high"; expect("p cl1 解決の出力が複数行", judgeCl1(d), [1, 2]);
  d = clGood1(); d.calls[1].text = "cc-sdd-implement-haiku turbo"; expect("p cl1 解決の推論量が無効", judgeCl1(d), [1, 2]);
  d = clGood1(); d.calls[1].isError = true; expect("p cl1 解決が失敗（エラー）", judgeCl1(d), [1, 2]);
  d = clGood1(); d.subs = []; expect("p cl1 通ったはずの子が起動していない", judgeCl1(d), [2]);
  d = clGood1(); d.subs.push({ agentType: "cc-sdd-implement-opus", models: [] }); expect("p cl1 拒否のはずの opus の子が動いた", judgeCl1(d), [5]);
  d = clGood1(); d.calls[0].text = clDeny("子の推論量が子のモデルの系統の上限より上です"); expect("p cl1 名前なしの拒否が別の理由", judgeCl1(d), [0]);
  d = clGood1(); d.calls[3] = clSp("cc-sdd-implement-sonnet", {}, "OK"); expect("p cl1 同じ系統の定義が通ってしまった", judgeCl1(d), [3]);
  d = clGood1(); d.calls[4].denied = false; expect("p cl1 上の格の拒否がフックの拒否でない（ツール側の失敗）", judgeCl1(d), [4]);
  const clEff = () => ({ calls: [clSp("cc-sdd-implement-haiku", { model: "sonnet" }, clDeny("子の推論量が子のモデルの系統の上限より上です", "子の推論量: high（上限: medium、系統: sonnet）"), true)] });
  expect("p cl2 正常な記録は全項目 OK", judgeCl2(clEff()), []);
  d = clEff(); d.calls[0].text = clDeny("子が指揮役と同じ系統のモデルです"); expect("p cl2 推論量の拒否が別の理由", judgeCl2(d), [0]);
  d = clEff(); d.calls[0].input = { subagent_type: "cc-sdd-implement-haiku" }; expect("p cl2 model の上書きがない起動（対象の起動が無い）", judgeCl2(d), [0]);
  const cxDeny = (label, extra = "") => `Tool call blocked by PreToolUse hook: 子の起動を拒否しました。理由: ${label}。\n${extra}`;
  const cxSp = (input, text = "", denied = false) => ({ name: "spawn_agent", input: { agent_type: "cc_sdd_implement", fork_turns: "none", ...input }, denied, text, isError: false });
  const cxOkSp = (task, model, effort, extra = {}) => cxSp({ task_name: task, model, reasoning_effort: effort, ...extra }, JSON.stringify({ task_name: `/root/${task}` }));
  const msg = (task, text) => ({ name: "@agent_message", input: { author: `/root/${task}` }, denied: false, text: JSON.stringify(text), isError: false });
  const wait = () => ({ name: "wait_agent", input: {}, denied: false, text: '{"message":"Wait completed."}', isError: false });
  const resolveX = { name: "exec", input: { input: "node .agent-hooks/cc-sdd-bootstrap/delegate.mjs --resolve-model --from codex" }, denied: false, text: "gpt-6.1-terra medium", isError: false };
  const cxGood1 = () => ({
    phrase: "P",
    calls: [
      cxSp({}, cxDeny("子のモデルが指定されていません", "node .agent-hooks/cc-sdd-bootstrap/delegate.mjs --resolve-model --from codex"), true),
      { ...resolveX },
      cxOkSp("t1", "gpt-6.1-terra", "medium"),
      wait(), msg("t1", "P"),
    ],
    cmds: [{ code: 0, out: "gpt-6.1-terra medium" }], sessions: [ROOT, kid("t1", ["gpt-6.1-terra/medium"], "P")],
  });
  expect("p cx1 正常な記録は全項目 OK", judgeCx1(cxGood1()), []);
  d = cxGood1(); d.calls[0] = cxSp({}, "ok"); expect("p cx1 model 省略の起動が通ってしまった", judgeCx1(d), [0]);
  d = cxGood1(); d.sessions = [ROOT, kid("t1", ["gpt-6.1-terra/high"], "P")]; expect("p cx1 子の記録の推論量が明示と違う", judgeCx1(d), [3]);
  d = cxGood1(); d.calls.splice(4, 1); expect("p cx1 子の応答が指揮役に届いていない", judgeCx1(d), [4]);
  d = cxGood1(); d.calls[2].input.fork_turns = "all"; expect("p cx1 fork_turns が none でない", judgeCx1(d), [2, 3, 4]);
  d = cxGood1(); d.calls[2].text = "error: spawn failed"; d.calls[4] = msg("other", "P"); d.calls.splice(3, 0, { ...wait() }); expect("p cx1 対象の起動が失敗・別の子の応答に合言葉・無関係な wait", judgeCx1(d), [2, 4]);
  d = cxGood1(); d.calls[4] = msg("other", "P"); expect("p cx1 別の子の応答だけに合言葉", judgeCx1(d), [4]);
  d = cxGood1(); d.calls.splice(3, 1); expect("p cx1 wait が無い", judgeCx1(d), [4]);
  d = cxGood1(); d.calls = [d.calls[0], d.calls[1], msg("t1", "P"), d.calls[2], wait()]; expect("p cx1 応答が起動より前", judgeCx1(d), [4]);
  d = cxGood1(); d.calls.splice(1, 1); expect("p cx1 解決の実行が起動より前に無い", judgeCx1(d), [2]);
  d = cxGood1(); d.cmds = [{ code: 0, out: "gpt-6.1-terra turbo" }]; expect("p cx1 解決の推論量が無効", judgeCx1(d), [1, 2, 3, 4]);
  const cxGood2 = () => ({
    phrase: "H",
    calls: [cxOkSp("t1", "gpt-6.1-terra", "high"), wait(), msg("t1", "H"),
      cxSp({ task_name: "t2", model: "gpt-6.1-terra", reasoning_effort: "xhigh" }, cxDeny("子の推論量が子のモデルの系統の上限より上です", "子の推論量: xhigh（上限: high、系統: terra）"), true)],
    sessions: [ROOT, kid("t1", ["gpt-6.1-terra/high"], "H")],
  });
  expect("p cx2 正常な記録は全項目 OK", judgeCx2(cxGood2()), []);
  d = cxGood2(); d.calls[3].denied = false; d.calls[3].text = "ok"; expect("p cx2 xhigh が通ってしまった", judgeCx2(d), [1]);
  d = cxGood2(); d.sessions.push(kid("t2", ["gpt-6.1-terra/xhigh"], "")); expect("p cx2 拒否のはずの xhigh の子が動いた", judgeCx2(d), [1]);
  d = cxGood2(); d.calls[0].denied = true; expect("p cx2 上限内の high が拒否された", judgeCx2(d), [0]);
  d = cxGood2(); d.calls[3].input.agent_type = "other_role"; expect("p cx2 xhigh の起動の定義が違う", judgeCx2(d), [1]);
  d = cxGood2(); d.calls[3].input.fork_turns = "all"; expect("p cx2 xhigh の起動の fork_turns が違う", judgeCx2(d), [1]);
  d = cxGood2(); d.calls[2] = msg("other", "H"); expect("p cx2 high の応答が別の子から", judgeCx2(d), [0]);
  d = cxGood2(); d.calls[0].text = "error"; expect("p cx2 high の起動の結果がエラー", judgeCx2(d), [0]);
  const cxGood3 = () => ({ calls: [cxSp({ task_name: "t_sol", model: "gpt-6.1-sol", reasoning_effort: "medium" }, cxDeny("子が指揮役より上の格のモデルです", "指揮役のモデル: gpt-6.1-terra"), true)], sessions: [ROOT] });
  expect("p cx3 正常な記録は全項目 OK", judgeCx3(cxGood3()), []);
  d = cxGood3(); d.sessions.push(kid("t_sol", ["gpt-6.1-sol/medium"], "")); expect("p cx3 拒否のはずの Sol の子が動いた", judgeCx3(d), [0]);
  d = cxGood3(); d.calls[0].text = cxDeny("子のモデルが指定されていません"); expect("p cx3 別の理由の拒否", judgeCx3(d), [0]);
  d = cxGood3(); d.calls[0].input.reasoning_effort = "xhigh"; expect("p cx3 推論量が xhigh（上の格だけの拒否の確認にならない）", judgeCx3(d), [0]);
  d = cxGood3(); d.calls[0].input.agent_type = "other_role"; expect("p cx3 定義が違う", judgeCx3(d), [0]);
  const BR = "subagents の設定に問題があるため、直るまで子を起動しません。\n問題の項目:\n- subagents.maxModel.claude: ...maxModel";
  const brGood = () => ({ ok: true, answer: "PONG-BROKEN", phrase: "PONG-BROKEN", calls: [clSp("cc-sdd-implement-haiku", {}, `PreToolUse:Agent hook error: ${BR}`, true)] });
  expect("p broken 正常な記録は全項目 OK", judgeBroken("claude", brGood()), []);
  d = brGood(); d.ok = false; d.answer = ""; expect("p broken 入力が止まった", judgeBroken("claude", d), [0]);
  d = brGood(); d.calls[0].text = clDeny("子のモデルが指定されていません"); expect("p broken 設定の誤りでなく役割表の拒否", judgeBroken("claude", d), [1]);
  d = brGood(); d.calls[0].denied = false; expect("p broken 子の起動が通ってしまった", judgeBroken("claude", d), [1]);
  const GATE = "PreToolUse:Agent hook error: 先に手順書 .claude/skills/kiro-spec-status/SKILL.md を読んでから、作業を進めてください。";
  const SK = "---\nname: kiro-spec-status\n---\n";
  const readCl = () => ({ name: "Read", input: { file_path: "/r/.claude/skills/kiro-spec-status/SKILL.md" }, denied: false, text: SK, isError: false });
  const gGood = () => ({ subsBefore: 1, subs: [{}, {}], calls: [clSp("cc-sdd-implement-haiku", {}, GATE, true), readCl(), clSp("cc-sdd-implement-haiku", {}, "OK")] });
  expect("p gate 正常な記録は全項目 OK", judgeGate("claude", gGood()), []);
  d = gGood(); d.calls[0].text = clDeny("子のモデルが指定されていません"); expect("p gate 未読の拒否が subagent-check の理由", judgeGate("claude", d), [0]);
  d = gGood(); d.calls[2].input = { subagent_type: "cc-sdd-implement-sonnet" }; expect("p gate 読んだ後の起動が別の引数", judgeGate("claude", d), [1]);
  d = gGood(); d.calls.splice(1, 1); expect("p gate 手順書を読んでいない", judgeGate("claude", d), [1]);
  d = gGood(); d.calls[2].denied = true; d.calls[2].isError = true; expect("p gate 読んだ後も拒否される", judgeGate("claude", d), [1]);
  d = gGood(); d.calls[1] = { name: "Bash", input: { command: "echo .claude/skills/kiro-spec-status/SKILL.md" }, denied: false, text: ".claude/skills/kiro-spec-status/SKILL.md", isError: false }; expect("p gate 手順書のパスを echo しただけ", judgeGate("claude", d), [1]);
  d = gGood(); d.calls[1].text = ""; expect("p gate 読み取りの結果に手順書の中身が無い", judgeGate("claude", d), [1]);
  d = gGood(); d.calls[1].isError = true; expect("p gate 読み取りが失敗", judgeGate("claude", d), [1]);
  d = gGood(); d.subs = [{}]; expect("p gate 2 回目の子が起動していない", judgeGate("claude", d), [1]);
  d = gGood(); d.calls.splice(1, 1); d.calls.push(readCl()); expect("p gate 手順書を読んだのが 2 回目の起動より後", judgeGate("claude", d), [1]);
  const cxGate = () => ({
    calls: [cxSp({ task_name: "ga", model: "gpt-6.1-terra", reasoning_effort: "medium" }, "Tool call blocked by PreToolUse hook: 先に手順書 .agents/skills/kiro-spec-status/SKILL.md を読んでから、作業を進めてください。", true),
      { name: "exec", input: { input: 'tools.exec_command({cmd:"cat /r/.agents/skills/kiro-spec-status/SKILL.md"})' }, denied: false, text: SK, isError: false },
      cxOkSp("gb", "gpt-6.1-terra", "medium"), wait(), msg("gb", "OK")],
    sessions: [ROOT, kid("gb", ["gpt-6.1-terra/medium"], "OK")],
  });
  expect("p gate(codex) 正常な記録は全項目 OK", judgeGate("codex", cxGate()), []);
  d = cxGate(); d.calls.splice(3, 2); expect("p gate(codex) 2 回目の応答が無い", judgeGate("codex", d), [1]);
  d = cxGate(); d.sessions = [ROOT]; expect("p gate(codex) 2 回目の子の記録が無い", judgeGate("codex", d), [1]);
  d = cxGate(); d.calls[2].text = "error"; expect("p gate(codex) 2 回目の起動の結果がエラー", judgeGate("codex", d), [1]);
  d = cxGate(); d.calls[1].input = { input: 'tools.exec_command({cmd:"echo .agents/skills/kiro-spec-status/SKILL.md"})' }; d.calls[1].text = ".agents/skills/kiro-spec-status/SKILL.md"; expect("p gate(codex) echo だけ", judgeGate("codex", d), [1]);
  // やり直しの条件: 本当に読んだときだけ
  // やり直しの条件の自己検査: 本当に手順書を読んだ後に最初の起動をしたときだけやり直す（拒否された echo だけなら、やり直さない）
  const expectBool = (label, got, want) => { const as = got === want; console.log(`${as ? "期待どおり" : "想定外"}: ${label} → ${got}`); if (!as) fail++; };
  expectBool("retry 起動より前に本当に読んだ", readBeforeSpawn("claude", [readCl(), clSp("cc-sdd-implement-haiku", {}, "OK")]), true);
  expectBool("retry 起動の前に拒否された echo だけ", readBeforeSpawn("claude", [{ name: "Bash", input: { command: "echo .claude/skills/kiro-spec-status/SKILL.md" }, denied: true, text: "blocked", isError: true }, clSp("cc-sdd-implement-haiku", {}, GATE, true)]), false);
  expectBool("retry 起動の前に読みが失敗", readBeforeSpawn("claude", [{ ...readCl(), isError: true, text: "error" }, clSp("cc-sdd-implement-haiku", {}, GATE, true)]), false);
  expectBool("retry 先に起動し、その後に読んだ", readBeforeSpawn("claude", [clSp("cc-sdd-implement-haiku", {}, GATE, true), readCl()]), false);
}

console.log(`結果: OK ${pass} 件、NG ${fail} 件`);
if (!process.env.POC_KEEP) fs.rmSync(base, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
