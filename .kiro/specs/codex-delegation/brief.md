# Brief: codex-delegation

## Problem
Codex（OpenAI のコーディングエージェント）が使える環境では、実装やレビューを Codex に任せると、Claude の指揮役のコストを抑えつつ、独立した目でのレビューが得られる。skyshare ではこの仕組みを作り込んだが、skyshare 固有のスクリプトと CLAUDE.md の長い文章に埋まっている。

## Current State
skyshare に、Codex を MCP サーバー（外部ツールを Claude Code へつなぐ仕組み）として提供するスクリプト一式（`codex-mcp-server.mjs` ほか）、Codex が信頼していないリポジトリで入力を止めるフック（`codex-trust-gate.mjs`）、`.mcp.json`、`.codex/config.toml`、CLAUDE.md の委任の決まり（モデルの選び方、失敗時の CLI への切り替え、Codex が使えないときの Claude サブエージェント）がある。

## Desired Outcome
- 導入時に「Codex MCP サーバーを使うか」を選べる。使わない場合は何も配置しない。
- 使う場合、役割（subagent-model-policy の一覧）ごとに Codex の sandbox・モデル・effort を設定でき、Codex が使えないときは同じ役割の Claude エージェント定義に切り替わる。
- Codex のモデル名（今の `gpt-6.1-sol`・`gpt-6-luna`）は設定ファイルで変えられる。

## Approach
skyshare の Codex 関連を移し、モデル名などの値を設定ファイルから読むようにする。CLAUDE.md の委任の決まりは、管理区画に入れる定型の文章にする。

## Scope
- **In**: MCP サーバーのスクリプト一式、信頼の確認のフック、`.mcp.json` の統合、役割と Codex の割り当ての設定、管理区画の委任の文章。
- **Out**: Codex 本体の導入・認証。

## Boundary Candidates
- MCP サーバー（実行・列・権限）
- 信頼の確認
- 委任の決まり（文章）

## Out of Boundary
- Claude サブエージェントのモデルの判定（subagent-model-policy）

## Upstream / Downstream
- **Upstream**: installer-core、subagent-model-policy（役割の一覧）
- **Downstream**: なし

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: subagent-model-policy

## Constraints
- 要件の段階で決めること: `.codex/config.toml` を配置するか、skyshare 固有の検証の分担（`test:imports` など）を外した汎用の委任の文章の範囲。
- PoC: MCP サーバーが `codex` の無い環境でツールを出さずに起動すること、`.mcp.json` の承認（settings.local.json）の扱い。
