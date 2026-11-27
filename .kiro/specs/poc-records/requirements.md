# 要件文書

## Project Description (Input)
設計の前提を確かめる PoC（実機で動かす試作）が、リポジトリの `poc/` に再実行用のスクリプトとして残り、配布している運用の区画の文章も「再実行できる PoC を残す」ことを求めるため、導入先のリポジトリにもコードと直接関係のないファイルが置かれてしまう。利用者は、検証は設計の前に行うが、リポジトリにはその資材を置きたくない。

変えたいこと: PoC は引き続き設計の前に行うが、リポジトリに残すのは `.kiro/specs/<spec 名>/poc/<段階>_<通し番号>.md`（例: `design_01.md`）という短い文書だけにする。文書には、どの段階で、何を確かめるために、どう実施して、どうなったかを書き、`feasibility.md` の根拠の表からこれを指して仕様の根拠にする。根拠として認める条件は「再実行できる」ではなく「位置付けと結果が文書で追える」にする。スクリプトはリポジトリの外で使い、リポジトリには置かない。このリポジトリ自身の既存の `poc/` は移行せずに削除し、これを根拠にしていた記述は、実行日と版を添えた一文の「確認済み」に書き換える。

詳細は `.kiro/specs/poc-records/brief.md`（discovery の結果。置き場所・移行の方針は本書が優先する）と `research.md`（既存コードとの差の分析）を参照。

## Introduction

poc-records は、設計の前提を確かめる PoC の記録の置き方を変える。確認は従来どおり設計の承認の前に行う。変わるのは、リポジトリに残すものである。実行用のスクリプトや資材は残さず、確認の位置付けと結果を書いた短い文書（PoC 文書）だけを、その spec のディレクトリの中の `poc/` に通し番号で残す。PoC 文書は、実現性の記録（`feasibility.md`）の根拠の表から指され、仕様の根拠になる。

この変更は、配布する運用の区画の文章と、入力のたびに出る追加の指示を通じて導入先のリポジトリにも効く。あわせて、このリポジトリ自身の steering・既存の spec の記録・テストを新しい置き方にそろえる。既存のリポジトリ直下の `poc/` は、PoC 文書へは移さず、削除する。

以下では、設計の前提を確かめるための実機での試作と確認を「PoC」、その位置付けと結果を書いた文書を「PoC 文書」、実現性の確認の結果をまとめた spec ごとのファイルを「実現性の記録」と呼ぶ。「段階」は、PoC を行った時期（`requirements`＝要件、`design`＝設計、`tasks`＝タスク計画、`impl`＝実装中）を指す。受け入れ基準の主語はすべて poc-records とする。

## Boundary Context

- **In scope**:
  - PoC 文書の置き場所・名前（段階と通し番号）・書式・必須の内容。
  - 根拠として認める条件（「再実行できる」から「位置付けと結果が文書で追える」へ）。
  - スクリプトや資材をリポジトリの管理対象に残さないこと。
  - 実現性の記録の根拠の表から PoC 文書を指すこと。
  - 運用の区画の文章、入力のたびに出る追加の指示、このリポジトリの steering の PoC の記述。
  - 既存のリポジトリ直下の `poc/` の削除と、それを根拠にしていた記述の書き換え。
  - 上記を確かめるテストの見直し。
- **Out of scope**:
  - 既存の `poc/` の内容の PoC 文書への移行（移さない）。
  - 実現性の記録の 3 つの節と `- 判定:` の行の形、およびそれを見て入力を止める関門の判定の仕組みの変更。
  - PoC 文書の中身の正しさの自動判定。
  - cc-sdd が持つファイル（spec.json・requirements.md・design.md・tasks.md）への印や項目の追加。
  - 導入先の既存の記録・`poc/` の自動的な書き換え・削除。
- **Adjacent expectations**:
  - feasibility-review（根拠の条件・実現性の記録の形・関門を定めた spec）を前提とする。その要件のうち「PoC は再実行できる」とする記述は、この spec が置き換える。関門が見るのは実現性の記録の判定の行だけで、この spec はそれを変えない。
  - kiro-gate・work-branch-flow・subagent-delegation・installer-core・session-install・codex-hook-trust・install-freshness・feasibility-review の各 spec の実現性の記録と設計・調査・タスクの文書は、`poc/` の場所を挙げた記述を書き換えるだけで、判定や内容は変えない。

## Requirements

### Requirement 1: PoC 文書の置き場所と名前

**Objective:** As a 開発者, I want PoC の記録が spec のディレクトリの中の短い文書として残るようにしたい, so that ソースコードのリポジトリにコードと関係のないファイルを置かずに、根拠をたどれる。

#### Acceptance Criteria
1. The poc-records shall PoC 文書を、その PoC が根拠になる spec のディレクトリの中の `poc/<段階>_<通し番号>.md` として置く。
2. The poc-records shall `<段階>` を `requirements`・`design`・`tasks`・`impl` のいずれかにする。
3. The poc-records shall `<通し番号>` を、段階ごとに 01 から始まる 2 桁の連番にする。
4. The poc-records shall 通し番号を、要件・設計の番号とは対応させず、spec の中で PoC を区別するためだけに使う。
5. When PoC 文書が増える, the poc-records shall 同じ段階の既存の最大の番号の次の番号を使う。
6. When 付けた番号の PoC 文書を取り除く, the poc-records shall ほかの PoC 文書の番号を詰め直さない。
7. The poc-records shall PoC 文書を、日本語で、人が読める形で残す。
8. The poc-records shall PoC 文書を、cc-sdd が持つファイル（spec.json・requirements.md・design.md・tasks.md）に印や項目を足さずに表す。
9. When 複数の spec が同じ PoC を根拠にする, the poc-records shall PoC 文書を 1 つの spec のディレクトリにだけ置き、ほかの spec の実現性の記録からは、その文書を相対パスで指す。

### Requirement 2: PoC 文書に書く内容

**Objective:** As a 開発者, I want PoC 文書だけで、何を確かめるために実施し、どうなったかが追えるようにしたい, so that スクリプトが無くても仕様の根拠として判断できる。

#### Acceptance Criteria
1. The poc-records shall PoC 文書の冒頭に、確かめた前提と、その前提に関わる要件・設計の番号（複数可）を `- 対象:` の行で書く。
2. The poc-records shall PoC 文書に、段階（要件・設計・タスク計画・実装中のいずれか）を `- 段階:` の行で書く。
3. The poc-records shall PoC 文書に、実施した確認の要点（何をして何を観測したか。数行）を書く。
4. The poc-records shall PoC 文書に、実施日と、環境と版（確かめた外部のツールの版を含む）を書く。
5. The poc-records shall PoC 文書に、結果と、その結果を仕様（要件・設計・タスク計画）にどう反映したかを書く。
6. The poc-records shall PoC 文書に、確かめられなかったこと・確認の限界があれば、そのことを書く。
7. The poc-records shall PoC 文書に、手順を追って再現できるだけの詳しさ、スクリプトの全文、コマンドの完全な列挙を求めない。
8. If 実施の結果が前提と食い違った, then the poc-records shall その食い違いと、仕様をどう直したかを PoC 文書に書く。
9. When 同じ前提を別の段階でもう一度確かめる, the poc-records shall 新しい通し番号の PoC 文書として残し、前の PoC 文書を書き換えない。

### Requirement 3: リポジトリに資材を残さない

**Objective:** As a 開発者, I want PoC のためのスクリプトや資材がリポジトリに残らないようにしたい, so that 導入先のソースコードのリポジトリがコードと直接関係のないファイルで汚れない。

#### Acceptance Criteria
1. The poc-records shall PoC のためのスクリプト・テスト用の入力・実行の生の出力を、リポジトリの管理対象に残さない。
2. The poc-records shall PoC の実行に必要なスクリプトや資材を、リポジトリの管理対象の外で使うよう求める。
3. If PoC の実行がリポジトリの管理対象の中にファイルを作った, then the poc-records shall それらを PoC の確認の後に管理対象から取り除くよう求める。
4. The poc-records shall PoC の前後で、利用者のリポジトリの管理対象が、PoC 文書の追加と、その spec の実現性の記録の更新を除いて変わらないことを求める。

### Requirement 4: 根拠として認める条件

**Objective:** As a 開発者, I want 根拠として認める条件を「位置付けと結果が文書で追えること」にしたい, so that スクリプトを残さなくても、設計の確認で根拠として使える。

#### Acceptance Criteria
1. The poc-records shall 設計・タスク計画の確認で根拠として認める PoC を、PoC 文書の必須の内容（要件 2.1〜2.5）がそろっているものに限る。
2. The poc-records shall PoC を根拠として認める条件に、再実行できることを含めない。
3. The poc-records shall 一次資料を根拠として認める条件（出典の場所と版を示せるもの）を変えない。
4. If PoC 文書に必須の内容が欠けている, then the poc-records shall その前提を根拠の無い前提として扱い、実現性の記録に未確認として残すよう求める。
5. The poc-records shall PoC を作らない前提を、従来どおり前提と理由を実現性の記録に残すものとする。

### Requirement 5: 実現性の記録から PoC 文書を指すこと

**Objective:** As a 開発者, I want 実現性の記録の根拠の表から PoC 文書をたどれるようにしたい, so that 仕様の根拠として、判定と文書が結びつく。

#### Acceptance Criteria
1. The poc-records shall 実現性の記録の設計の確認・タスク計画の確認の根拠の表で、PoC を根拠にする前提の出典の欄に、PoC 文書をその実現性の記録からの相対パス（例: `poc/design_01.md`）で挙げる。
2. When 実現性の記録が PoC 文書を根拠として挙げる, the poc-records shall 挙げた PoC 文書が実在することを自動の確認で確かめられるようにする。
3. If 実現性の記録が挙げた PoC 文書が実在しない, then the poc-records shall その自動の確認が失敗するようにする。
4. The poc-records shall 実現性の記録の 3 つの節と、各節の `- 判定:` の行の形、およびその語（`必要`・`不要`・`通過`・`未通過`）を変えない。
5. While 実現性の記録の判定の行が条件を満たす, the poc-records shall 既存の入力の停止の条件（記録が無い・未通過のとき止める）を変えず、PoC 文書の内容を見て止めることをしない。

### Requirement 6: 運用の区画の文章と入力のたびに出る追加の指示

**Objective:** As a 導入先の開発者とそのエージェント, I want 配布される文章と、入力のたびに出る指示が、新しい PoC の置き方を案内するようにしたい, so that 導入先でも PoC のスクリプトをリポジトリに残さず、同じ形で記録できる。

#### Acceptance Criteria
1. The poc-records shall 運用の区画の文章の PoC の説明を、「再実行できる試作」から「実機で確かめる試作と、その位置付けと結果を残す PoC 文書」に直す。
2. The poc-records shall 運用の区画の文章に、PoC 文書の置き場所と名前（`.kiro/specs/<spec 名>/poc/<段階>_<通し番号>.md`）・必須の内容・`- 対象:`・`- 段階:` の書き方を含める。
3. The poc-records shall 運用の区画の文章に、根拠として認める PoC の条件（要件 4）と、PoC のスクリプトや資材をリポジトリの管理対象に残さないこと（要件 3）を含める。
4. The poc-records shall 運用の区画の文章に、レビュー役へ渡す実現性の観点を、「一次資料か、PoC 文書で位置付けと結果が追える PoC で確かめられているか」に直して含める。
5. The poc-records shall 入力のたびに出る追加の指示（要件の段階・設計の段階・タスク計画の段階の分）の、PoC を根拠として認める条件の文面を、要件 4 に合わせて直す。
6. The poc-records shall 運用の区画の文章と追加の指示を、Claude Code 向けと Codex 向けの両方で同じ内容にする。
7. When 導入・更新のコマンドが導入先に運用の区画の文章を配置する, the poc-records shall 新しい文章を配置し、導入先の既存の `poc/` や実現性の記録を自動では書き換えない。

### Requirement 7: このリポジトリの steering の更新

**Objective:** As a このリポジトリの開発者, I want steering が新しい PoC の置き方を定めるようにしたい, so that このリポジトリ自身の作業が同じ決まりに従う。

#### Acceptance Criteria
1. The poc-records shall steering の構造の説明から、リポジトリ直下の `poc/<前提ごと>/` の項を除き、PoC 文書の置き場所と名前の説明に置き換える。
2. The poc-records shall steering の開発の決まり・テストの決まりの PoC の説明（再実行できるスクリプトと結果を残すこと）を、PoC 文書で残すことに置き換える。
3. The poc-records shall steering のよく使うコマンドの一覧から、`poc/<名前>/run.sh` の項を除く。
4. The poc-records shall steering の「cc-sdd の版を上げるときに `poc/self-install/run.mjs` で確かめる」とする記述を、`poc/` に依存しない確認の手順に置き換える。
5. The poc-records shall steering のどこにも、存在しないリポジトリ直下の `poc/` の場所を書かない。

### Requirement 8: 既存の `poc/` の削除と、参照の書き換え

**Objective:** As a このリポジトリの開発者, I want 既存の `poc/` をリポジトリから無くし、それを根拠にしていた記述も一貫した形にしたい, so that リポジトリに `poc/` が無い前提で構成できる。

#### Acceptance Criteria
1. When 既存の `poc/` を取り除く, the poc-records shall リポジトリ直下の `poc/` ディレクトリとその中のファイルをすべて削除する。
2. The poc-records shall 既存の `poc/` の内容を、PoC 文書へ移さない。
3. The poc-records shall 既存の 8 つの spec の実現性の記録（`feasibility.md`）で `poc/` の場所を根拠として挙げた箇所を、リンクを付けずに「〜が〜であることは、〈段階〉の前の実機検証（〈実行日〉、〈環境と版〉）で確認済み」の一文に書き換える。
4. The poc-records shall 8.3 の一文に添える実行日・環境と版を、削除する `poc/` の元の記録に書かれているとおりに使い、書かれていない項目（確認を行った段階を含む）は「記録なし」と書く（推測で補わない）。確かめられる段階（例: 実装中）は、元の記録から確かめられるときだけ書く。
5. The poc-records shall 既存の 8 つの spec の設計・調査・タスク・要件・概要の文書にある `poc/` の場所の記述を取り除き、場所を取り除くだけでは意味が通らなくなる文、および削除する `poc/` の再実行を指示している文は、何を確認したか・何が必要かの意味を保つように書き換える。
6. The poc-records shall 配布物（利用者の環境へ入るファイル）に含まれる、削除する `poc/` を出典にしたコメントを、`poc/` に依存しない形に直す。
7. If 既存の `poc/` に、設計の根拠ではなく繰り返し使う確認手順（例: cc-sdd の版を上げるときの確認）が含まれる, then the poc-records shall その手順ごとに、既存の自動のテストで足りるかを確かめ、(a) 足りるなら足りるとした理由、(b) 足りず自動のテストとして残すなら残したテスト、(c) 足りず自動化しないなら、自動化しない理由と、手順を steering の文章に残して結果を PoC 文書に残すこと、のいずれかを記録に残す。
8. When 書き換えを終える, the poc-records shall リポジトリのどこにも、削除した `poc/` の場所を参照先として書かない。

### Requirement 9: 自動の確認

**Objective:** As a このリポジトリの開発者, I want 新しい置き方が崩れたときに自動で気づけるようにしたい, so that 根拠の参照切れを防げる。

#### Acceptance Criteria
1. The poc-records shall 既存の自動の確認のうち、リポジトリ直下の `poc/` の実在を確かめるものを、PoC 文書の実在を確かめるものに置き換える。
2. The poc-records shall リポジトリ直下に `poc/` が存在することを失敗とする確認を、置かない。
3. The poc-records shall 自動の確認のどこにも、リポジトリ直下の `poc/` を前提にした記述を残さない。
4. The poc-records shall 運用の区画の文章の変更（要件 6.1〜6.4）と、追加の指示の変更（要件 6.5）を、それぞれ既存の文章の内容を確かめる自動の確認で確かめられるようにする。
5. When 自動の確認をすべて実行する, the poc-records shall 削除と書き換えの後も、すべて成功する。

### Requirement 10: 既存の仕組みとの併存

**Objective:** As a 導入先の開発者, I want この変更で既存の関門や導入の動きが変わらないようにしたい, so that 導入済みのリポジトリの運用が壊れない。

#### Acceptance Criteria
1. The poc-records shall 実現性の記録の `- 判定:` の行を見て入力を止める既存の関門の動作を変えない。
2. While 導入先の既存の実現性の記録が、`poc/` の場所を根拠に挙げたまま残っている, the poc-records shall その記録の判定が `通過` であれば、入力を止めない。
3. The poc-records shall 導入・更新のコマンドで配置するファイルの一覧と、その配置の動作（文章の内容の更新を除く）を変えない。
4. If 配置物の変更で、このリポジトリ自身への配置の内容が更新される, then the poc-records shall 更新のコマンドを実行して結果を反映する。
