# Research & Design Decisions

> 改訂（2026-11-23）: 単純化後の要件（先読みの強制だけに絞り、Codex に同じ規則を適用する）に合わせて書き直した。旧版（roadmap・brief の検査、開始時の状態通知、手順書が無いときの停止）は git の履歴にある。

## Summary
- **Feature**: `kiro-gate`
- **Discovery Scope**: New Feature（develop には実装が無い。旧版はタスクまで承認したが未実装）
- **Key Findings**:
  - Claude Code: UserPromptSubmit の `prompt` は入力のまま届き（`/kiro-x 本文`）、PreToolUse の拒否の理由はモデルに届き、手順書の Read の後の PostToolUse で読んだことを記録でき、Stop は `stop_hook_active` で 2 回目を通せる（実機検証、2026-11-23 に再実行で OK 12。記録は削除済み）。
  - Codex: 同じ 4 つのフックがあり、`$kiro-*` も `prompt` の先頭で検出できる。シェル（`tool_name: "Bash"`、`tool_input.command`）で手順書を `cat` で読むので、コマンドの文字列で読み取りを観測する。Stop の 2 回目も通せる（実機検証で確認済み）。
  - 両ツールのフックの入力に `session_id` があり、セッションごとに状態を分けられる（Codex は実機検証で確認済み）。

## Research Log

### 状態の置き場所
- **Context**: 要件 3.4（リポジトリに残さない）・3.5（別のリポジトリ・セッションに適用しない）・3.6（作業ディレクトリが変わっても取り違えない）。
- **Findings**: `session_id` は両ツールで全フックにある。フックの作業場所はセッションの作業場所で変わりうるが、スクリプトは自分の位置から根を求められる。
- **Implications**: 状態は OS の一時ディレクトリ（`os.tmpdir()`）の下に、「根の絶対の道筋＋`session_id`」のハッシュを名前にしたファイルで持つ。根はスクリプトの位置から求め、`cwd` は使わない。

### 読み取りの観測
- **Findings**: Claude Code は Read の `tool_input.file_path`（絶対の道筋）。Codex は Bash の `tool_input.command` の文字列に手順書の道筋（`.agents/skills/<名前>/SKILL.md`）が含まれるか。
- Codex の PostToolUse の `tool_response` はコマンドの出力の文字列だけで、終了コードは無い（失敗は `cat: missing.txt: No such file or directory` のような出力になる。実機検証で確認済み）。
- **Implications**: 道筋を含むかだけで判定すると `ls <手順書>` でも解ける（設計レビューの指摘）。最初のコマンドが読み取りだけのコマンド（`cat`・`head`・`nl`。`sed -i` で書き換えられるので `sed` は含めない。設計レビューの再指摘）で、引数を入力の `cwd` から解いた道筋が手順書と一致するときだけ通す。成功は「応答に手順書の最初の空でない行が含まれる」で確かめる（両ツール共通）。`cat <手順書> && 別のコマンド` は最初が読み取りなので通る（汎用のシェルの解析はしない）。

### スキルとして展開された場合（利用者との意識合わせで改訂）
- **Findings**: セッション開始時から一覧にあるスキルを、Claude Code は `/kiro-x`、Codex は `$kiro-x` で呼ぶと、手順書の本文がスキルとして渡る（実機検証で確認済み。b の場面。記録は削除済み）。一覧はセッション開始時に決まり、途中で導入したスキルは載らない。Codex の `/kiro-x` はスキルとして扱われない。
- **Implications**: SessionStart で一覧にあった `kiro-*` を記録し、本文が渡る形で呼ばれたら最初から読み取り済みにする（余分な Read を求めない）。読み直しを求めるのは、Codex の `/kiro-x` と、途中で導入して一覧に無いスキルだけ。

## Design Decisions

### Decision: 1 つのスクリプトで 4 つのフックを受ける
- **Selected Approach**: `kiro-gate.mjs <イベント> --tool <claude|codex>`。純粋な判断は `kiro-gate-rules.mjs`。
- **Rationale**: 状態の読み書きと判断の規則を 1 か所にまとめる。

### Decision: 判定できないときは通す
- **Context**: 要件 3.1・3.2。session-install（判定できなければ止める）とは逆。
- **Selected Approach**: 例外は日本語で標準エラーに出し、何も出力せずに終了 0。

### Decision: 単純化
- 手順書が無いときの停止、roadmap・brief の検査、開始時の状態通知、自然文への機械的な強制、コマンドの解析による読み取りの厳密な判定は持たない。

## Risks & Mitigations
- 同じ時点の UserPromptSubmit で session-install が導入した直後は、手順書がまだ無く、そのターンは先読みの対象にならない（要件 3.3 どおり通す）。同じイベントのフックは並行に動くことがあるので、カタログの並び順では保証しない — session-install の追加の文脈が手順書を直接読むよう伝える。
- 一時ディレクトリの状態ファイルが残る — 小さく、OS の一時ディレクトリの掃除に任せる。

## References
- 実機検証の記録（kiro-gate・req-feasibility・codex-hook-path の 3 件。記録は削除済み）
- `.kiro/specs/installer-core/design.md`（カタログ・フックのコマンドの形）、`.kiro/specs/session-install/design.md`（同じ時点のフック）
