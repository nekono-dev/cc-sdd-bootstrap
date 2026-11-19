# Roadmap

## Overview

skyshare で手作りした cc-sdd の運用一式を汎用化し、`npx github:nekono-dev/cc-sdd-bootstrap init` の 1 コマンドで任意のリポジトリへ配置できるようにする。配置したものは利用先のリポジトリだけで動き、クラウドセッションでも環境の準備直後から `/kiro-*` が使える。同じリポジトリを Claude Code のプラグインとしても配り、会話から導入・更新を頼めるようにする。

完成したら、このリポジトリ自身と skyshare に適用する（skyshare の移行手順はこのプロジェクトでは扱わない）。

## Approach Decision

- **Chosen**: 配置方式＋プラグインのスキル（2026-11-18 の相談で決定。B＋C）。導入コマンドがスクリプト・フック・エージェント定義を利用先へ写し、更新は再実行で行う。プラグインのスキルは、その導入コマンドを会話から使う入口にする。
- **Why**: skyshare では、セッション開始の時点でプラグインが入っていることを当てにできず、BRW を入れるための専用スクリプトを別に用意していた。フックの本体を利用先に置けば、プラグインの導入を待たずに動く。
- **Rejected alternatives**:
  - プラグイン方式（フックをプラグインに持たせる）: 環境の準備直後から動くという要件を満たせない。
  - このリポジトリ（claude-plugins）への同居: claude-plugins は一覧だけを置く方針で、版の上げ方も違う。

## Scope

- **In**: 導入・更新コマンドと設定ファイル、セッション開始時の cc-sdd 固定版導入と失敗時の停止、kiro-gate、役割ごとのサブエージェントのモデル固定と指揮役と同じモデルの拒否、Codex MCP サーバーによる委任（選択制）、プラグインのスキル、それぞれの前提を確かめる PoC。
- **Out**: cc-sdd 本体（スキル・雛形）の配布や改変、BRW（branch-release-workflow）の導入、skyshare 固有の仕組み（migration-gate、コメント規約など）、skyshare の移行手順。

## Constraints

- cc-sdd に関わる成果物はこのリポジトリに置かない（cc-sdd は MIT。本リポジトリは Unlicense）。
- Node.js 22 以上、外部パッケージなし。
- Claude Code の動作に依存する前提は、設計の承認前に PoC で確かめる。PoC は再実行できるスクリプトで残す。
- 指揮役と同じモデルでサブエージェントを起動しない。役割ごとのモデルは設定で固定し、既定値に指揮役より賢いモデルは使わない。
- cc-sdd の版はプロジェクトごとに設定ファイルで変えられる。版によってファイルの書式が変わりうるので、書式に依存する判定は、想定の書式が見つからないときに何もしない。

## Boundary Strategy

- **Why this split**: 導入コマンド（このリポジトリで動く）と、配置物の各部品（利用先のフックで動く）は、動く場所も確かめ方も違う。配置物は部品ごとに Claude Code のどの動作に依存するかが違い、PoC も部品ごとに分かれる。
- **Shared seams to watch**:
  - 設定ファイルの形式: installer-core が定義し、他の spec はキーを足す。キーの名前と既定値の衝突に注意する。
  - `.claude/settings.json` のフックの登録: 各部品のフックを installer-core が混ぜて書く。登録の順番と、利用者が書いた既存のフックを壊さないこと。
  - CLAUDE.md の管理区画: 各部品が文章を足す。区画の中の並びと重複に注意する。
  - 役割の一覧: subagent-model-policy が定義し、codex-delegation が同じ役割を Codex に割り当てる。

## Specs (dependency order)

- [x] installer-core -- 導入・更新コマンド、設定ファイル、利用先への配置（設定の統合・管理区画・.gitignore）、自己適用. Dependencies: none
- [ ] session-install -- セッション開始時に設定の版で cc-sdd を入れ直し、失敗したら次の入力を止める. Dependencies: installer-core
- [ ] kiro-gate -- `/kiro-*` で始めた作業で手順書を先に読ませ、roadmap の新しい spec に brief が欠けたまま終わらせない. Dependencies: session-install
- [ ] subagent-model-policy -- 役割ごとのモデルの設定、エージェント定義の生成、指揮役と同じモデルや未指定（引き継ぎ）の起動を拒否するフック. Dependencies: installer-core
- [ ] codex-delegation -- 導入時の選択で、Codex MCP サーバーと委任の決まりを配置し、役割を Codex に割り当てる. Dependencies: installer-core, subagent-model-policy
- [ ] plugin-skill -- プラグインの定義と、会話から導入・更新を行うスキル。マーケットプレイス nekono-dev への掲載. Dependencies: installer-core
