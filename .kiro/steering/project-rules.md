# このリポジトリの決まり

この文書は、このリポジトリで作業する人やエージェントが独自の開発ルールを確認するため、作業の開始時に読む。cc-sdd（Kiro 方式の仕様駆動開発）の運用一式を各プロジェクトへ 1 コマンドで導入・更新する仕組みである。目的と方針は `.kiro/steering/`（`product.md`・`tech.md`・`structure.md`）、全体の分割と順序は `.kiro/steering/roadmap.md` を読む。

## 開発の決まり

- このリポジトリ自身も cc-sdd の手順で進める。仕様は `.kiro/specs/<spec名>/`、プロジェクト全体の決まりは `.kiro/steering/` に置く。決めたことは会話や自動メモリに残さず、これらのファイルに書く。
- 段階を飛ばさない: discovery → spec-init → requirements → design → tasks → impl。各段階の成果物は利用者の承認を得てから次へ進む（`-y` は利用者が明示したときだけ使う）。
- **実装は `/kiro-impl` でだけ行う。** tasks.md が承認される前に、このリポジトリのコード（配置物・導入コマンド・テスト）を書かない。PoC（前提を確かめるための試作）のスクリプトは設計の根拠を集めるためのもので、実装には数えない。
- Claude Code・Codex の動作に依存する前提は、設計の承認前に一時ディレクトリで実際の CLI を動かす PoC で確かめる（Claude Code では `claude -p`、Codex では `codex exec` を実行する）。再実行できるスクリプトと結果を残し、推測で設計しない。
- 配置するファイルまたは導入コマンドを変更したときは、`node bin/cc-sdd-bootstrap.mjs update` を実行して結果をコミットする。cc-sdd の版を上げるときは `.cc-sdd-bootstrap.json` の `ccSdd.version` を変更し、`poc/self-install/run.mjs` で導入と停止を確かめる。
- 自己適用後は `CLAUDE.md`・`AGENTS.md` が導入のたびに作り直されるため、コミットしない。

## ブランチ

- 作業ブランチは `develop` と `dev/*`、切り出し元は `develop`、保護ブランチは `main`（`.branch-release-workflow.json`）。作業ブランチへの push と、作業ブランチから `develop` への PR の作成は許可なしで行う（宣言の `autoApprove` でフックが確認を省く）。`main` への commit・push・merge と、`develop` へのマージは利用者の許可を得てから行う。

## 書き方

- 文書・コードのコメント・利用者向けの出力は日本語で書く。専門用語は一般的な言葉に言い換えるか、初出で意味を添える。
