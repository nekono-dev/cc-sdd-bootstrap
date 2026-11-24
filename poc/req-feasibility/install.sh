#!/usr/bin/env bash
# PoC: cc-sdd を Claude Code・Codex の両方へ、利用者の文書を壊さずに非対話で導入できるか。
#
# 対応する要件: session-install 1.2・3.1〜3.3・4.4、installer-core 5（AGENTS.md の管理区画）
# 確かめること
#   a. 独自の manifest で、Codex 向けのスキルを入れつつ、標準の文書（AGENTS.md）の出力先を .kiro/settings へ差し替えられるか
#   b. 既存の AGENTS.md・CLAUDE.md（管理区画と利用者の記述）が変わらないか
#   c. .codex/agents（cc-sdd 既定の spec-reviewer）を入れずに済むか
#   d. Claude Code 向けと Codex 向けを続けて入れても、互いの導入物と .kiro/settings を壊さないか
#   e. 2 回目（入れ直し）でも a〜d が保たれるか
#
# 使い方: poc/req-feasibility/install.sh   （CC_SDD_VERSION で版を変えられる。既定 3.1.0）
# 必要なもの: node・npx・git、パッケージのレジストリへの通信。一時ディレクトリで試し、このリポジトリは変えない。
set -uo pipefail
ver="${CC_SDD_VERSION:-3.1.0}"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
pass=0; fail=0
check() { local l="$1"; shift; if "$@"; then echo "OK   $l"; pass=$((pass+1)); else echo "NG   $l"; fail=$((fail+1)); fi; }
repo="$work/repo"; mkdir -p "$repo"; git -C "$repo" init -q
printf '# 利用者の AGENTS.md\n\n利用者の記述。\n\n<!-- cc-sdd-bootstrap:begin -->\n管理区画\n<!-- cc-sdd-bootstrap:end -->\n' > "$repo/AGENTS.md"
printf '# 利用者の CLAUDE.md\n\n<!-- cc-sdd-bootstrap:begin -->\n管理区画\n<!-- cc-sdd-bootstrap:end -->\n' > "$repo/CLAUDE.md"
cp "$repo/AGENTS.md" "$work/AGENTS.orig"; cp "$repo/CLAUDE.md" "$work/CLAUDE.orig"
# ベンダごとの manifest。標準の文書は .kiro/settings へ別名で出し、Codex の既定のエージェント定義は入れない。
cat > "$work/claude.json" <<'J'
{"version":1,"artifacts":[
 {"id":"skills","source":{"type":"templateDir","fromDir":"templates/agents/{{AGENT}}/skills","toDir":"{{AGENT_COMMANDS_DIR}}"}},
 {"id":"doc_main","source":{"type":"templateFile","from":"templates/agents/{{AGENT}}/docs/CLAUDE.md","toDir":"{{KIRO_DIR}}/settings","rename":"cc-sdd-guide.md"}},
 {"id":"settings_templates","source":{"type":"templateDir","fromDir":"templates/shared/settings/templates","toDir":"{{KIRO_DIR}}/settings/templates"}}]}
J
cat > "$work/codex.json" <<'J'
{"version":1,"artifacts":[
 {"id":"skills","source":{"type":"templateDir","fromDir":"templates/agents/{{AGENT}}/skills","toDir":"{{AGENT_COMMANDS_DIR}}"}},
 {"id":"doc_main","source":{"type":"templateFile","from":"templates/agents/{{AGENT}}/docs/AGENTS.md","toDir":"{{KIRO_DIR}}/settings","rename":"cc-sdd-guide-codex.md"}},
 {"id":"settings_templates","source":{"type":"templateDir","fromDir":"templates/shared/settings/templates","toDir":"{{KIRO_DIR}}/settings/templates"}}]}
J
install() { # vendor-flag manifest
  (cd "$repo" && npx --yes "cc-sdd@$ver" --yes --overwrite force --manifest "$2" "$1" --lang ja >"$work/npx.log" 2>&1) || { echo "     導入に失敗: $(tail -3 "$work/npx.log")"; return 1; }
}
for round in 1 2; do
  echo "== ${round} 回目"
  t0=$(date +%s); check "Claude Code 向けの導入が非対話で成功する" install --claude-skills "$work/claude.json"
  check "Codex 向けの導入が非対話で成功する" install --codex-skills "$work/codex.json"; echo "     所要 $(( $(date +%s) - t0 )) 秒（2 回分）"
  check "a. Codex 向けのスキル（.agents/skills/kiro-*/SKILL.md）がある" test -f "$repo/.agents/skills/kiro-spec-init/SKILL.md"
  check "a. Codex 向けの標準の文書が .kiro/settings/cc-sdd-guide-codex.md に出る" test -s "$repo/.kiro/settings/cc-sdd-guide-codex.md"
  check "b. AGENTS.md が変わらない" cmp -s "$repo/AGENTS.md" "$work/AGENTS.orig"
  check "b. CLAUDE.md が変わらない" cmp -s "$repo/CLAUDE.md" "$work/CLAUDE.orig"
  check "c. .codex/agents が作られない" test ! -e "$repo/.codex/agents"
  check "d. Claude Code 向けのスキルが残る" test -f "$repo/.claude/skills/kiro-spec-init/SKILL.md"
  check "d. Claude Code 向けの標準の文書が残る" test -s "$repo/.kiro/settings/cc-sdd-guide.md"
  check "d. 設定の雛形がある" test -f "$repo/.kiro/settings/templates/specs/requirements.md"
done
echo "     導入されたもの: $(cd "$repo" && find . -path ./.git -prune -o -type f -print | sed -E 's|/kiro-[^/]+/.*|/kiro-*/…|' | sort -u | tr '\n' ' ')"
echo "結果: OK $pass 件、NG $fail 件"; [ "$fail" -eq 0 ]
