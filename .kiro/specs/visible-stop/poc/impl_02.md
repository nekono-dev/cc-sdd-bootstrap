- 対象: 更新した導入のフック（`install-cc-sdd.mjs` と `stop-notice-rules.mjs`）の実際の配置物で、導入が未完了のときの入力の停止が、応答の文章（停止の案内）として出ること。あわせて、導入の停止と関門の停止が並ぶ場合（要件 4.1〜4.5・6.2・6.3・7.1・7.2、タスク 4.1）
- 段階: impl

## 実施内容の要点
- 使い捨てのリポジトリ（基底ブランチ `main`、`.kiro/specs/alpha/`・`beta/` に `spec.json` だけ）に、この worktree の配置物（`.agent-hooks/cc-sdd-bootstrap/` の `*.mjs`）と、本体の checkout の実際の cc-sdd のスキルを置いた。導入の失敗の記録（`.cache/cc-sdd-install.failed`）を置き、運用の区画の文章の複製（`agent-section-*.md`）は置かなかったため、導入のフックは「導入が完了していない」ことを理由に入力を止める状態にした。
- 実物の導入のフック（`install-cc-sdd.mjs`）・kiro-gate・work-branch-gate を登録し、一部の回は実物の `feasibility-gate.mjs` も並べた。
- 入力: 通常の依頼（「README の内容を要約してください」）と、関門の対象の入力（`/kiro-spec-quick alpha`、Codex は `$kiro-spec-quick alpha`）。
- Claude Code は `claude -p`（haiku、sonnet、sonnet の auto モード）、Codex は `codex -a never exec`（`-s workspace-write`、フックの信頼の承認を省く指定）。見たもの: 応答の文章の有無とターン数、使われたツール、ブランチ、spec のファイル。

## 実施日・環境と版
- 実施日: 2026-11-27
- 環境: Linux 6.8.0（Ubuntu）、Node.js v22.16.0、Claude Code 2.1.329、Codex CLI 0.172.0

## 結果
- 5 回（Claude Code haiku 1 回・sonnet の auto モード 1 回・sonnet 1 回、Codex 2 回）すべてで、停止の案内が応答の文章として出た。止めた入力、止めたこと（導入が完了していない）、理由（運用の区画の複製が読み取れない）、次にやること（通常の端末で `node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs` を実行する。Claude の外で実行する）が含まれていた。Claude Code のターン数は 1 で、ツールは使われなかった。
- 導入の停止と関門の停止が並んだ回（`/kiro-spec-quick alpha`、Claude Code sonnet）は、2 つの理由（導入が未完了であること、alpha の実現性の記録が無いこと）がどちらも応答の文章に含まれた。ファイルの作成・編集、ブランチの切り替え、子のエージェントの起動は行われなかった。
- spec のファイルは `spec.json` 以外が増えず、ブランチは `main` のままだった。作業が進んだ観測は無かった。
- 今回の理由は「区画の複製が読み取れない」ことによる停止で、導入のフックの失敗の経路（要件 4.1〜4.4 のうち、判定不能・失敗に近い経路）にあたる。導入中（別のセッションが導入している）・古い印・区画の書き直しの失敗の各経路は、自動のテスト（`test/install-cc-sdd.test.mjs`）で出力の形を確かめた。

## 仕様への反映
- 仕様の変更は不要。導入のフックの停止も、停止の案内として応答の文章で届く。
- 確かめられなかったこと: 導入中（新しい印・古い印）・区画の書き直しの失敗の各経路の実機での確認（テストで代替）。リモートセッションの画面での表示（タスク 4.2。利用者が実画面で確かめる）。haiku・sonnet 以外のモデル。
