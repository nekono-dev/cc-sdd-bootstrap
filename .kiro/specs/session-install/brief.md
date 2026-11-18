# Brief: session-install

## Problem
cc-sdd の導入物はライセンスが異なるのでコミットしない。そのため clone 直後やクラウドセッションの開始時には `/kiro-*` のスキルが存在しない。導入に失敗しても SessionStart のフックでは作業を止められず、スキルの無いまま作業が進んでしまう。

## Current State
skyshare の `install-cc-sdd.sh`（固定版を SessionStart で入れ直す）と `install-gate.mjs`（失敗の記録があれば次の入力を止める）で解決済み。版はスクリプトに直書きで、BRW の導入確保と同じファイルに混ざっている。

## Desired Outcome
- セッション開始のたびに、設定ファイルの版・言語で cc-sdd の導入物（スキル・設定の雛形・標準の決まりの文書）が入れ直される。CLAUDE.md は書き換えず、標準の決まりの文書は `.kiro/settings/cc-sdd-guide.md` に出力する（CLAUDE.md からの取り込みは installer-core）。
- 導入に失敗した・途中で止まったときは、次の入力が理由と再試行の方法つきで止まる。成功したら止める状態が消える。
- 導入直後でスキル一覧に載らないスキルも、手順書を直接読んで使えるよう案内される。

## Approach
skyshare の 2 本を汎用化する。版と言語は設定ファイルから読む。失敗の記録の仕組みは、他の導入対象を足せる形にしておく（ただし BRW は扱わない）。

## Scope
- **In**: SessionStart での導入、失敗の記録、UserPromptSubmit での停止、導入直後の案内。
- **Out**: 手順書を読ませる強制（kiro-gate）、BRW の導入確保。

## Boundary Candidates
- 導入の実行と失敗の記録
- 入力の停止

## Out of Boundary
- cc-sdd のスキルの内容の改変
- 導入物をコミットする運用

## Upstream / Downstream
- **Upstream**: installer-core（設定ファイル・配置・フックの登録）
- **Downstream**: kiro-gate（スキルの場所を前提にする）

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: kiro-gate

## Constraints
- 毎回の入れ直しは時間がかかる（skyshare では時間制限 600 秒）。要件の段階で、版が同じで導入物が揃っていれば入れ直しを省くかを決める。
- 導入の実行方法: skyshare はシェルスクリプト。外部パッケージなしの Node に寄せるかを設計で決める。
- PoC: SessionStart の標準出力が会話の文脈に入ること、UserPromptSubmit の `decision: "block"` で入力が止まること、導入直後のセッションでスキル一覧に載らないスキルの扱い。
- 実現可能性の確認（2026-11-18、discovery Step 5）の指摘: `--manifest` は cc-sdd の README に載らない内部の形式で、`"version": 1` が必須。非対話（フック）では `--overwrite` の既定が skip に落ちるため `--yes` の併用が必須。存在しない版は `notarget` で失敗する。初回はレジストリからの取得で数秒〜十数秒かかり、フックの `timeout` の明示が要る。クラウドセッションではレジストリへの通信が許可されている必要がある。同じリポジトリで複数のセッションが同時に始まると同じファイルを同時に書くため、排他（ロック）の要否を設計で決める。
