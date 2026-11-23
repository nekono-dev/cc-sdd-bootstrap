# PoC 結果: Codex のプロジェクトのフックで配置物のスクリプトを呼ぶ書き方

- 実行日: 2026-11-23
- 環境: Codex CLI 0.167.0（指揮役 gpt-6-luna、推論量 low）、Node.js v22.16.0。一時の `CODEX_HOME`、フックの信頼の承認は `--dangerously-bypass-hook-trust` で省いた
- 目的: installer-core 4.1（Codex のフックの設定への登録）の設計の前に、`.codex/hooks.json` のコマンドの書き方を確かめる

| 確かめたこと | 結果 |
|---|---|
| 最上位で起動したとき、相対の道筋（`node .agent-hooks/cc-sdd-bootstrap/probe.mjs`）で呼べるか | 呼べる。フックの作業場所はリポジトリの最上位 |
| 下のディレクトリ（`--cd sub`）で起動したとき、`.codex/hooks.json` が読まれるか | 読まれる（絶対の道筋のフックは呼ばれた） |
| 下のディレクトリで起動したとき、相対の道筋で呼べるか | 呼べない。フックの作業場所はセッションの作業場所（`sub`）になる |
| シェルの展開で根を求める書き方（`node "$(<版管理の CLI> rev-parse --show-toplevel)/.agent-hooks/cc-sdd-bootstrap/probe.mjs"`）で呼べるか | 最上位・下のディレクトリのどちらでも呼べる（コマンドはシェルで解釈される） |
| フックの入力に、セッションを見分ける値があるか（kiro-gate の状態の置き場所の前提） | ある。すべてのフック（SessionStart・UserPromptSubmit・PreToolUse・PostToolUse・Stop）に `session_id` が入り、1 回の起動の中で同じ値。ほかに `turn_id`・`transcript_path`・`cwd`・`model`・`permission_mode` |
| シェルの操作はフックの入力にどう入るか | `tool_name` は `Bash`、`tool_input.command` にコマンドの文字列。PostToolUse には `tool_response` が加わる。Stop には `stop_hook_active`（1 回目は false）と `last_assistant_message` |
| フックの環境変数に、プロジェクトの根を表すもの（Claude Code の `CLAUDE_PROJECT_DIR` 相当）があるか | 無い（`CODEX_HOME`・`CODEX_MANAGED_*`・`PWD` だけ） |

## 設計に引き継ぐこと

- Codex 向けのコマンドは、シェルの展開で根を求める形にする。Claude Code 向けは今どおり `"$CLAUDE_PROJECT_DIR/..."`。
- フックの作業場所は起動した場所になるので、配置物のスクリプトは自分の位置から根を求める（今の `install-cc-sdd.mjs` と同じ形）。
- kiro-gate の状態は、`session_id` とリポジトリの根でセッションごとに分けられる。
- `.codex/hooks.json` の形は Claude Code の `hooks` と同じ（イベント → `{ matcher?, hooks: [{ type: "command", command, timeout }] }` の配列）。
