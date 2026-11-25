# 依頼: Codex のクラウドセッションでの前提の確認（codex-hook-trust）

あなたは Codex のクラウドセッションとして、次の前提を実際に確かめ、結果をファイルに書いて push してください。実装や設計の変更はしません。

## 背景
- リポジトリ: `nekono-dev/cc-sdd-bootstrap`、確認の起点にするブランチ: `dev/codex-hook-trust`（このブランチをクローン・チェックアウトして始める）。
- このリポジトリは cc-sdd（仕様駆動開発）の導入物を配置し、Codex のフックを `.codex/hooks.json` に登録する。Codex のフックは、(1) プロジェクトの信頼（`[projects."<道筋>"] trust_level = "trusted"`）と、(2) フックの信頼の承認（`[hooks.state."<hooks.json の道筋>:<イベント>:<番号>:<番号>"] trusted_hash`）の 2 段の確認が済むまで動かない、と手元の環境で確かめてある。
- 手元で作ろうとしている機能（`.kiro/specs/codex-hook-trust/`）は、導入・更新と準備スクリプトで (2) の記録を自動で書くもの。クラウドで (1)・(2) が実際にどう扱われるかが未確認で、それを確かめたい。
- 確認の手順の原型は `poc/codex-hook-trust/`（`run.mjs`・`probe.mjs`・`result.md`）にある。

## 決まり
- `.kiro/`・`lib/`・`.agent-hooks/` などの既存のファイルを変更しない。追加してよいのは結果のファイル `poc/codex-hook-trust/cloud-result.md` だけ。
- 認証情報（`auth.json` の中身・トークン・メールアドレス・環境変数の値のうち秘密のもの）を結果に書かない。`config.toml` は、表の見出しとキーの名前だけを書き、値は `trusted_hash` を含めて伏せずに構わないが、`auth`・`token`・`key` を含む項目は伏せる。
- 実行できなかった確認は、理由（コマンドと出力）を書いて「未確認」とする。推測で埋めない。
- PR は作らない。

## 最初にすること（セッション開始時の状態の記録）
他のコマンドを実行する前に、次を記録する。セッション開始のフックが動いたかを、後から判断する材料になる。
```sh
date -u
pwd; git rev-parse --show-toplevel; git status --short | head -20
ls -la --time-style=full-iso . .cache .agents CLAUDE.md AGENTS.md 2>&1 | head -60
cat .cache/cc-sdd-install.state.json 2>&1 | head -20
```

## 確認する事項
各事項は、実行したコマンドと出力（要点）、判断を書く。

1. **環境の事実**
   - `codex --version`、`which codex node git npx`、`node --version`
   - `echo "CODEX_HOME=$CODEX_HOME"`、`echo "HOME=$HOME"`
   - `ls -la ~/.codex ${CODEX_HOME:-} 2>&1`（`auth.json` の中身は見ない）
   - 設定ファイルが書けるか: `touch "${CODEX_HOME:-$HOME/.codex}/.probe" && rm "${CODEX_HOME:-$HOME/.codex}/.probe"`
   - ネットワークとサンドボックスの制限（外部へ通信できるか、`npx` が使えるか）がわかる範囲で。
2. **設定ファイルの中身（秘密を除く）**
   - `${CODEX_HOME:-$HOME/.codex}/config.toml` が無いか、あるか。ある場合は、表の見出しの一覧（`grep -n '^\[' …`）と、`[projects."…"]` にこのリポジトリの道筋があるか、`trust_level` の値。
   - `[hooks.state."…"]` の記録が最初から入っているか（あれば `.codex/hooks.json` のキーと一致するか）。
3. **プロジェクトの信頼（(1)）はクラウドで必要か**
   - このセッションで、`.codex/hooks.json` のフック（`install-cc-sdd.mjs` の `session-start`）が自動で動いたか。最初の記録（`.cache/cc-sdd-install.state.json`・`.agents/skills/kiro-*`・`AGENTS.md` の末尾の区画の有無と更新時刻）から判断する。
   - `codex exec` が使えるなら、`cd` した別の一時ディレクトリ（信頼されていない場所）で `codex exec --skip-git-repo-check "OK とだけ答えて"` を実行し、`Untrusted project-local configuration is disabled` の警告が出るか、出ないか（出力の該当行を記録）。使えないなら理由。
4. **フックの信頼の承認（(2)）はクラウドで必要か**
   - 3 でフックが動いていたなら、`[hooks.state]` に記録が無いのに動いたか（記録の有無と合わせて判断）。
   - `node poc/codex-hook-trust/run.mjs`（`POC_HOOKS_JSON=$PWD/.codex/hooks.json` を付ける）の出力。「記録なし」「一致」のどれか。
   - `node poc/codex-hook-trust/run.mjs --e2e` は、`codex exec` が認証済みで使えるときだけ実行し、出力を記録する（使えないなら理由）。
5. **承認を省く指定**
   - `codex exec --help | grep -n bypass`。
   - `codex exec` が使えるなら、`codex -a never exec --sandbox read-only --dangerously-bypass-hook-trust --skip-git-repo-check --cd "$PWD" "OK とだけ答えて"` の出力（フックの実行表示と、警告の有無）。
6. **準備スクリプトの経路**
   - 環境の準備スクリプト（セットアップスクリプト）が設定されているか、設定されていればその内容（わかる範囲で。`node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs` を呼んでいるか）。
   - 準備スクリプトが動く時点で `~/.codex` ディレクトリが既にあるか（セッション開始時の記録の `ls -la ~/.codex` と、準備スクリプトの実行時刻から推測できる範囲で）。
7. **worktree**: クラウドの checkout は通常の clone か（`git rev-parse --git-common-dir`、`git worktree list`）。

## 結果の書き方・戻し方
1. `poc/codex-hook-trust/cloud-result.md` に次の形で書く（日本語）。
   - 実行日・`codex --version`・環境の概要（1 段落）。
   - 事項ごとの表: 「確かめたこと」「コマンド」「出力の要点」「結論（確認済み／未確認）」。
   - 最後に「判断のまとめ」: (a) クラウドでプロジェクトの信頼が必要か、(b) クラウドでフックの承認が必要か、(c) 準備スクリプトの時点で `~/.codex` があるか、(d) このセッションでフックが自動で動いたか、の 4 点を 1 行ずつ。
2. 新しいブランチ `dev/codex-hook-trust-cloud`（`dev/codex-hook-trust` の先頭から切る）にコミットして push する。コミットメッセージは `poc(codex-hook-trust): クラウドでの前提の確認結果を追加する`。
3. 最後の返信に、判断のまとめ 4 行とブランチ名を書く。手元のセッションが `git fetch` して結果を読み、設計に反映する。
