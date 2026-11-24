# PoC 結果: ファイルで置く役割定義と、別の提供元の CLI の権限

- 実行日: 2026-11-23
- 環境: Claude Code 2.1.329（指揮役 sonnet）、Codex CLI 0.167.0（指揮役 gpt-6.1-sol）
- 実行: `node poc/subagent-defs/run.mjs`（a・b・c を個別にも指定できる）

| 確かめたこと | 結果 |
|---|---|
| a. Claude Code の `.claude/agents/<名前>.md`（`model: haiku`・`effort`・`tools: Read, Grep, Glob`）の子を `subagent_type` で起動できるか | できる。合言葉が返った |
| a. そのとき PreToolUse の `tool_input` にモデルが入るか | 入らない（`subagent_type` だけ）。定義のモデルはフックから見えない |
| a. `tools` を読み取りだけにした子は書けないか | 書けない |
| b. Codex の `.codex/agents/<名前>.toml`（`model`・`model_reasoning_effort`・`sandbox_mode = "read-only"`）の子を `agent_type` で起動できるか | できる。子は `gpt-6-luna` で動き、合言葉が返った。`tool_input` のキーは `task_name`・`agent_type`・`fork_turns`・`message`（モデルは入らない） |
| b. `sandbox_mode = "read-only"` の子は書けないか | **書けた**。定義の権限は効かず、子は親の権限（workspace-write）で動いた（観測） |
| c. `claude -p --tools Read,Grep,Glob` は書けないか | 書けない |
| c. `claude -p --permission-mode acceptEdits` は書けるか | 書ける |
| c. `--permission-mode acceptEdits --allowedTools Bash` でシェル（テストの実行）も使えるか | 使える |

## 設計に引き継ぐこと

- 子のモデルの確認では、`tool_input.model` が無いとき、`subagent_type`・`agent_type` から定義ファイルのモデルを引く。
- Codex の組み込みの子には、定義で読み取り専用を適用できない。読み取り専用の役割を Codex の組み込みの子に割り当てる設定は、適用できない項目として示す（要件 2.3）。Codex が指揮役のときのレビューは、もともと別の提供元（`claude -p --tools Read,Grep,Glob`）で行う。
- 別の提供元の CLI の権限: Claude Code の子は読み取り専用なら `--tools Read,Grep,Glob`、書き込み可なら `--permission-mode acceptEdits`（テストの実行のため Bash も許す）。Codex の子は `--sandbox read-only`・`workspace-write`（今の運用で確認済み）。
