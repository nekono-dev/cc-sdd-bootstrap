# Requirements Document

## Project Description (Input)
**誰が困っているか**: cc-sdd-bootstrap で cc-sdd の運用を導入したリポジトリの開発者（クラウドセッションや clone 直後に作業を始める人を含む）。

**今の状況**: cc-sdd の導入物（スキル・雛形・標準の決まりの文書）はライセンスが異なるのでコミットせず、clone 直後やクラウドセッションの開始時には存在しない。installer-core が初期の配置物として置いた `.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.sh`（SessionStart）と `install-gate.mjs`（UserPromptSubmit）が、skyshare の仕組みをそのまま写した形で入れ直しと停止を行っている。ただし版（3.1.0）と言語（ja）がスクリプトに直書きで、設定ファイル `.cc-sdd-bootstrap.json` の `ccSdd.version`・`ccSdd.lang` を読まない。毎回の入れ直しには時間がかかり、同時に始まった複数のセッションが同じファイルを書く可能性もある。

**何が変わるべきか**:
- セッション開始のたびに、設定ファイルの版・言語で cc-sdd の導入物が入れ直される。CLAUDE.md は書き換えず、標準の決まりの文書は `.kiro/settings/cc-sdd-guide.md` に出力する（CLAUDE.md からの取り込みは installer-core が済ませている）。
- 導入に失敗した・途中で止まったときは、次の入力が理由と再試行の方法つきで止まる。成功したら止める状態が消える。
- 導入直後でスキル一覧に載らないスキルも、手順書を直接読んで使えるよう案内される。
- installer-core の初期の配置物（2 本のスクリプト）の中身をこの spec が引き継ぎ、汎用化する。配置・フックの登録の仕組みは installer-core のもの（カタログ）を使う。

**範囲外**: 手順書を読ませる強制（kiro-gate）、BRW の導入確保、cc-sdd のスキルの内容の改変、導入物をコミットする運用。

**要件の段階で決めること**（brief より）: 版が同じで導入物が揃っていれば入れ直しを省くか。導入の実行方法（シェルスクリプトのままか Node に寄せるか）と、同時に始まったセッションの排他は設計で決める。

詳細は同じディレクトリの `brief.md` を参照。

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->
