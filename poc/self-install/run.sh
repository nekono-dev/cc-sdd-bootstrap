#!/usr/bin/env bash
# PoC: 実際の Claude Code でセッション導入・省略・停止・手動再試行を確かめる。
# 必要なもの: claude（認証済み）、Node.js 22、npx、git、cc-sdd の配布元（npm レジストリ）への通信。
# 使い方: poc/self-install/run.sh
set -uo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

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

if ! command -v claude >/dev/null 2>&1; then
  echo "NG   claude が見つからない（Claude Code と認証が必要）"
  echo "結果: OK $pass 件、NG $((fail + 1)) 件"
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  echo "NG   node・npx・git が必要"
  echo "結果: OK $pass 件、NG $((fail + 1)) 件"
  exit 1
fi

# init が作る利用者側のファイルだけを含む、導入直後のリポジトリを作る。
make_fresh_repo() {
  local dest="$1"
  mkdir -p "$dest"
  (cd "$dest" && git init -q && node "$repo/bin/cc-sdd-bootstrap.mjs" init)
  local init_status=$?
  if [ "$init_status" -ne 0 ]; then
    echo "NG   init に失敗（終了コード $init_status）: $dest"
    return 1
  fi
  cp "$dest/CLAUDE.md" "$dest.before-poc"
  (cd "$dest" && git add -A && git -c user.name=poc -c user.email=poc@example.invalid commit -qm poc)
  test ! -e "$dest/.claude/skills/kiro-impl/SKILL.md"
}

real_npx="$(command -v npx)"
mkdir -p "$work/fakebin" "$work/failbin"
cat > "$work/fakebin/npx" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$POC_NPX_LOG"
exec "$POC_REAL_NPX" "$@"
SH
cat > "$work/failbin/npx" <<'SH'
#!/bin/sh
echo "PoC: 失敗させた npx" >&2
exit 7
SH
chmod +x "$work/fakebin/npx" "$work/failbin/npx"

# --- 1・2. 初回導入と、続くセッションでの省略 ---
ok_dir="$work/ok"
mkdir -p "$ok_dir"
if make_fresh_repo "$ok_dir"; then
  check "1-前提: init 直後は導入物が無い" test ! -e "$ok_dir/.claude/skills/kiro-impl/SKILL.md"
  export POC_NPX_LOG="$work/npx.log" POC_REAL_NPX="$real_npx"
  : > "$POC_NPX_LOG"
  ok_out="$(cd "$ok_dir" && PATH="$work/fakebin:$PATH" claude -p "PONG とだけ答えてください。" 2>"$work/ok-1.err")"
  ok_status=$?
  echo "     1 回目の応答: $ok_out（終了コード $ok_status）"
  check "1: セッション導入が完了" test -f "$ok_dir/.claude/skills/kiro-impl/SKILL.md"
  check "1: 雛形が入った" test -f "$ok_dir/.kiro/settings/templates/specs/tasks.md"
  check "1: 標準の決まりの文書が入った" test -f "$ok_dir/.kiro/settings/cc-sdd-guide.md"
  check "1: 導入状態の記録がある" test -f "$ok_dir/.cache/cc-sdd-install.state.json"
  check "1: 失敗の記録が無い" test ! -e "$ok_dir/.cache/cc-sdd-install.failed"
  check "1: プロンプトが通った（応答に PONG）" grep -q PONG <<<"$ok_out"
  check "1: CLAUDE.md は変わっていない" cmp -s "$ok_dir.before-poc" "$ok_dir/CLAUDE.md"
  check "1: 導入物は git の変更に出ない" test -z "$(cd "$ok_dir" && git status --porcelain)"
  npx_count="$(wc -l < "$POC_NPX_LOG")"
  check "1: 初回に npx が 1 回呼ばれた" test "$npx_count" -eq 1

  ok_out_2="$(cd "$ok_dir" && PATH="$work/fakebin:$PATH" claude -p "PONG とだけ答えてください。" 2>"$work/ok-2.err")"
  ok_status_2=$?
  echo "     2 回目の応答: $ok_out_2（終了コード $ok_status_2）"
  check "2: 2 回目のプロンプトが通った（応答に PONG）" grep -q PONG <<<"$ok_out_2"
  check "2: 失敗の記録が無い" test ! -e "$ok_dir/.cache/cc-sdd-install.failed"
  check "2: 導入が省略され npx 呼び出し数が増えない" test "$(wc -l < "$POC_NPX_LOG")" -eq "$npx_count"
else
  check "1: init 直後の状態を作成" false
fi

# --- 3・4. 導入失敗による入力停止と、Claude の外からの再試行 ---
ng_dir="$work/ng"
mkdir -p "$ng_dir"
if make_fresh_repo "$ng_dir"; then
  ng_out="$(cd "$ng_dir" && PATH="$work/failbin:$PATH" claude -p "PONG とだけ答えてください。" 2>"$work/ng.err")"
  ng_status=$?
  echo "     停止時の応答: $ng_out（終了コード $ng_status）"
  check "3: 失敗の記録が残った" test -f "$ng_dir/.cache/cc-sdd-install.failed"
  check "3: 記録に「終了コードが 7」の理由がある" grep -qF "npx の終了コードが 7 でした" "$ng_dir/.cache/cc-sdd-install.failed"
  check "3: 入力が止まった（応答に PONG が無い）" bash -c '! grep -q PONG <<<"$1"' _ "$ng_out"
  # モデルが通常の回答として返したのではなく、フックが入力を拒否したことを、拒否の表示で確かめる
  check "3: フックが入力を拒否した（拒否の表示がある）" grep -qF "UserPromptSubmit operation blocked by hook" <<<"$ng_out"
  check "3: 停止の理由に失敗の理由（終了コード 7）がある" grep -qF "npx の終了コードが 7 でした" <<<"$ng_out"
  check "3: 停止の理由に再試行のコマンドがある" grep -qF "node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs" <<<"$ng_out"

  (cd "$ng_dir" && node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs)
  retry_status=$?
  check "4: 手動再試行が成功（終了コード 0）" test "$retry_status" -eq 0
  check "4: 成功後に失敗の記録が消えた" test ! -e "$ng_dir/.cache/cc-sdd-install.failed"
  recovered_out="$(cd "$ng_dir" && claude -p "PONG とだけ答えてください。" 2>"$work/recovered.err")"
  recovered_status=$?
  echo "     再試行後の応答: $recovered_out（終了コード $recovered_status）"
  check "4: 再試行後のプロンプトが通った（応答に PONG）" grep -q PONG <<<"$recovered_out"
else
  check "3: init 直後の状態を作成" false
fi

echo "結果: OK $pass 件、NG $fail 件"
[ "$fail" -eq 0 ]
