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

## 4.6 古い配置物からの区画の書き直し（`poc/self-apply/rewrite.mjs`）

`node poc/self-apply/rewrite.mjs` で、前の配置物（develop の `eb49c83`）から作った一時の checkout を、4.5 のコミットの配置物に更新し、後の入力のフックで区画だけが書き直されることを確かめる。作業場所は `~/.cache/cc-sdd-bootstrap-scratch/rewrite-<乱数>/` の下に作り、`POC_KEEP=1` で残せる。

手順:
1. 前の配置物を `git archive` で普通のディレクトリに展開して `git init` し、`init`・`update` の後に `install-cc-sdd.mjs` で cc-sdd を導入する（本物の `npx`。通信が要る）。追跡中の `.cc-sdd-bootstrap.json` は、`init` が未作成の状態を前提にするため外してから実行する。
2. CLAUDE.md・AGENTS.md の区画の前後に、区画の外の目印の文章を足す。
3. 呼び出しを記録するだけの `npx`（引数と作業場所を追記し、終了コード 0）を一時のディレクトリに置く。
4. 4.5 のコミットの `bin/cc-sdd-bootstrap.mjs update` を、そのツリーを別に展開して実行し、checkout を cwd にする。
5. 入力の JSON（`UserPromptSubmit` の形）を標準入力に渡して、checkout の `install-cc-sdd.mjs user-prompt-submit --tool claude` を実行する。このときだけ記録用の `npx` を `PATH` の先頭に置く。2 回目も同じ入力を渡す。

確かめること:
- 前提: 古い区画が前の配置物の文章と同じで、配置物の区画は 4.5 の文章に変わり、両者が違う。
- (a) CLAUDE.md・AGENTS.md の区画が 4.5 の文章（委任の案内を含む）に書き直された。
- (b) 区画の外の目印の文章が一字も変わっていない。
- (c) 記録した `npx` が一度も呼ばれていない（cc-sdd の再導入が起きていない）。
- (d) 2 回目の入力では文書がバイト単位で変わらず、書き直しの案内も出ない。

結果: OK 19 件、NG 0 件（2026-11-25）

- 環境: Claude Code 2.1.329、Codex CLI 0.167.0（この確認では起動しない）。一時の checkout は `~/.cache/cc-sdd-bootstrap-scratch/rewrite-<乱数>/`（普通のディレクトリで、git の worktree ではない）。4.5 のコミットは `d71527a`、前の配置物は `eb49c83`。生ログ `~/.cache/cc-sdd-bootstrap-logs/rewrite-1.log`
- 確かめた項目（すべて OK）: 前の配置物の `init`・`update`・cc-sdd の導入（本物の `npx`）、前提（古い区画が前の配置物の文章と同じ。配置物の区画は 4.5 の文章に変わり、両者が違う。CLAUDE.md・AGENTS.md の両方）、4.5 の `update`、1 回目の入力のフックが終了コード 0 で区画だけを書き直したと知らせる、(a) 両文書の区画が 4.5 の文章（委任の案内を含む）に書き直された、(b) 区画の外の目印の文章が一字も変わっていない（両文書）、(c) 記録した `npx` が一度も呼ばれていない、(d) 2 回目の入力で文書がバイト単位で変わらず、書き直しの案内も出ず、`npx` も呼ばれない。
- 備考:
  - 更新先のコミットは 4.5 の `d71527a` に固定している（`TARGET_REV`）。後続のコミットを 4.5 として検証したことにしないため。別のコミットで試すときは `REWRITE_TARGET_REV=<コミット>` で明示する（出力に「REWRITE_TARGET_REV で指定」と出る）。存在しないコミットは終了コード 2 で止まる。レビューの指摘で足した（固定の後の再実行も OK 19・NG 0、生ログ `rewrite-2.log`）。
  - 前の配置物の `.cc-sdd-bootstrap.json` は `eb49c83` に追跡されていて、そのままでは `init` が止まる（設定が既にある）。展開後に外してから `init` を実行している。
  - CLI の `update` は配置物の区画ファイル（`.agent-hooks/cc-sdd-bootstrap/agent-section-*.md`）だけを書き、CLAUDE.md・AGENTS.md の区画は書かない。区画の書き直しは入力のフックだけが行うので、この確認はその経路を通している。
  - 実装役（Haiku）の最初の実行も OK 19・NG 0 で、親の再実行と同じだった。
