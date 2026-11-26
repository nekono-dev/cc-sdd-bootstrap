# Brief: codex-hook-trust

## Problem
Codex のフックは「信頼の承認」が済むまで動かない（承認の前は `codex exec` で黙って飛ばされ、対話の `codex` では「Hooks need review」の確認画面が出る）。利用者は導入・更新のたびに手で承認する必要があり、煩わしい。更新でフックの定義が変わるとハッシュも変わるため、承認し直しが繰り返し起きる。Claude から `codex exec` で起動する子も、未承認のフックは動かないか確認が要る。

## Current State
- 承認の記録は利用者の `~/.codex/config.toml` の `[hooks.state."<hooks.json の道筋>:<イベント>:<番号>:0"]` と `trusted_hash = "sha256:…"`。承認は対話の確認画面で `t` を押すと記録される。
- ハッシュは hooks.json の項目をそのまま sha256 にしたものと一致しない（フック 1 件・グループ・コマンド文字列・イベント名付きの 4 通りを試した）。Codex 内部の正規化の方法は未特定。
- 公式の回避手段 `--dangerously-bypass-hook-trust` は起動 1 回ごとの指定で、設定ファイルは書き換えない。
- 導入コマンドは `.codex/hooks.json` へ印のある項目を登録するが、承認の記録は書かない。subagent-delegation の文章は「未承認のときは文章で補う」と案内している。

## Desired Outcome
- 導入・更新の行程で、承認の記録を `~/.codex/config.toml` へ自動で書き、対話の Codex でも確認画面が出ない。
- Claude から起動する `codex exec` の子は、承認の記録が無い・効かないときも止まらない（子の起動だけ承認を省く）。
- Codex の版が変わって記録の方式が合わなくなっても、子の起動は止まらず、対話の承認は従来どおり手で行える（壊れ方が安全）。

## Approach
案 C（併用）。A: 導入・更新の最後に、hooks.json の各フックのハッシュを計算して `~/.codex/config.toml` へ追記・更新する（利用者が許可済み、2026-11-25）。B: `delegate.mjs` が起動する `codex exec` に `--dangerously-bypass-hook-trust` を付け、A が効かない環境の保険にする。最初の PoC でハッシュの計算方法を特定する（Codex の公式ソース、または一時の `CODEX_HOME` で承認して記録されたハッシュとの突き合わせ）。特定できなければ A は作らず B だけにして報告する。

## Scope
- **In**: ハッシュの計算方法の特定（PoC）、承認の記録の書き込み・更新（`~/.codex/config.toml` の該当の表だけを書き換え、他の設定を保つ）、worktree と本体の道筋の扱い、`delegate.mjs` の子の起動への回避指定の追加、書き込んだ内容の確認方法（`update` の出力・取り除き）、文章（運用の区画）の更新。
- **Out**: `~/.codex/config.toml` の承認以外の設定の変更、Claude Code 側の許可の設定（`.claude/settings.json` の permissions）、フックそのものの定義の変更、承認の確認を一括で省く恒久的な回避指定の設定。

## Boundary Candidates
- ハッシュの計算（hooks.json の項目 → trusted_hash）
- 利用者の設定への書き込み（該当の表だけの追記・更新・取り除き）
- 子の起動の回避指定（delegate.mjs）

## Out of Boundary
- フックの登録そのもの（installer-core）
- 役割表・子のモデルの決まり（subagent-delegation）

## Upstream / Downstream
- **Upstream**: installer-core（`.codex/hooks.json` の登録・導入と更新の行程）、subagent-delegation（`delegate.mjs`・運用の区画の文章）
- **Downstream**: なし

## Existing Spec Touchpoints
- **Extends**: installer-core（導入・更新・uninstall の行程に書き込みを足す）、subagent-delegation（delegate.mjs の起動引数と文章の更新）
- **Adjacent**: session-install（セッション開始時の導入。承認の書き込みはここで行わない）、kiro-gate（承認の有無で働き方が変わる）

## Constraints
- 利用者全体の設定を触るため、書く前に内容を確認し、書いた箇所を利用者が確認・取り除ける形にする（uninstall で記録を外す）。許可は利用者から得ている（2026-11-25）。
- 外部パッケージなし・Node.js 22 以上。TOML は該当の表だけを文字列で扱う。
- Codex の動作に依存するため、設計の承認前に PoC（再実行できるスクリプト）で確かめる。
- 承認の記録が書けない・効かない場合は止めずに、従来の文章による補いへ戻る。
