# Requirements Document

## Project Description (Input)
**誰が困っているか**: cc-sdd（Kiro 方式の仕様駆動開発）の運用を新しいリポジトリで始めたい開発者と、その運用を複数のリポジトリで保守する開発者。

**今の状況**: skyshare では、フックの登録・`scripts/agent/` のスクリプト・`.gitignore`・CLAUDE.md の追記を手で揃えた。汎用の導入手段は無く、新しいリポジトリでは同じ作業を繰り返し、版の更新や不具合の修正もリポジトリごとに手で行う必要がある。

**何が変わるべきか**:
- `npx github:nekono-dev/cc-sdd-bootstrap init` で、利用先に一式が配置される（対話の選択と、同じ選択を引数で渡す非対話の指定の両方）。
- 同じコマンドの `update` で、共通部分が新しい版に置き換わり、プロジェクト固有の部分（設定ファイルの値、CLAUDE.md の管理区画の外、利用者が書いたフック）は残る。
- 設定ファイル（仮称 `.cc-sdd-bootstrap.json`）に cc-sdd の版・言語・Codex の有無・役割ごとのモデルが書かれ、リポジトリにコミットされる。設定ファイルは読み込み時に検証される。
- `.claude/settings.json` へのフックの統合、`.gitignore` への追記、CLAUDE.md の管理区画の作成・更新（cc-sdd 標準の決まりは `.kiro/settings/cc-sdd-guide.md` に出力し、管理区画から `@` で取り込む）、配置した版の記録を行う。
- このリポジトリ自身にも同じコマンドで導入され（自己適用）、暫定の導入の仕組み（`scripts/agent/install-cc-sdd.sh`・`install-gate.mjs` とそのフック登録、CLAUDE.md の暫定の節）が置き換えられる。

**範囲外**: 各部品（セッション開始時の導入、kiro-gate、モデルの判定、Codex）の中身と、cc-sdd 本体の取得・役割とモデルの定義は、それぞれの spec で扱う。

詳細は同じディレクトリの `brief.md` を参照。

## Codex 対応で追加する目標
- 同じリポジトリで Claude Code と Codex を使う開発者が、一度の操作で両方の導入・更新・取り除きを行える。
- 導入対象の選択を共有設定に記録する。Claude Code のセッションから Codex に委任する設定は、導入対象とは独立して扱う。
- 各クライアントの既存フックと指示文書を保ったまま、後続 spec がフック・指示・生成物の除外を追加できる。

## Introduction
cc-sdd-bootstrap の導入コマンド（以下「導入コマンド」）は、cc-sdd の運用一式（フックのスクリプト、フックの登録、各クライアントの指示文書の定型の節、`.gitignore` の追記、設定ファイル）を利用先のリポジトリへ配置し、更新し、取り除く。利用者は `npx github:nekono-dev/cc-sdd-bootstrap <init|update|uninstall>` を 1 回実行して、一式を配置・更新・取り除ける。プロジェクト固有の部分（設定ファイルの値、利用者が書いたフック、各指示文書の管理区画の外、利用者が書き換えた共通部分）は、利用者の明示なしには失われない。

要件の段階で次を決めた（2026-11-19、利用者との確認）。
- 設定ファイルの名前は `.cc-sdd-bootstrap.json`（リポジトリの最上位）。
- 配置物のスクリプトの置き場は `.agent-hooks/cc-sdd-bootstrap/`。Claude Code にも Codex にも寄らず、git のフックの置き場（`.hooks/` など）と取り違えず、他の道具も `.agent-hooks/<名前>/` に並べられる名前として選んだ。
- `update` で利用者が書き換えた共通部分が見つかったら、何も変えずに一覧を出して中止する。強制の指定があるときだけ上書きする。
- アンインストール（`uninstall`）を扱う。設定ファイルも取り除く。書き換えられた共通部分があれば `update` と同じく中止する。
- `uninstall` は、設定ファイルが読めない・検証を通らないときも中止せずに進める（設定ファイルの値を使わないため。壊れた設定のままでも一式をやめられるようにする。2026-11-19、利用者の判断）。
- 導入済みのリポジトリで `init` を実行したら、何も変えずに `update` を案内する。
- 対話できない実行で選択が足りないときは、既定値で補い、使った値を表示する。

## Boundary Context
- **In scope**: `init`・`update`・`uninstall` の 3 つの操作、対話の選択と引数による非対話の指定、設定ファイルの形式・既定値・検証、配置物の写し（共通部分は置き換え、プロジェクト固有の部分は無いときだけ置く）、配置した版と内容の記録、利用者による書き換えの検出、`.claude/settings.json` へのフックの登録の統合、`.gitignore` への追記、CLAUDE.md の管理区画の作成・更新・削除（cc-sdd 標準の決まりの文書 `.kiro/settings/cc-sdd-guide.md` の取り込みを含む）、このリポジトリへの自己適用と暫定の導入の仕組みの置き換え。Codex 対応では、導入対象の選択、`.codex/hooks.json` の統合、AGENTS.md の管理区画、利用開始時の信頼設定の案内も扱う。
- **Out of scope**: 各部品の中身（セッション開始時の cc-sdd の導入と失敗時の停止＝session-install、手順書の強制＝kiro-gate、役割とモデルの定義と判定＝subagent-model-policy、Codex への委任＝codex-delegation）、cc-sdd 本体の取得と `.kiro/settings/cc-sdd-guide.md` の生成（session-install）、会話から導入コマンドを使うスキル（plugin-skill）、skyshare の移行手順、BRW（branch-release-workflow）の導入。
- **Adjacent expectations**:
  - 下流の spec は、設定ファイルにキーを、配置物にファイルを足し、対応するクライアントのフック登録と指示文書の管理区画に項目を足す。導入コマンドは、足されたものを `init`・`update`・`uninstall` で同じ規則に従って扱う。
  - `.kiro/settings/cc-sdd-guide.md` は session-install がセッション開始時に作る。導入コマンドは CLAUDE.md からの取り込みの行だけを置き、このファイルが無い状態でも CLAUDE.md が壊れない前提に立つ（2026-11-18 の PoC で確認済み）。
  - Codex 用スキルの導入と、標準手順や除外対象の生成物は session-install が定める。Codex の手順の強制は kiro-gate、サブエージェントの使い分けと委任は subagent-model-policy と codex-delegation が扱う。
  - plugin-skill は、導入コマンドを非対話の指定で呼ぶ。

## Requirements

### Requirement 1: コマンドの入口と共通の振る舞い
**Objective:** As a 利用者, I want 1 つのコマンドで導入・更新・削除を呼び分けたい, so that 手順を調べずに運用を始めたりやめたりできる

#### Acceptance Criteria
1. When 利用者が `npx github:nekono-dev/cc-sdd-bootstrap` に `init`・`update`・`uninstall` のいずれかを付けて実行した, the 導入コマンド shall カレントディレクトリのリポジトリを対象に、その操作を実行する。
2. When 利用者が操作を付けずに、または使い方の表示を求める指定を付けて実行した, the 導入コマンド shall 3 つの操作と指定できる選択の一覧を表示し、ファイルを変更せずに終わる。
3. If 未知の操作や未知の指定が渡された, the 導入コマンド shall 何が未知かと使い方を表示し、ファイルを変更せずに失敗として終わる。
4. If 実行環境の Node.js が 22 より古い, the 導入コマンド shall 必要な版を表示し、ファイルを変更せずに失敗として終わる。
5. If カレントディレクトリが git のリポジトリの最上位でない, the 導入コマンド shall その旨を表示し、ファイルを変更せずに失敗として終わる。
6. When 操作が成功した, the 導入コマンド shall 作成・更新・削除したファイルの一覧を表示し、成功として終わる。
7. If 操作が失敗した, the 導入コマンド shall 失敗の理由と利用者が取れる次の手を表示し、失敗として終わる（終了コードが 0 以外）。
8. The 導入コマンド shall 利用者向けの出力を日本語で表示する。
9. The 導入コマンド shall Node.js の標準の機能だけで動き、利用先のリポジトリに依存のパッケージを持ち込まない。

### Requirement 2: 導入（init）
**Objective:** As a 新しいリポジトリで cc-sdd の運用を始めたい開発者, I want 選択に答えるか引数で渡すだけで一式を配置したい, so that skyshare で手作業した準備を繰り返さずに済む

#### Acceptance Criteria
1. When 利用者が導入されていないリポジトリで端末から `init` を実行した, the 導入コマンド shall 設定ファイルの各項目（cc-sdd の版、言語、導入対象、Claude Code から Codex へ委任するか、役割ごとのモデル、および下流の spec が足した項目）を、既定値を示して順に尋ねる。
2. When 利用者が `init` に項目の値を引数で渡した, the 導入コマンド shall その項目を尋ねずに、渡された値を使う。
3. While 端末がつながっていない（対話できない）, when `init` に一部またはすべての項目が渡されなかった, the 導入コマンド shall 渡されなかった項目を既定値で補い、使った値を項目ごとに表示する。
4. When 選択が決まった, the 導入コマンド shall 設定ファイルを書き、配置物の写し（Requirement 4）、フックの登録の統合（Requirement 6）、`.gitignore` への追記（Requirement 7）、導入対象の指示文書の管理区画の作成（Requirement 8）を行う。
5. If 渡された値が設定ファイルの検証（Requirement 3）を通らない, the 導入コマンド shall どの項目がなぜ不正かを表示し、ファイルを変更せずに失敗として終わる。
6. If 対象のリポジトリに設定ファイルが既にある, the 導入コマンド shall 導入済みであることと `update` を使う案内を表示し、ファイルを変更せずに終わる。
7. When `init` が成功した, the 導入コマンド shall 設定ファイルと配置したファイルをコミットすること、および cc-sdd 本体は次のセッション開始時に導入されることを案内する。
8. When 新規導入時に導入対象の指定が省略され、対話で別の値が選ばれなかった, the 導入コマンド shall Claude Code と Codex の両方を既定値として使う。
9. When Codex を含む導入または更新が成功した, the 導入コマンド shall プロジェクトの信頼設定とフックの確認・承認がフックの実行に必要であること、および Codex での確認方法を案内する。
10. The 導入コマンド shall 利用者が行う Codex のプロジェクトおよびフックの信頼設定を保持する。

### Requirement 3: 設定ファイル
**Objective:** As a 複数のリポジトリを保守する開発者, I want プロジェクトごとの選択を 1 つのファイルにまとめてコミットしたい, so that 誰がどこで clone しても同じ選択で動き、`update` でも選択が引き継がれる

#### Acceptance Criteria
1. The 導入コマンド shall 設定ファイルをリポジトリの最上位の `.cc-sdd-bootstrap.json` として、人が読み書きできる形で書く。
2. The 導入コマンド shall 設定ファイルに、cc-sdd の版、言語、導入対象、Claude Code から Codex へ委任するか、役割ごとのモデル、および下流の spec が足した項目を記録する。
3. When 導入コマンドが設定ファイルを読んだ, the 導入コマンド shall 各項目の型と許される値を検証する。
4. If `update` で読んだ設定ファイルが読めない形式である、または検証を通らない, the 導入コマンド shall ファイル名・項目・理由を表示し、ファイルを変更せずに失敗として終わる。
5. When `update` で読んだ設定ファイルに、今の版で増えた項目が無い, the 導入コマンド shall その項目を更新時の既定値で補って書き戻し、補った項目と値を表示する。
6. If 設定ファイルに導入コマンドの知らない項目がある, the 導入コマンド shall その項目を変えずに残し、知らない項目であることを警告として表示する。
7. The 導入コマンド shall 既存の項目の値を、利用者の指定なしに書き換えない。
8. The 導入コマンド shall 導入対象として、Claude Code のみ、Codex のみ、両方のいずれかを受け付ける。
9. When 導入対象の項目を持たない従来の設定で、導入対象を指定せずに update を実行した, the 導入コマンド shall 両方を導入対象として記録し、補った値を表示する。
10. The 導入コマンド shall 既存の `codex.enabled` を Claude Code からの MCP 委任の選択として保持し、その値と Codex 自体を導入対象に含めるかの選択を独立に扱う。

### Requirement 4: 配置物の写しと記録
**Objective:** As a 利用者, I want 共通部分は版に合わせて揃い、プロジェクトで書く部分は残ってほしい, so that 更新しても自分の変更を失わない

#### Acceptance Criteria
1. The 導入コマンド shall 配置物のスクリプトを、利用先の `.agent-hooks/cc-sdd-bootstrap/` の下に置く。
2. When 導入コマンドが配置物を写す, the 導入コマンド shall 共通部分のファイルを、その版の内容で作成または置き換える。
3. When 導入コマンドが配置物を写す, the 導入コマンド shall プロジェクト固有の部分のファイルを、利用先に無いときだけ置き、あるときは変えない。
4. The 導入コマンド shall 自分が配置したもの以外のファイル（`.agent-hooks/` の下の他の道具のファイルや、利用者が置いたファイルを含む）を作成・変更・削除しない。
5. When 配置が終わった, the 導入コマンド shall 配置した導入コマンドの版と、共通部分の各ファイルを配置したときの内容を判別できる記録を、リポジトリにコミットできる形で残す。
6. When `update` または `uninstall` を実行した, the 導入コマンド shall 記録と今の内容を比べ、配置した後に書き換えられた共通部分のファイルを見つける。
7. Where 配置物のスクリプトを実行できる状態にする必要がある, the 導入コマンド shall 写したスクリプトを実行できる状態にする。
8. If 書き込みの途中で失敗した, the 導入コマンド shall 失敗したファイル、それまでに変更したファイル、まだ変更していないファイルを表示し、失敗として終わる。

### Requirement 5: 更新（update）
**Objective:** As a 複数のリポジトリを保守する開発者, I want 同じコマンドの再実行で共通部分を新しい版にしたい, so that 版の更新や不具合の修正をリポジトリごとに手で行わずに済む

#### Acceptance Criteria
1. When 利用者が導入済みのリポジトリで `update` を実行した, the 導入コマンド shall 設定ファイルの値を引き継いで、配置物の写し（Requirement 4）、フックの登録の統合（Requirement 6）、`.gitignore` への追記（Requirement 7）、導入対象の指示文書の管理区画の更新（Requirement 8）を行う。
2. If 配置した後に書き換えられた共通部分のファイルがある, the 導入コマンド shall そのファイルの一覧と、強制の指定を付けて再実行すれば上書きされることを表示し、ファイルを変更せずに失敗として終わる。
3. When 利用者が強制の指定を付けて `update` を実行した, the 導入コマンド shall 書き換えられた共通部分のファイルも新しい版の内容で置き換え、置き換えたファイルを表示する。
4. When 新しい版で共通部分から外れたファイルがあり、そのファイルが配置した後に書き換えられていない, the 導入コマンド shall そのファイルを削除する。
5. If 対象のリポジトリに設定ファイルが無い, the 導入コマンド shall 導入されていないことと `init` を使う案内を表示し、ファイルを変更せずに失敗として終わる。
6. When 利用者が `update` に設定ファイルの項目の値を引数で渡した, the 導入コマンド shall その項目の値を設定ファイルに書き、その値で更新する。
7. When 内容がすべて最新の状態で `update` を実行した, the 導入コマンド shall ファイルを変更せず、変更が無いことを表示する。
8. When update で導入対象を変更した, the 導入コマンド shall 新しい対象の管理対象を追加し、対象から外れたクライアントにだけ必要な管理対象を取り除き、引き続き必要な共有の配置物を残す。

### Requirement 6: フックの登録の統合
**Objective:** As a 利用者, I want 自分が書いたフックや設定を残したまま、一式のフックが登録されてほしい, so that 既存の Claude Code と Codex の設定が壊れない

#### Acceptance Criteria
1. When Claude Code を対象に `init` または `update` を実行した, the 導入コマンド shall 一式のフックの登録を `.claude/settings.json` に加え、`.claude/settings.json` が無ければ作る。
2. The 導入コマンド shall `.claude/settings.json` の、一式のフックの登録以外の内容（利用者が書いたフック、許可の設定、プラグインの設定などのほかの項目）を変えずに残す。
3. When `update` を実行した, the 導入コマンド shall 前の版で加えた一式のフックの登録を今の版の内容に置き換え、同じ登録を重複させない。
4. When Claude Code を対象に同じ版で `init` 相当の統合を繰り返した, the 導入コマンド shall `.claude/settings.json` の内容を前回と同じに保つ。
5. If 統合対象の `.claude/settings.json` が読めない形式である, the 導入コマンド shall その旨を表示し、ファイルを変更せずに失敗として終わる。
6. When Codex を対象に init または update を実行した, the 導入コマンド shall Codex 向けのフックの登録を `.codex/hooks.json` に加え、必要に応じてそのファイルを作る。
7. The 導入コマンド shall `.codex/hooks.json` の利用者のフックとその他の項目、および `.codex/config.toml` に利用者が定義したフックや設定を保持する。
8. When Codex を対象に update を実行した, the 導入コマンド shall 自分が加えた Codex 用の登録を今の版の内容に置き換え、同じ登録を重複させない。
9. If 統合対象の `.codex/hooks.json` を読み取れない、またはフックを統合できる構造でない, the 導入コマンド shall ファイル名と理由を示し、両クライアントのファイルを含め何も変更せずに失敗として終わる。

### Requirement 7: `.gitignore` への追記
**Objective:** As a 利用者, I want cc-sdd の導入物や手元だけの状態がコミットされないようにしたい, so that ライセンスの異なる cc-sdd の成果物をリポジトリに持ち込まない

#### Acceptance Criteria
1. When `init` または `update` を実行した, the 導入コマンド shall 一式が必要とする除外の行（cc-sdd の導入物、手元だけの状態など）を `.gitignore` に加え、`.gitignore` が無ければ作る。
2. The 導入コマンド shall `.gitignore` のうち、自分が加えた行以外を変えずに残す。
3. When `update` を実行した, the 導入コマンド shall 自分が加えた行を今の版の内容に揃え、同じ行を重複させない。
4. The 導入コマンド shall 設定ファイル、配置物、配置の記録、`.claude/settings.json`、`.codex/hooks.json`、CLAUDE.md、AGENTS.md を除外の対象にしない。
5. Where Codex が導入対象に含まれる, the 導入コマンド shall session-install が生成する Codex 用の導入物を除外の対象にし、`.agents/skills/` 全体や利用者の独自スキルを一律に除外しない。

### Requirement 8: 指示文書の管理区画
**Objective:** As a 利用者, I want 一式の定型の文章は各クライアントの指示文書の決まった範囲だけに入ってほしい, so that 自分で書いたプロジェクトの文書が書き換えられない

#### Acceptance Criteria
1. When Claude Code を対象に `init` を実行した, the 導入コマンド shall CLAUDE.md に、目印の行で囲んだ管理区画を作り、CLAUDE.md が無ければ管理区画だけを持つ CLAUDE.md を作る。
2. Where Claude Code が導入対象に含まれる, the 導入コマンド shall CLAUDE.md の管理区画に、cc-sdd 標準の決まりの文書 `.kiro/settings/cc-sdd-guide.md` の取り込みの行（`@.kiro/settings/cc-sdd-guide.md`）と、下流の spec が足した文章を入れる。
3. The 導入コマンド shall cc-sdd 標準の決まりの文書の中身そのものを CLAUDE.md に書かない。
4. When Claude Code を対象に `update` を実行した, the 導入コマンド shall 管理区画の中だけを今の版の内容に置き換え、管理区画の外を 1 文字も変えない。
5. If 統合対象の CLAUDE.md の目印の行が片方だけある、または複数組ある, the 導入コマンド shall 目印が壊れていることを表示し、ファイルを変更せずに失敗として終わる。
6. If Claude Code を対象とする `update` で CLAUDE.md に管理区画が無い, the 導入コマンド shall 管理区画を作り直し、作り直したことを表示する。
7. When Codex を対象に init または update を実行した, the 導入コマンド shall リポジトリ最上位の AGENTS.md に管理区画を作成または更新し、区画外の内容を保持する。
8. Where Codex が導入対象に含まれる, the 導入コマンド shall AGENTS.md の管理区画に、Codex 向けの標準手順の参照と、下流の spec が足した Codex 向けの指示を入れる。
9. If 統合対象の AGENTS.md の管理区画の目印が片方だけある、または複数組ある, the 導入コマンド shall ファイル名と理由を表示し、ファイルを変更せずに失敗として終わる。
10. If Codex を対象とする update で AGENTS.md に管理区画が無い, the 導入コマンド shall 管理区画を作り直し、作り直したことを表示する。

### Requirement 9: アンインストール（uninstall）
**Objective:** As a 利用者, I want 一式をやめるときに配置したものをまとめて取り除きたい, so that 手作業で探して消さずに済み、自分の文書や設定は残る

#### Acceptance Criteria
1. When 利用者が導入済みのリポジトリで `uninstall` を実行した, the 導入コマンド shall 配置物、配置の記録、設定ファイル、両クライアントの設定ファイルで自分が加えたフックの登録、`.gitignore` に自分が加えた行、CLAUDE.md と AGENTS.md で自分が作った管理区画を取り除く。
2. The 導入コマンド shall `uninstall` で、自分が加えたもの以外（利用者のフックや設定、`.gitignore` の他の行、CLAUDE.md と AGENTS.md の管理区画の外、プロジェクト固有の部分のうち利用者が書いた内容）を変えずに残す。
3. If 配置した後に書き換えられた共通部分のファイルがある, the 導入コマンド shall そのファイルの一覧と、強制の指定を付けて再実行すれば削除されることを表示し、ファイルを変更せずに失敗として終わる。
4. When 利用者が強制の指定を付けて `uninstall` を実行した, the 導入コマンド shall 書き換えられた共通部分のファイルも削除する。
5. When 取り除いた結果、`.agent-hooks/cc-sdd-bootstrap/` や `.agent-hooks/` などのディレクトリが空になった, the 導入コマンド shall その空のディレクトリを削除する。
6. If 対象のリポジトリに設定ファイルが無い, the 導入コマンド shall 導入されていないことを表示し、ファイルを変更せずに失敗として終わる。
7. The 導入コマンド shall `uninstall` で、cc-sdd の導入物（`.claude/skills/kiro-*/`・`.agents/skills/kiro-*/`・`.kiro/settings/`）と、`.kiro/steering/`・`.kiro/specs/` の利用者の成果物を削除しない。
8. If `uninstall` で設定ファイルが読めない形式である、または検証を通らない, the 導入コマンド shall 設定ファイルの値を使わずに取り除きを進め、設定ファイルに問題があったが取り除きを続けたことを、ファイル名と理由つきで表示する。

### Requirement 10: 自己適用
**Objective:** As a このリポジトリの開発者, I want このリポジトリにも同じコマンドで一式を導入したい, so that 作るものを自分で使って確かめ、暫定の仕組みを残さない

#### Acceptance Criteria
1. When このリポジトリで導入コマンドを使って一式を導入した, the このリポジトリ shall 利用先と同じ配置物・フックの登録・`.gitignore` の行・CLAUDE.md の管理区画を持つ。
2. When 自己適用を行った, the このリポジトリ shall 暫定の導入の仕組み（`scripts/agent/install-cc-sdd.sh`・`scripts/agent/install-gate.mjs`、`.claude/settings.json` のそれらのフックの登録、CLAUDE.md の「cc-sdd の導入（自己適用ができるまでの暫定の仕組み）」の節）を持たない。
3. When 自己適用の直後にこのリポジトリで `update` を実行した, the 導入コマンド shall 書き換えられた共通部分を誤って検出せず、変更が無いことを表示する。
4. When このリポジトリに両方を指定して自己適用した, the このリポジトリ shall 両クライアントのフック登録と指示文書の管理区画を持つ。
