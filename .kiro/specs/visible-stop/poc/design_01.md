- 対象: 入力を `decision: "block"` で止めると応答が 1 件も作られない原因（再現）と、追加の文脈（`additionalContext`）だけで停止の案内が応答の文章になること（要件 1.1・1.6・6.1〜6.3、`feasibility.md` の前提 (a)）
- 段階: design

## 実施内容の要点
- リモートセッションの記録（2026-11-26、Claude Code 2.1.329）で、`/kiro-spec-quick install-freshness` が実現性の関門のフックに止められた入力を確認した。結果は成功扱いで `num_turns=0`、応答の文章は 1 件も無く、止めた理由は結果の文字列とシステムの通知にだけあった（無応答の原因）。
- 使い捨てのリポジトリ（`/kiro-spec-quick demo` を判定する試作のフックだけを登録）で、同じ入力を Claude Code（`claude -p --output-format stream-json`）と Codex（`codex -a never exec --json`）に送り、次を比べた。(1) `decision: "block"`、(2) `additionalContext` に停止の案内と「ほかの作業をしない」指示を入れた出力、(3) 比較用に、止めずに手順書を読むよう促す案内だけを出した場合（作業が進むことの確認）。
- 見たもの: 応答の文章の有無、ターン数（`num_turns`）、使われたツール、`OUT.txt`（手順書が命じる作業の成果物）の有無、ブランチ。

## 実施日・環境と版
- 実施日: 2026-11-26
- 環境: Linux 6.8.0（Ubuntu）、Node.js v22.16.0、Claude Code 2.1.329（haiku・sonnet、`--permission-mode acceptEdits` と `auto`、`--allowedTools Bash,Read,Write,Edit,Skill`）、Codex CLI 0.172.0（`-a never`・`-s workspace-write`・フックの信頼の承認を省く指定）

## 結果
- `decision: "block"`: Claude Code は `num_turns=0`・応答の文章なし（記録と同じ。無応答の再現）。Codex も応答なし。
- 追加の文脈で停止の案内を渡した場合: Claude Code は haiku（3 回）・sonnet・sonnet の auto モードのすべてで `num_turns=1` 以上の応答の文章ができ、止めた入力・理由・次にやることを書いた。ツールは使われず、`OUT.txt` は作られず、ブランチも変わらなかった。Codex も同じ案内を応答の文章として出し、コマンドを実行しなかった。
- 比較用（止めずに手順書を促すだけ）: Claude Code・Codex とも、手順書を読み、`OUT.txt` を作った。つまり、ここで見ている「作業が進む」状態を、この確認の仕組みは検出できる。

## 仕様への反映
- 入力を止める出力を、`decision: "block"` から、追加の文脈（停止の案内と止める指示）に変える（設計の方針）。
- 確かめられなかったこと: 画面（リモートセッションのアプリ）への表示そのものは、実際には見ていない。ただし、同じ記録の中で通常の応答の文章（`assistant` の `text`）は画面に表示されているので、応答の文章ができれば表示される前提を置く。実装後に実際の画面で確かめる（要件 6.4）。
