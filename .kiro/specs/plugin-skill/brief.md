# Brief: plugin-skill

## Problem
導入コマンドの引数（Codex の有無、役割ごとのモデル）や、更新の手順を毎回調べるのは手間がかかる。会話の中で「このリポジトリに cc-sdd を入れて」「cc-sdd の版を上げて」と頼めるようにしたい。

## Current State
nekono-dev の他の仕組み（BRW、bootstrap-ci-builder など）は、プラグインとしてマーケットプレイス nekono-dev（nekono-dev/claude-plugins）に載っている。

## Desired Outcome
- このリポジトリを Claude Code のプラグインとして入れられる。
- プラグインのスキルが、利用者に選択（Codex の有無、役割ごとのモデル、cc-sdd の版）を確かめてから導入コマンドを実行し、結果を確かめて報告する。
- マーケットプレイス nekono-dev に載っている。

## Approach
`.claude-plugin/plugin.json` とスキル 1 つを置く。スキルは導入コマンドの使い方の案内と、導入後の確認の手順に絞り、配置の処理そのものは持たない。

## Scope
- **In**: プラグインの定義、スキル、マーケットプレイスへの掲載（claude-plugins リポジトリの一覧への追加）。
- **Out**: 導入コマンドの処理（installer-core）。

## Boundary Candidates
- プラグインの定義
- スキルの手順

## Out of Boundary
- プラグインからフックを動かすこと（フックは利用先に配置する方式に決めたため）

## Upstream / Downstream
- **Upstream**: installer-core
- **Downstream**: なし

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: installer-core

## Constraints
- プラグインのスキルが、導入コマンドを `npx github:` 経由で呼ぶか、プラグインとして取得済みのファイル（`${CLAUDE_PLUGIN_ROOT}`）を直接使うかを設計で決める。
