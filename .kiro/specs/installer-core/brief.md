# Brief: installer-core

## Problem
cc-sdd の運用を始めるには、skyshare ではフックの登録・スクリプト・`.gitignore`・CLAUDE.md の追記を手で揃えた。新しいリポジトリでは同じ作業を繰り返すことになり、版の更新や不具合の修正もリポジトリごとに手で行う必要がある。

## Current State
skyshare の `scripts/agent/` と `.claude/settings.json` に手作りの一式がある。汎用の導入手段は無い。

## Desired Outcome
- `npx github:nekono-dev/cc-sdd-bootstrap init` で、利用先に一式が配置される。
- 同じコマンドの `update` で、共通部分が新しい版に置き換わり、プロジェクト固有の部分（設定ファイルの値、CLAUDE.md の管理区画の外、利用者が書いたフック）は残る。
- 設定ファイル（仮称 `.cc-sdd-bootstrap.json`）に、cc-sdd の版・言語・Codex の有無・役割ごとのモデルが書かれ、リポジトリにコミットされる。
- このリポジトリ自身にも同じコマンドで導入されている（自己適用）。

## Approach
配置物は、このリポジトリ内に利用先と同じ相対パスの形で持ち、導入コマンドはそれを写す。共通部分は上書きし、プロジェクト固有の部分は無いときだけ置く（bootstrap-ci-builder の sync と同じ考え方）。

## Scope
- **In**: CLI（`init`・`update`。対話の選択と、同じ選択を引数で渡す非対話の指定）、設定ファイルの形式と検証、`.claude/settings.json` へのフックの統合、`.gitignore` への追記、CLAUDE.md の管理区画の作成・更新、配置した版の記録、自己適用。
- **Out**: 各部品（セッション開始時の導入、kiro-gate、モデルの判定、Codex）の中身。それぞれの spec で扱う。

## Boundary Candidates
- 設定ファイルの読み書きと検証
- 配置（写す・上書きする・無いときだけ置く）
- 既存ファイルとの統合（settings.json・.gitignore・CLAUDE.md）

## Out of Boundary
- cc-sdd 本体の取得（session-install）
- 役割とモデルの定義（subagent-model-policy）

## Upstream / Downstream
- **Upstream**: なし
- **Downstream**: 他のすべての spec（設定ファイルにキーを足し、配置物を足す）

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: plugin-skill（同じ CLI を会話から呼ぶ）

## Constraints
- Node.js 22 以上、外部パッケージなし。
- 要件の段階で決めること: 設定ファイルの名前、配置先のディレクトリ名（skyshare と同じ `scripts/agent/` にするか）、`update` で利用者が書き換えた共通部分をどう扱うか（上書き・中止・差分の表示）、アンインストールを扱うか。
- PoC: `npx github:<owner>/<repo>` で bin が動くこと（公開リポジトリ、認証なし）。
