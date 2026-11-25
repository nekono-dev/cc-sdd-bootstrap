# クラウドでの前提の確認結果

実行日: 2026-11-25 UTC。Codex は `codex-cli 0.172.0-alpha.2`、Node は `v24.22.3`。クラウドセッションは `/workspace` から始まり、そこは Git リポジトリではなかった。既存の `/workspace/cc-sdd-bootstrap` は空の作業ツリーだったため、開始後に `dev/codex-hook-trust` の先頭 `de9b633918b5e8a7dd3eba3fd2661858e913ee2f` を `/workspace/hook-trust-check` に clone した。セッション開始時に対象ブランチが checkout されておらず、そのフック実行は観察できない。

| 確かめたこと | コマンド | 出力の要点 | 結論（確認済み／未確認） |
|---|---|---|---|
| 開始時の位置と状態 | `date -u; pwd; git rev-parse --show-toplevel; git status --short \| head -20` | 10:51:48 UTC、`/workspace`、Git の両コマンドは `fatal: not a git repository (or any of the parent directories): .git` | 確認済み。対象 checkout 外 |
| 開始時の成果物 | `ls -la --time-style=full-iso . .cache .agents CLAUDE.md AGENTS.md 2>&1 \| head -60`; `cat .cache/cc-sdd-install.state.json 2>&1 \| head -20` | `.cache`、`CLAUDE.md`、`AGENTS.md`、state は `No such file or directory`、`.agents` は空。`/workspace/cc-sdd-bootstrap` が存在 | 確認済み。対象 checkout 外 |
| 既存ディレクトリの開始直後 | 同じ開始時コマンドを `/workspace/cc-sdd-bootstrap` で実行 | 10:51:53 UTC、Git のルートは同ディレクトリ、status 出力なし。作業ツリーは `.git` のみ、`.cache`、`.agents`、`CLAUDE.md`、`AGENTS.md`、state は存在せず | 確認済み。ブランチは後の `git status -sb; git log -1 --oneline` で `work`、`86abb67 Initial commit` |
| 実行環境 | `codex --version; which codex node git npx; node --version` | codex `/opt/codex/bin/codex`、node と npx は `/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/`、git `/usr/local/bin/git`。codex は PATH aliases 作成時に `Read-only file system` の警告 | 確認済み |
| 設定ディレクトリ | `echo "CODEX_HOME=$CODEX_HOME"; echo "HOME=$HOME"; ls -la ~/.codex ${CODEX_HOME:-} 2>&1` | `CODEX_HOME=/home/agent/.codex`、`HOME=/home/agent`。`auth.json` は存在、内容は未閲覧。`config.toml` は 0 バイト | 確認済み。開始時の指定4コマンド実行後の観測 |
| 設定への書き込み | `touch "${CODEX_HOME:-$HOME/.codex}/.probe" && rm "${CODEX_HOME:-$HOME/.codex}/.probe"` | `touch: cannot touch '/home/agent/.codex/.probe': Read-only file system` | 書き込み不可を確認済み |
| 設定の表と信頼記録 | `grep -n '^\[' "${CODEX_HOME:-$HOME/.codex}/config.toml"` | 出力なし。ファイルは 0 バイトのため表もキーもなく、対象パスの `trust_level` と `[hooks.state."…"]` は存在しない | 記録なしを確認済み。hooks.json のキーとの一致対象なし |
| 通信と npx | `git ls-remote --heads origin dev/codex-hook-trust dev/codex-hook-trust-cloud`; `npm ping --fetch-timeout=10000 --fetch-retries=0`; `npx --version`; `npx --no-install npm --version` | GitHub 読み取り成功、npm registry は `PONG`、npx は `11.19.1`。最後のコマンドは `/home/agent/.npm/_cacache` の `mkdir` が `ENOENT` で失敗 | 通信と npx の存在は確認済み。通常のパッケージ実行は未確認。環境 status はネットワークを `restricted` / `enforced` と報告し、GitHub と npm registry は許可先 |
| プロジェクトの信頼 | `/tmp/codex-hook-untrusted` で `timeout 45s codex exec --skip-git-repo-check 'OK とだけ答えて'` | `Error: failed to initialize in-process app-server client: Read-only file system (os error 30)`、終了コード 1。`Untrusted project-local configuration is disabled` は出力されなかった | 未確認。初期化失敗のため警告の有無から必要性を判断できない |
| 開始フックと承認 | 開始時記録、`ls -la .cache .agents AGENTS.md 2>&1`、空の config | 対象ブランチは開始後に clone。clone 後も `.cache`、`.agents`、`AGENTS.md` は存在せず。承認記録なし | セッション開始時の対象フック実行は未確認。承認なしで動いた証拠もない |
| フック承認の照合 | `POC_HOOKS_JSON=$PWD/.codex/hooks.json node poc/codex-hook-trust/run.mjs` | `承認済みの記録との突き合わせ: 一致 0 / 不一致 0 / 記録なし 8` | 8件とも記録なしを確認済み |
| E2E | `node poc/codex-hook-trust/run.mjs --e2e` | `codex exec` が上記の通り初期化できないため、指定の実行条件を満たさず実行せず | 未確認 |
| 承認省略オプション | `codex exec --help \| grep -n bypass` | 67: `--dangerously-bypass-approvals-and-sandbox`、71: `--dangerously-bypass-hook-trust` | オプションの存在は確認済み |
| 承認省略の動作 | `codex -a never exec --sandbox read-only --dangerously-bypass-hook-trust --skip-git-repo-check --cd "$PWD" 'OK とだけ答えて'` | `codex exec` が初期化できないため、指定の実行条件を満たさず実行せず | フック表示と警告は未確認 |
| 準備スクリプト | 環境 status と開始時のファイルを確認 | status にスクリプト内容や実行時刻は含まれず、開始時の成果物も見つからない。`ls -ld --time-style=full-iso ~/.codex` はディレクトリ時刻 `2026-11-25 19:51:31 +0900` | 設定・実行・installer 呼び出しは未確認。ディレクトリ時刻だけでは準備スクリプト時点の存在を確定できない |
| worktree | clone 先で `git rev-parse --git-common-dir; git worktree list` | `.git`、`/workspace/hook-trust-check de9b633 [dev/codex-hook-trust]` | clone 後は通常の clone で worktree は1件と確認済み。セッション開始時は対象 checkout なし |

## 判断のまとめ

- (a) クラウドでプロジェクトの信頼が必要か: 未確認（`codex exec` の初期化失敗）。
- (b) クラウドでフックの承認が必要か: 未確認（8件の承認記録はないが、実行検証不可）。
- (c) 準備スクリプトの時点で `~/.codex` があるか: 未確認（準備スクリプトの設定と実行時刻が不明）。
- (d) このセッションで対象フックが自動で動いたか: 未確認（対象ブランチはセッション開始後に clone）。
