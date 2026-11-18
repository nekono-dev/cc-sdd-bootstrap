# Brief: kiro-gate

## Problem
cc-sdd のスキルは、`disable-model-invocation: true` のものや導入直後のものがスキル一覧に載らない。そのため `/kiro-*` と入力しても、エージェントが手順書を読まずに自己流で進めることがある。また、kiro-discovery で複数の spec に分けたのに、分割を会話の中だけに残し、各 spec の brief.md を書かずに終えることがある。

## Current State
skyshare の `kiro-gate.mjs` が次の 2 つを強制している。
1. `/kiro-*` で始めたターンでは、対応する SKILL.md を Read するまで他のツールを拒否する。
2. そのセッションで roadmap.md が更新され、最後の「Specs (dependency order)」節に載った spec の brief.md が欠けていれば、ターンの終了を 1 回だけ止める。

## Desired Outcome
- 上の 2 つが、利用先のどのリポジトリでも同じに動く（2026-11-18 の相談で、roadmap の判定を付けることを決定。他のファイルの判定は付けない）。
- 書式が想定と違う（cc-sdd の版で見出しが変わった等）ときは、何もしない。
- 手順書が無いとき（導入の失敗）は、導入の再試行を案内して止める。

## Approach
skyshare の実装を移す。状態は OS の一時ディレクトリに置き、リポジトリに残さない。判定できないときは通す（通常の作業を止めない）。

## Scope
- **In**: SessionStart（spec の状態の要約）、UserPromptSubmit（`/kiro-*` の検出）、PreToolUse（未読の間の拒否）、PostToolUse（Read の記録）、Stop（未読・brief 欠けの停止）。
- **Out**: spec.json の承認や tasks.md のチェックの判定（cc-sdd のスキル自身が管理するため付けない）。

## Boundary Candidates
- コマンドの検出と状態
- 未読の間の拒否
- 終了時の判定（未読・roadmap と brief）

## Out of Boundary
- 自然文の依頼（`/kiro-*` で始まらない）の強制
- サブエージェントのモデルの判定（subagent-model-policy）

## Upstream / Downstream
- **Upstream**: session-install（スキルの場所と、導入失敗の扱い）
- **Downstream**: なし

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: subagent-model-policy（同じ PreToolUse で動く）

## Constraints
- PoC: UserPromptSubmit の入力に `/kiro-*` がどの形で入るか（スキル一覧に無いコマンドを入力したとき）、PreToolUse の deny が ToolSearch 以外を止めること、Stop の `stop_hook_active` で 2 回目は通ること。
