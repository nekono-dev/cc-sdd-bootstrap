#!/usr/bin/env bash
# PoC: `npx github:<owner>/<repo>#<ref>` で、外部パッケージなしの bin が動くことを確かめる（installer-core の設計の前提）。
#
# 確かめること
#   1. 公開リポジトリから認証なしで取得でき、bin（先頭に #!/usr/bin/env node）が実行される
#   2. bin のカレントディレクトリは、npx を実行した場所のまま（導入先＝カレントにできる）
#   3. bin から自分のパッケージのルートを求め、同梱のファイルを読める
#   4. package.json の files に無いファイルは同梱されない（配る範囲を files で絞れる）
#   5. 同梱のシェルスクリプトの実行権限が保たれるか（保たれなければ導入時に付け直す必要がある）
#   6. 引数がそのまま bin に渡る
#
# 方法: 最小のパッケージだけを持つ一時ブランチ（dev/poc-npx-bin、履歴を持たない）を push し、
# 一時ディレクトリから npx で実行して確かめ、最後に一時ブランチを消す。
#
# 使い方: poc/npx-bin/run.sh
# 必要なもの: node、npx、git、origin への push の権限（作業ブランチ dev/* への push は許可不要の決まり）
set -uo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
remote_url="$(git -C "$repo" remote get-url origin)"
branch="dev/poc-npx-bin"
spec="github:nekono-dev/cc-sdd-bootstrap#${branch}"
work="$(mktemp -d)"
cleanup() {
  git -C "$work/pkg" push -q origin --delete "$branch" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

# --- 最小のパッケージを作る ---
pkg="$work/pkg"
mkdir -p "$pkg/bin" "$pkg/payload"
cat > "$pkg/package.json" << 'JSON'
{
  "name": "cc-sdd-bootstrap",
  "version": "0.0.0-poc",
  "type": "module",
  "bin": { "cc-sdd-bootstrap": "bin/cc-sdd-bootstrap.mjs" },
  "files": ["bin/", "payload/"],
  "engines": { "node": ">=22" }
}
JSON
cat > "$pkg/bin/cc-sdd-bootstrap.mjs" << 'JS'
#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sh = path.join(root, "payload", "hook.sh")
const result = {
  cwd: process.cwd(),
  args: process.argv.slice(2),
  payload: fs.readFileSync(path.join(root, "payload", "data.txt"), "utf8").trim(),
  excludedShipped: fs.existsSync(path.join(root, "excluded.txt")),
  shMode: (fs.statSync(sh).mode & 0o777).toString(8),
}
process.stdout.write(`${JSON.stringify(result)}\n`)
JS
chmod +x "$pkg/bin/cc-sdd-bootstrap.mjs"
echo "payload-ok" > "$pkg/payload/data.txt"
printf '#!/bin/sh\necho hook\n' > "$pkg/payload/hook.sh"
chmod +x "$pkg/payload/hook.sh"
echo "これは配らない" > "$pkg/excluded.txt"
(
  cd "$pkg" &&
    git init -q -b "$branch" &&
    git add -A &&
    git -c user.name=poc -c user.email=poc@example.invalid commit -qm "PoC: npx github の bin" &&
    git remote add origin "$remote_url" &&
    git push -q -f origin "$branch"
) || { echo "一時ブランチの push に失敗しました"; exit 1; }

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

# --- 実行する（npx のキャッシュを分け、以前の取得結果を使わない） ---
target="$work/target"
mkdir -p "$target"
out="$(cd "$target" && npm_config_cache="$work/npm-cache" npx --yes "$spec" init --lang ja 2>"$work/npx.err")"
status=$?
echo "     出力: $out（終了コード $status）"
[ -s "$work/npx.err" ] && sed 's/^/     stderr: /' "$work/npx.err" | head -5

field() { node -e 'const o=JSON.parse(process.argv[1]);const v=o[process.argv[2]];process.stdout.write(typeof v==="string"?v:JSON.stringify(v))' "$out" "$1" 2>/dev/null; }

check "1: bin が実行された（終了コード 0）" test "$status" -eq 0
check "2: カレントは npx を実行した場所" test "$(field cwd)" = "$target"
check "3: 同梱のファイルを読める" test "$(field payload)" = "payload-ok"
check "4: files に無いファイルは同梱されない" test "$(field excludedShipped)" = "false"
check "6: 引数がそのまま渡る" test "$(field args)" = '["init","--lang","ja"]'
echo "     5: 同梱のシェルスクリプトの権限 = $(field shMode)（755 なら保たれる。644 なら導入時に付け直す）"

echo "結果: OK ${pass} 件、NG ${fail} 件"
[ "$fail" -eq 0 ]
