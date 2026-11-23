# Research & Design Decisions

> 改訂（2026-11-23）: 単純化後の要件（先読みの強制だけに絞り、Codex に同じ規則を適用する）に合わせて書き直した。旧版（roadmap・brief の検査、開始時の状態通知、手順書が無いときの停止）は git の履歴にある。

## Summary
- **Feature**: `kiro-gate`
- **Discovery Scope**: New Feature（develop には実装が無い。旧版はタスクまで承認したが未実装）
- **Key Findings**:
  - Claude Code: UserPromptSubmit の `prompt` は入力のまま届き（`/kiro-x 本文`）、PreToolUse の拒否の理由はモデルに届き、手順書の Read の後の PostToolUse で読んだことを記録でき、Stop は `stop_hook_active` で 2 回目を通せる（`poc/kiro-gate/`、2026-11-23 に再実行で OK 12）。
  - Codex: 同じ 4 つのフックがあり、`$kiro-*` も `prompt` の先頭で検出できる。シェル（`tool_name: "Bash"`、`tool_input.command`）で手順書を `cat` で読むので、コマンドの文字列で読み取りを観測する。Stop の 2 回目も通せる（`poc/req-feasibility/codex.sh`）。
  - 両ツールのフックの入力に `session_id` があり、セッションごとに状態を分けられる（Codex は `poc/codex-hook-path/` で確認）。

## Research Log

### 状態の置き場所
- **Context**: 要件 3.4（リポジトリに残さない）・3.5（別のリポジトリ・セッションに適用しない）・3.6（作業ディレクトリが変わっても取り違えない）。
- **Findings**: `session_id` は両ツールで全フックにある。フックの作業場所はセッションの作業場所で変わりうるが、スクリプトは自分の位置から根を求められる。
- **Implications**: 状態は OS の一時ディレクトリ（`os.tmpdir()`）の下に、「根の絶対の道筋＋`session_id`」のハッシュを名前にしたファイルで持つ。根はスクリプトの位置から求め、`cwd` は使わない。

### 読み取りの観測
- **Findings**: Claude Code は Read の `tool_input.file_path`（絶対の道筋）。Codex は Bash の `tool_input.command` の文字列に手順書の道筋（`.agents/skills/<名前>/SKILL.md`）が含まれるか。
- Codex の PostToolUse の `tool_response` はコマンドの出力の文字列だけで、終了コードは無い（失敗は `cat: missing.txt: No such file or directory` のような出力になる。`poc/codex-hook-path/` で確認）。
- **Implications**: 道筋を含むかだけで判定すると `ls <手順書>` でも解ける（設計レビューの指摘）。最初のコマンドが読み取りのコマンド（`cat`・`head`・`sed`・`nl`）で、引数を入力の `cwd` から解いた道筋が手順書と一致するときだけ通す。成功は「応答に手順書の最初の空でない行が含まれる」で確かめる（両ツール共通）。`cat <手順書> && 別のコマンド` は最初が読み取りなので通る（汎用のシェルの解析はしない）。

### スキルとして展開された場合
- **Findings**: 一覧に載るスキルを `/kiro-x` で呼ぶと、手順書の本文はモデルに渡る（Claude Code の展開）が、`prompt` は入力のままで、フックからは展開の有無が分からない。
- **Implications**: 展開されていても、手順書の Read を 1 回求める（要件 2.4 の「読み取りの成功を確認できる」を満たす唯一の観測点）。余分な Read 1 回は許容する。

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
- `poc/kiro-gate/result.md`、`poc/req-feasibility/result.md`、`poc/codex-hook-path/result.md`
- `.kiro/specs/installer-core/design.md`（カタログ・フックのコマンドの形）、`.kiro/specs/session-install/design.md`（同じ時点のフック）
