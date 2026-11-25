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

## 4.7 自己適用したこのリポジトリで、両ツールの子の起動を確かめる（`node poc/subagent-defs/run.mjs q`）

- 環境: Claude Code の指揮役は `claude -p --model sonnet`（この worktree で起動し、`--setting-sources project --permission-mode acceptEdits --allowedTools Bash`）。Codex の指揮役は `codex -a never exec --model gpt-6.1-terra -c model_reasoning_effort="high"`（4.5 のコミット `d71527a` を `git archive` で普通の checkout に写し、起動の前に `install-cc-sdd.mjs` で cc-sdd と AGENTS.md を導入した。フックの信頼は `--dangerously-bypass-hook-trust` で省略。検証専用）。
- `--resolve-model` の指定: Claude Code は `--orchestrator-model claude-sonnet-5-5`、Codex は `--orchestrator-model gpt-6.1-terra`。
- 確かめること:
  - Claude Code: この worktree の `.claude/settings.json` に Agent の subagent-check（claude）が登録されている（前提）。指揮役が終了し結果を返す。
  - Claude Code: 名前を付けない子（general-purpose）が、フックの理由（子のモデル未指定・`--resolve-model` の案内）で拒否される。
  - Claude Code: `--resolve-model` が成功し、ちょうど 1 行「定義の名前 推論量」を出す。その名前（model 指定なし）の起動が通り、その定義の子が実際に起動した。
  - Codex: 写した checkout で `install-cc-sdd.mjs` が終了 0 で、cc-sdd（手順書）と AGENTS.md の区画が入る。
  - Codex: 実装の定義（`cc_sdd_implement`）＋モデル省略の起動が、フックの理由（子のモデル未指定・`--resolve-model` の案内）で拒否される。
  - Codex: `--resolve-model` が終了 0 で「モデル 推論量」の 1 行を返す。
  - Codex: その出力のモデル・推論量を明示し `fork_turns` を `none` にした起動が通り、子の名前が返る。その子の記録が親子の対応で特定でき、turn_context のモデル・推論量が明示した組と一致する。子の応答（合言葉）が `wait_agent` の後に親へ届く。
- 結果: OK 13 件、NG 0 件（2026-11-25。Claude Code 2.1.329、Codex CLI 0.167.0。生ログ `~/.cache/cc-sdd-bootstrap-logs/q-3.log`）。Claude Code は自己適用したこの worktree、Codex は 4.5 のコミット `d71527a` を `git archive` で写した普通の checkout（`install-cc-sdd.mjs` で cc-sdd と AGENTS.md を入れ、フックの信頼は検証専用の `--dangerously-bypass-hook-trust` で省略）で確かめた。
- 備考:
  - 最初の実行（`q-1.log`）は、Codex の確認の準備で `git archive` の出力が `spawnSync` の既定の上限（1MB）を超えて失敗した（Claude Code 側は OK 5）。上限を広げて再実行し、すべて OK になった。確認の道具側の直しで、製品側の不具合ではない。
  - レビューの指摘で、解決コマンドの引数の判定を足した（`resolveArgsOk`）: Claude Code は `--from claude --role implement --orchestrator-model claude-sonnet-5-5`、Codex は `--from codex --role implement --orchestrator-model gpt-6.1-terra` の引数で、解決が成功して出力が返ったことを見る。誤った指揮役モデル・`--from`・役割・`--resolve-model` なしが NG になる自己検査を足した。固定前の通し（`q-2.log`）は OK 11・NG 0 で、この 2 項目を足して OK 13（`q-3.log`）。認証の写しは、コピーの直後から後始末（finally）に入るようにした。
  - 既知の限界（レビューの指摘。利用者の判断で、この限界を明記して 4.7 を完了とした）: 引数を確かめる解決コマンドと、子の起動に使った解決結果は、同じコマンドに結び付けて判定していない（`judgeCl1`・`judgeCx1` は最初に適合した解決結果を起動と照合し、引数の検査は別の成功コマンドを探す）。誤った指揮役モデルで解決して子を起動した後に、正しい引数の解決だけをもう 1 回実行した場合は、両方の検査が通りうる。実機の通し（`q-3.log`）では、解決は 1 回ずつで、別々の呼び出しは起きていない。
  - 既知の限界（レビューの指摘。節 p・f と同じ作りで、この確認の範囲外）: 共通の作業場所 `~/.cache/cc-sdd-bootstrap-scratch/subagent-defs/` は、節の実行の開始時に消される。`POC_KEEP=1` で残した記録や、同じ場所を使う並行実行のデータは、次の実行で消える（並行して実行しない）。
  - Claude Code の子の記録は `~/.claude/projects/<この worktree の slug>/` に残る（この worktree のセッションと同じ場所のため消していない）。
  - 4.6 と 4.7 の結果が揃った。取り込みの前の確認は、4.7 までを対象にした `/kiro-validate-impl` の結果を添えて、利用者に develop への取り込みの承認を求める（4.8 は取り込みの後）。
