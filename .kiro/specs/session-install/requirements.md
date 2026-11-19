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

**要件の段階で決めたこと**（2026-11-19、利用者の回答）: 版・言語が前回と同じで、導入物が揃い中身も導入時から変わっていなければ入れ直しを省く。設定ファイルが無い・読めない・値が不正なら導入の失敗として止める。入れ直すときは前回の導入物を消してから入れる（新しい版に無いスキルを残さない）。Codex 向けの導入物は扱わない。設定の雛形（`.kiro/settings/templates/`）は、既定では `.gitignore` の対象として毎回入れ替え、設定の選択で上書きせずに保持できるようにする（2026-11-19、利用者の指示）。導入の実行方法（シェルスクリプトのままか Node に寄せるか）と、同時に始まったセッションの排他の方法は設計で決める。

詳細は同じディレクトリの `brief.md` を参照。

## Introduction
cc-sdd-bootstrap を導入したリポジトリでは、cc-sdd の導入物（スキル・設定の雛形・標準の決まりの文書）をコミットしない。この spec は、セッションの開始のたびに設定ファイルの版と言語で導入物を揃え、揃えられなかったときは次の入力を理由と再試行の方法つきで止める仕組み（以下「セッション導入」）を定める。installer-core が初期の配置物として置いた 2 本のスクリプトの動きを引き継ぎ、版と言語を設定ファイルから読むように一般化する。

## Boundary Context
- **In scope**: セッション開始時の導入物の確認と入れ直し、入れ直しの省略、設定の雛形の保持（選択制）、失敗・中断の記録、次の入力の停止と再試行の案内、導入直後にスキル一覧に載らないスキルの案内、CLAUDE.md の管理区画への運用の説明。
- **Out of scope**: 手順書を先に読ませる強制（kiro-gate）、BRW（branch-release-workflow）の導入確保、cc-sdd のスキルの内容の改変、導入物をコミットする運用、cc-sdd の Codex 向けの導入物（codex-delegation 以降で扱う）、設定ファイルの作成・検証の規則そのもの（installer-core）。
- **Adjacent expectations**:
  - installer-core が設定ファイル `.cc-sdd-bootstrap.json`（`ccSdd.version`・`ccSdd.lang`）の形式と検証の規則を定め、セッション導入のファイルを `.agent-hooks/cc-sdd-bootstrap/` に配置し、セッション開始時と入力時のフックを `.claude/settings.json` に登録し、CLAUDE.md の管理区画から `.kiro/settings/cc-sdd-guide.md` を取り込む。セッション導入はこれらを前提にし、同じ検証の規則で設定を判定する。
  - 設定の雛形の保持の選択（Requirement 7）は、installer-core の設定ファイルに項目を 1 つ足し、installer-core の導入・更新がその値に応じて `.gitignore` の管理区画を書く。項目の追加と `.gitignore` の書き分けはこの spec が installer-core の仕組みに載せて行う。
  - kiro-gate は、セッション導入が導入したスキルの場所（`.claude/skills/kiro-*/SKILL.md`）を前提にする。
  - cc-sdd の配布元（パッケージの取得元）に通信できることを前提にする。通信できない場合は、入れ直しを省ける場合を除き導入の失敗として扱う。

## Requirements

### Requirement 1: 設定の版と言語による導入
**Objective:** As a 導入先のリポジトリの開発者, I want セッションの開始のたびに設定ファイルの版と言語で cc-sdd の導入物が揃ってほしい, so that clone 直後やクラウドセッションでも、決めた版の `/kiro-*` をすぐに使える

#### Acceptance Criteria
1. When セッションが開始し、入れ直しを省く条件（Requirement 2）を満たさない, the セッション導入 shall 雛形の保持を選んだ場合（Requirement 7）を除き、 設定ファイルの `ccSdd.version` の版と `ccSdd.lang` の言語で、cc-sdd のスキル（`.claude/skills/kiro-*/`）・設定の雛形（`.kiro/settings/templates/`）・標準の決まりの文書（`.kiro/settings/cc-sdd-guide.md`）を導入する。
2. When 入れ直しを行う, the セッション導入 shall 雛形の保持を選んだ場合の `.kiro/settings/templates/` を除き、前回の導入物の場所（`.claude/skills/` の下の `kiro-` で始まるディレクトリ、`.kiro/settings/templates/`、`.kiro/settings/cc-sdd-guide.md`）を消してから導入し、導入後に新しい版に無いスキルを残さない。
3. The セッション導入 shall CLAUDE.md を作成・変更しない。
4. The セッション導入 shall 1.1・1.2 に挙げた導入物の場所、失敗の記録、導入状態の記録の他のファイルを作成・変更・削除しない（`.claude/skills/` の下の `kiro-` で始まらないスキルや、`.kiro/steering/`・`.kiro/specs/` には触れない）。
5. When 導入が成功する, the セッション導入 shall 導入した版と言語、および導入物の場所を、セッションの文脈に入る形で 1〜3 行で知らせる。
6. The セッション導入 shall cc-sdd の導入処理が出す途中経過の出力を、セッションの文脈に入れない。
7. If 設定ファイルが無い、JSON として読めない、または `ccSdd.version`・`ccSdd.lang` が installer-core の検証の規則に合わない, the セッション導入 shall 導入を行わず導入の失敗として扱い（Requirement 3）、失敗の理由にどのファイル・どの値が問題かと直し方を含める。

### Requirement 2: 入れ直しの省略
**Objective:** As a 導入先のリポジトリの開発者, I want 導入物が設定どおりに揃っているときは入れ直しを省いてほしい, so that セッションの開始が速くなり、通信できない状況でも作業を始められる

#### Acceptance Criteria
1. When セッションが開始し、前回の成功した導入の版・言語が設定ファイルの版・言語と同じで、前回導入したファイルがすべて存在し、各ファイルの中身が導入時から変わっていない, the セッション導入 shall 入れ直しを省き、cc-sdd の配布元に通信しない。
2. If 前回導入したファイルのうち 1 つでも無い、または中身が導入時から変わっている, the セッション導入 shall 入れ直しを行う。
3. If 設定ファイルの版または言語が前回の成功した導入と異なる, the セッション導入 shall 入れ直しを行う。
4. If 前回の成功した導入の記録が無い、または読めない, the セッション導入 shall 入れ直しを行う。
5. While 失敗の記録が残っている, the セッション導入 shall 入れ直しを省かない。
6. When 入れ直しを省く, the セッション導入 shall 省いたことと版・言語を、セッションの文脈に入る形で 1 行で知らせ、失敗の記録を作らない。
7. When 導入が成功する, the セッション導入 shall 次回の省略の判定に使うため、版・言語と導入したファイルごとの中身の指紋（内容から計算する短い識別値）を記録する。
8. The セッション導入 shall 導入状態の記録をコミットの対象にしない（`.gitignore` の対象にする）。

### Requirement 3: 失敗・中断の記録と次の入力の停止
**Objective:** As a 導入先のリポジトリの開発者, I want 導入が失敗・中断したら次の入力が理由と再試行の方法つきで止まってほしい, so that スキルの無いまま、または古い版のまま作業を進めてしまわない

#### Acceptance Criteria
1. When 入れ直しを始める, the セッション導入 shall 導入が完了していないことを示す失敗の記録を、導入物を変更する前に残す。
2. When 導入が成功する, the セッション導入 shall 失敗の記録を消す。
3. If 導入が失敗する, the セッション導入 shall 失敗の記録に失敗の理由（設定の不備・取得の失敗・導入処理の終了コードなど）と再試行の方法を書き、セッション開始時の出力でも同じ内容を知らせる。
4. If 導入が時間切れや強制終了で途中で止まる, the セッション導入 shall 失敗の記録が残った状態にし、次の入力を止められるようにする。
5. While 失敗の記録が残っている, when 利用者がプロンプトを送る, the セッション導入 shall そのプロンプトを止め、導入が完了していないこと、記録に書かれた理由、新しいセッションを開くと再試行されること、および Claude の外で実行する再試行のコマンドを示す。
6. While 失敗の記録が無い, when 利用者がプロンプトを送る, the セッション導入 shall プロンプトを止めず、何も出力しない。
7. When 利用者が再試行のコマンドを Claude の外で実行して導入が成功する, the セッション導入 shall 失敗の記録を消し、以後のプロンプトを止めない。
8. If プロンプトの停止の判定そのものが予期しない誤りで行えない, the セッション導入 shall 誤りの内容を標準エラーに出し、プロンプトを止めない。
9. Where 失敗の記録を持つ導入の対象が複数ある, the セッション導入 shall 記録の残っている対象ごとに名前・理由・再試行の方法を並べて示す。
10. The セッション導入 shall 失敗の記録をコミットの対象にしない（`.gitignore` の対象にする）。

### Requirement 4: 同時に始まったセッション
**Objective:** As a 同じリポジトリで複数のセッションを開く開発者, I want 同時に始まったセッションの導入が互いを壊さないでほしい, so that 導入物が混ざった状態で作業が始まらない

#### Acceptance Criteria
1. If 同じリポジトリで複数のセッションの導入が同時に行われる, the セッション導入 shall 各セッションの結果を「成功（入れ直しの省略を含む）」か「失敗の記録を残す」のどちらかにし、導入物が欠けた・混ざった状態で成功と知らせない。
2. If 他のセッションの導入が終わるのを待つ場合, the セッション導入 shall 待つ時間をセッション開始のフックの時間制限の内に収め、超えるときは失敗として扱い再試行の方法を示す。

### Requirement 5: 導入直後の案内
**Objective:** As a 導入直後のセッションで作業を始める開発者, I want スキル一覧に載らないスキルも使えるよう案内されたい, so that 導入したばかりのスキルが見つからず作業が止まることがない

#### Acceptance Criteria
1. When 導入が成功する（入れ直しの省略を含む）, the セッション導入 shall 一覧に載らないスキルは対応する `.claude/skills/<名前>/SKILL.md` を読んでその手順を実行するよう、セッションの文脈に入る形で案内する。
2. The セッション導入 shall CLAUDE.md の管理区画に、導入物がセッション開始時に入ること、導入が完了していなければ入力が止まること、再試行のコマンド、および SKILL.md が見つからないときは導入の未完了を利用者に伝えて再試行を勧めることを、installer-core の管理区画の仕組みを通して載せる。

### Requirement 6: 初期の配置物の引き継ぎと配置
**Objective:** As a cc-sdd-bootstrap の利用者, I want installer-core の導入・更新のコマンドで新しいセッション導入が配置されてほしい, so that 既存の導入先も `update` を 1 回実行するだけで設定の版と言語が反映される

#### Acceptance Criteria
1. When 利用者が installer-core の導入（`init`）または更新（`update`）を実行する, the cc-sdd-bootstrap shall セッション導入のファイルを配置し、セッション開始時と入力時のフックを登録した状態にする。
2. When 初期の配置物（版 3.1.0・言語 ja を固定したスクリプト）が置かれた導入先で `update` を実行する, the cc-sdd-bootstrap shall それを設定ファイルの版と言語を読むセッション導入に置き換え、利用者に追加の手作業を求めない。
3. When `update` で配置物が置き換わった後の最初のセッションが開始する, the セッション導入 shall 導入状態の記録が無いものとして入れ直しを行う。
4. The セッション導入 shall 導入先のリポジトリの中だけで動き、cc-sdd-bootstrap のパッケージやプラグインが無くても動く。
5. When 利用者が `uninstall` を実行する, the cc-sdd-bootstrap shall セッション導入のファイルとフックの登録を取り除き、`.gitignore` の除外が外れて git の未追跡として現れる失敗の記録・導入状態の記録を、installer-core の uninstall が示す一覧（不要なら削除する道筋）に含める。

### Requirement 7: 設定の雛形の保持（選択制）
**Objective:** As a cc-sdd の雛形（要件・設計・タスクの書式）を自分のプロジェクト向けに書き換えたい開発者, I want 雛形を毎回の入れ直しで上書きせずに保持する設定を選べるようにしたい, so that 書き換えた雛形をコミットして使い続けられる

#### Acceptance Criteria
1. The cc-sdd-bootstrap shall 設定ファイルに雛形の保持を選ぶ項目を持ち、既定値を「保持しない」にする。導入（`init`）の対話と引数でも選べるようにする。
2. While 雛形の保持を選んでいない, the セッション導入 shall `.kiro/settings/templates/` を他の導入物と同じく `.gitignore` の対象にし、入れ直しのたびに消してから入れ替える。
3. While 雛形の保持を選んでいる, when 入れ直しを行う, the セッション導入 shall `.kiro/settings/templates/` の既存のファイルを消さず上書きもしない。
4. While 雛形の保持を選んでいる, if `.kiro/settings/templates/` が無い, the セッション導入 shall 設定の版と言語の雛形を置く。
5. While 雛形の保持を選んでいる, the セッション導入 shall `.kiro/settings/templates/` の中身の変更を入れ直しの理由（Requirement 2.2）にしない。
6. While 雛形の保持を選んでいる, the cc-sdd-bootstrap shall `.kiro/settings/templates/` を `.gitignore` の除外の対象から外し、コミットできる状態にする（他の導入物は引き続き除外する）。
7. While 雛形の保持を選んでいる, when 設定の版が雛形を置いたときの版と異なる状態で導入が成功する, the セッション導入 shall 雛形は保持したため新しい版の雛形とは異なりうることと、入れ替えたい場合の手順を、セッションの文脈に入る形で 1 行で知らせる。
8. When 利用者が雛形の保持の選択を変えて `update` を実行する, the cc-sdd-bootstrap shall `.gitignore` の管理区画を選択に合わせて書き直す。
9. When 利用者が雛形の保持を選ぶ, the cc-sdd-bootstrap shall 雛形は cc-sdd の成果物（MIT ライセンス）であり、コミットする場合はそのライセンスに従う必要があることを知らせる。
