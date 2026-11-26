#!/usr/bin/env bash
# PoC: 実際の配置物で、worktree の Codex が作業の前に cc-sdd を worktree へ入れるかを確かめる。
# このリポジトリの作業ブランチを普通の checkout として写し（本体の役）、そこから worktree を作って Codex を起動する。
# 使い方: bash poc/codex-worktree-hooks/real-install.sh [ブランチ名（既定: dev/spec-simplify）]
#   認証済みの codex と、cc-sdd の取得に使うネットワークが要る。git を含むため Claude の外の端末で実行する。
set -u
SRC=$(cd "$(dirname "$0")/../.." && pwd)
BRANCH=${1:-dev/spec-simplify}
B=${POC_BASE:-$HOME/.cache/cc-sdd-bootstrap-scratch/wt-real}
M="$B/main"; W="$B/wt"
rm -rf "$B"; mkdir -p "$B"
git clone -q --branch "$BRANCH" "$SRC" "$M"
git -C "$M" worktree add -q -b dev/probe "$W"

H=$(mktemp -d "$B/codexhome.XXXX")
cp ~/.codex/auth.json "$H/"; chmod 600 "$H/auth.json"
printf '[projects."%s"]\ntrust_level = "trusted"\n[projects."%s"]\ntrust_level = "trusted"\n' "$M" "$W" > "$H/config.toml"
(cd "$W" && CODEX_HOME="$H" timeout 600 codex -a never exec --json --dangerously-bypass-hook-trust -s read-only \
  --model "${POC_MODEL:-gpt-6-luna}" -c 'model_reasoning_effort="low"' 'AGENTS.md の最初の見出しの行だけを答えて' \
  < /dev/null > "$B/out.jsonl" 2>&1)
echo "codex の終了コード: $?"
echo "worktree のスキル: $(ls "$W/.agents/skills" 2>/dev/null | wc -l) 個、AGENTS.md の運用の区画の行: $(grep -c cc-sdd-bootstrap "$W/AGENTS.md" 2>/dev/null || echo 0)"
echo "本体の .agents: $(ls -d "$M/.agents" 2>/dev/null || echo なし)"
grep -o '"type":"agent_message","text":"[^"]*"' "$B/out.jsonl"
rm -rf "$H"
