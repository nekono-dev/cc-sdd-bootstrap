- 対象: 止める指示が、同じ入力に並ぶ他のフックの案内（手順書を先に読む案内、作業ブランチへの切り替えの案内、実物の kiro-gate の終了の停止）と両立し、止めた入力の作業が進まないこと（要件 2.1〜2.4・7.1〜7.3・9.2・9.3、`feasibility.md` の前提 (b)(c)）
- 段階: design

## 実施内容の要点
- `design_01.md` と同じ使い捨てのリポジトリと起動の方法で、次を組み合わせて 3 回に分けて実行した。止める指示（`stop`）、手順書を先に読む案内（`gate`）、作業ブランチへの切り替えの案内の試作（`branch`）、このリポジトリの実物の `kiro-gate.mjs`（`kg`。手順書の一覧に載らない状態にして、手順書を読むまで他のツールを拒否し、終了を 1 回止める）、実物の `work-branch-gate.mjs`（`wbg`。基底ブランチ `main` の上でツールを拒否し、作業ブランチへの切り替えを案内する）。止める指示と kiro-gate・work-branch-gate の登録の順序も変えた。
- 手順書は「`OUT.txt` を作り中身を書く」だけの内容にして、作業が進んだかを `OUT.txt` の有無で見た。ツールの使用、ブランチ、リポジトリの変更（`git status`）も見た。

## 実施日・環境と版
- 実施日: 2026-11-26
- 環境: `design_01.md` と同じ（Claude Code 2.1.329、Codex CLI 0.172.0、Node.js v22.16.0）。

## 結果

実行の一覧（停止の指示を含む 18 回。比較用の 4 回は別に示す）。

| 組 | ツール・モデル・モード | フックの構成 | 回数 | 作業の成果物（`OUT.txt`） | 手順書の読み取り（`Read`） | 停止の案内 |
|---|---|---|---|---|---|---|
| 1 | Claude Code haiku | stop のみ／stop+gate／stop+gate+branch | 3 | なし | なし | 応答の文章に出た |
| 1 | Claude Code sonnet | stop+gate+branch | 1 | なし | なし | 出た |
| 1 | Claude Code sonnet（auto モード） | stop+gate+branch | 1 | なし | なし | 出た |
| 1 | Codex | stop+gate+branch | 1 | なし | なし | 出た |
| 2 | Claude Code haiku | stop+kg（順序 2 通り）、もう 1 回 stop+kg | 3 | なし | 3 回とも あり | 出た |
| 2 | Claude Code sonnet | stop+kg（順序 2 通り） | 2 | なし | なし | 出た |
| 2 | Claude Code sonnet | stop+gate+branch+kg | 1 | なし | あり | 出た |
| 2 | Codex | stop+kg（順序 2 通り） | 2 | なし | なし | 出た |
| 3 | Claude Code haiku | stop+kg+wbg | 1 | なし | あり（`Read` 2 回と `Bash`） | 出た |
| 3 | Claude Code sonnet | stop+kg+wbg | 1 | なし | あり | 出た |
| 3 | Claude Code sonnet（auto モード） | wbg+stop+kg | 1 | なし | なし | 出た |
| 3 | Codex | stop+kg+wbg | 1 | なし | なし | 出た |

- 集計: 作業の成果物は、停止の指示を含む Claude Code 14 回・Codex 4 回（計 18 回）のどれでも作られなかった。ブランチは `main` のまま、リポジトリの変更も無かった（試験の土台のファイルだけ）。停止の案内は全回の応答の文章に出た。
- 実物の kiro-gate を並べた回は、Claude Code 9 回（組 2 の 6 回、組 3 の 3 回）。うち手順書の読み取りが起きたのは 6 回（haiku 4 回中 4 回、sonnet 5 回中 2 回）。Codex は 3 回とも起きなかった。読み取りの後も作業は進まなかった。
- 実物の work-branch-gate を並べた回（組 3）でも、止める指示のほうが優先され、ブランチは切り替わらなかった。

比較用（止める指示なし）: kiro-gate だけ（Claude Code・Codex 各 1 回）は手順書を読み `OUT.txt` を作った。work-branch-gate + kiro-gate（Claude Code haiku 1 回）は、作業ブランチを作り、手順書を読み、`OUT.txt` を作った。Codex の work-branch-gate + kiro-gate は、ブランチの作成を試みた（書き込み不可で失敗）。つまり、この確認の仕組みは、作業が進む場合を検出できる。

- 応答の文章の自己申告は、ツールの使用と食い違うことがあった（haiku の 1 回は、「手順書の読み込みは行っていません」と書いたが `Read` が使われていた）。

## 仕様への反映
- 止める指示だけで、並んだ案内があっても作業（ファイルの作成・編集・状態を変えるコマンド・ブランチの切り替え）は止まる。ツールの拒否による補強は、現時点では入れない（要件 2.4）。作業が進んだ観測が出たら、補強を設計に足す（見直しの条件）。
- 手順書の読み取りは、kiro-gate の終了の停止によって起きる。kiro-gate は変えず、要件 2.1 を「手順書の読み取りは許容する」に直した（利用者の判断。2026-11-26）。
- 確かめられなかったこと: 回数が少ない。haiku・sonnet 以外のモデル。実際の cc-sdd の手順書（長い手順書を読んだ後の振る舞い）。リモートセッションの画面での表示（`design_01.md` と同じ）。導入のフック（`install-cc-sdd.mjs`）の停止との併存（実装後の E2E で確かめる）。
