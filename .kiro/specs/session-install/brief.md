# Brief: session-install

> 改訂（2026-11-22、単純化の discovery）: 実装済み（develop に取り込み済み）だが、要件に戻して削り、初回の確実な導入と Codex への対応を足す。理由と全体の方針は `.kiro/steering/roadmap.md` の「単純化の決定（2026-11-22）」を参照する。旧版の brief は git の履歴（`59174f6` 以前）にある。

## Problem
cc-sdd の導入物はライセンスが異なるのでコミットしない（大目的①）。今の仕組みはセッション開始時に入れ直すが、次の穴と重さがある。
- **初回に `/kiro-*` が使えない**: セッション開始時のフック（SessionStart）で入れたスキルは、そのセッションのスキル一覧に載らない。対話モードでは `/kiro-*` が「Unknown command」と表示されて終わり、どのフックにも届かない（`poc/session-hooks/result.md` の b、`poc/kiro-gate/result.md` の対話モードの確認）。clone 直後やクラウドの新しい環境の最初のセッションで、cc-sdd を使い漏らす。
- **Codex に入らない**: Claude Code 向け（`--claude-skills`）だけを入れている。
- **余計な仕組み**: 雛形をコミットできる例外（`keepTemplates`、旧要件 6）、全ファイルの内容照合による入れ直しの判定（旧要件 2）、複数の導入対象への一般化（旧要件 3.9）。

## Current State
- SessionStart で `.cc-sdd-bootstrap.json` の版・言語で入れ直し、揃っていれば省く。失敗・中断の記録があれば UserPromptSubmit で次の入力を止める（`install-cc-sdd.mjs` 167 行・`install-rules.mjs` 197 行・`install-gate.mjs` 90 行・`config-schema.mjs` 114 行）。
- cc-sdd 3.1.0 は Codex 向けの導入（`--codex-skills`）を持ち、`.agents/skills/kiro-*`・`AGENTS.md`・`.codex/agents` に書く（2026-11-22、`--dry-run` で確認）。

## Desired Outcome
- **クラウド環境**: 環境の準備スクリプトで、Claude Code・Codex の起動前に、cc-sdd を各ベンダ向けの手順で導入できる。準備スクリプトに書く 1 行（このリポジトリの入口の呼び出し）を案内する。
- **手元の環境**: Claude Code・Codex が最初の入力を受けたときに、フックで導入を始められる。導入したセッションではスキル一覧に載らないので、手順書（SKILL.md）を直接読むよう案内する。仕組みで強制できない部分は CLAUDE.md・AGENTS.md の文章で認識させる。CLAUDE.md・AGENTS.md は cc-sdd の標準の文書として書き出し、導入のたびに運用の区画を末尾へ書き足す（2026-11-23、利用者の指示）。
- 導入に失敗・中断したときは、次の入力が理由と再試行の方法つきで止まる（今の仕組みを残す）。
- 導入物は一律にコミットしない（`keepTemplates` を撤回）。入れ直しの判定は、版・言語と必須ファイルの有無程度に縮める。

## Approach
今の入口を、Claude Code と Codex の両方に対して同じ規則で動くように直し、余計な判定を外す。起動前の導入は、同じ入口を準備スクリプトから呼ぶ形にする。

## Scope
- **In**: 起動前の導入の入口（準備スクリプトから呼ぶ）、手元の初回の導入（フック）、Claude Code と Codex の両方への導入、失敗の記録と入力の停止、導入直後の案内（文章を含む）。
- **Out**: 手順書を読ませる強制（kiro-gate）、雛形のコミット、全ファイルの内容照合、BRW の導入確保。

## Boundary Candidates
- 導入の実行（ベンダごとの引数）と失敗の記録
- 入力の停止
- 起動前・初回の導入の入口

## Out of Boundary
- cc-sdd のスキルの内容の改変
- 導入物をコミットする運用

## Upstream / Downstream
- **Upstream**: installer-core（設定ファイル・配置・フックの登録）
- **Downstream**: kiro-gate（スキルの場所を前提にする）

## Existing Spec Touchpoints
- **Extends**: session-install 自身（要件から改訂）
- **Adjacent**: kiro-gate（手順書が無いときの停止は、ここの入力の停止に寄せて重複させない）

## Constraints
- 設計前の PoC: Codex に SessionStart に当たるフックがあるか（UserPromptSubmit・PreToolUse・Stop は `dev/codex-support` の `poc/codex-delegation-live/result.md` と `.codex/hooks.json` で確認済み）、Codex の `/kiro-*`（スキル）が初回にどう扱われるか、手元の初回の導入をどのフックで始められるか。
- 同時に始まったセッションの導入は重なる（`poc/session-hooks/result.md` の d）。今の「排他なし・記録を先に書いて成功で消す」方式を残すかを設計で決める。
- クラウドセッションではパッケージのレジストリへの通信が要る（既定で許可されている）。
