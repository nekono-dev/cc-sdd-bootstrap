# cc-sdd-bootstrap

cc-sdd（Kiro 方式の仕様駆動開発）の運用一式を、各プロジェクトへ 1 コマンドで導入・更新する仕組み。目的と方針は `.kiro/steering/`（product.md・tech.md・structure.md）、全体の分割と順序は `.kiro/steering/roadmap.md` を読む。

## cc-sdd の標準の決まり

次の取り込みは、cc-sdd が生成する標準の決まり（手順の段階・承認・ステアリングの読み込み）である。cc-sdd の導入物なのでコミットせず、導入のたびに版に合わせて作り直す。無いときは下の手順で導入する。

@.kiro/settings/cc-sdd-guide.md

## このリポジトリの決まり

- このリポジトリ自身も cc-sdd の手順で進める。仕様は `.kiro/specs/<spec名>/`、プロジェクト全体の決まりは `.kiro/steering/` に置く。決めたことは会話や自動メモリに残さず、これらのファイルに書く。
- 段階を飛ばさない: discovery → spec-init → requirements → design → tasks → impl。各段階の成果物は利用者の承認を得てから次へ進む（`-y` は利用者が明示したときだけ使う）。
- **実装は `/kiro-impl` でだけ行う。** tasks.md が承認される前に、このリポジトリのコード（配置物・導入コマンド・テスト）を書かない。PoC のスクリプトは設計の根拠を集めるためのもので、実装には数えない。
- `/kiro-*` を頼まれたら、`.claude/skills/<名前>/SKILL.md` を Read し、その手順を最後まで実行する（スキル一覧に載らないスキルがあるため）。手順が「提示して止まる」なら、そこで利用者に返す。
- Claude Code の動作に依存する前提は、設計の承認前に PoC（一時ディレクトリで実際の `claude -p` を動かす検証）で確かめ、再実行できるスクリプトと結果を残す。推測で設計しない。
- サブエージェント（Agent ツール）を使うときは、必ず `model` を指定し、指揮役（このセッション）と同じモデルにしない。強制のフック（spec: subagent-model-policy）ができるまでは、この決まりを手順で守る。

## cc-sdd の導入（自己適用ができるまでの暫定の仕組み）

導入物（`.claude/skills/kiro-*/`・`.kiro/settings/`）は `.gitignore` の対象で、コミットしない。セッション開始のたびに `scripts/agent/install-cc-sdd.sh --claude`（SessionStart のフック）が固定版（3.1.0）で入れ直す。標準の決まりの文書は、CLAUDE.md を書き換えないよう `.kiro/settings/cc-sdd-guide.md` に出力する。

- 導入に失敗・中断したら `.cache/cc-sdd-install.failed` が残り、`scripts/agent/install-gate.mjs`（UserPromptSubmit のフック）が次の入力を止める。再試行は Claude の外で `scripts/agent/install-cc-sdd.sh --claude`。
- SKILL.md が見つからないときは、導入が済んでいないと利用者に伝え、上の再試行を勧める。
- `scripts/agent/` のこの 2 つは、このリポジトリの開発用の暫定の道具（skyshare の同名のものを写した）。製品のコード（配置物・導入コマンド・テスト）には数えず、「実装は `/kiro-impl` でだけ行う」の対象外とする。installer-core の自己適用ができたら、その導入物（CLAUDE.md の管理区画を含む）に置き換えて消す。
- 版を上げるときは `install-cc-sdd.sh` の `CC_SDD_VERSION` を変え、`poc/self-install/run.sh` で導入と停止を確かめる。

## ブランチ

- 作業ブランチは `develop` と `dev/*`、切り出し元は `develop`、保護ブランチは `main`（`.branch-release-workflow.json`）。作業ブランチへの push と、作業ブランチから `develop` への PR の作成は許可なしで行う（宣言の `autoApprove` でフックが確認を省く）。`main` への commit・push・merge と、`develop` へのマージは利用者の許可を得てから行う。

## 書き方

- 文書・コードのコメント・利用者向けの出力は日本語で書く。専門用語は一般的な言葉に言い換えるか、初出で意味を添える。
