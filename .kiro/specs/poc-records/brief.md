# Brief: poc-records

## Problem
設計の前提を確かめる PoC（実機で動かす試作）が、リポジトリの `poc/` に再実行用のスクリプト（`run.sh`・`run.mjs` など）として残る。導入先のリポジトリ（利用者のソースコードがあるリポジトリ）にも、配布している運用の区画の文章が「再実行できる PoC を残す」ことを求めるので、コードと直接関係のないファイルが置かれてしまう。利用者は、検証は設計の前に行うが、リポジトリにはその資材を置きたくない。

## Current State
- 運用の区画の文章（`lib/catalog.mjs` の `feasibilityReviewSection`）は、根拠として「一次資料」か「再実行できる PoC（手順と実行日・環境・結果が残るもの）」を認め、PoC を作ることを基本とする。置き場所は文章では決めていない。
- このリポジトリの steering（`structure.md`・`project-rules.md`・`tech.md`）は、PoC を `poc/<前提ごと>/` に「再実行可能なスクリプト＋ `result.md`」で置くと定めている。
- `poc/` に 49 ファイルがある。既存 spec の `feasibility.md`（8 つ）が根拠として `poc/…` の場所を挙げ、`test/feasibility-records.test.mjs` がその場所の実在を確かめている。`test/package.test.mjs` は「`poc/` が配布物に入らない」ことを確かめている。
- `poc/self-install/run.mjs` は、cc-sdd の版を上げるときの確認手順として `project-rules.md` が参照している（検証の手順であり、設計の根拠ではない）。

## Desired Outcome
- PoC は設計に入る前に引き続き行うが、リポジトリに残るのは spec の中の文書だけになる（スクリプトや資材は置かない）。
- 文書は `.kiro/specs/<spec 名>/poc-<前提名>.md`。前提ごとに 1 ファイルで、次を書く。
  - 段階: 冒頭の `- 段階:` の行。要件／設計／タスク計画／実装中のどこで確かめたか。
  - 方法: 実行した手順（コマンドや入力の要点）、実行日、環境と版。
  - 確かめたこと: 何を確認したか。
  - 結果: どうなったか、仕様にどう反映したか。
- `feasibility.md` の根拠の表は、`poc-<前提名>.md` を相対パスで指す。これが仕様の根拠になる。
- 根拠として認める条件は、「手順・実行日・環境と版・確かめたこと・結果が文書で追える」ことにする（「再実行できる」は条件にしない）。スクリプトの本体は一時ディレクトリ（`~/.cache/cc-sdd-bootstrap-scratch/` など）で使い、リポジトリに置かない。

## Approach
- 運用の区画の文章を直す（根拠の条件、PoC 文書の置き場所・書式、スクリプトをリポジトリに置かないこと）。これが導入先の全リポジトリに効く。
- このリポジトリ自身も同じ方式にそろえる。steering の PoC の項を書き換え、既存の `poc/` の各 `result.md` を spec 内の `poc-*.md` に書き直して `poc/` を削除する（利用者の選択: 文書に移して `poc/` を削除）。
- 関門（入力の停止）は `feasibility.md` の判定の行だけを見るので、判定の形式は変えない。変えるのは根拠の置き場所と書式。

## Scope
- **In**:
  - 運用の区画の文章（`lib/catalog.mjs`）と、それを確かめるテスト（`test/catalog.test.mjs`・`test/feasibility-gate-rules.test.mjs`）。
  - `feasibility.md` の根拠の書き方（`poc-*.md` を指す）。
  - steering（`structure.md`・`project-rules.md`・`tech.md`・`roadmap.md` の PoC の記述）。
  - 既存 `poc/` の文書への移行と削除。8 つの既存 `feasibility.md` の参照の付け替え。
  - `test/feasibility-records.test.mjs`（`poc/` の実在確認 → `poc-*.md` の実在確認）と `test/package.test.mjs` の見直し。
  - 配置物の更新（`node bin/cc-sdd-bootstrap.mjs update`）。
- **Out**:
  - 関門の判定の仕組み（`feasibility.md` の 3 つの節・`- 判定:` の行）の変更。
  - PoC 文書の中身の正しさの自動判定。
  - cc-sdd 標準のファイル（requirements.md・design.md・tasks.md・spec.json）への印の追加。

## Boundary Candidates
- 運用の区画の文章（配布する決まり）。
- このリポジトリの steering と既存の記録の移行（自己適用の側）。
- テスト（実在確認の対象の付け替え）。

## Out of Boundary
- `poc/` 以外にあるテスト用の仕組み（`test/`）の作り直し。
- 導入先の `.gitignore` の扱い。

## Upstream / Downstream
- **Upstream**: feasibility-review（根拠の条件・記録の形式を定めた spec）、kiro-gate（入力の停止）。
- **Downstream**: 今後作るすべての spec（PoC の記録の書き方に従う）。

## Existing Spec Touchpoints
- **Extends**: feasibility-review（要件 2.3「PoC は再実行でき結果が残るもの」などを置き換える。要件の改訂は `/kiro-spec-requirements` の段階で扱う）。
- **Adjacent**: kiro-gate・work-branch-flow・subagent-delegation・installer-core・session-install・codex-hook-trust・install-freshness（既存の `feasibility.md` の参照を付け替えるだけで、内容は変えない）。

## Constraints
- 実機検証が必要かどうかは、要件の段階で判定する（外部の動作に依存する前提がある場合は必要）。この spec 自身の PoC も、新方式の `poc-*.md` で残す。
- 要件の段階で決める未決の点: `poc/self-install/run.mjs`・`poc/install-freshness/e2e.mjs` のような、設計の根拠ではなく繰り返し使う確認手順は、`test/` に移すか、文書の手順に置き換えるか（既定の方針は、繰り返し必要なものだけ `test/` の e2e に移し、それ以外は文書だけにする）。
- 文書は日本語で書く。コード内のコメントも日本語。
