# 自己適用の後の実機の確認（installer-core 7.2）の結果

`node poc/self-apply/run.mjs` で、自己適用済みのこのリポジトリで `claude -p` と `codex exec` を各 2 回起動して確かめる。

## 2026-11-24（Claude Code 2.1.329、Codex CLI 0.167.0、git の worktree の中で実行）
結果: OK 14 件、NG 3 件（Claude のスキル起動の判定は、この実行の後に直した。直した判定は同じ日の Claude の出力で OK になることを確かめた）。

- Claude Code: フック（SessionStart の kiro-gate の一覧）、運用の区画の案内（`.kiro/steering/` を答えた）、`/kiro-spec-status kiro-gate` の実行と進捗の報告、kiro-gate の拒否が無いことは、すべて OK。
  - `-p` で先頭に書いたスラッシュコマンドは、手順書の本文が出力に現れない。そのため、init の `skills` に載っていることと、最初の Read が `.kiro/specs/kiro-gate/spec.json`（手順書の Step 1）であることを証拠にした。
- Codex: 運用の区画の案内、`$kiro-spec-status kiro-gate` の実行（手順書を読み、進捗を報告）、拒否が無いことは OK。
  - SessionStart のフックの状態ファイルが作られない（NG 2 件、両方の起動で listed=null）。
  - 原因: Codex は git の worktree の中で起動されると、worktree ではなく本体のチェックアウト側の `.codex/hooks.json` を読む（使い捨てのリポジトリで再現）。
  - 普通のチェックアウトでは Codex のフックも動く。

この食い違いのため、tasks.md の 7.2 を `_Blocked:_` にした（設計への戻し方は未決定）。
