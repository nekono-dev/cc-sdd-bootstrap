# PoC 結果: work-branch-flow の設計の前提

- 実行日: 2026-11-25
- 環境: Claude Code 2.1.329（haiku、`--setting-sources project`、`--permission-mode acceptEdits`）、Codex CLI 0.172.0（`-a never`・`-s workspace-write`・承認の省略指定）、Node.js v22.16.0、branch-release-workflow（`~/git/nekono-dev/branch-release-workflow`、以下 brw。Claude Code ではプラグインとして読み込み）
- 実行: `node poc/work-branch-flow/run.mjs [A] [B] [C] [D] [E]`（使い捨てのリポジトリを `~/.cache/cc-sdd-bootstrap-scratch/poc-branch-flow/` に作る）
- 試作の関門（`probe.mjs` の `gate`・`gate-all`）: 現在のブランチが基底ブランチ（`main`・`master`・`develop`）か detached HEAD の間、ツールを拒否する。拒否の理由に「作業用ブランチへ切り替える」案内を入れる

## 結果の要約

| 場面 | 確かめたこと | 結果 |
|---|---|---|
| A | フックの入力が worktree での作業をどう映すか | 下の「入力の事実」 |
| B | 編集ツールだけを止める関門 | Claude Code は成立。**Codex は抜けた**（シェルでファイルを作った） |
| C | B に brw を重ねる（Claude Code） | **抜けた**（モデルがシェルでファイルを作り、関門も brw も通らなかった） |
| E1 | Bash も対象にした関門（brw なし） | Claude Code は成立（拒否→`git switch -c`→作成）。Codex は拒否の後に `git switch -c` が失敗（下記） |
| E2 | E1 に brw を重ね、関門が brw を許可しない | **行き詰まる**。brw の拒否で案内された `brw create`（`node …/brw.mjs create`）を関門が拒否し、作業ブランチを作れずに終わった |
| E3 | E2 で関門が brw のコマンドを許可する | 成立。拒否→`git switch -c`（brw が拒否）→`brw create`→worktree でファイルを作成。ただし `cd <worktree> && …` の Bash は関門が誤って拒否した（下記） |
| D | `gh` が無い・未認証・GitHub 以外のリモート | 3 場面とも終了コードが 0 以外（成功と取り違えない）。`gh` が無いときは `ENOENT` |

## 入力の事実（A、E から）

- 編集のツールは PreToolUse で観測できる。Claude Code は `Write`（`tool_input.file_path`）、Codex は `apply_patch`（`tool_input.command` にパッチ本文。対象は「`*** Add File: パス`」の行）。
- フックの `cwd`:
  - Claude Code は、Bash の `cd` の後も**セッションを始めた場所のまま**（`cd` 済みの場所には変わらない）。`cd <worktree> && 書き込み` は、本体が基底ブランチなら関門が拒否する（誤検出）。
  - Codex の Bash は、モデルが指定した作業場所（`workdir`）が `cwd` に入る。`apply_patch` の `cwd` はセッションの場所。
- Write の対象は絶対パスで届く（Claude Code）。対象ファイルの場所からブランチを求める方法は、worktree での作業に正しく効いた（C・E3 の Write）。
- Codex の `workspace-write` では、本体の checkout の外（リポジトリの外の worktree）へは書けない。brw の worktree は `.claude/worktrees/` にあり、リポジトリの中なので書ける（A）。

## 設計に引き継ぐこと

1. **編集のツールだけを関門にしても抜ける。** モデルは単純なファイルをシェル（`echo > …`・`printf > …`）で作る。Bash も対象にする必要がある（B・C の NG の原因）。
2. **Bash を対象にすると、brw の `brw create` まで止まる（E2）。** cc-sdd-bootstrap が brw を知らない前提のままでは、関門が拒否する範囲に「ブランチ・worktree を作るコマンド」を通す例外が要る。選択肢は設計で決める。
   - (i) 設定ファイルの項目に「関門を通すコマンドの接頭辞」を持つ（既定は `git` の切り替え系・読み取り専用。brw 導入先は利用者が足す。brw の名前は本体に書かない）。
   - (ii) 関門を一度だけの拒否にする（拒否の案内を一度出し、以後は通す。強制は弱くなる）。
   - (iii) Bash は対象にせず、基底ブランチでの `git commit`・`git push` を止める（作業の途中の変更は `git switch -c` で作業ブランチへ持ち越せる。brw の保護とは別に、brw なしの導入先で効く）。
3. **Bash の `cd` の後は、実行場所のブランチを正しく判定できない。** Claude Code のフックの `cwd` が `cd` に追随しないため。判定は「編集ツールの対象ファイルの場所」を優先し、Bash は `cwd`（Codex は `workdir`）で近似するか、判定できないときは通す（要件で決める）。
4. **Codex の `workspace-write` では `.git` が読み取り専用になり、`git switch -c` が失敗した（E1 の Codex。「`.git` が読み取り専用」と答えた）。** 承認なし・書き込み制限ありの実行で起きる。承認ありの実行や制限なしの実行での確認は、自動モードの判定が安全装置を外す操作として止めたため、していない。関門の案内は、ブランチを作れないときは利用者へ伝えて止まるよう書く。
5. **brw の拒否は、関門の拒否と衝突しなかった（E3）。** 拒否は別々の理由として届き、モデルは両方に従って `brw create` へ進んだ。

## 既存の PoC で確かめ済みの前提（再実行していない）

- 入力時のフックでコマンドを検出できる（`poc/kiro-gate/result.md`）。
- Stop のフックで 1 回だけ止められ、2 回目は `stop_hook_active` が真になって終われる（Claude Code・Codex。`poc/req-feasibility/result.md`、`poc/kiro-gate/result.md`）。
- Codex は worktree でも本体の `.codex/hooks.json` を読み、スクリプトは worktree 側のものが動く（`poc/codex-worktree-hooks/result.md`）。新しいフックも同じ登録の形を使うので、前提は同じ。

## 未確認

- brw と関門を重ねた Codex での確認（brw の Codex 用の登録に信頼の承認が要るため、していない）。
- `/kiro-validate-impl` の後の「PR が無ければ止める」を実際に流す確認（Stop の仕組みは既存の PoC で確認済み。PR の有無は D の結果どおり、`gh` の終了コードが 0 以外なら判定できない扱いにできる）。

## 追記: 同じイベントに複数のフックが出力したとき（`coexist.mjs`、2026-11-25）

| 場面 | Claude Code | Codex |
|---|---|---|
| P: PreToolUse で 2 つのフックがどちらも拒否（理由が別） | **1 つだけ届く**（後に登録したものの理由。「PreToolUse:Bash hook error: …」の形） | **1 つだけ届く**（先に登録したものの理由。「Command blocked by PreToolUse hook: …」の形） |
| U: UserPromptSubmit で 2 つのフックがどちらも追加の文脈を返す | 両方届いた | モデルが「非公開の指示は開示できない」と答え、届いたかは確認できなかった（Codex が文脈に従うことは `poc/kiro-gate/result.md` で確認済み） |
| B: 1 つが入力を止め（block）、もう 1 つが追加の文脈を返す | 止まる。理由は入力の拒否として表示され、モデルは追加の文脈を受け取らない | 止まり、モデルの応答が無い |

設計に引き継ぐこと:
- 同じ操作への拒否が重なると、理由は 1 つしか届かない。work-branch-flow と kiro-gate の拒否が重なる場面（基底ブランチで対象の入力を始め、手順書も未読）では、work-branch-flow の理由が届かないことがある。**入力時の追加の文脈で先に案内を届け、拒否は最大 2 回にする**（要件 3.5・3.12・7.2）。
- 入力の停止（block）の理由はモデルには届かず、利用者に示される。feasibility-review の停止の文言は利用者向けに書く（要件 5.5）。
