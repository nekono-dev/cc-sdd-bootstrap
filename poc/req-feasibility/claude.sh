#!/usr/bin/env bash
# PoC: Claude Code を指揮役にしたときの、要件の前提を実際の claude -p で確かめる。
#
# 対応する要件
#   session-install 1.3（起動前に導入すれば最初のセッションからスキルが載る）、2.1〜2.3（最初の入力時のフックで導入し、手順書を直接読ませる）
#   subagent-delegation 3.1〜3.6（子の起動前にモデルの未指定を拒否できる、指揮役のモデルをフックで得られるか）
# 確かめること
#   a. セッション開始時のフックで導入すると、そのセッションのスキル一覧（起動時の slash_commands）に kiro-* が載らない（対照）
#   b. 起動前に導入しておくと、最初のセッションのスキル一覧に kiro-* が載る
#   c. UserPromptSubmit のフックで cc-sdd を実際に導入し、追加の文脈で手順書を直接読むよう伝えると、モデルが SKILL.md を Read する
#   d. Agent の PreToolUse で tool_input の model を見て、未指定の起動を拒否でき、理由が親に届く。明示した起動は通る
#   e. フックの入力（SessionStart・UserPromptSubmit・PreToolUse）に指揮役のモデルが入るか（観測のみ）
#
# 使い方: poc/req-feasibility/claude.sh   （POC_MODEL で指揮役のモデルを変えられる。既定 haiku。CC_SDD_VERSION 既定 3.1.0）
# 必要なもの: claude（認証済み）・node・npx・git。一時ディレクトリで試し、このリポジトリは変えない。
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ver="${CC_SDD_VERSION:-3.1.0}"; model="${POC_MODEL:-haiku}"
work="${POC_KEEP:-$(mktemp -d)}"; [ -n "${POC_KEEP:-}" ] || trap 'rm -rf "$work"' EXIT; mkdir -p "$work"
pass=0; fail=0
check() { local l="$1"; shift; if "$@"; then echo "OK   $l"; pass=$((pass+1)); else echo "NG   $l"; fail=$((fail+1)); fi; }
note() { echo "     $*"; }
manifest="$work/claude.json"
cat > "$manifest" <<'J'
{"version":1,"artifacts":[
 {"id":"skills","source":{"type":"templateDir","fromDir":"templates/agents/{{AGENT}}/skills","toDir":"{{AGENT_COMMANDS_DIR}}"}},
 {"id":"doc_main","source":{"type":"templateFile","from":"templates/agents/{{AGENT}}/docs/CLAUDE.md","toDir":"{{KIRO_DIR}}/settings","rename":"cc-sdd-guide.md"}},
 {"id":"settings_templates","source":{"type":"templateDir","fromDir":"templates/shared/settings/templates","toDir":"{{KIRO_DIR}}/settings/templates"}}]}
J
# 試験用のフック。入力を記録し、イベントごとに導入・文脈の追加・拒否を行う。
cat > "$work/hook.mjs" <<'JS'
import fs from "node:fs"; import path from "node:path"; import { spawnSync } from "node:child_process"
const event = process.argv[2]; const root = process.env.CLAUDE_PROJECT_DIR
const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}")
const log = o => fs.appendFileSync(path.join(root, "log.jsonl"), JSON.stringify(o) + "\n")
log({ event, keys: Object.keys(input).sort(), model: input.model ?? null, tool_name: input.tool_name ?? null, tool_input: input.tool_input ?? null })
const emit = o => process.stdout.write(JSON.stringify(o))
const install = () => spawnSync("npx", ["--yes", `cc-sdd@${process.env.POC_VER}`, "--yes", "--overwrite", "force", "--manifest", process.env.POC_MANIFEST, "--claude-skills", "--lang", "ja"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] }).status === 0
if (event === "session-start" && process.env.POC_MODE === "session-start") install()
if (event === "user-prompt-submit" && process.env.POC_MODE === "first-prompt") {
  const ok = install(); log({ event: "installed", ok })
  if (ok) emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "cc-sdd をこのセッションで導入しました。スキル一覧には載りません。依頼に対応する手順書 .claude/skills/kiro-spec-status/SKILL.md を Read で直接読み、その手順に従ってください。" } })
  else emit({ decision: "block", reason: "cc-sdd の導入に失敗しました" })
}
if (event === "pre-tool-use") {
  // 指揮役のモデルを、会話の記録（transcript）の最後のアシスタントの応答から読む（観測）
  let m = null; try { for (const line of fs.readFileSync(input.transcript_path, "utf8").split("\n")) { try { const e = JSON.parse(line); if (e.type === "assistant" && e.message?.model) m = e.message.model } catch {} } } catch {}
  log({ event: "transcript-model", tool_name: input.tool_name, model: m })
}
if (event === "pre-tool-use" && input.tool_name === "Agent") {
  if (!input.tool_input?.model) emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "CCSDD-POC: サブエージェントは model を明示して起動してください（指揮役と別のモデル）。" } })
}
JS
make_repo() { # dir mode
  mkdir -p "$1/.claude"; git -C "$1" init -q; cp "$work/hook.mjs" "$1/hook.mjs"
  node -e '
const ev={SessionStart:"session-start",UserPromptSubmit:"user-prompt-submit",PreToolUse:"pre-tool-use"};const hooks={};
for(const [k,v] of Object.entries(ev)) hooks[k]=[{hooks:[{type:"command",command:`node "$CLAUDE_PROJECT_DIR/hook.mjs" ${v}`,timeout:600}]}];
require("fs").writeFileSync(process.argv[1],JSON.stringify({hooks},null,1))' "$1/.claude/settings.json"
}
run() { # dir mode prompt
  (cd "$1" && POC_MODE="$2" POC_VER="$ver" POC_MANIFEST="$manifest" timeout 600 claude -p "$3" --model "$model" --output-format stream-json --verbose --permission-mode bypassPermissions > out.jsonl 2> err.log)
}
init_has_kiro() { node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse);const i=l.find(e=>e.type==="system"&&e.subtype==="init");const all=[...(i?.slash_commands||[]),...(i?.skills||[])];process.exit(all.some(s=>String(s).includes("kiro-spec-status"))?0:1)' "$1/out.jsonl"; }
tool_uses() { node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse);for(const e of l) if(e.type==="assistant") for(const c of e.message.content||[]) if(c.type==="tool_use") console.log(c.name, JSON.stringify(c.input).slice(0,160))' "$1/out.jsonl"; }

echo "== a. セッション開始時のフックで導入（対照）"
d="$work/a"; make_repo "$d"; run "$d" session-start "1 行で「了解」とだけ答えてください。"
check "a. 導入は終わっている（.claude/skills/kiro-spec-status がある）" test -f "$d/.claude/skills/kiro-spec-status/SKILL.md"
if init_has_kiro "$d"; then check "a. そのセッションの起動時のスキル一覧に kiro-* が載らない" false; else check "a. そのセッションの起動時のスキル一覧に kiro-* が載らない" true; fi

echo "== b. 起動前に導入"
d="$work/b"; make_repo "$d"; (cd "$d" && npx --yes "cc-sdd@$ver" --yes --overwrite force --manifest "$manifest" --claude-skills --lang ja >/dev/null 2>&1)
run "$d" none "1 行で「了解」とだけ答えてください。"
check "b. 最初のセッションの起動時のスキル一覧に kiro-* が載る" init_has_kiro "$d"

echo "== c. 最初の入力時のフックで導入"
d="$work/c"; make_repo "$d"; run "$d" first-prompt "このリポジトリの spec の進み具合を確認してください。"
check "c. フックで導入できた" grep -q '"installed","ok":true' "$d/log.jsonl"
tool_uses "$d" > "$d/tools.txt"; note "使われたツール: $(head -5 "$d/tools.txt" | cut -c1-120 | tr '\n' '|')"
check "c. モデルが手順書 kiro-spec-status/SKILL.md を Read した" grep -q 'Read .*kiro-spec-status/SKILL.md' "$d/tools.txt"

echo "== d. 子の起動前のモデルの確認"
d="$work/d"; make_repo "$d"
run "$d" none "Agent ツールで general-purpose のサブエージェントを、model を指定せずに 1 回だけ起動し、「PONG と答えて」と頼んでください。拒否されたら、拒否の理由に従って model に sonnet を指定してもう 1 回だけ起動してください。最後に結果を 1 行で答えてください。"
tool_uses "$d" > "$d/tools.txt"; note "Agent の呼び出し: $(grep '^Agent' "$d/tools.txt" | cut -c1-140 | tr '\n' '|')"
check "d. model なしの Agent の起動を PreToolUse で観測した" node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse);process.exit(l.some(e=>e.event==="pre-tool-use"&&e.tool_name==="Agent"&&!e.tool_input?.model)?0:1)' "$d/log.jsonl"
check "d. 拒否の理由が親に届いた（tool_result に CCSDD-POC）" grep -q 'CCSDD-POC' "$d/out.jsonl"
check "d. model を明示した Agent の起動は通った（PreToolUse の tool_input.model あり）" node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse);process.exit(l.some(e=>e.event==="pre-tool-use"&&e.tool_name==="Agent"&&e.tool_input?.model)?0:1)' "$d/log.jsonl"

echo "== e. フックの入力に指揮役のモデルが入るか（観測）"
for x in a c d; do node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse);const seen={};for(const e of l) if(e.keys&&!seen[e.event+e.tool_name]){seen[e.event+e.tool_name]=1;console.log("     "+e.event+(e.tool_name?"("+e.tool_name+")":"")+": model="+JSON.stringify(e.model)+" keys="+e.keys.join(","))}' "$work/$x/log.jsonl"; done | sort -u
for x in c d; do grep -h transcript-model "$work/$x/log.jsonl" | head -1 | sed 's/^/     会話の記録から: /'; done
check "e. ツール起動前に、会話の記録から指揮役のモデルを読める" grep -q '"transcript-model","tool_name":"Agent","model":"claude' "$work/d/log.jsonl"
echo "結果: OK $pass 件、NG $fail 件"; [ "$fail" -eq 0 ]
