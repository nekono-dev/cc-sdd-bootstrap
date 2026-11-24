#!/usr/bin/env bash
# PoC: git の worktree の中で Codex を起動したとき、どの .codex/hooks.json が読まれ、
# フックのコマンドがどこで動き、どの checkout のスクリプトが呼ばれるかを確かめる。
# 使い方: bash poc/codex-worktree-hooks/run.sh
#   認証済みの codex が要る（~/.codex/auth.json を一時の CODEX_HOME へ写す）。
#   git を含むスクリプトは branch-release-workflow のフックが Claude Code の中での実行を止めるため、
#   Claude の外の端末で実行する（2026-11-24 は同じ手順を 1 つずつ Claude の中で実行した）。
set -u
B=${POC_BASE:-$HOME/.cache/cc-sdd-bootstrap-scratch/codex-worktree-hooks}
MODEL=${POC_MODEL:-gpt-6-luna}
rm -rf "$B"; mkdir -p "$B"
LOG="$B/log.jsonl"

# フックから呼ばれるスクリプト: 自分の置き場所・作業場所・git の根・入力の cwd を記録する
probe() {
  cat <<JS
const fs = require('fs');
let input = '';
process.stdin.on('data', d => input += d).on('end', () => {
  let j = {}; try { j = JSON.parse(input); } catch {}
  const top = require('child_process').execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  fs.appendFileSync('$LOG', JSON.stringify({ label: process.argv[2], script: __filename, cwd: process.cwd(), toplevel: top, inputCwd: j.cwd, event: j.hook_event_name }) + '\n');
});
JS
}
# hooks.json の中身。$1 は見分けの名前
hooks() {
  printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node \\"$(git rev-parse --show-toplevel)/probe.cjs\\" %s","timeout":10}]}]}}\n' "$1"
}

# 本体の checkout（M）と worktree（W）。両方に別の名前の hooks.json を置く
M="$B/main"; W="$B/wt"
git init -q -b main "$M"
probe > "$M/probe.cjs"; mkdir -p "$M/.codex" "$M/sub"; hooks main-json > "$M/.codex/hooks.json"; touch "$M/sub/.keep"
git -C "$M" add -A
git -C "$M" -c user.name=poc -c user.email=poc@example.invalid commit -qm init
git -C "$M" worktree add -q -b dev/poc "$W"
hooks wt-json > "$W/.codex/hooks.json"   # worktree 側だけ中身を変える（コミットしない）

H=$(mktemp -d "$B/codexhome.XXXX")
cp ~/.codex/auth.json "$H/"; chmod 600 "$H/auth.json"
printf '[projects."%s"]\ntrust_level = "trusted"\n[projects."%s"]\ntrust_level = "trusted"\n' "$M" "$W" > "$H/config.toml"

# $1 = 場面の名前、$2 = 起動する場所
run() {
  : > "$LOG"
  CODEX_HOME="$H" timeout 300 codex -a never exec --json --dangerously-bypass-hook-trust -s read-only \
    --model "$MODEL" -c 'model_reasoning_effort="low"' --cd "$2" 'OK とだけ答えて' < /dev/null > "$B/out-$1.jsonl" 2>&1
  echo "### $1（起動: ${2#$B/}、exit=$?）"
  if [ -s "$LOG" ]; then sed "s#$B/##g" "$LOG"; else echo "(フックの記録なし)"; fi
}

run "1-worktree-root" "$W"
run "2-worktree-sub" "$W/sub"
run "3-main-root" "$M"
# 本体側の hooks.json が無いとき、worktree の hooks.json が代わりに読まれるか
mv "$M/.codex/hooks.json" "$B/main-hooks.json.bak"
run "4-worktree-root-main-hooks-missing" "$W"
mv "$B/main-hooks.json.bak" "$M/.codex/hooks.json"
# 本体側にスクリプトが無いとき（本体が古い版）、worktree のスクリプトが呼ばれるか
rm "$M/probe.cjs"
run "5-worktree-root-main-script-missing" "$W"
# 本体側の登録が worktree に無いスクリプトを指すとき（worktree が古い版のとき）、セッションとツールが止まるか
cp "$M/.codex/hooks.json" "$B/main-hooks.json.orig"
cat > "$M/.codex/hooks.json" <<'J'
{"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"node \"$(git rev-parse --show-toplevel)/missing.cjs\" s","timeout":10}]}],
 "UserPromptSubmit":[{"hooks":[{"type":"command","command":"node \"$(git rev-parse --show-toplevel)/missing.cjs\" u","timeout":10}]}],
 "PreToolUse":[{"hooks":[{"type":"command","command":"node \"$(git rev-parse --show-toplevel)/missing.cjs\" p","timeout":10}]}]
}}
J
CODEX_HOME="$H" timeout 300 codex -a never exec --json --dangerously-bypass-hook-trust -s read-only \
  --model "$MODEL" -c 'model_reasoning_effort="low"' --cd "$W" 'ls を 1 回実行して、出力の行数だけを答えて' \
  < /dev/null > "$B/out-6-missing-script.jsonl" 2>&1
echo "### 6-worktree-root-script-missing（exit=$?）"
grep -o '"type":"command_execution","command":"[^"]*","aggregated_output":"[^"]*","exit_code":[0-9]*' "$B/out-6-missing-script.jsonl"
grep -o '"type":"agent_message","text":"[^"]*"' "$B/out-6-missing-script.jsonl"
cp "$B/main-hooks.json.orig" "$M/.codex/hooks.json"
rm -rf "$H"
