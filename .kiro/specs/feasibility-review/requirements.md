# 要件文書

## Project Description (Input)

**対象となる利用者**：cc-sdd-bootstrap を導入したリポジトリの開発者と、そこで指揮役として作業する Claude Code および Codex。

**解決する問題**：要件や設計を変えなければならないほどの食い違いが、実装の段階（`/kiro-impl`）で初めて見つかり、実装が途中で止まって要件・設計・タスクの承認をやり直すことになる。実機の確認が計画の最後に置かれ、設計の段階の確認が実際の配置物を使わないことが原因になっている。cc-sdd は、実装中の食い違いは止める（Blocked にする）が、設計とタスクの承認の前に実現性を「確かめた根拠」で確認することは求めない。

**実現すること**：cc-sdd に手を入れず、外から次を求める。

- 要件の段階で、実機検証（実際の動作環境での確認）が必要かを判定する。除外にあたる場合を除き、基本的に PoC（前提を確かめる再実行できる試作）を作る。
- 設計とタスク計画の承認の前に、各前提が一次資料か PoC の根拠で確かめられていることを、レビューで確認して記録に残す。
- 記録が通っていない間は、次の段階の `/kiro-spec-tasks`・`/kiro-impl` の入力を止める。
- 実機の確認はタスク計画の最初に置く。実装中に要件・設計の変更が要るときは、その場で書き換えず段階を戻す。

**対象外**：cc-sdd のスキルの改変・複製、spec.json などの cc-sdd が持つファイルへの印の追加、PoC の中身の正しさの自動判定、実装中の spec の書き換えの拒否、既存の 4 つの spec の設計のやり直し。

詳細な背景は同じディレクトリの brief.md を、実機で確かめた前提は `poc/feasibility-review/result.md` を参照する。

## Introduction

feasibility-review は、設計とタスク計画の実現性を、推測ではなく根拠（一次資料または実機の PoC）で確かめた状態にしてから次の段階へ進める運用である。要件の段階で実機検証の要否を判定し、設計とタスクの段階のレビューに実現性の観点を渡し、確認の結果を spec ごとの記録に残し、記録が通っていなければ次の段階の入力を止める。

実機検証が必要な spec では、実際の配置物を使う確認をタスク計画の最初に置き、端から端まで動く最小の形を先に作る（ウォーキングスケルトン）。実装中に要件・設計の変更が必要になったときは、その場で書き換えず、cc-sdd の Blocked の扱いに従って段階を戻す。

## 対象と境界

- **対象**：`/kiro-spec-quick`・`/kiro-spec-batch` の入力の時点の停止（設計・タスクの各段階を内部で続けて実行し、途中で止められないため。2026-11-25、利用者の判断）、要件の段階の実機検証の要否の判定、設計・タスク計画の段階の実現性の確認とその記録、記録に基づく `/kiro-spec-tasks`・`/kiro-impl` の入力の停止と通す手順の案内、実機の確認をタスク計画の最初に置く求め、実装中の食い違いのときの段階の戻し方の案内、運用の区画の文章、Claude Code と Codex の両方への適用。
- **対象外**：cc-sdd のスキルの改変・複製、spec.json・tasks.md など cc-sdd が持つファイルへの印や項目の追加、PoC の中身の正しさの自動判定、実装中の requirements.md・design.md への書き込みの拒否、自然文の依頼への機械的な強制、既存の完了済み spec の設計のやり直し。
- **cc-sdd との関係**：実現性の観点は、cc-sdd のレビュー（`/kiro-validate-design` と `/kiro-spec-tasks` の独立したレビュー）を使うときに、外から追加の指示として渡す。cc-sdd のファイルの形は変えず、cc-sdd が自然に PoC を作って確かめられるよう、指示と記録の置き場所を spec のディレクトリの中に用意する。
- **kiro-gate との関係**：`/kiro-*` で始まる入力の検出の規則は kiro-gate と同じものを使う。手順書の先読みの拒否は kiro-gate が扱う。入力の停止の理由は、停止の案内として応答の文章で届く（2026-11-27、visible-stop で、`decision: "block"` による停止からモデルに話させる出力へ変更。従来の停止はリモートセッションの画面に理由が出なかった）。追加の指示は、複数のフックの文脈が並んで届く（Claude Code で確認。`poc/work-branch-flow/result.md`）。
- **work-branch-flow との関係**：同じ入力の時点で動く。作業ブランチへの誘導は work-branch-flow が扱い、feasibility-review はそれを妨げない。
- **installer-core・session-install との関係**：設定ファイルの項目の定義、フックの登録、運用の区画の文章の配置は installer-core が、導入のたびの書き足しは session-install が扱う。この仕様は、判定の内容と記録の意味と停止の条件を定める。
- **強制の前提**：機械的な強制の対象は、フックが有効で、対象の入力を判定できる環境とする。Codex のフックの信頼が承認されていない環境では、運用の区画の文章で促すが、機械的な強制は保証しない。
- **レビューへの観点の届き方（既知の制約）**：追加の文脈はレビューを実行するエージェントには届くが、手順書が決めた出力の形には反映されないことがある（`poc/feasibility-review/result.md`）。また Codex では、独立した子のレビュー役の依頼文をフックで検査・追記できない。そのため、観点が使われたことの証拠は、文脈を渡したことではなく、記録の内容で確かめる（要件 4・5）。

以下では、設計の前提（設計がそう動くと仮定していること）を「前提」、実現性の確認の結果をまとめた spec ごとのファイルを「実現性の記録」と呼ぶ。「根拠」は、一次資料（公式の文書の URL と版）か、実機の PoC（再実行できるスクリプトとその結果）を指す。受け入れ基準の主語はすべて feasibility-review とする。

## Requirements

### Requirement 1: 要件の段階での実機検証の要否の判定

**目的**：開発者として、要件の段階で実機検証が必要かを判定してから設計へ進みたい。これにより、外部の動作に依存する spec で、確認の後回しによる手戻りを避けられる。

#### 受け入れ基準

1. When 利用者が `/kiro-spec-requirements` を使う入力（`/` と `$` の形を含む）を送る, the feasibility-review shall エージェントが受け取る指示に、その spec が実機検証を必要とするかを判定し、判定と理由を実現性の記録に残すよう求める内容を含める。
2. The feasibility-review shall 実機検証が必要と判定する条件を、spec が外部の実行環境・外部のツール・外部のサービスの動作（例：Claude Code・Codex・OS・ネットワーク・第三者のツール）に依存する前提を 1 つ以上含むことと定める。
3. The feasibility-review shall 実機検証を不要と判定できる場合を、外部の動作に依存する前提を含まない場合に限る。
4. While 実機検証が必要と判定された, the feasibility-review shall 除外にあたる前提を除き、その前提ごとに PoC を作ることを基本とするよう求める。
5. If 利用者が個別の前提について PoC を作らない判断を示す, then the feasibility-review shall その前提と理由を実現性の記録に残すことを求める。
6. The feasibility-review shall 判定の結果が不要であっても、その判定と理由を実現性の記録に残すよう求める。

### Requirement 2: 設計の承認前の前提の確認

**目的**：開発者として、設計の承認の前に、各前提が根拠で確かめられた状態にしたい。これにより、実装で初めて前提が崩れることを減らす。

#### 受け入れ基準

1. When 利用者が `/kiro-spec-design` または `/kiro-validate-design` を使う入力を送る, the feasibility-review shall エージェントが受け取る指示に、設計の各前提について根拠（一次資料か PoC）を確認し、根拠の無い前提を推測のまま残さないよう求める内容を含める。
2. The feasibility-review shall 根拠として認める一次資料を、公式の文書のように出典（場所と版）を示せるものに限る。
3. The feasibility-review shall 根拠として認める PoC を、再実行できる手順と、実行日・環境・結果が残っているものに限る。
4. The feasibility-review shall 設計の確認の結果を、前提ごとの根拠と、根拠の無い前提の有無を含めて実現性の記録に残すよう求める。
5. If 設計の確認で根拠の無い前提が残る, then the feasibility-review shall その前提を記録に未確認として残し、設計の承認の前に根拠を足すよう求める。
6. Where `/kiro-validate-design` が独立したレビュー役を起動する, the feasibility-review shall 実現性の観点がレビュー役にも渡るようにする。

### Requirement 3: タスク計画の実現性の確認と、実機の確認を最初に置くこと

**目的**：開発者として、タスク計画の段階で、確実に実施できる段取りかを確かめたい。これにより、実機の確認が最後に回って食い違いが遅く見つかることを避けられる。

#### 受け入れ基準

1. When 利用者が `/kiro-spec-tasks` を使う入力を送る, the feasibility-review shall エージェントが受け取る指示に、タスク計画の各前提の根拠の確認と、段取りが確実に実施できるかの確認を求める内容を含める。
2. While その spec で実機検証が必要と判定されている, the feasibility-review shall 実際の配置物を使う確認を、タスク計画の最初の実装のタスクとして置くよう求める。
3. The feasibility-review shall タスク計画の確認の結果を、各前提の根拠の有無と、実機の確認が最初に置かれているかを含めて実現性の記録に残すよう求める。
4. If タスク計画で実機の確認が最後に置かれている、または確認が計画に無いのに実機検証が必要と判定されている, then the feasibility-review shall その状態を記録に未解決として残し、計画を直すよう求める。
5. Where `/kiro-spec-tasks` が独立したレビュー役を起動する, the feasibility-review shall 実現性の観点がレビュー役にも渡るようにする。

### Requirement 4: 実現性の記録

**目的**：開発者として、確認の結果が spec ごとに残るようにしたい。これにより、関門が実質の確認の結果を見られ、あとから根拠をたどれる。

#### 受け入れ基準

1. The feasibility-review shall 実現性の記録を、その spec のディレクトリの中の 1 つのファイルに置く。
2. The feasibility-review shall 実現性の記録に、実機検証の要否の判定と理由、設計の確認の結果、タスク計画の確認の結果を、段階ごとに分けて残す。
3. The feasibility-review shall 実現性の記録の各段階に、その段階の確認が通ったか（根拠の無い前提が無く、未解決が無い）の判定を含める。
4. The feasibility-review shall 実現性の記録を、cc-sdd が持つファイル（spec.json・requirements.md・design.md・tasks.md）に印や項目を足さずに表す。
5. The feasibility-review shall 実現性の記録を、日本語で、人が読める形で残す。
6. When 設計またはタスク計画の確認をやり直す, the feasibility-review shall 実現性の記録のその段階の結果を更新し、古い結果を通った判定のまま残さない。

### Requirement 5: 記録に基づく次の段階の入力の停止

**目的**：開発者として、実現性が確かめられていない spec が次の段階へ進まないようにしたい。これにより、確認を飛ばして進める読み落としを止められる。

#### 受け入れ基準

1. When 利用者が `/kiro-spec-tasks <spec 名>` の入力（`/` と `$` の形を含む）を送り、その spec の実現性の記録に、設計の確認が通った判定が無い, the feasibility-review shall 入力を止める。
2. When 利用者が `/kiro-impl <spec 名>` の入力を送り、その spec の実現性の記録に、タスク計画の確認が通った判定が無い, the feasibility-review shall 入力を止める。
3. If 実現性の記録が存在しない、または想定の形で読めない, then the feasibility-review shall その spec の入力を止める。
4. The feasibility-review shall 5.3 の停止を、この仕組みの導入前に作られた spec にも同じように適用する。
5. When feasibility-review が入力を止める, the feasibility-review shall 止めた理由（どの段階の確認が通っていないか）と、通すための手順（確認の実施と記録、または不要と判定する場合はその判定と理由を記録に残すこと）を応答の文章（停止の案内）で利用者に示す。
6. When 実現性の記録の該当する段階が通った判定になる, the feasibility-review shall 同じ入力を再び送ったときに入力を止めない。
7. If 入力から対象の spec を特定できない（spec 名が無い、対応するディレクトリが無い、など）, then the feasibility-review shall 入力を止めずに通す。
8. The feasibility-review shall 止めたことの記録を、リポジトリの管理対象に残さない。
9. While 実現性の記録が実機検証を不要と判定し、その理由が残っている, the feasibility-review shall その判定を実機検証に関する未確認とは扱わない。
10. When 利用者が `/kiro-spec-quick <spec 名>` または `/kiro-spec-batch` の入力（`/` と `$` の形を含む）を送り、これらが設計・タスクの各段階を 1 回の入力の中で続けて実行する, the feasibility-review shall 入力の時点で、対象の spec の実現性の記録に設計の確認が通った判定が無ければ入力を止める。
11. When feasibility-review が 5.10 の入力を止める, the feasibility-review shall 止めた理由と、個別の段階のコマンド（`/kiro-spec-requirements`・`/kiro-spec-design` など）で実現性の確認を済ませてから再び送る手順を応答の文章（停止の案内）で利用者に示す。
12. If `/kiro-spec-batch` の入力から対象の spec を特定できない（roadmap に複数の spec がある、など）, then the feasibility-review shall 入力を止めずに通し、運用の区画の文章で、個別の段階のコマンドで実現性の確認を行うよう促す。

### Requirement 6: 実装中の食い違いのときの段階の戻し方

**目的**：開発者として、実装中に要件・設計の変更が必要と分かったとき、承認の手順を飛ばさずに戻したい。これにより、承認されたはずの文書が気づかないうちに書き換わることを避ける。

#### 受け入れ基準

1. When 利用者が `/kiro-impl` を使う入力を送る, the feasibility-review shall エージェントが受け取る指示に、実装中に要件・設計と現実の食い違いが見つかったときは、その場で requirements.md・design.md を書き換えず、cc-sdd の Blocked の扱いに従って該当する段階へ戻すよう求める内容を含める。
2. The feasibility-review shall 上の指示に、段階を戻した後に、実現性の記録のその段階を更新し直すことを含める。
3. The feasibility-review shall 実装中の requirements.md・design.md への書き込みを機械的に拒否しない。

### Requirement 7: 運用の区画の文章

**目的**：開発者として、自然文の依頼やフックが働かない環境でも、実現性の確認の運用が案内されるようにしたい。

#### 受け入れ基準

1. The feasibility-review shall CLAUDE.md と AGENTS.md の末尾に書き足す運用の区画の文章に、要件の段階の実機検証の要否の判定、設計・タスク計画の承認前の根拠の確認、実機の確認をタスク計画の最初に置くこと、実現性の記録の置き場所、実装中の食い違いのときは段階を戻すことを含める。
2. The feasibility-review shall 運用の区画の文章に、独立したレビュー役（子）を起動するときは、依頼文に実現性の観点を入れることを含める。
3. The feasibility-review shall 同じ内容の文章を Claude Code 向けと Codex 向けの両方に置く。
4. The feasibility-review shall 運用の区画の文章に、実現性の記録がなければ `/kiro-spec-tasks`・`/kiro-impl` が止まること、通すための手順を含める。

### Requirement 8: 両ツールへの適用と他の仕組みとの併存

**目的**：開発者として、Claude Code と Codex のどちらを指揮役にしても同じ運用を得たい。また、既存の拒否や案内と競合しないようにしたい。

#### 受け入れ基準

1. The feasibility-review shall Claude Code と Codex の両方に、同じ規則で追加の指示と入力の停止を適用する。
2. When feasibility-review の停止と kiro-gate の追加の文脈・work-branch-flow の追加の文脈が同じ入力に重なる, the feasibility-review shall 入力を止める場合は理由を応答の文章（停止の案内）で利用者に示し、止めない場合は自分の追加の指示を他の仕組みの追加の文脈と並べてエージェントに届ける。
3. While Codex のフックの信頼が承認されていない, the feasibility-review shall 機械的な強制が働かないことを許容し、運用の区画の文章で同じ運用を促す。
4. If feasibility-review のフックが入力を解釈できない、または内部で失敗する, then the feasibility-review shall 入力を止めずに通す。
5. The feasibility-review shall 5.3 の停止（記録が無いとき）と 8.4 の通過（フック自体の失敗）を区別し、前者は spec を特定できた場合に限って止める。
