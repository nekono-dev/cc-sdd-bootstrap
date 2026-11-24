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

## 2026-11-24、設計の改訂の後（7.3。Claude Code 2.1.329、Codex CLI 0.167.0）
`node poc/self-apply/run.mjs --claude <自己適用した dev/spec-simplify の worktree> --codex ~/.cache/cc-sdd-bootstrap-scratch/self-apply-codex`。Codex の場所は、コミット `d9675ad` の `dev/spec-simplify` を普通の checkout として写したもの（worktree ではない。設計の Testing Strategy のとおり）。

- **1 回目（写した直後、cc-sdd が未導入）: OK 14 件、NG 3 件。** Claude Code はすべて OK。Codex の NG は次の 3 件。
  - 案内の入力の SessionStart の一覧が空。
  - 案内の文面から steering の場所を答えられない（「リポジトリルート」と答えた）。
  - 2 回目の起動で、手順書を読んだ証拠が見つからない。
  - 原因: 写した直後は cc-sdd も AGENTS.md も無い。cc-sdd は最初の入力の時点（UserPromptSubmit のフック）で入るので、最初のセッションでは、セッションの開始時に読まれる AGENTS.md と SessionStart の一覧がまだ無い。session-install の設計どおりの順序で、導入そのものは成功した（2 回目の起動で SessionStart の一覧に `kiro-*` が載った）。
  - 2 回目の起動の手順書の判定（手順書をシェルの操作で読んだ跡）が NG になった原因は確かめていない。確認のスクリプトが生の出力を残さないため。導入が済んだ後の再実行では OK だった（下）。
- **2 回目（同じ場所で、導入が済んだ後）: OK 17 件、NG 0 件。** Claude Code・Codex とも、次のことを確かめた。
  - 登録したフックが動く（SessionStart の状態ファイル）。
  - 運用の区画の案内から `.kiro/steering/` を答える。
  - `/kiro-spec-status`（Codex は `$kiro-spec-status`）がスキルとして動き、kiro-gate の拒否が無い。
- 対象外: develop に取り込んだ後の worktree での Codex のフックの確認（設計の Testing Strategy）。
- 1 回目の Codex の結果から、写したばかり（または新しい worktree）の最初の Codex のセッションでは、AGENTS.md の案内が効かないことが分かった。導入後の案内（5.3）の「起動する前に導入のコマンドを実行する」で避けられる。
