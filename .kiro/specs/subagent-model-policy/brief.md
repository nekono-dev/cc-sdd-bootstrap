# Brief: subagent-model-policy

## Problem
cc-sdd のスキルは「Agent ツールで新しいサブエージェントに任せる」と書くだけで、モデルを指定しない。モデルを指定しない Agent の呼び出しは指揮役（会話を進めるメインのエージェント）のモデルを引き継ぐため、高いモデルで二重に払うことになる。skyshare では CLAUDE.md の文章で防いでいるが、強制はしていない。

## Current State
skyshare の `.claude/agents/` に、Codex が使えないときの役割別の定義（Sonnet・Haiku、effort つき）がある。モデルの選び方は CLAUDE.md の文章だけで決まっている。

## Desired Outcome
- サブエージェントを使う役割ごとに、導入時にモデルを設定できる（基本は固定）。役割の候補: 調査役（discovery・requirements・design の調査、validate-impl の検証観点）、設計役（spec の作成・修正）、設計レビュー役、実装役、実装レビュー役、デバッグ役。
- 既定値は指揮役より安いモデルにする。指揮役より賢いモデルも設定できるが、既定値にはしない（2026-11-18 の相談で決定）。
- 役割ごとのエージェント定義（`.claude/agents/`）が設定から作られる。
- Agent の呼び出しのうち、モデルが決まらない（引き継ぎになる）もの、または指揮役と同じモデルになるものを、フックが拒否し、使うべきエージェント定義を理由で示す。

## Approach
PreToolUse（Agent ツール）のフックで、呼び出しの `model` の指定とエージェント定義の `model` から実際のモデルを求め、会話記録（transcript）の最新の応答から指揮役のモデルを求めて比べる。途中の `/model` での切り替えにも追従する。

## Scope
- **In**: 役割の一覧と設定のキー、エージェント定義の生成、Agent 呼び出しの判定、CLAUDE.md の管理区画に入れる「どの役割にどの定義を使うか」の文章。
- **Out**: Codex への割り当て（Claude Code から外部の Codex を呼ぶ経路。codex-delegation）。

## Codex のネイティブサブエージェント
- 実装・修正、設計・調査、レビュー・デバッグなど、役割ごとに Codex のモデルと推論量を設定できるようにする。導入先の指揮役には、作業の種類に応じて対応する定義を選ぶ手順を示す。
- このリポジトリの CLAUDE.md の例を既定値の出発点にする。実装・修正は `gpt-6-luna`、レビュー・調査・デバッグは `gpt-6.1-sol`、通常の推論量は `medium`。設計判断などで推論量を変えられるようにし、役割の既定値は要件で確認する。
- Codex 内の委任はネイティブサブエージェントを使う。プロジェクト固有のエージェント定義と AGENTS.md の管理区画への案内を候補とする。Claude Code から Codex を呼ぶ MCP 委任には、共通の役割名を渡す。
- 設計承認前に、Codex の定義と起動時の指定の優先順、指定したモデルと推論量が実際に適用されること、利用環境でモデル・定義が使えない場合の挙動、フックで起動を判定できる範囲を実機で確認する。自動拒否の条件は、その結果を踏まえて要件・設計で定める。

## Boundary Candidates
- 役割とモデルの設定
- エージェント定義の生成
- 呼び出しの判定（フック）

## Out of Boundary
- cc-sdd のスキルの改変（スキルの指示は変えず、CLAUDE.md とフックで振り分ける）

## Upstream / Downstream
- **Upstream**: installer-core
- **Downstream**: codex-delegation

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: kiro-gate（同じ PreToolUse で動く）

## Constraints
- 要件の段階で決めること: 指揮役を切り替えて役割のモデルと同じになったとき（例: 指揮役を Sonnet にし、レビュー役も Sonnet）の扱い。組み込みのエージェント（Explore・general-purpose など）の扱い。
- PoC（設計の承認前に必須）:
  - PreToolUse の Agent ツールの入力に `subagent_type`・`model` がどう入るか。
  - フックの deny でサブエージェントの起動が止まり、理由が指揮役に返ること。
  - transcript から指揮役の現在のモデルを取れること（`/model` で切り替えた後も）。
  - エージェント定義の `model`（別名・完全な ID）と `effort` が実際に効くこと、呼び出しの `model` が定義より優先されること。
  - サブエージェントの中からのツール呼び出しにも同じフックが働くか（入れ子の起動の判定）。
