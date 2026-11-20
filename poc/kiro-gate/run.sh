#!/usr/bin/env bash
# PoC: kiro-gate の設計の前提を、実際の Claude Code（claude -p）で確かめる。
#
# 確かめること
#   a. UserPromptSubmit の入力の prompt に、/kiro-* がどの形で入るか
#      （スキルが無い／一覧に載る／disable-model-invocation で一覧に載らない、の 3 通り）。そもそもフックが動くか
#   b. PreToolUse の deny が Bash を実際に止めるか。手順書の Read と ToolSearch は通せるか。PostToolUse で Read を記録できるか
#   c. Stop のフックで終了を止めた後、2 回目の入力の stop_hook_active が真になり、終了できるか
#
# 使い方: poc/kiro-gate/run.sh   （POC_MODEL でモデルを変えられる。既定は haiku）
# 必要なもの: claude（認証済み）、node、git。一時ディレクトリで試し、このリポジトリは変えない。
set -uo pipefail

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
model="${POC_MODEL:-haiku}"
pass=0; fail=0
check() { local label="$1"; shift; if "$@"; then echo "OK   $label"; pass=$((pass + 1)); else echo "NG   $label"; fail=$((fail + 1)); fi; }
note() { echo "     $*"; }

# 試験用のフック。入力を記録し、手順書の未読の間は Read（手順書）と ToolSearch 以外を deny する。
write_hook() {
  cat > "$1/hook.mjs" << 'JS'
import fs from "node:fs"
import path from "node:path"
const event = process.argv[2]
const root = process.env.CLAUDE_PROJECT_DIR
const raw = fs.readFileSync(0, "utf8")
const input = raw.trim() ? JSON.parse(raw) : {}
fs.appendFileSync(path.join(root, "log.jsonl"), JSON.stringify({ event, input }) + "\n")
const stateFile = path.join(root, "state.json")
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")) } catch { return null } }
const emit = o => process.stdout.write(JSON.stringify(o))
if (event === "user-prompt-submit") {
  const m = /^\s*\/(kiro-[a-z0-9-]+)/.exec(String(input.prompt ?? ""))
  if (m) fs.writeFileSync(stateFile, JSON.stringify({ required: path.join(root, ".claude/skills", m[1], "SKILL.md"), read: false }))
}
if (event === "pre-tool-use") {
  const s = readState()
  if (s && !s.read) {
    const target = path.resolve(input.cwd ?? root, String(input.tool_input?.file_path ?? ""))
    const ok = input.tool_name === "ToolSearch" || (input.tool_name === "Read" && target === s.required)
    if (!ok) fs.appendFileSync(path.join(root, "log.jsonl"), JSON.stringify({ event: "denied", input: { tool_name: input.tool_name } }) + "\n")
    if (!ok) emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `先に手順書を Read してください: ${s.required}` } })
  }
}
if (event === "post-tool-use") {
  const s = readState()
  const target = path.resolve(input.cwd ?? root, String(input.tool_input?.file_path ?? ""))
  if (s && input.tool_name === "Read" && target === s.required) fs.writeFileSync(stateFile, JSON.stringify({ ...s, read: true }))
}
if (event === "stop") {
  const s = readState()
  const always = process.env.POC_STOP_ALWAYS === "1" && input.stop_hook_active !== true
  if ((s && !s.read && input.stop_hook_active !== true) || always) emit({ decision: "block", reason: "手順書を読んでから終えてください（PoC）" })
}
JS
}

make_repo() { # dir
  local dir="$1"
  mkdir -p "$dir/.claude/skills/kiro-listed" "$dir/.claude/skills/kiro-hidden"
  cat > "$dir/.claude/skills/kiro-listed/SKILL.md" << 'MD'
---
name: kiro-listed
description: PoC 用の一覧に載るスキル。
---
この手順では、LISTED-DONE とだけ答えてください。
MD
  cat > "$dir/.claude/skills/kiro-hidden/SKILL.md" << 'MD'
---
name: kiro-hidden
description: PoC 用の一覧に載らないスキル。
disable-model-invocation: true
---
この手順では、HIDDEN-DONE とだけ答えてください。
MD
  write_hook "$dir"
  local cmd='node \"$CLAUDE_PROJECT_DIR/hook.mjs\"'
  cat > "$dir/.claude/settings.json" << JSON
{ "hooks": {
  "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "$cmd user-prompt-submit", "timeout": 10 } ] } ],
  "PreToolUse": [ { "hooks": [ { "type": "command", "command": "$cmd pre-tool-use", "timeout": 10 } ] } ],
  "PostToolUse": [ { "matcher": "Read", "hooks": [ { "type": "command", "command": "$cmd post-tool-use", "timeout": 10 } ] } ],
  "Stop": [ { "hooks": [ { "type": "command", "command": "$cmd stop", "timeout": 10 } ] } ]
} }
JSON
  (cd "$dir" && git init -q && git -c user.name=poc -c user.email=poc@example.invalid commit -q --allow-empty -m poc)
}
run_claude() { # dir prompt
  (cd "$1" && timeout 240 claude -p "$2" --model "$model" --permission-mode acceptEdits --allowedTools "Bash,Read,Write" 2>>"$work/claude.err")
}
# ログの検索: log <dir> <jq 風の node 式（e は {event,input}）>
logq() { node -e 'const l=require("fs").readFileSync(process.argv[1]+"/log.jsonl","utf8").split("\n").filter(Boolean).map(x=>JSON.parse(x)); const r=l.filter(e=>eval(process.argv[2])); console.log(JSON.stringify(r))' "$1" "$2" 2>/dev/null || echo "[]"; }
count() { node -pe 'JSON.parse(process.argv[1]).length' "$(logq "$1" "$2")"; }

# --- a. UserPromptSubmit の入力 ---
for kind in ghost listed hidden; do
  d="$work/a-$kind"; make_repo "$d"
  out="$(run_claude "$d" "/kiro-$kind こんにちは。ファイルやコマンドは使わず『了解』とだけ答えて")"
  prompts="$(logq "$d" 'e.event==="user-prompt-submit"')"
  note "[$kind] 応答: $(echo "$out" | head -c 120 | tr '\n' ' ')"
  note "[$kind] UserPromptSubmit の入力の prompt: $(node -pe 'JSON.stringify(JSON.parse(process.argv[1]).map(e=>String(e.input.prompt).slice(0,160)))' "$prompts")"
  note "[$kind] 入力のキー: $(node -pe 'JSON.stringify(Object.keys(JSON.parse(process.argv[1])[0]?.input??{}))' "$prompts")"
  check "a-$kind: UserPromptSubmit が動いた" test "$(count "$d" 'e.event==="user-prompt-submit"')" -ge 1
  check "a-$kind: prompt が /kiro-$kind で始まる" test "$(count "$d" 'e.event==="user-prompt-submit" && /^\s*\/kiro-'"$kind"'/.test(String(e.input.prompt))')" -ge 1
done

# --- b. deny が Bash を止めるか。手順書の Read と PostToolUse ---
d="$work/b"; make_repo "$d"
out="$(run_claude "$d" "/kiro-listed 最初に Bash で touch bash-ran を実行してください。その後 .claude/skills/kiro-listed/SKILL.md を Read してください。最後に touch bash-ran-after を Bash で実行してください。")"
note "[b] 応答: $(echo "$out" | head -c 200 | tr '\n' ' ')"
note "[b] PreToolUse のツール: $(node -pe 'JSON.stringify(JSON.parse(process.argv[1]).map(e=>e.input.tool_name))' "$(logq "$d" 'e.event==="pre-tool-use"')")"
# 拒否の後にモデルが同じ操作をやり直すことがあるので、ファイルの有無ではなく、記録の順序で確かめる
check "b: 手順書を読む前の Bash が拒否された" test "$(count "$d" 'e.event==="denied" && e.input.tool_name==="Bash"')" -ge 1
first_read_idx="$(node -pe 'const l=require("fs").readFileSync(process.argv[1]+"/log.jsonl","utf8").split("\n").filter(Boolean).map(x=>JSON.parse(x)); l.findIndex(e=>e.event==="post-tool-use"&&e.input.tool_name==="Read")' "$d")"
check "b: 手順書を読む前に、Bash は 1 つも完了していない（PostToolUse が無い）" test "$(node -pe 'const l=require("fs").readFileSync(process.argv[1]+"/log.jsonl","utf8").split("\n").filter(Boolean).map(x=>JSON.parse(x)); l.slice(0, Number(process.argv[2])).filter(e=>e.event==="post-tool-use"&&e.input.tool_name==="Bash").length' "$d" "$first_read_idx")" -eq 0
check "b: 手順書の Read は通り、PostToolUse が来る" test "$(count "$d" 'e.event==="post-tool-use" && e.input.tool_name==="Read"')" -ge 1
check "b: 手順書を読んだ後の Bash は実行される" test -e "$d/bash-ran-after"

# --- c. Stop のフックの 2 回目 ---
d="$work/c"; make_repo "$d"
out="$(POC_STOP_ALWAYS=1 run_claude "$d" "『了解』とだけ答えて")"
note "[c] 応答: $(echo "$out" | head -c 200 | tr '\n' ' ')"
note "[c] Stop の stop_hook_active: $(node -pe 'JSON.stringify(JSON.parse(process.argv[1]).map(e=>e.input.stop_hook_active))' "$(logq "$d" 'e.event==="stop"')")"
check "c: 1 回目の Stop は stop_hook_active が偽" test "$(count "$d" 'e.event==="stop" && e.input.stop_hook_active!==true')" -ge 1
check "c: 2 回目の Stop は stop_hook_active が真で、終了できた" test "$(count "$d" 'e.event==="stop" && e.input.stop_hook_active===true')" -ge 1

echo; echo "結果: OK $pass 件、NG $fail 件"
[ "$fail" -eq 0 ]
