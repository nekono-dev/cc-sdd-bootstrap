#!/usr/bin/env bash
# PoC: Codex を指揮役にしたときの、要件の前提を実際の codex exec で確かめる。
#
# 対応する要件
#   session-install 1.3・2.1〜2.3（起動前の導入でスキルが載る、最初の入力時のフックで導入して手順書を読ませる、失敗で止める）
#   kiro-gate 1〜3（/kiro-* の入力の形、手順書を読むまでの拒否、読んだことの観測、終了を 1 回だけ止める）
#   subagent-delegation 3（子の起動 spawn_agent の前にモデルの未指定を拒否）、4.1（Codex から claude -p を子として起動）
#   installer-core 4（Codex のフックの登録）
# 確かめること
#   a. 開始時のフック（SessionStart）が呼ばれるか。各フックの入力のキーと、指揮役のモデルが入るか（観測）
#   b. 起動前に導入すると、最初のセッションで `$kiro-*` と明示したスキルの手順書がモデルに渡る
#      （cc-sdd の Codex 向けスキルの多くは allow_implicit_invocation: false で、モデルの一覧には出ない）
#   b2. 開始時のフック（SessionStart）で導入したスキルが、同じセッションで b と同じく使えるか
#   c. UserPromptSubmit のフックで cc-sdd を導入し、追加の文脈で手順書を読ませられる。失敗時に入力を止められる
#   d. `/kiro-*`・`$kiro-*` の入力が UserPromptSubmit の prompt にどの形で入るか。PreToolUse で手順書の読み取り以外のシェルを拒否でき、
#      読み取りをシェルのコマンドで観測できるか
#   e. Stop のフックで終了を 1 回止めると、2 回目は stop_hook_active が真になって終われるか
#   f. spawn_agent の PreToolUse で tool_input のモデルを見て、未指定の起動を拒否できるか
#   g. Codex の中から claude -p を子として起動できるか（書き込み可のサンドボックス、通信の許可の有無）
#
# 使い方: poc/req-feasibility/codex.sh [a b c ...]   （引数で一部だけ実行。POC_KEEP=<dir> で作業領域を残す）
# 必要なもの: codex（~/.codex/auth.json で認証済み）・claude（g のみ）・node・npx・git。
# 一時の CODEX_HOME を使い、認証ファイルは一時コピーを終了時に消す。ホストの ~/.codex とこのリポジトリは変えない。
# フックの信頼の承認は --dangerously-bypass-hook-trust で省く（検証専用）。
set -uo pipefail
ver="${CC_SDD_VERSION:-3.1.0}"
work="${POC_KEEP:-$(mktemp -d)}"; mkdir -p "$work"
# 認証ファイルの一時コピーは、途中で止まっても必ず消す（作業領域を残す指定のときも）
cleanup() { rm -f "${work:?}"/home/*/auth.json; [ -n "${POC_KEEP:-}" ] || rm -rf "${work:?}"; }
trap cleanup EXIT INT TERM
only=" ${*:-a b c d e f g} "
pass=0; fail=0
check() { local l="$1"; shift; if "$@"; then echo "OK   $l"; pass=$((pass+1)); else echo "NG   $l"; fail=$((fail+1)); fi; }
note() { echo "     $*"; }
cat > "$work/codex.json" <<'J'
{"version":1,"artifacts":[
 {"id":"skills","source":{"type":"templateDir","fromDir":"templates/agents/{{AGENT}}/skills","toDir":"{{AGENT_COMMANDS_DIR}}"}},
 {"id":"doc_main","source":{"type":"templateFile","from":"templates/agents/{{AGENT}}/docs/AGENTS.md","toDir":"{{KIRO_DIR}}/settings","rename":"cc-sdd-guide-codex.md"}},
 {"id":"settings_templates","source":{"type":"templateDir","fromDir":"templates/shared/settings/templates","toDir":"{{KIRO_DIR}}/settings/templates"}}]}
J
cat > "$work/hook.mjs" <<'JS'
import fs from "node:fs"; import path from "node:path"; import { spawnSync } from "node:child_process"
const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}")
const ev = input.hook_event_name; const root = process.env.POC_REPO; const mode = process.env.POC_MODE
const log = o => fs.appendFileSync(path.join(process.env.POC_DIR, "log.jsonl"), JSON.stringify(o) + "\n")
log({ event: ev, keys: Object.keys(input).sort(), model: input.model ?? null, prompt: input.prompt ?? null, tool_name: input.tool_name ?? null, tool_input: input.tool_input ?? null, stop_hook_active: input.stop_hook_active ?? null })
const emit = o => process.stdout.write(JSON.stringify(o))
const state = path.join(process.env.POC_DIR, "state.json")
const rd = () => { try { return JSON.parse(fs.readFileSync(state, "utf8")) } catch { return null } }
const cmd = () => { const t = input.tool_input; return typeof t === "string" ? t : JSON.stringify(t ?? "") }
const installCodex = () => spawnSync("npx", ["--yes", `cc-sdd@${process.env.POC_VER}`, "--yes", "--overwrite", "force", "--manifest", process.env.POC_MANIFEST, "--codex-skills", "--lang", "ja"], { cwd: root, stdio: "ignore" }).status === 0
if (ev === "SessionStart" && mode === "session-start") log({ event: "installed", ok: installCodex() })
if (ev === "UserPromptSubmit" && mode === "first-prompt") {
  const ok = process.env.POC_FAIL !== "1" && spawnSync("npx", ["--yes", `cc-sdd@${process.env.POC_VER}`, "--yes", "--overwrite", "force", "--manifest", process.env.POC_MANIFEST, "--codex-skills", "--lang", "ja"], { cwd: root, stdio: "ignore" }).status === 0
  log({ event: "installed", ok })
  if (ok) emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "cc-sdd をこのセッションで導入しました。依頼に対応する手順書 .agents/skills/kiro-spec-status/SKILL.md を最初に読み、その手順に従ってください。" } })
  else emit({ decision: "block", reason: "CCSDD-POC: cc-sdd の導入に失敗しました" })
}
if (ev === "UserPromptSubmit" && mode === "gate") {
  const m = /^\s*[\/$](kiro-[a-z0-9-]+)/.exec(String(input.prompt ?? ""))
  if (m) fs.writeFileSync(state, JSON.stringify({ skill: m[1], read: false }))
}
if (ev === "PreToolUse" && mode === "gate") {
  const s = rd()
  if (s && !s.read) {
    if (cmd().includes(`skills/${s.skill}/SKILL.md`)) { fs.writeFileSync(state, JSON.stringify({ ...s, read: true })); log({ event: "marked-read" }) }
    else { log({ event: "denied", tool_name: input.tool_name }); emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `CCSDD-POC: 先に手順書 .agents/skills/${s.skill}/SKILL.md を読んでください` } }) }
  }
}
if (ev === "Stop" && mode === "stop" && input.stop_hook_active !== true) emit({ decision: "block", reason: "CCSDD-POC: 終える前に「再開しました」と 1 行だけ答えてください" })
if (ev === "PreToolUse" && mode === "spawn" && /spawn_agent/.test(String(input.tool_name))) {
  const t = input.tool_input ?? {}
  if (!t.model) emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "CCSDD-POC: spawn_agent は model を明示してください" } })
}
JS
make_repo() { # dir
  local repo="$1/repo"; mkdir -p "$repo/.codex"; git -C "$repo" init -q
  node -e '
const cmd=`node ${process.argv[2]}`;const h=[{hooks:[{type:"command",command:cmd,timeout:600}]}];
const hooks={SessionStart:h,UserPromptSubmit:h,PreToolUse:[{matcher:".*",hooks:h[0].hooks}],PostToolUse:[{matcher:".*",hooks:h[0].hooks}],Stop:h};
require("fs").writeFileSync(process.argv[1],JSON.stringify({hooks},null,1))' "$repo/.codex/hooks.json" "$work/hook.mjs"
}
preinstall() { (cd "$1/repo" && npx --yes "cc-sdd@$ver" --yes --overwrite force --manifest "$work/codex.json" --codex-skills --lang ja >/dev/null 2>&1); }
run() { # dir mode sandbox prompt [extra codex args...]
  local d="$1" mode="$2" sb="$3" prompt="$4"; shift 4
  local home="$work/home/$(basename "$d")"; mkdir -p "$home"; cp ~/.codex/auth.json "$home/auth.json"; chmod 600 "$home/auth.json"
  printf '[projects.%s]\ntrust_level = "trusted"\n' "$(node -p 'JSON.stringify(process.argv[1])' "$d/repo")" > "$home/config.toml"
  (cd "$d/repo" && env -u CODEX_SESSION_ID -u CODEX_THREAD_ID -u CODEX_TOOL_CALL_ID CODEX_HOME="$home" POC_DIR="$d" POC_REPO="$d/repo" POC_MODE="$mode" POC_VER="$ver" POC_MANIFEST="$work/codex.json" \
    timeout 600 codex -a never exec --json --skip-git-repo-check --dangerously-bypass-hook-trust -s "$sb" --model gpt-6-luna -c 'model_reasoning_effort="low"' "$@" --cd "$d/repo" "$prompt" < /dev/null > "$d/out.jsonl" 2> "$d/err.log")
  rm -f "$home/auth.json"
}
# Codex の JSON の出力から、エージェントの応答・実行したコマンド・コマンドの出力を取り出す
msgs() { node -e 'for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")){try{const e=JSON.parse(l);if(e.type==="item.completed"&&e.item?.type==="agent_message")console.log(e.item.text)}catch{}}' "$1/out.jsonl"; }
cmds() { node -e 'for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")){try{const e=JSON.parse(l);if(e.type==="item.completed"&&e.item?.type==="command_execution")console.log(JSON.stringify(e.item.command).slice(0,150), "→", e.item.status)}catch{}}' "$1/out.jsonl"; }
cmd_out() { node -e 'for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")){try{const e=JSON.parse(l);if(e.item?.type==="command_execution")console.log(e.item.aggregated_output)}catch{}}' "$1/out.jsonl"; }
events() { node -e 'const seen={};for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean)){const e=JSON.parse(l);const k=e.event+(e.tool_name||"");if(e.keys&&!seen[k]){seen[k]=1;console.log("     "+e.event+(e.tool_name?"("+e.tool_name+")":"")+": model="+JSON.stringify(e.model)+" keys="+e.keys.join(","))}}' "$1/log.jsonl" 2>/dev/null; }
has_event() { grep -q "\"event\":\"$2\"" "$1/log.jsonl" 2>/dev/null; }
msgs_contain() { msgs "$1" | grep -q "$2"; }
no_msgs() { [ -z "$(msgs "$1")" ]; }

if [[ $only == *" a "* || $only == *" b "* ]]; then
  echo "== a・b. 起動前に導入した最初のセッション"
  d="$work/b"; make_repo "$d"; preinstall "$d"
  ask='$kiro-spec-status ツールを使わずに答えてください。このスキルの手順書の本文にある最初の見出し（# で始まる行）を、そのまま 1 行で答えてください。手順書の本文が渡されていなければ「不明」とだけ答えてください。'
  run "$d" observe read-only "$ask"
  check "a. 開始時のフック（SessionStart）が呼ばれる" has_event "$d" SessionStart
  events "$d"
  note "応答: $(msgs "$d" | tr '\n' ' ' | cut -c1-200)"
  check "b. 起動前の導入で、明示したスキルの手順書がモデルに渡る" msgs_contain "$d" "Specification Status"
  echo "== b2. 開始時のフックで導入したセッション"
  d="$work/b2"; make_repo "$d"
  run "$d" session-start read-only "$ask"
  check "b2. 開始時のフックで導入できた" grep -q '"installed","ok":true' "$d/log.jsonl"
  note "応答: $(msgs "$d" | tr '\n' ' ' | cut -c1-200)"
  if msgs_contain "$d" "Specification Status"; then note "→ 同じセッションで使えた"; else note "→ 同じセッションでは使えない"; fi
fi
if [[ $only == *" c "* ]]; then
  echo "== c. 最初の入力時のフックで導入"
  d="$work/c"; make_repo "$d"
  run "$d" first-prompt read-only "このリポジトリの spec の進み具合を確認してください。"
  check "c. フックで導入できた" grep -q '"installed","ok":true' "$d/log.jsonl"
  cmds "$d" > "$d/cmds.txt"; note "コマンド: $(head -4 "$d/cmds.txt" | tr '\n' '|' | cut -c1-300)"
  check "c. 追加の文脈に従い、手順書 kiro-spec-status/SKILL.md を読んだ" grep -q 'kiro-spec-status/SKILL.md' "$d/cmds.txt"
  d="$work/c2"; make_repo "$d"
  POC_FAIL=1 run "$d" first-prompt read-only "こんにちは。1 行で答えてください。"
  note "停止時の codex の出力: $(tail -c 300 "$d/err.log" | tr '\n' ' ')"
  check "c. 導入の失敗で入力を止められる（モデルの応答が無い）" no_msgs "$d"
fi
if [[ $only == *" d "* ]]; then
  for form in '/kiro-spec-status' '$kiro-spec-status'; do
    echo "== d. 手順書を読むまでの拒否（入力: $form）"
    d="$work/d$( [ "$form" = '/kiro-spec-status' ] && echo 1 || echo 2 )"; make_repo "$d"; preinstall "$d"
    run "$d" gate read-only "$form このリポジトリの spec の進み具合を確認してください。"
    note "UserPromptSubmit の prompt: $(grep -m1 '"event":"UserPromptSubmit"' "$d/log.jsonl" | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).prompt).slice(0,120))')"
    cmds "$d" > "$d/cmds.txt"; note "コマンド: $(head -5 "$d/cmds.txt" | tr '\n' '|' | cut -c1-400)"
    check "d. ($form) 入力の先頭からスキル名を検出できた" test -f "$d/state.json"
    check "d. ($form) 手順書の読み取りをシェルのコマンドで観測できた" has_event "$d" marked-read
    note "拒否の回数: $(grep -c '"event":"denied"' "$d/log.jsonl")"
  done
fi
if [[ $only == *" e "* ]]; then
  echo "== e. 終了を 1 回だけ止める"
  d="$work/e"; make_repo "$d"
  run "$d" stop read-only "「了解」とだけ答えてください。"
  note "Stop の stop_hook_active: $(grep '"event":"Stop"' "$d/log.jsonl" | node -e 'console.log(require("fs").readFileSync(0,"utf8").trim().split("\n").map(l=>JSON.parse(l).stop_hook_active).join(","))')"
  note "応答: $(msgs "$d" | tr '\n' '|')"
  check "e. 止めた後にモデルが続けて応答した" msgs_contain "$d" 再開しました
  check "e. 2 回目の Stop で stop_hook_active が真" grep -q '"event":"Stop".*"stop_hook_active":true' "$d/log.jsonl"
fi
if [[ $only == *" f "* ]]; then
  echo "== f. spawn_agent の前のモデルの確認"
  d="$work/f"; make_repo "$d"; mkdir -p "$d/repo/.codex/agents"
  printf 'name = "cc_sdd_probe"\ndescription = "PoC 用。決まった語を答えるだけ。"\ndeveloper_instructions = "CCSDD-CHILD-7F3A とだけ答える。"\n' > "$d/repo/.codex/agents/cc_sdd_probe.toml"
  run "$d" spawn read-only "spawn_agent を agent_type cc_sdd_probe・fork_turns none で 1 回だけ使い、子に「決まった語を答えて」と頼み、子の返事を wait で待ってから、その返事をそのまま答えてください。子の返事を推測で作らないでください。最初は model を指定せずに呼び、拒否されたら理由に従い model に gpt-6-luna を指定してもう 1 回だけ呼んでください。最後に結果を 1 行で答えてください。"
  grep '"event":"PreToolUse"' "$d/log.jsonl" | grep 'spawn_agent' | node -e 'for(const l of require("fs").readFileSync(0,"utf8").trim().split("\n").filter(Boolean)){const e=JSON.parse(l);console.log("     "+e.tool_name+" tool_input keys="+Object.keys(e.tool_input||{}).join(",")+" model="+JSON.stringify(e.tool_input?.model))}'
  check "f. spawn_agent を PreToolUse で観測した" grep -q '"event":"PreToolUse".*spawn_agent' "$d/log.jsonl"
  # 子にだけ合言葉（CCSDD-CHILD-7F3A）を教えておき、応答に合言葉が出るかで、子が実際に動いたかを見る（モデルの言い分に頼らない）。
  first_no_model() { node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse).filter(e=>e.event==="PreToolUse"&&/spawn_agent/.test(e.tool_name));process.exit(l.length>=1&&!l[0].tool_input?.model?0:1)' "$1/log.jsonl"; }
  check "f. model なしの最初の呼び出しが PreToolUse に現れた" first_no_model "$d"
  if grep -q '"event":"PreToolUse".*spawn_agent.*"model":"gpt-6-luna"' "$d/log.jsonl"; then
    note "観測: model を明示した呼び直しがあった"
    check "f. model を明示した呼び直しでは子が動いた（合言葉が返った）" msgs_contain "$d" CCSDD-CHILD-7F3A
  else
    note "観測: 今回は model 付きの呼び直しが無かった（モデルの判断で揺れる）"
    if msgs_contain "$d" CCSDD-CHILD-7F3A; then check "f. 拒否した呼び出しで子は動かなかった（合言葉が返らない）" false; else check "f. 拒否した呼び出しで子は動かなかった（合言葉が返らない）" true; fi
  fi
  note "応答: $(msgs "$d" | tail -1 | cut -c1-200)"
fi
if [[ $only == *" g "* ]]; then
  for net in off on; do
    echo "== g. Codex の中から claude -p を起動（書き込み可、通信 $net）"
    d="$work/g-$net"; make_repo "$d"
    extra=(); [ "$net" = on ] && extra=(-c 'sandbox_workspace_write.network_access=true')
    run "$d" observe workspace-write "シェルで次のコマンドを 1 回だけ実行し、その出力をそのまま 1 行で答えてください: claude -p --model haiku 'PONG とだけ答えてください'" "${extra[@]}"
    cmds "$d" > "$d/cmds.txt"; note "コマンド: $(cut -c1-200 "$d/cmds.txt" | tr '\n' '|')"
    note "出力: $(cmd_out "$d" | tr '\n' ' ' | cut -c1-200)"
    if [ "$net" = on ]; then check "g. (通信あり) claude -p が PONG を返した" bash -c "$(declare -f cmd_out); cmd_out '$d' | grep -q PONG"
    else check "g. (通信なし・対照) claude -p は PONG を返せない（通信の許可が要る）" bash -c "$(declare -f cmd_out msgs); ! { cmd_out '$d'; msgs '$d'; } | grep -q PONG"; fi
  done
fi
echo "結果: OK $pass 件、NG $fail 件"; [ "$fail" -eq 0 ]
