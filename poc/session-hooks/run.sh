#!/usr/bin/env bash
# PoC: session-install の設計の前提を、実際の Claude Code（claude -p）で確かめる。
#
# 確かめること
#   a. SessionStart のフックの標準出力が会話の文脈に入り、標準エラーは入らない
#   b. SessionStart のフックで新しく置いたスキルが、そのセッションのスキル一覧に載るか（次のセッションでは載るか）
#   c. SessionStart のフックが時間制限を超えたとき、フックとその子のプロセスが止められるか、Claude は待つか、プロンプトは処理されるか
#   d. 同じリポジトリで 2 つのセッションを同時に始めたとき、SessionStart のフックが同時に動くか（重なるか）。フックに渡る入力（source など）
#
# 使い方: poc/session-hooks/run.sh
# 必要なもの: claude（認証済み）、node、git。一時ディレクトリに小さなリポジトリを作って試す（このリポジトリは変えない）。
set -uo pipefail

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
here="$(cd "$(dirname "$0")" && pwd)"
model="${POC_MODEL:-haiku}"

pass=0
fail=0
check() {
  local label="$1"
  shift
  if "$@"; then echo "OK   $label"; pass=$((pass + 1)); else echo "NG   $label"; fail=$((fail + 1)); fi
}
note() { echo "     $*"; }

# 小さなリポジトリを作り、SessionStart のフック（hook.sh）を時間制限つきで登録する
make_repo() {
  local dir="$1" timeout="$2"
  mkdir -p "$dir/.claude" "$dir/.cache"
  cat > "$dir/.claude/settings.json" << JSON
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "\"\$CLAUDE_PROJECT_DIR/hook.sh\"", "timeout": $timeout } ] } ] } }
JSON
  (cd "$dir" && git init -q && git -c user.name=poc -c user.email=poc@example.invalid commit -q --allow-empty -m poc)
}

# stream-json の出力から、最初の init の出来事のスキル（slash_commands）一覧と、最後の応答の本文を取り出す
parse() {
  node -e '
    const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
    let init = null, result = "";
    for (const l of lines) { try { const e = JSON.parse(l);
      if (e.type === "system" && e.subtype === "init" && !init) init = e;
      if (e.type === "result") result = String(e.result ?? ""); } catch {} }
    const names = init ? [...(init.slash_commands ?? []), ...(init.skills ?? [])] : [];
    console.log(JSON.stringify({ names, result }));
  '
}
run_claude() { # dir prompt -> stream-json を標準出力へ
  (cd "$1" && claude -p --model "$model" --output-format stream-json --verbose "$2" 2>>"$work/claude.err")
}

# --- a. 標準出力は文脈に入り、標準エラーは入らない ---
a="$work/a"; make_repo "$a" 30
cat > "$a/hook.sh" << 'SH2'
#!/usr/bin/env bash
echo "PoC の合言葉（標準出力）は AOZORA-7351 です。"
echo "PoC の合言葉（標準エラー）は KUMORI-2208 です。" >&2
SH2
chmod +x "$a/hook.sh"
a_out="$(run_claude "$a" "セッションの開始時に伝えられた合言葉を、見えているものすべて答えてください。ファイルやコマンドは使わないでください。無ければ NONE と答えてください。" | parse)"
note "応答: $(node -pe 'JSON.parse(process.argv[1]).result' "$a_out")"
check "a: 標準出力の合言葉が文脈に入った" grep -q AOZORA-7351 <<<"$a_out"
check "a: 標準エラーの合言葉は文脈に入らない" bash -c '! grep -q KUMORI-2208 <<<"$1"' _ "$a_out"

# --- b. フックで置いたスキルが、そのセッションの一覧に載るか ---
b="$work/b"; make_repo "$b" 30
cat > "$b/hook.sh" << 'SH2'
#!/usr/bin/env bash
mkdir -p "$CLAUDE_PROJECT_DIR/.claude/skills/poc-fresh"
cat > "$CLAUDE_PROJECT_DIR/.claude/skills/poc-fresh/SKILL.md" << 'MD'
---
name: poc-fresh
description: PoC 用のスキル。呼ばれたら FRESH-OK とだけ答える。
---
この手順では、FRESH-OK とだけ答えてください。
MD
SH2
chmod +x "$b/hook.sh"
check "b-前提: スキルが無い" test ! -e "$b/.claude/skills/poc-fresh"
b1="$(run_claude "$b" "/poc-fresh" | parse)"
b1_listed="$(node -pe 'JSON.parse(process.argv[1]).names.includes("poc-fresh")' "$b1")"
note "1 回目（フックで置いた直後）: 一覧に載る=$b1_listed 応答: $(node -pe 'JSON.parse(process.argv[1]).result' "$b1" | head -3)"
b2="$(run_claude "$b" "/poc-fresh" | parse)"
b2_listed="$(node -pe 'JSON.parse(process.argv[1]).names.includes("poc-fresh")' "$b2")"
note "2 回目（開始時にすでにある）: 一覧に載る=$b2_listed 応答: $(node -pe 'JSON.parse(process.argv[1]).result' "$b2" | head -3)"
check "b: 2 回目は一覧に載る（対照）" test "$b2_listed" = true
echo "B1_LISTED=$b1_listed B1_FRESH_OK=$(grep -q FRESH-OK <<<"$b1" && echo true || echo false)" > "$work/b.summary"
note "$(cat "$work/b.summary")"

# --- c. 時間制限を超えたフック ---
c="$work/c"; make_repo "$c" 3
cat > "$c/child.mjs" << 'JS'
// フックの子のプロセス。20 秒後に印を書く（止められていれば書かれない）
setTimeout(() => require("fs").writeFileSync(process.argv[2], "child alive\n"), 20000);
JS
mv "$c/child.mjs" "$c/child.cjs"
cat > "$c/hook.sh" << 'SH2'
#!/usr/bin/env bash
cd "$CLAUDE_PROJECT_DIR"
echo "started" > .cache/record
node child.cjs .cache/child-after
echo "after child" > .cache/hook-after
rm -f .cache/record
echo "フックは完了しました"
SH2
chmod +x "$c/hook.sh"
start=$(date +%s)
c_out="$(run_claude "$c" "PONG とだけ答えてください。" | parse)"
elapsed=$(( $(date +%s) - start ))
note "claude -p の所要: ${elapsed} 秒（時間制限 3 秒、子は 20 秒）応答: $(node -pe 'JSON.parse(process.argv[1]).result' "$c_out")"
check "c: プロンプトは処理された" grep -q PONG <<<"$c_out"
check "c: Claude は子の終了（20 秒）を待たなかった" test "$elapsed" -lt 20
note "子とフックの後続が動くか、25 秒待って確かめる"
sleep 25
check "c: 記録（record）が残った" test -f "$c/.cache/record"
check "c: フックの後続（hook-after）は動かなかった" test ! -e "$c/.cache/hook-after"
if [ -e "$c/.cache/child-after" ]; then note "子のプロセスは止められず、時間切れの後も動き続けた（child-after がある）"; echo "C_CHILD_SURVIVED=true" >> "$work/b.summary"
else note "子のプロセスも止められた（child-after が無い）"; echo "C_CHILD_SURVIVED=false" >> "$work/b.summary"; fi

# --- c2. 時間切れの後も claude が動き続ける場合（子が止められるのは時間切れの時点か、claude の終了の時点か） ---
c2="$work/c2"; make_repo "$c2" 3
cp "$c/child.cjs" "$c/hook.sh" "$c2/"
rm -f "$c2/.cache/"*
c2_out="$(cd "$c2" && claude -p --model "$model" --allowedTools "Bash(sleep 25)" --output-format stream-json --verbose \
  "Bash ツールで sleep 25 を実行し、終わったら PONG とだけ答えてください。" 2>>"$work/claude.err" | parse)"
note "応答: $(node -pe 'JSON.parse(process.argv[1]).result' "$c2_out")"
check "c2: claude は sleep 25 を終えて応答した" grep -q PONG <<<"$c2_out"
if [ -e "$c2/.cache/child-after" ]; then note "claude が動いている間、子は時間切れの後も動き続けた（child-after がある）"; echo "C2_CHILD_SURVIVED_WHILE_RUNNING=true" >> "$work/b.summary"
else note "子は時間切れの時点で止められた（claude が動いている間に child-after が書かれない）"; echo "C2_CHILD_SURVIVED_WHILE_RUNNING=false" >> "$work/b.summary"; fi
check "c2: フックの後続（hook-after）は動かなかった" test ! -e "$c2/.cache/hook-after"

# --- d. 同時に始めたセッション ---
d="$work/d"; make_repo "$d" 30
cat > "$d/hook.sh" << 'SH2'
#!/usr/bin/env bash
input="$(cat)"
log="$CLAUDE_PROJECT_DIR/.cache/log"
echo "start $$ $(date +%s%3N)" >> "$log"
printf 'input %s %s\n' "$$" "$(printf '%s' "$input" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(JSON.stringify({source:j.source, keys:Object.keys(j)}))')" >> "$log"
sleep 5
echo "end $$ $(date +%s%3N)" >> "$log"
SH2
chmod +x "$d/hook.sh"
run_claude "$d" "PONG とだけ答えてください。" > "$work/d1.json" &
p1=$!
run_claude "$d" "PONG とだけ答えてください。" > "$work/d2.json" &
p2=$!
wait "$p1" "$p2"
sed 's/^/     log: /' "$d/.cache/log"
overlap="$(node -e '
  const L = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(l => l.split(" "));
  const s = {}, e = {};
  for (const [k, pid, t] of L) { if (k === "start") s[pid] = +t; if (k === "end") e[pid] = +t; }
  const p = Object.keys(s);
  console.log(p.length === 2 && s[p[0]] < e[p[1]] && s[p[1]] < e[p[0]]);
' "$d/.cache/log")"
check "d: フックが 2 回動いた" test "$(grep -c '^start' "$d/.cache/log")" -eq 2
note "2 つのフックの実行が重なった: $overlap"
echo "D_OVERLAP=$overlap" >> "$work/b.summary"

echo "--- まとめ ---"
cat "$work/b.summary"
echo "結果: OK $pass 件、NG $fail 件"
[ "$fail" -eq 0 ]
