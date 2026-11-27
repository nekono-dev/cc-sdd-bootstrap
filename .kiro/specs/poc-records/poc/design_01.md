- 対象: PoC のスクリプトをリポジトリの管理対象の外で実行しても、両ツールの指揮役がリポジトリの `git status` を変えずに結果を得られること（要件 3.1・3.2・3.4、`feasibility.md` の前提 (a)）
- 段階: design

## 実施内容の要点
- 使い捨ての git リポジトリ（`.kiro/specs/demo/spec.json` だけを 1 コミット）を、リポジトリの外の作業場所に作った。
- 指揮役に、「スクリプトや出力は `mktemp -d` の一時ディレクトリで実行し、リポジトリの中には結果の文書だけを置く」という決まりを渡し、前提「node で `console.log(1+1)` を実行すると 2 と出る」を確かめさせた。
- 実行後に、リポジトリの `git status --porcelain` と `.kiro/specs/demo/` の中身を見た。
- Claude Code は `claude -p`（`--setting-sources project`、`--permission-mode acceptEdits`、`--allowedTools Bash,Read,Write,Edit`、モデルは haiku）、Codex は `codex -a never exec -s workspace-write`（認証は使い捨ての `CODEX_HOME` に写して実行後に削除）で動かした。

## 実施日・環境と版
- 実施日: 2026-11-26
- 環境: Linux 6.8.0（Ubuntu）、Node.js v22.16.0、Claude Code 2.1.329、Codex CLI 0.172.0

## 結果
- 両ツールとも、スクリプトを一時ディレクトリで作って実行し、`git status --porcelain` は `?? .kiro/specs/demo/poc/`（PoC 文書の追加）だけだった。`.kiro/specs/demo/` の中は `spec.json` と `poc/` だけで、スクリプトも出力も残らなかった。
- Codex の `workspace-write` でも、`/tmp` 配下の一時ディレクトリへの書き込みと実行はできた。リポジトリの外へ書けないという既存の観察は、リポジトリの外の別の作業場所（別の worktree）の場合であり、一時ディレクトリは対象外だった。
- Claude Code は、`--allowedTools` で Bash を許可しない場合、`node` の実行と一時ディレクトリの作成が承認待ちになり、確認が終わらなかった（最初の実行で観察）。対話の画面では承認の確認が出る場面にあたる。

## 仕様への反映
- 運用の区画の文章は、一時ディレクトリでの実行を求める（要件 3.2）。実行の承認が必要な環境があることを、設計の運用の注意に書く。
- 確かめられなかったこと: リモートのクラウド環境と、承認の自動判定（auto モード）での挙動。
