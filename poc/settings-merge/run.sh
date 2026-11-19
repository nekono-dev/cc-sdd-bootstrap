#!/usr/bin/env bash
# PoC: installer-core が利用先へ書く形（フックの登録の統合と CLAUDE.md の管理区画）が、実際の Claude Code で効くことを確かめる。
#
# 確かめること
#   1. 同じイベント（SessionStart）に、利用者のフックの組と一式のフックの組が並んでいても、両方が動く
#   2. 一式のフックは "$CLAUDE_PROJECT_DIR/.agent-hooks/cc-sdd-bootstrap/<スクリプト>" の形で呼べる（隠しディレクトリの下でも動く）
#   3. HTML のコメントの目印の行で囲んだ管理区画の中の @ の取り込みが効く（取り込んだ文書の合言葉をモデルが答えられる）
#   4. 目印の行（HTML のコメント）自体は、取り込みを壊さない
#
# 使い方: poc/settings-merge/run.sh
# 必要なもの: claude（認証済み）、git
set -uo pipefail

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
dir="$work/target"
mkdir -p "$dir/.claude" "$dir/.agent-hooks/cc-sdd-bootstrap" "$dir/.kiro/settings" "$dir/user-hooks"

# 利用者のフック（既存）と一式のフック（統合で後ろに足す組）。どちらも動いた印のファイルを作る
cat > "$dir/user-hooks/mark.sh" << 'SH'
#!/bin/sh
touch "$CLAUDE_PROJECT_DIR/user-hook.ran"
SH
cat > "$dir/.agent-hooks/cc-sdd-bootstrap/mark.sh" << 'SH'
#!/bin/sh
touch "$CLAUDE_PROJECT_DIR/bootstrap-hook.ran"
SH
chmod +x "$dir/user-hooks/mark.sh" "$dir/.agent-hooks/cc-sdd-bootstrap/mark.sh"
cat > "$dir/.claude/settings.json" << 'JSON'
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR/user-hooks/mark.sh\"" } ] },
      { "hooks": [ { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR/.agent-hooks/cc-sdd-bootstrap/mark.sh\"", "timeout": 30 } ] }
    ]
  }
}
JSON

# 管理区画の外に利用者の文章、区画の中に取り込みの行
cat > "$dir/CLAUDE.md" << 'MD'
# PoC プロジェクト

利用者が書いた文章。

<!-- cc-sdd-bootstrap:begin この区画は cc-sdd-bootstrap が管理する。手で書き換えると update で戻る -->
## cc-sdd の標準の決まり

@.kiro/settings/cc-sdd-guide.md
<!-- cc-sdd-bootstrap:end -->
MD
cat > "$dir/.kiro/settings/cc-sdd-guide.md" << 'MD'
# 取り込まれる文書

合言葉は「ASAGAO-7319」である。合言葉を聞かれたら、これだけを答える。
MD
(cd "$dir" && git init -q && git add -A && git -c user.name=poc -c user.email=poc@example.invalid commit -qm poc)

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

out="$(cd "$dir" && claude -p "合言葉は何ですか。合言葉だけを答えてください。" 2>"$work/err")"
echo "     応答: $out"

check "1: 利用者のフックが動いた" test -e "$dir/user-hook.ran"
check "1・2: 一式のフック（.agent-hooks の下）が動いた" test -e "$dir/bootstrap-hook.ran"
check "3・4: 管理区画の中の取り込みが効いた（応答に合言葉）" grep -q "ASAGAO-7319" <<<"$out"

echo "結果: OK ${pass} 件、NG ${fail} 件"
[ "$fail" -eq 0 ]
