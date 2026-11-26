#!/usr/bin/env bash
# PoC: CLAUDE.md の無いリポジトリで、最初の入力が `/kiro-steering` だけのとき、スキルの手順書を読み込んだうえで実行されるか。
#
# 背景: CLAUDE.md・AGENTS.md をコミットしない（cc-sdd の標準の文書として導入のたびに作り直す）方針の前提確認。
#       クラウドセッションは別セッションから起動すると最初の入力を `/` で始められないため、同じ Claude Code の claude -p で代わりに確かめる。
# 確かめること
#   A. 起動前に導入（クラウドの準備スクリプトに相当）→ `/kiro-steering` がスキルとして展開され、手順書に沿って進む
#   B. 起動前に導入せず、SessionStart フックだけで導入（今の develop の仕組み）→ 同じ入力がどう扱われるか（対照）
#
# 使い方: poc/first-kiro-command/run.sh [ブランチ]   （既定 dev/poc-cloud-first-run。POC_MODEL 既定 sonnet）
# 必要なもの: claude（認証済み）・node・npx・curl・tar・jq、GitHub とパッケージのレジストリへの通信。
# 作業場所は ~/.cache/cc-sdd-bootstrap-scratch/first-kiro-command（このリポジトリと /tmp は使わない）。
# 取得はブランチのアーカイブで行い、版管理のコマンドは使わない（変更の確認は取得直後の写しとの比較）。
set -uo pipefail
branch="${1:-dev/poc-cloud-first-run}"; model="${POC_MODEL:-sonnet}"
base=~/.cache/cc-sdd-bootstrap-scratch/first-kiro-command
rm -rf "${base:?}"; mkdir -p "$base"
pass=0; fail=0
check() { local l="$1"; shift; if "$@"; then echo "OK   $l"; pass=$((pass+1)); else echo "NG   $l"; fail=$((fail+1)); fi; }
prep() { # 名前 → 取得したての作業場所（隣に比較用の写し）
  local d="$base/$1/cc-sdd-bootstrap"; mkdir -p "$d"
  curl -fsSL "https://codeload.github.com/nekono-dev/cc-sdd-bootstrap/tar.gz/refs/heads/$branch" | tar -xz -C "$d" --strip-components=1 \
    && cp -a "$d/.kiro/steering" "$base/$1/steering.orig" && echo "$d"
}
run() { # 作業場所 記録
  (cd "$1" && timeout 900 claude -p "/kiro-steering" --model "$model" --permission-mode acceptEdits \
     --output-format stream-json --verbose > "$2" 2> "$2.err"); echo "     終了コード $?"
}
# 展開の有無は stream-json に出ないため、会話の記録（transcript）で見る
transcript() { local sid; sid=$(jq -r 'select(.type=="system" and .subtype=="init") | .session_id' "$1" | head -1); ls ~/.claude/projects/*/"$sid".jsonl 2>/dev/null | head -1; }
expanded() { local t; t=$(transcript "$1"); [ -n "$t" ] && grep -q '<command-name>/kiro-steering</command-name>' "$t" && grep -q 'Base directory for this skill: [^"]*kiro-steering' "$t"; }
in_list() { jq -e 'select(.type=="system" and .subtype=="init") | .slash_commands | index("kiro-steering")' "$1" >/dev/null 2>&1; }
# ツール呼び出しの全件について判定する（jq -e は最後の出力だけを見るため、slurp して any を使う）
uses() { jq -s -e --arg re "$2" --arg tool "$3" '[.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and ($tool=="" or .name==$tool)) | (.input.file_path // .input.command // "") | test($re)] | any' "$1" >/dev/null 2>&1; }
read_skill_md() { uses "$1" 'kiro-steering/SKILL.md$' Read; }
not_read_skill_md() { ! read_skill_md "$1"; }
followed() { uses "$1" 'kiro-steering/rules/steering-principles.md' ''; }
steering_changed() { ! diff -rq "$base/$1/steering.orig" "$base/$1/cc-sdd-bootstrap/.kiro/steering" >/dev/null; }
last() { jq -r 'select(.type=="result") | .result' "$1" | head -c 300 | tr '\n' ' '; }

echo "== A. 起動前に導入してから /kiro-steering"
a=$(prep a) || { echo "取得に失敗"; exit 1; }
(cd "$a" && node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs > "$base/a.install.log" 2>&1); echo "     導入の終了コード $?"
check "A. CLAUDE.md が無い" test ! -e "$a/CLAUDE.md"
run "$a" "$base/a.jsonl"
check "A. 起動時のスキル一覧に kiro-steering が載る" in_list "$base/a.jsonl"
check "A. /kiro-steering がスキルとして展開される（手順書の本文が渡る）" expanded "$base/a.jsonl"
check "A. SKILL.md を自分で Read していない（展開された本文で動いた）" not_read_skill_md "$base/a.jsonl"
check "A. 手順書が指す決まり（rules/steering-principles.md）を読んで手順を進める" followed "$base/a.jsonl"
if steering_changed a; then echo "     観測: A で .kiro/steering が更新された"; else echo "     観測: A で .kiro/steering は変更なし（同期の結果）"; fi
echo "     最後の応答: $(last "$base/a.jsonl")"

echo "== B. 起動前に導入せず（SessionStart フックだけで導入）/kiro-steering"
b=$(prep b) || { echo "取得に失敗"; exit 1; }
check "B. CLAUDE.md が無い" test ! -e "$b/CLAUDE.md"
check "B. 起動前は手順書が無い" test ! -e "$b/.claude/skills/kiro-steering/SKILL.md"
run "$b" "$base/b.jsonl"
check "B. SessionStart フックで導入される" test -e "$b/.claude/skills/kiro-steering/SKILL.md"
if in_list "$base/b.jsonl"; then echo "     観測: B の起動時のスキル一覧に kiro-steering が載る"; else echo "     観測: B の起動時のスキル一覧に kiro-steering は載らない"; fi
if expanded "$base/b.jsonl"; then echo "     観測: B で /kiro-steering がスキルとして展開された"; else echo "     観測: B で /kiro-steering はスキルとして展開されなかった"; fi
if read_skill_md "$base/b.jsonl"; then echo "     観測: B は SKILL.md を自分で Read した"; else echo "     観測: B は SKILL.md を Read しなかった"; fi
if followed "$base/b.jsonl"; then echo "     観測: B は手順書が指す決まりを読んだ"; else echo "     観測: B は手順書が指す決まりを読まなかった"; fi
if steering_changed b; then echo "     観測: B で .kiro/steering が更新された"; else echo "     観測: B で .kiro/steering は変更なし"; fi
echo "     最後の応答: $(last "$base/b.jsonl")"
echo "記録: $base/{a,b}.jsonl"
echo "結果: OK $pass 件、NG $fail 件"; [ "$fail" -eq 0 ]
