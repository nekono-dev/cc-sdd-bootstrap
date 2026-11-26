# 要件文書

## Project Description (Input)
設計の前提を確かめる PoC（実機で動かす試作）が、リポジトリの `poc/` に再実行用のスクリプトとして残り、配布している運用の区画の文章も「再実行できる PoC を残す」ことを求めるため、導入先のリポジトリにもコードと直接関係のないファイルが置かれてしまう。利用者は、検証は設計の前に行うが、リポジトリにはその資材を置きたくない。

変えたいこと: PoC は引き続き設計の前に行うが、リポジトリに残すのは `.kiro/specs/<spec 名>/poc-<前提名>.md` という文書だけにする。文書には、どの段階（要件／設計／タスク計画／実装中）で、どの方法（手順・実行日・環境と版）で、何を確かめ、どうなったかを書き、`feasibility.md` の根拠の表からこれを指して仕様の根拠にする。根拠として認める条件は「再実行できる」ではなく「文書で追える」にする。スクリプトは一時ディレクトリで使い、リポジトリには置かない。このリポジトリ自身の既存の `poc/` も文書に移して削除する。

詳細は `.kiro/specs/poc-records/brief.md`（discovery の結果）を参照。

## Introduction

poc-records は、設計の前提を確かめる PoC の記録の置き方を変える。確認は従来どおり設計の承認の前に行う。変わるのは、リポジトリに残すものである。実行用のスクリプトや資材は残さず、段階・方法・確かめたこと・結果を書いた文書（PoC 文書）だけを、その spec のディレクトリの中に残す。PoC 文書は、実現性の記録（`feasibility.md`）の根拠の表から指され、仕様の根拠になる。

この変更は、配布する運用の区画の文章を通じて導入先のリポジトリにも効く。あわせて、このリポジトリ自身の steering・既存の spec の記録・テストを新しい置き方にそろえ、既存の `poc/` を文書へ移して削除する。

以下では、設計の前提を確かめるための実機での試作と確認を「PoC」、その内容と結果を書いた文書を「PoC 文書」、実現性の確認の結果をまとめた spec ごとのファイルを「実現性の記録」と呼ぶ。受け入れ基準の主語はすべて poc-records とする。

## Boundary Context

- **In scope**:
  - PoC 文書の置き場所・単位・書式・必須の内容。
  - 根拠として認める条件（「再実行できる」から「文書で追える」へ）。
  - スクリプトや資材をリポジトリの管理対象に残さないこと。
  - 実現性の記録の根拠の表から PoC 文書を指すこと。
  - 運用の区画の文章（導入先に配る決まり）、このリポジトリの steering の PoC の記述。
  - 既存の `poc/` の文書への移行と削除、既存の実現性の記録の参照の付け替え。
  - 繰り返し使う確認手順の扱い。
  - 上記を確かめるテストの見直し。
- **Out of scope**:
  - 実現性の記録の 3 つの節と `- 判定:` の行の形、およびそれを見て入力を止める関門の判定の仕組みの変更。
  - PoC 文書の中身の正しさの自動判定。
  - cc-sdd が持つファイル（spec.json・requirements.md・design.md・tasks.md）への印や項目の追加。
  - 導入先の既存の記録の自動的な書き換え（導入先が過去に作った `poc/` を自動で移す・消すことはしない）。
- **Adjacent expectations**:
  - feasibility-review（根拠の条件・実現性の記録の形・関門を定めた spec）を前提とする。その要件のうち「PoC は再実行できる」とする記述は、この spec が置き換える。関門が見るのは実現性の記録の判定の行だけで、この spec はそれを変えない。
  - kiro-gate・work-branch-flow・subagent-delegation・installer-core・session-install・codex-hook-trust・install-freshness の各 spec の実現性の記録は、根拠の参照先を付け替えるだけで、判定や内容は変えない。

## Requirements

### Requirement 1: PoC 文書の置き場所と単位

**Objective:** As a 開発者, I want PoC の記録が spec のディレクトリの中の文書として残るようにしたい, so that ソースコードのリポジトリにコードと関係のないファイルを置かずに、根拠をたどれる。

#### Acceptance Criteria
1. The poc-records shall PoC 文書を、その PoC が根拠になる spec のディレクトリの中の `poc-<前提名>.md` として置く。
2. The poc-records shall PoC 文書を、確かめる前提ごとに 1 ファイルにする。
3. The poc-records shall `<前提名>` を、小文字の英数字とハイフンだけで、前提の内容が分かる名前にする。
4. The poc-records shall PoC 文書を、日本語で、人が読める形で残す。
5. The poc-records shall PoC 文書を、cc-sdd が持つファイル（spec.json・requirements.md・design.md・tasks.md）に印や項目を足さずに表す。
6. When 複数の spec が同じ PoC を根拠にする, the poc-records shall PoC 文書を 1 つの spec のディレクトリにだけ置き、ほかの spec の実現性の記録からは、その文書を相対パスで指す。

### Requirement 2: PoC 文書に書く内容

**Objective:** As a 開発者, I want PoC 文書だけで、いつ・どの方法で・何を確かめ・どうなったかが追えるようにしたい, so that スクリプトが無くても仕様の根拠として判断できる。

#### Acceptance Criteria
1. The poc-records shall PoC 文書の冒頭に、その確認をどの段階で行ったか（要件・設計・タスク計画・実装中のいずれか）を `- 段階:` の行で書く。
2. The poc-records shall PoC 文書に、確かめた前提と、確かめた内容（何を確認したか）を書く。
3. The poc-records shall PoC 文書に、方法として、実行した手順（コマンドや入力の要点）・実行日・環境と版（確かめた外部のツールの版を含む）を書く。
4. The poc-records shall PoC 文書に、結果（観測したこと）と、その結果を仕様（要件・設計・タスク計画）にどう反映したかを書く。
5. The poc-records shall PoC 文書に、確かめられなかったこと・確認の限界があれば、そのことを書く。
6. When 同じ前提を別の段階でもう一度確かめる, the poc-records shall 同じ PoC 文書に、段階・実行日・結果を新しい記録として追記し、前の記録を消さない。
7. If 実行の結果が前提と食い違った, then the poc-records shall その食い違いと、仕様をどう直したかを PoC 文書に書く。

### Requirement 3: リポジトリに資材を残さない

**Objective:** As a 開発者, I want PoC のためのスクリプトや資材がリポジトリに残らないようにしたい, so that 導入先のソースコードのリポジトリがコードと直接関係のないファイルで汚れない。

#### Acceptance Criteria
1. The poc-records shall PoC のためのスクリプト・テスト用の入力・実行の生の出力を、リポジトリの管理対象に残さない。
2. The poc-records shall PoC の実行に必要なスクリプトや資材を、リポジトリの管理対象の外で使うよう求める。
3. If PoC の実行がリポジトリの管理対象の中にファイルを作った, then the poc-records shall それらを PoC の確認の後に管理対象から取り除くよう求める。
4. While PoC のスクリプトが長く、PoC 文書に全文を載せない, the poc-records shall 文書に、確認の内容と手順の要点を、読んだ人が何を実行したか理解できる程度に書く。
5. The poc-records shall 実機での PoC の実施が、利用者の管理対象のリポジトリを PoC の前後で変更しないことを求める（PoC 文書の追加を除く）。

### Requirement 4: 根拠として認める条件

**Objective:** As a 開発者, I want 根拠として認める条件を「文書で追えること」にしたい, so that スクリプトを残さなくても、設計の確認で根拠として使える。

#### Acceptance Criteria
1. The poc-records shall 設計・タスク計画の確認で根拠として認める PoC を、PoC 文書の必須の内容（要件 2.1〜2.4）がそろっているものに限る。
2. The poc-records shall PoC を根拠として認める条件に、再実行できることを含めない。
3. The poc-records shall 一次資料を根拠として認める条件（出典の場所と版を示せるもの）を変えない。
4. If PoC 文書に必須の内容が欠けている, then the poc-records shall その前提を根拠の無い前提として扱い、実現性の記録に未確認として残すよう求める。
5. The poc-records shall PoC を作らない前提を、従来どおり前提と理由を実現性の記録に残すものとする。

### Requirement 5: 実現性の記録から PoC 文書を指すこと

**Objective:** As a 開発者, I want 実現性の記録の根拠の表から PoC 文書をたどれるようにしたい, so that 仕様の根拠として、判定と文書が結びつく。

#### Acceptance Criteria
1. The poc-records shall 実現性の記録の設計の確認・タスク計画の確認の根拠の表で、PoC を根拠にする前提の出典の欄に、PoC 文書をその実現性の記録からの相対パスで挙げる。
2. When 実現性の記録が PoC 文書を根拠として挙げる, the poc-records shall 挙げた PoC 文書が実在することを自動の確認で確かめられるようにする。
3. If 実現性の記録が挙げた PoC 文書が実在しない, then the poc-records shall その自動の確認が失敗するようにする。
4. The poc-records shall 実現性の記録の 3 つの節と、各節の `- 判定:` の行の形、およびその語（`必要`・`不要`・`通過`・`未通過`）を変えない。
5. While 実現性の記録の判定の行が条件を満たす, the poc-records shall 既存の入力の停止の条件（記録が無い・未通過のとき止める）を変えず、PoC 文書の内容を見て止めることをしない。

### Requirement 6: 運用の区画の文章

**Objective:** As a 導入先の開発者とそのエージェント, I want 配布される運用の区画の文章が新しい PoC の置き方を案内するようにしたい, so that 導入先でも PoC のスクリプトをリポジトリに残さず、同じ形で記録できる。

#### Acceptance Criteria
1. The poc-records shall 運用の区画の文章の PoC の説明を、「再実行できる試作」から「実機で確かめる試作と、その内容を残す PoC 文書」に直す。
2. The poc-records shall 運用の区画の文章に、PoC 文書の置き場所（`.kiro/specs/<spec 名>/poc-<前提名>.md`）・必須の内容・段階の書き方を含める。
3. The poc-records shall 運用の区画の文章に、根拠として認める PoC の条件（要件 4）と、PoC のスクリプトや資材をリポジトリの管理対象に残さないこと（要件 3）を含める。
4. The poc-records shall 同じ内容の文章を Claude Code 向けと Codex 向けの両方に置く。
5. The poc-records shall 運用の区画の文章に、レビュー役へ渡す実現性の観点（前提ごとの根拠が確かめられているか）を、「一次資料か、PoC 文書で追える PoC」に直して含める。
6. When 導入・更新のコマンドが導入先に運用の区画の文章を配置する, the poc-records shall 新しい文章を配置し、導入先の既存の `poc/` や実現性の記録を自動では書き換えない。

### Requirement 7: このリポジトリの steering の更新

**Objective:** As a このリポジトリの開発者, I want steering が新しい PoC の置き方を定めるようにしたい, so that このリポジトリ自身の作業が同じ決まりに従う。

#### Acceptance Criteria
1. The poc-records shall steering の構造の説明から `poc/<前提ごと>/` の項を除き、PoC 文書の置き場所と書式の説明に置き換える。
2. The poc-records shall steering の開発の決まり・テストの決まりの PoC の説明（再実行できるスクリプトと結果を残すこと）を、PoC 文書で残すことに置き換える。
3. The poc-records shall steering のよく使うコマンドの一覧から、`poc/<名前>/run.sh` の項を除く。
4. The poc-records shall steering に残る過去の経緯の記述のうち、`poc/` の場所を挙げているものを、移行後の PoC 文書の場所を指すように直す。
5. The poc-records shall steering の更新の後、steering のどこにも、存在しない `poc/` の場所を現行の決まりとして書かない。

### Requirement 8: 既存の `poc/` の移行と削除

**Objective:** As a このリポジトリの開発者, I want 既存の `poc/` の内容が失われずに文書へ移るようにしたい, so that 過去の根拠をたどれるまま、リポジトリからスクリプトを無くせる。

#### Acceptance Criteria
1. When 既存の `poc/<名前>/` に前提の確認の結果が残っている, the poc-records shall その内容（前提・段階・方法・実行日・環境と版・確かめたこと・結果）を、要件 2 の書式の PoC 文書に移す。
2. The poc-records shall 移した PoC 文書の実行日・環境と版・結果を、元の記録のとおりに保ち、移行の日付に書き換えない。
3. The poc-records shall 移した PoC 文書に、元は `poc/` のスクリプトで行い、現在は再実行用のスクリプトが残っていないことを書く。
4. The poc-records shall 既存の 8 つの spec の実現性の記録（`feasibility.md`）の、`poc/` の場所を挙げた根拠を、移した PoC 文書の相対パスに付け替える。
5. When 移行を終える, the poc-records shall リポジトリから `poc/` ディレクトリとその中のファイルをすべて削除する。
6. If `poc/` の内容に、設計の根拠ではなく繰り返し使う確認手順（例: cc-sdd の版を上げるときの確認）が含まれる, then the poc-records shall その手順を、PoC 文書とは別に、繰り返し実行できる形（自動のテスト）で残すか、不要と判断した理由を記録に残す。
7. The poc-records shall 移行の後、リポジトリのどこにも、削除した `poc/` の場所を現行の参照先として書かない（過去の経緯として挙げる記述を除く）。
8. If 既存の `poc/` に、確認の結果を示す文書が無く、スクリプトだけが残るものがある, then the poc-records shall その扱い（文書に書き起こすか、根拠として挙げずに削除するか）と理由を記録に残す。

### Requirement 9: 自動の確認

**Objective:** As a このリポジトリの開発者, I want 新しい置き方が崩れたときに自動で気づけるようにしたい, so that 資材が再びリポジトリに紛れ込むことや、根拠の参照切れを防げる。

#### Acceptance Criteria
1. The poc-records shall 既存の自動の確認のうち `poc/` の実在を確かめるものを、PoC 文書の実在を確かめるものに置き換える。
2. If `poc/` ディレクトリがリポジトリに存在する, then the poc-records shall 自動の確認が失敗するようにする。
3. The poc-records shall 配布物（利用者の環境へ入るファイル）に PoC のスクリプトや PoC 文書が含まれないことを、自動の確認で確かめられるようにする。
4. The poc-records shall 運用の区画の文章の変更（要件 6）を、既存の文章の内容を確かめる自動の確認で確かめられるようにする。
5. When 自動の確認をすべて実行する, the poc-records shall 移行の後も、すべて成功する。

### Requirement 10: 既存の仕組みとの併存

**Objective:** As a 導入先の開発者, I want この変更で既存の関門や導入の動きが変わらないようにしたい, so that 導入済みのリポジトリの運用が壊れない。

#### Acceptance Criteria
1. The poc-records shall 実現性の記録の `- 判定:` の行を見て入力を止める既存の関門の動作を変えない。
2. While 導入先の既存の実現性の記録が、`poc/` の場所を根拠に挙げたまま残っている, the poc-records shall その記録の判定が `通過` であれば、入力を止めない。
3. The poc-records shall 導入・更新のコマンドで配置するファイルの一覧と、その配置の動作（運用の区画の文章の内容の更新を除く）を変えない。
4. If 配置物の変更で、このリポジトリ自身への配置の内容が更新される, then the poc-records shall 更新のコマンドを実行して結果を反映する。
