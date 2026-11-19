#!/usr/bin/env bash
# PoC: cc-sdd の導入スクリプトと停止フックが、実際の Claude Code で動くことを確かめる。
#
# 確かめること
#   1. 導入物が無い状態（新しい clone と同じ）から、セッション開始で cc-sdd の導入物が入り、プロンプトが通る
#   2. 導入に失敗すると失敗の記録が残り、次のプロンプトが止まる（モデルが応答しない）
#
# 使い方: poc/self-install/run.sh
# 必要なもの: claude（認証済み）、node、npx、git。作業ツリーの今の内容（コミット前を含む）を一時ディレクトリに写して試す。
set -uo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 追跡中・未追跡（.gitignore の対象を除く）のファイルを写す。導入物（.gitignore の対象）は写らない
copy_repo() {
  local dest="$1"
  mkdir -p "$dest"
  (cd "$repo" && git ls-files -co --exclude-standard -z | xargs -0 -I{} cp --parents {} "$dest/")
  test -f "$dest/.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.sh"
  test -f "$dest/.agent-hooks/cc-sdd-bootstrap/install-gate.mjs"
  (cd "$dest" && git init -q && git add -A && git -c user.name=poc -c user.email=poc@example.invalid commit -qm poc)
}

pass=0
fail=0
check() {
  local label="$1"
  shift
  if "$@"; then
    echo "OK   $label"
    pass=$((pass + 1))
  else
    echo "NG   $label"
    fail=$((fail + 1))
  fi
}

# --- 1. 成功の場合 ---
ok_dir="$work/ok"
copy_repo "$ok_dir"
check "1-前提: 導入物が無い" test ! -e "$ok_dir/.claude/skills/kiro-impl/SKILL.md"
ok_out="$(cd "$ok_dir" && claude -p "PONG とだけ答えてください。" 2>"$work/ok.err")"
echo "     応答: $ok_out"
check "1: スキルが入った" test -f "$ok_dir/.claude/skills/kiro-impl/SKILL.md"
check "1: 雛形が入った" test -f "$ok_dir/.kiro/settings/templates/specs/tasks.md"
check "1: 標準の決まりの文書が入った" test -f "$ok_dir/.kiro/settings/cc-sdd-guide.md"
check "1: 失敗の記録が無い" test ! -e "$ok_dir/.cache/cc-sdd-install.failed"
check "1: プロンプトが通った（応答に PONG）" grep -q PONG <<<"$ok_out"
check "1: CLAUDE.md は変わっていない" cmp -s "$repo/CLAUDE.md" "$ok_dir/CLAUDE.md"
check "1: 導入物は git の変更に出ない" test -z "$(cd "$ok_dir" && git status --porcelain)"

# --- 2. 失敗の場合（必ず失敗する npx を PATH の先頭に置く） ---
ng_dir="$work/ng"
copy_repo "$ng_dir"
mkdir -p "$work/fakebin"
printf '#!/bin/sh\necho "PoC: 失敗させた npx" >&2\nexit 7\n' > "$work/fakebin/npx"
chmod +x "$work/fakebin/npx"
ng_out="$(cd "$ng_dir" && PATH="$work/fakebin:$PATH" claude -p "PONG とだけ答えてください。" 2>"$work/ng.err")"
ng_status=$?
echo "     応答: $ng_out（終了コード $ng_status）"
check "2: 失敗の記録が残った" test -f "$ng_dir/.cache/cc-sdd-install.failed"
check "2: 記録に終了コードが書かれた" grep -q "終了コード 7" "$ng_dir/.cache/cc-sdd-install.failed"
check "2: プロンプトが止まった（応答に PONG が無い）" bash -c '! grep -q PONG <<<"$1"' _ "$ng_out"

echo "結果: OK $pass 件、NG $fail 件"
[ "$fail" -eq 0 ]
