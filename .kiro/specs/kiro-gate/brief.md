# Brief: kiro-gate

> 改訂（2026-11-22、単純化の discovery）: タスクまで承認済み・未実装だったが、要件に戻して削り、Codex への対応を足す。理由と全体の方針は `.kiro/steering/roadmap.md` の「単純化の決定（2026-11-22）」を参照する。旧版の brief は git の履歴（`a1263af`）にある。

## Problem
cc-sdd のスキルは、`disable-model-invocation: true` のものや導入直後のものがスキル一覧に載らない。そのため `/kiro-*` と入力しても、エージェントが手順書（SKILL.md）を読まずに自己流で進めることがある（大目的②）。Codex を指揮役にしたときも同じことが起きる。

旧要件は、手順書の先読みに加えて、roadmap を読んで brief の欠けで終了を止める判定（旧要件 3.2〜3.4・4）、セッション開始時の spec 状態の知らせ（旧要件 5）、手順書が無いときの停止（旧要件 2）まで持ち、5 種類のフックを使う設計になっていた。前の 2 つは先読みの強制とは別の成果物の検査で、最後の 1 つは session-install の入力の停止と重なる。

## Current State
- 未実装。要件・設計・タスク・PoC（`poc/kiro-gate/`）がある。
- PoC で確認済み: UserPromptSubmit の `prompt` は入力のまま届く。PreToolUse の拒否は Bash を止め、手順書の Read は通せる。拒否の理由はモデルに届き、モデルは手順書を読んでやり直す。

## Desired Outcome
- `/kiro-*` で始めた依頼では、対応する手順書を読むまで他の作業ツールを拒否する。Claude Code と Codex の両方で同じ規則で動く。
- 自然文の依頼は、依頼の種類と使うスキルの対応表を CLAUDE.md・AGENTS.md の運用の区画に書いて促す（フックで止めない）。
- 判定できないときは通す（通常の作業を止めない）。状態はリポジトリに残さない。

## Approach
入力時のフックで対象の手順書を決め、ツール起動前のフックで、その手順書の読み取りまで他のツールを拒否する。読んだかどうかの最小の状態だけを持つ。

## Scope
- **In**: `/kiro-*` の検出、手順書を読むまでの拒否、読んだ記録、自然文の依頼の対応表（文章）、Claude Code と Codex の両方のフック。
- **Out**: roadmap と brief の欠けによる終了の停止、セッション開始時の spec 状態の知らせ、手順書が無いときの停止（session-install の入力の停止に任せる）、spec.json の承認や tasks.md のチェックの判定。

## Boundary Candidates
- コマンドの検出と最小の状態
- 未読の間の拒否

## Out of Boundary
- 自然文の依頼の機械的な強制
- サブエージェントのモデルの判定（subagent-delegation）

## Upstream / Downstream
- **Upstream**: session-install（スキルの場所、導入の失敗の扱い）、installer-core（フックの登録・運用の区画の文章）
- **Downstream**: なし

## Existing Spec Touchpoints
- **Extends**: kiro-gate 自身（要件から改訂）
- **Adjacent**: session-install、subagent-delegation（同じツール起動前のフックで動く）

## Constraints
- 設計前の PoC: Codex で、スキルの呼び出し（`/kiro-*` に当たる入力）が UserPromptSubmit にどの形で届くか、PreToolUse の拒否で手順書の読み取り以外を止められるか、読み取りをどのツール名で観測できるか。
- 手順書の場所はベンダで違う（Claude Code は `.claude/skills/<名前>/SKILL.md`、Codex は `.agents/skills/<名前>/SKILL.md`）。
