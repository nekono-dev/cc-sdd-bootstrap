- 対象: 更新した実現性の関門（`feasibility-gate.mjs` と `stop-notice-rules.mjs`）の実際の配置物で、停止の案内が応答の文章として出て、止めた入力の作業が進まないこと（要件 1.1・2.1〜2.3・6.2・6.3・7.1・7.2・9.1〜9.3、タスク 1.3）
- 段階: impl

## 実施内容の要点
- 使い捨てのリポジトリ（基底ブランチ `main`、`.kiro/specs/alpha/`・`beta/` に `spec.json` だけ。実現性の記録なし）に、この worktree の配置物（`.agent-hooks/cc-sdd-bootstrap/` 全体）と、本体の checkout の実際の cc-sdd のスキル（`.claude/skills/`・`.agents/skills/`）を置いた。フックは実物の `feasibility-gate.mjs`・`kiro-gate.mjs`（入力・ツールの拒否・終了の停止）・`work-branch-gate.mjs`（入力・ツールの拒否・終了の停止）を、Claude Code は `.claude/settings.json`、Codex は `.codex/hooks.json` に登録した。
- 入力: 単一の spec（`/kiro-spec-quick alpha`、Codex は `$kiro-spec-quick alpha`）と、複数の spec 名と `-y`（`/kiro-spec-tasks alpha beta -y`、Codex は `$` 形）を送った。
- 見たもの: 応答の文章の有無とターン数、使われたツール、spec のディレクトリに作られたファイル、ブランチ。
- Claude Code は `claude -p`（haiku と sonnet、`--permission-mode acceptEdits` と `auto`、Bash・Read・Write・Edit・Skill を許可）、Codex は `codex -a never exec`（`-s workspace-write`、フックの信頼の承認を省く指定、認証は使い捨ての `CODEX_HOME`）。

## 実施日・環境と版
- 実施日: 2026-11-27
- 環境: Linux 6.8.0（Ubuntu）、Node.js v22.16.0、Claude Code 2.1.329、Codex CLI 0.172.0

## 結果
- 6 回（Claude Code haiku 2 回・sonnet 1 回・sonnet の auto モード 1 回、Codex 2 回）すべてで、停止の案内が応答の文章として出た。止めた入力（`/kiro-spec-quick alpha`・`/kiro-spec-tasks alpha beta -y` など）、止めた理由（spec `alpha` の記録が無い）、次にやること（記録の `## 設計の確認` を通過にする、実機検証が不要なら不要と判定する、個別の段階のコマンドで確認する）が含まれていた。複数の spec 名と `-y` の入力でも、先頭の spec（`alpha`）の記録が無いことを案内した。
- Claude Code の応答のターン数は 2〜4 で、停止の案内を含む応答の文章が 1 件以上できた（従来の `decision: "block"` の `num_turns=0` とは異なる）。Codex は応答の文章（`agent_message`）に停止の案内が出た。
- 作業の成果物は作られなかった。`.kiro/specs/alpha/`・`beta/` には `spec.json` 以外のファイルが増えず、ブランチは `main` のまま、ブランチは増えなかった。
- 手順書の読み取り（`Read`）は、Claude Code 4 回中 3 回で起きた（haiku の 1 回は `Read` と `Bash`、sonnet の 2 回は `Read`）。kiro-gate の終了の停止による読み取りで、利用者の判断（要件 2.1 の緩和）で許容した範囲。読み取りの後も作業は進まなかった。Codex は 2 回とも読み取りが起きなかった。
- 作業が進んだ観測は無かったため、要件 2.4 の補強は設計に足さない。

## 仕様への反映
- 仕様の変更は不要。設計の方針（追加の文脈による停止の案内）が、実際の配置物で成り立った。
- 確かめられなかったこと: 導入のフック（`install-cc-sdd.mjs`）の停止（タスク 2・4.1 で確かめる）。リモートセッションの画面での表示（タスク 4.2 で利用者が確かめる）。haiku・sonnet 以外のモデル。回数が少ないこと。
