# Brief: installer-core

> 改訂（2026-11-22、単純化の discovery）: 実装済み（develop に取り込み済み）だが、要件に戻して削る。理由と全体の方針は `.kiro/steering/roadmap.md` の「単純化の決定（2026-11-22）」を参照する。旧版の brief は git の履歴（`59174f6` 以前）にある。

## Problem
cc-sdd の運用を始めるには、フックの登録・スクリプト・`.gitignore`・CLAUDE.md の追記を利用先ごとに揃える必要がある。一方、今の導入コマンド（lib 約 1,800 行）は、配置したファイルの記録と改変の検出・汎用の取り除き計画・対話での聞き取り・下流が項目を足せる汎用の契約まで持つ「小さな配布管理システム」になり、配置物を写すだけの用途に対して重い。また、配置先が Claude Code だけで、Codex を指揮役（会話を進めるメインのエージェント）にした運用に対応していない。

## Current State
- `npx github:nekono-dev/cc-sdd-bootstrap init|update|uninstall` が動き、このリポジトリにも自己適用している。
- 部品: `lib/cli.mjs`（489 行）・`plan.mjs`（355）・`target.mjs`（275）・`config.mjs`（225）・`blocks.mjs`（132）・`settings-hooks.mjs`（110）・`catalog.mjs`（104）・`ledger.mjs`（94）。
- 配置先は `.claude/settings.json`・CLAUDE.md・`.gitignore`・`.agent-hooks/cc-sdd-bootstrap/`。

## Desired Outcome
- 1 コマンドで、利用先に一式が配置・更新される。再実行で共通部分が新しい版に置き換わる。
- 指揮役として Claude Code と Codex の両方に配置する: フックの登録（`.claude/settings.json` と Codex のフックの設定）、CLAUDE.md と AGENTS.md の末尾に書き足す運用の区画の文章（書き足しは session-install。2026-11-23 の改訂で、利用者の CLAUDE.md を保つ管理区画はやめた）、`.gitignore`。
- 共通の配置物は「生成物・直接編集しない」と定め、更新の差分は git で確かめる運用にする。配置したファイルの記録・改変の検出・強制上書きの指定は持たない。
- 設定は小さな 1 ファイル（`.cc-sdd-bootstrap.json`）。対話の聞き取りはせず、既定値で作り、利用者がファイルを直接直す。
- クラウド環境の準備スクリプトから呼べる入口を、session-install と合わせて用意する（後述）。

## Approach
配置物はこのリポジトリ内に利用先と同じ相対パスで持ち、固定の一覧を写す。既存ファイルとの統合は、フックの登録（自分の印のある項目だけを置き換える）と `.gitignore` に絞る。

## Scope
- **In**: 固定の配置一覧の写し、設定ファイルの初期作成と最小の検証、Claude Code と Codex のフックの登録の統合、運用の区画の文章、`.gitignore`、自己適用。
- **Out**: 配置したファイルの記録と改変の検出、`--force`、汎用の取り除き計画、対話の聞き取り、下流が項目を足せる汎用の契約（カタログ・項目定義の拡張点）。

## Boundary Candidates
- 配置（固定の一覧を写す）
- 既存ファイルとの統合（フックの登録・.gitignore）
- 設定ファイルの初期作成

## Out of Boundary
- cc-sdd 本体の取得（session-install）
- 役割とモデルの定義（subagent-delegation）

## Upstream / Downstream
- **Upstream**: なし
- **Downstream**: session-install・kiro-gate・subagent-delegation（配置物と運用の区画の文章を足す）

## Existing Spec Touchpoints
- **Extends**: installer-core 自身（要件から改訂）
- **Adjacent**: session-install（準備スクリプトの入口）

## Constraints
- Node.js 22 以上、外部パッケージなし。
- 残す安全策: 利用者が書いたフックを壊さない、配置先をリポジトリの中に限る、シンボリックリンクの先へ書かない。
- 要件で決めること: `uninstall` を残すか（残すならフックの登録と運用の区画を外す程度の単純なもの）、廃止した配置物を更新でどう片付けるか（固定の「廃止一覧」で足りるか）。
- Codex のフックは信頼の承認が要る（BRW の Codex 対応の記述）。設計前に PoC で、Codex のフックの設定の置き場所・形式・承認の扱いを確かめる。
- 自己適用で、既存の配置記録（`.agent-hooks/cc-sdd-bootstrap/installed.json`）を片付ける。

## 引き継ぎ
- このリポジトリへの循環的な自己適用（今の CLAUDE.md を steering と運用の区画へ置き換える）の手順: `handoff-self-apply.md`
