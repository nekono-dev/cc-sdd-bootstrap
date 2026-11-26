# 実現性の記録: installer-core

> この記録は、実現性の確認の導入（feasibility-review）より前に完了した spec に、後から足した移行用の記録である。設計のやり直しではなく、実装・検証済みで、確認の根拠（PoC）が残っていることを示す。

## 実機検証の要否
- 判定: 必要
- 理由: 実機の確認が必要。導入先のコマンド（`npx` の実行入口）、設定ファイルの統合、Codex・Claude Code のフックの形、git の worktree での読まれ方が、外部の動作に依存する。

## 設計の確認
- 判定: 通過
- 根拠:
  | 前提 | 根拠の種別 | 出典・PoC（場所と版／実行日・環境・結果） |
  |---|---|---|
  | `npx` で入口のコマンドが動く | 実機の PoC | `poc/npx-bin/`（`result.md`・`run.sh`） |
  | 既存の設定ファイルへフックの登録を統合できる | 実機の PoC | `poc/settings-merge/` |
  | Codex のフックのコマンドの形 | 実機の PoC | `poc/codex-hook-path/` |
  | git の worktree での Codex のフックの読まれ方 | 実機の PoC | `poc/codex-worktree-hooks/` |
  | 自己適用（このリポジトリへの導入）が動く | 実機の PoC | `poc/self-apply/` |
- 未確認: なし（実装・検証済み。`spec.json` の phase は `implementation-complete`）

## タスク計画の確認
- 判定: 通過
- 実機の確認の位置: 実機の確認は、実装の途中と最後（タスク 7.2・7.3）で実施済み（全 25 タスク完了）。
- 未解決: なし
