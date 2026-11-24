#!/usr/bin/env bash
# PoC: cc-sdd の導入で CLAUDE.md・AGENTS.md を cc-sdd の標準の文書として書き出し、その後に独自の区画を書き足せるか。
#
# 対応する要件: session-install 4（標準の文書の書き出しと区画の書き足し）、installer-core 5・6（除外設定）
# 確かめること
#   a. 既存の CLAUDE.md・AGENTS.md（利用者の記述と古い区画）は、cc-sdd の導入（--overwrite force）で標準の文書に丸ごと置き換わるか
#   b. Claude Code 向け（CLAUDE.md）と Codex 向け（AGENTS.md）を続けて入れても、互いの文書を壊さないか
#   c. 導入の後に、目印の行で囲んだ区画を末尾へ書き足せるか
#   d. 2 回目（入れ直し）でも、文書は標準の文書＋区画 1 つになる（区画が重ならない）か
#   e. .codex/agents（cc-sdd 既定の spec-reviewer）を入れずに済むか
#
# 使い方: poc/req-feasibility/doc-append.sh   （CC_SDD_VERSION で版を変えられる。既定 3.1.0）
# 必要なもの: node・npx・git、パッケージのレジストリへの通信。一時ディレクトリで試し、このリポジトリは変えない。
set -uo pipefail
ver="${CC_SDD_VERSION:-3.1.0}"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
pass=0; fail=0
check() { local l="$1"; shift; if "$@"; then echo "OK   $l"; pass=$((pass+1)); else echo "NG   $l"; fail=$((fail+1)); fi; }
repo="$work/repo"; mkdir -p "$repo"; git -C "$repo" init -q
printf '# 利用者の AGENTS.md\n\n利用者の記述。\n\n<!-- cc-sdd-bootstrap:begin -->\n古い区画\n<!-- cc-sdd-bootstrap:end -->\n' > "$repo/AGENTS.md"
printf '# 利用者の CLAUDE.md\n\n利用者の記述。\n' > "$repo/CLAUDE.md"
# ベンダごとの manifest。標準の文書は既定どおりリポジトリの直下に出し、Codex の既定のエージェント定義は入れない。
for v in claude:CLAUDE.md codex:AGENTS.md; do
  name="${v%%:*}"; doc="${v#*:}"
  cat > "$work/$name.json" <<J
{"version":1,"artifacts":[
 {"id":"skills","source":{"type":"templateDir","fromDir":"templates/agents/{{AGENT}}/skills","toDir":"{{AGENT_COMMANDS_DIR}}"}},
 {"id":"doc_main","source":{"type":"templateFile","from":"templates/agents/{{AGENT}}/docs/$doc","toDir":"."}},
 {"id":"settings_templates","source":{"type":"templateDir","fromDir":"templates/shared/settings/templates","toDir":"{{KIRO_DIR}}/settings/templates"}}]}
J
done
install() { # vendor-flag manifest
  (cd "$repo" && npx --yes "cc-sdd@$ver" --yes --overwrite force --manifest "$2" "$1" --lang ja >"$work/npx.log" 2>&1) || { echo "     導入に失敗: $(tail -3 "$work/npx.log")"; return 1; }
}
# 区画の書き足し（導入のたびに行う想定。導入で文書が作り直されるので、末尾へ足すだけでよい）
append() { printf '\n<!-- cc-sdd-bootstrap:begin -->\n## cc-sdd-bootstrap の運用\n独自の区画（%s 向け）\n<!-- cc-sdd-bootstrap:end -->\n' "$2" >> "$repo/$1"; }
count() { grep -c 'cc-sdd-bootstrap:begin' "$repo/$1"; }
for round in 1 2; do
  echo "== ${round} 回目"
  check "Claude Code 向けの導入が非対話で成功する" install --claude-skills "$work/claude.json"
  check "a. CLAUDE.md から利用者の記述が消える" bash -c "! grep -q '利用者の記述' '$repo/CLAUDE.md'"
  check "a. CLAUDE.md が cc-sdd の標準の文書になる" grep -q 'Spec-Driven Development' "$repo/CLAUDE.md"
  check "a. CLAUDE.md に区画が無い（書き足しの前）" test "$(count CLAUDE.md)" -eq 0
  append CLAUDE.md "Claude Code"
  check "Codex 向けの導入が非対話で成功する" install --codex-skills "$work/codex.json"
  check "a. AGENTS.md から利用者の記述と古い区画が消える" bash -c "! grep -q '利用者の記述\|古い区画' '$repo/AGENTS.md'"
  check "a. AGENTS.md が cc-sdd の標準の文書になる" grep -q 'Spec-Driven Development' "$repo/AGENTS.md"
  append AGENTS.md "Codex"
  check "b. Codex 向けの導入の後も CLAUDE.md の区画が残る" test "$(count CLAUDE.md)" -eq 1
  check "c/d. CLAUDE.md の区画は 1 つ" test "$(count CLAUDE.md)" -eq 1
  check "c/d. AGENTS.md の区画は 1 つ" test "$(count AGENTS.md)" -eq 1
  check "c. 区画は文書の末尾にある" bash -c "tail -1 '$repo/CLAUDE.md' | grep -q 'cc-sdd-bootstrap:end' && tail -1 '$repo/AGENTS.md' | grep -q 'cc-sdd-bootstrap:end'"
  check "e. .codex/agents が作られない" test ! -e "$repo/.codex/agents"
  check "b. 両ベンダのスキルがある" test -f "$repo/.claude/skills/kiro-spec-init/SKILL.md" -a -f "$repo/.agents/skills/kiro-spec-init/SKILL.md"
done
echo "     CLAUDE.md の先頭: $(head -1 "$repo/CLAUDE.md")、AGENTS.md の先頭: $(head -1 "$repo/AGENTS.md")"
echo "結果: OK $pass 件、NG $fail 件"; [ "$fail" -eq 0 ]
