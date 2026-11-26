# PoC 結果: git の worktree の中で Codex を起動したときのフック

- 実行日: 2026-11-24
- 環境: Codex CLI 0.167.0（gpt-6-luna、推論量 low）、Node.js v22.16.0。一時の `CODEX_HOME`、信頼の承認は `--dangerously-bypass-hook-trust` で省いた
- 目的: installer-core 7.2 が止まった原因（worktree では Codex のフックが動かない）を確かめ、`.codex/hooks.json` の置き方を設計で決める
- 手順: `poc/codex-worktree-hooks/run.sh`。使い捨てのリポジトリの本体の checkout（`main`）と worktree（`wt`）の両方に、見分けの名前だけが違う `.codex/hooks.json`（`main-json`・`wt-json`）と、記録用のスクリプトを置く。コマンドは配置物と同じ `node "$(git rev-parse --show-toplevel)/<スクリプト>"` の形

| 場面 | 読まれた hooks.json | 呼ばれたスクリプト | フックの作業場所・git の根 |
|---|---|---|---|
| 1. worktree の最上位で起動 | 本体側（`main-json`） | **worktree 側** | `wt`・`wt` |
| 2. worktree の下のディレクトリで起動 | 本体側 | worktree 側 | `wt/sub`・`wt` |
| 3. 本体の最上位で起動 | 本体側 | 本体側 | `main`・`main` |
| 4. worktree で起動、本体側に hooks.json が無い | なし（worktree 側の hooks.json も読まれない） | — | — |
| 5. worktree で起動、本体側にスクリプトが無い | 本体側 | worktree 側（本体側のスクリプトは要らない） | `wt`・`wt` |
| 6. worktree で起動、登録が worktree に無いスクリプトを指す | 本体側 | なし（node が失敗） | セッションは止まらず、`ls` も実行され、答えが返った |

フックの入力の `cwd` は、どの場面でもセッションの作業場所と同じだった。

## 分かったこと

- Codex は、worktree の中でも本体の checkout の `.codex/hooks.json` だけを読む。worktree 側の `.codex/hooks.json` は、本体側に無くても読まれない。
- フックのコマンドはセッションの作業場所で動く。今の形（`$(git rev-parse --show-toplevel)` で根を求める）なら、根は worktree になり、**worktree 側の配置物のスクリプト**が呼ばれる。
- つまり worktree では「どのイベントに何を登録するか」は本体側の版、「スクリプトの中身」は worktree 側の版になる。
- 登録が指すスクリプトが worktree に無い（worktree が古い版）と、そのフックは失敗するだけで、セッションもツールの実行も止まらない（動かないだけ）。
- 信頼の承認は本体側のファイルに対して行う（下の「追加の確認」の 7・8）。

## 追加の確認（2026-11-24、設計レビューの指摘を受けて）

| 場面 | 結果 |
|---|---|
| 7. 承認を省かず（`--dangerously-bypass-hook-trust` なし）に `codex exec` を worktree で起動 | フックは動かず、何の表示も無い（未承認のフックは黙って飛ばされる） |
| 8. 対話の画面の `codex` を worktree で起動（tmux で操作） | 「Hooks need review」が出て、確認の画面の Source は `Project config - …/main/.codex/hooks.json`（本体側）。承認すると `~/.codex/config.toml` に `[hooks.state."…/main/.codex/hooks.json:session_start:0:0"]` と `trusted_hash` が記録され、その後は承認を省かない `codex exec` でも worktree で worktree 側のスクリプトが動いた |
| 9. 実際の配置物（`real-install.sh`）: このリポジトリの `dev/spec-simplify` を普通の checkout として写して本体にし、worktree を作って `codex exec` を起動 | 本体側の登録から worktree 側の `install-cc-sdd.mjs` が呼ばれ、答える前に worktree へ `.agents/skills/kiro-*`・AGENTS.md（標準の文書＋運用の区画）が入った。Codex は AGENTS.md の見出しを答えた。本体側には `.agents` が作られない |

場面 8 の手順（手で行う）: 一時の `CODEX_HOME` で worktree に移って `codex` を起動し、「Review hooks」→ イベント → フックを開いて Source を読み、`t` で承認する。

## 設計に引き継ぐこと

- コマンドの形は変えない（worktree でも worktree 側のスクリプトが動く）。
- worktree の中で Codex のフックを動かすには、本体の checkout にも同じ導入（`.codex/hooks.json` の登録）が要る。本体側が未導入か古い版なら、フックは動かないか一部だけ動く。
- 本体側に登録があれば、cc-sdd の導入のフック（session-install）が worktree の作業の前に worktree へ cc-sdd を入れる（場面 9）。本体側が未導入の間は、worktree で Codex を起動する前に `node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs` を手で実行する必要がある（フックが動かないと AGENTS.md もスキルも無いため）。
- 信頼の承認は本体の checkout で 1 回行えば、その worktree にも効く。`codex exec` では承認を求められないので、最初は対話の画面の `codex` で承認する。
- 7.2（自己適用の後の実機の確認）の Codex のフックは、このリポジトリの本体の checkout（develop）に自己適用が取り込まれるまで worktree では確かめられない。
