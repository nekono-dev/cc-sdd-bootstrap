# Research & Design Decisions

## Summary
- **Feature**: `subagent-delegation`
- **Discovery Scope**: New Feature（撤回した subagent-model-policy・codex-delegation の後継。`dev/codex-support` の実装は引き継がず、PoC の事実だけを使う）
- **Key Findings**:
  - 子の起動は両ツールで PreToolUse から拒否でき、理由は指揮役に届く。Claude Code は `Agent`、Codex は `spawn_agent`（フックの `tool_name` は `collaborationspawn_agent` を含む）。`tool_input.model` は明示したときだけ入る。定義ファイルで起動した子のモデルは `tool_input` に出ない（`poc/subagent-defs/`、`poc/req-feasibility/`）。
  - 指揮役のモデルは、Codex ではすべてのフックの入力に `model` がある。Claude Code はフックの入力に無く、会話の記録（`transcript_path`）の最後の応答から読む。セッションの最初のツール呼び出しでは読めない（`poc/req-feasibility/claude.sh` の e）。
  - Claude Code の `.claude/agents/<名前>.md` の `model`・`effort`・`tools` は効く。Codex の `.codex/agents/<名前>.toml` の `model`・`model_reasoning_effort` は効くが、`sandbox_mode = "read-only"` は効かず、子は親の権限で動く（Codex 0.167.0、`poc/subagent-defs/`）。
  - 別の提供元の CLI: `codex -a never exec --sandbox <read-only|workspace-write> --model <M> --config 'model_reasoning_effort="<E>"' --cd <根> -`（今の運用）。`claude -p --model <M> --effort <E>` に、読み取り専用は `--tools Read,Grep,Glob`、書き込み可は `--permission-mode acceptEdits --allowedTools Bash`（`poc/subagent-defs/` の c）。Codex から `claude -p` を呼ぶには、Codex のシェルに通信の許可が要る（`poc/req-feasibility/codex.sh` の g）。

## Research Log

### 子のモデルの見え方
- **Sources Consulted**: `poc/subagent-defs/run.mjs`、`poc/req-feasibility/claude.sh`・`codex.sh`、`dev/codex-support` の `poc/subagent-model-policy/result.md`。
- **Findings**: `tool_input` のキー — Claude Code: `subagent_type`・`description`・`prompt`（`model` は明示時）。Codex: `task_name`・`agent_type`・`fork_turns`・`message`（`model` は明示時）。Codex は履歴の引き継ぎを省くと親と同じモデルになる。
- **Implications**: 子のモデル = `tool_input.model` → 無ければ `subagent_type`・`agent_type` の定義ファイルの `model` → どちらも無ければ「未指定」（拒否）。定義の `model: inherit` も引き継ぎとして拒否する。

### モデルの名前の揺れ
- **Findings**: Claude Code の子は別名（`sonnet`）、会話の記録の指揮役は正式な ID（`claude-sonnet-5-5`）。Codex は `gpt-6-luna` のような ID。
- **Implications**: 比較は「系統」（`haiku`・`sonnet`・`opus`・`luna`・`sol`・`astra` などの語）で行う。モデルの ID を小文字にして、格の表のキーの語を含むかで系統を決める。系統が決まらないモデルは「格を確認できない」扱い（3.6）。

### Codex の組み込みの子の権限
- **Findings**: 定義の `sandbox_mode` は効かない。
- **Implications**: Codex の組み込みの子に読み取り専用の役割を割り当てることはできない。要件 2.3 に従い、Codex の定義は書き込み可の役割だけ作り、読み取り専用の役割は「Codex の組み込みの子では読み取り専用を適用できない」と示す。Codex が指揮役のときのレビュー・調査・原因調査は、既定どおり別の提供元（`claude -p --tools Read,Grep,Glob`）で行い、別の提供元が使えなければ入口の `--to same`（`codex exec --sandbox read-only`）で行う。

## Design Decisions

### Decision: 4 つの部品に絞る
- 役割表の解釈（純粋）、役割定義の生成（installer-core のカタログの「設定から作るファイル」）、子の起動の確認のフック、別の提供元の入口。手順と作業の流れは運用の区画の文章。
- 撤回した前身の入口の認証・MCP・ジョブの管理・自動切り替えは持たない。

### Decision: 役割表は「指揮役の提供元 × 役割」で持つ（設計レビューの指摘）
- **Context**: 要件 1.1（指揮役の提供元ごとに、同じ・別とモデル・推論量・権限を指定）・1.3。
- **Selected Approach**: `roles[指揮役の提供元][役割] = { provider: same|other, model, effort, permission }`。既定値は 1.3 の表そのもの。役割定義のファイルは、提供元 V については `roles[V]` だけから作る（V が指揮役のときの組み込みの子）。`provider=other` の役割は、別の提供元が使えないときの予備としてモデル無しで作る。2 人の指揮役の設定を 1 つのファイルに集めると衝突するため（設計レビューの再指摘）。
- **Rationale**: 最初の案（受け持ちの `assign` と提供元ごとの `roles` に分ける）では、「Claude Code が指揮役のときの Codex の実装」と「Codex が指揮役のときの Codex の実装」に別の推論量を設定できなかった。

### Decision: Astra の既定のモデル
- Codex のモデル一覧（`~/.codex/models_cache.json`、2026-11-23）に `gpt-6.2-astra`・`gpt-6-astra` がある。既定は一覧の先頭の `gpt-6.2-astra` とし、`modelIds` で変えられる。Opus の指揮役のレビューの既定は Astra になる（1.4）。

### Decision: 同じ提供元の CLI も入口で起動できる（設計レビューの指摘）
- 別の提供元が使えないとき（5.7）、Codex の組み込みの子は読み取り専用にできない。入口に `--to same` を足し、`codex exec --sandbox read-only` を指揮役と異なるモデルで起動できるようにする。

### Decision: 格 2 以外の指揮役の既定値は、起動のときに決める
- **Context**: 要件 1.4・1.5。役割定義のファイルは指揮役のモデルを知らない。
- **Selected Approach**: 役割定義のファイルは格 2 の既定値で作る。別の提供元の入口は、指揮役のモデルを受け取ったら 1.4 の規則で既定のモデルを決める。組み込みの子では、指揮役がモデルを明示し、フックが格と同一を確かめる。手順の文章で 1.4・1.5 を示す。

### Decision: フックは「明らかな違反だけ」止める
- 未指定・引き継ぎは常に止める。同じモデル・上の格は、両方のモデルの系統と格が分かるときだけ止める（3.6）。フックの内部の誤りは通す（設定が壊れていても、未指定の拒否だけは既定の格の表で続ける）。`allow` は出さない（kiro-gate の拒否を解かない、3.8）。

### Decision: Build vs Adopt
- 別の提供元の実行は既存の CLI（`codex exec`・`claude -p`）をそのまま使う。MCP や自作のサーバーは使わない。

## Risks & Mitigations
- Claude Code の最初のツール呼び出しで指揮役のモデルが分からない — 子のモデルが明示されていれば通す（3.6）。手順の文章で、子のモデルを常に明示するよう示す。
- Codex の組み込みの子が読み取り専用にできない — 定義を作らず示す（2.3）。読み取り専用の役割は別の提供元か指揮役自身が行う。
- 別名の対応のずれ（新しいモデルの名前）— 格の表は設定で足せる（1.2）。分からないモデルは格を確認できない扱いで通す。

## References
- `poc/subagent-defs/result.md`、`poc/req-feasibility/result.md`
- `dev/codex-support` の `poc/subagent-model-policy/result.md`（Codex の履歴の引き継ぎとモデル）
- `.kiro/specs/installer-core/design.md`（カタログ・設定の項目定義・フックのコマンドの形）
