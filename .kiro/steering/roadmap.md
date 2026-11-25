# Roadmap

## Overview

cc-sdd（Kiro 方式の仕様駆動開発のスキル集）の運用一式を、1 コマンドで任意のリポジトリへ配置・更新する。大目的は次の 3 つだけで、これに効かない仕組みは持たない（2026-11-22、利用者の指示）。

1. **cc-sdd のスキルをリポジトリに再複製しない**: 導入物はコミットせず、固定版で入れる。
2. **cc-sdd を使い漏らさないワークフローを、フックと各ハーネスで強制する**: cc-sdd のスキルが無い初回でも `/kiro-*` を確実に使える。指揮役（会話を進めるメインのエージェント）は Claude Code と Codex の両方を対象にする（Claude Code のトークンを使い切ったときの回避策にもなる）。
3. **skyshare で採用した仕組みを抽象化・機械化する**: サブエージェントのモデルの決まりと、別ベンダのサブエージェントの積極的な利用。厳密さのためにコードを増やすことではない。

完成したら、このリポジトリ自身と skyshare に適用する（skyshare の移行手順はこのプロジェクトでは扱わない）。

## Approach Decision

- **Chosen**: 配置方式を続け、各部品を最小の核に削る（2026-11-22 の単純化の discovery で決定）。「何を使わせるか」は短い文章（cc-sdd の標準の文書として作り直す CLAUDE.md・AGENTS.md の末尾に書き足す運用の区画）と役割表、「使い漏らしを止める箇所」は薄いフック、「別ベンダの実行」は既存の CLI（`codex exec`・`claude -p`）に任せる。初回の確実な導入は、クラウドでは環境の準備スクリプト（起動前）、手元では最初の入力時のフックで行う。
- **Why**: 2026-11-18 の方針で進めた結果、厳密さのための仕組みが膨らんだ（下の「単純化の決定」）。手作業の運用（CLAUDE.md の `codex exec` の直呼び）は問題なく回っており、機械化はその形を写せば足りる。
- **Rejected alternatives**:
  - プラグイン方式（フックをプラグインに持たせる）: 環境の準備直後から動く保証が無い（このリポジトリでも、プロジェクトの設定で有効にしただけのプラグインは未導入のままだった。2026-11-22 に確認）。Codex 側の配布も統一できない。
  - 初回の `/kiro-*` のために、名前だけの小さな入口（`.claude/commands/kiro-*.md` など）をコミットする案: 利用者が起動前の導入を選んだ。
  - 初回は使えないことを制限として受け入れる案: 大目的②に反する。

## 単純化の決定（2026-11-22）

全ブランチの spec の作業状況を調べた結果（develop の実行コード約 2,400 行に対し、`dev/codex-support` は約 7,600 行・テストを含めて約 16,000 行増）。

| spec | 状態（2026-11-22） | 判断 | 理由 |
|---|---|---|---|
| installer-core | develop に取り込み済み | 要件に戻して削る | 配置したファイルの記録と改変の検出・汎用の取り除き計画・対話の聞き取り・下流向けの汎用の契約が、配置物を写す用途に対して重い。Codex への配置が無い |
| session-install | develop に取り込み済み | 要件に戻して削り、足す | `keepTemplates`（雛形のコミット）は大目的①に反する。全ファイルの内容照合は過剰。初回の `/kiro-*` が「Unknown command」になる穴と、Codex への導入が無い |
| kiro-gate | `dev/kiro-gate` でタスク承認済み・未実装 | 要件に戻して削り、足す | roadmap と brief の終了時の検査・開始時の状態の知らせは先読みの強制と別物。手順書が無いときの停止は session-install と重複。Codex への対応が無い |
| subagent-model-policy | `dev/codex-support` で 21 タスク中 18 完了・未取り込み | **撤回**（subagent-delegation へ） | 使い捨ての合言葉の発行・コマンドの書き換え・事前確認の経路分けなど、入口の認証のためのコードが大半（関連 8 ファイル 約 1,500 行） |
| codex-delegation | 同上、28 タスク中 9 完了 | **撤回**（subagent-delegation へ） | MCP の探査・自作の Codex MCP・ジョブの記録と別プロセス制御（約 2,800 行）。最終的な実行は `codex exec` で、管理入口を通した起動の成功も未確認 |
| plugin-skill | brief のみ | **撤回** | 大目的への寄与が間接的。必要になったら改めて起こす |

- `dev/codex-support`（`c47d0df`）は消さず、取り込まずに残す。PoC で分かった事実（`poc/subagent-model-policy/result.md`、`poc/codex-delegation-live/result.md` の Codex のフックの実機確認）は subagent-delegation の調査記録へ引き継ぐ。
- 撤回した spec の文書は `dev/codex-support` と git の履歴にある。develop からは消す。

## Scope

- **In**: 導入・更新のコマンドと小さな設定ファイル、Claude Code と Codex の両方への配置（フックの登録・運用の区画の文章・`.gitignore`）、起動前と初回の cc-sdd の固定版の導入と失敗時の停止、`/kiro-*` の手順書の先読みの強制、役割表とエージェント定義の生成・子のモデルの拒否・別ベンダの CLI を起動する入口、それぞれの前提を確かめる PoC。
- **Out**: cc-sdd 本体（スキル・雛形）の配布や改変、BRW（branch-release-workflow）の導入、skyshare 固有の仕組み、skyshare の移行手順、プラグインとしての配布、MCP の探査・自作の MCP サーバー・ジョブの管理、入口の認証（合言葉・引数の照合）、配置したファイルの改変の検出。

## Constraints

- cc-sdd に関わる成果物はこのリポジトリに置かない（cc-sdd は MIT。本リポジトリは Unlicense）。
- Node.js 22 以上、外部パッケージなし。
- Claude Code・Codex の動作に依存する前提は、設計の承認前に PoC で確かめる。PoC は再実行できるスクリプトで残す。
- 厳密さのためにコードを増やさない。フックは「判定できないときは通す」か「止める」かを部品ごとに決めて明記し、どちらでも短く保つ。
- 指揮役と同じモデル、指揮役より上の格のモデルでサブエージェントを起動しない。役割ごとのモデルは設定で決める。
- 2 つの提供元を使える環境では、作る役（実装・修正）は指揮役と同じ提供元の下位のモデル、レビューは別の提供元が作業単位ごとに 1 回行い、指揮役はレビューをやり直さない（レビューの重複によるトークンの浪費を避ける。2026-11-23、利用者の指示）。2 つの提供元は必須条件にしない。
- cc-sdd の版はプロジェクトごとに設定ファイルで変えられる。書式に依存する判定は、想定の書式が見つからないときに何もしない。
- Codex のフックは信頼の承認が要る。承認されていない環境では文章（AGENTS.md）で補う。

## Boundary Strategy

- **Why this split**: 導入コマンド（このリポジトリで動く）・cc-sdd の導入（起動前とセッションで動く）・手順書の強制（入力とツール起動の前で動く）・サブエージェント（子の起動の前と CLI で動く）は、動く時点と PoC が違う。目的③の 2 つ（モデルの決まりと別ベンダの利用）は同じ役割表を使うため 1 つにまとめる。
- **Shared seams to watch**:
  - 設定ファイル（`.cc-sdd-bootstrap.json`）: installer-core が作り、session-install（版・言語）と subagent-delegation（役割表）がキーを読む。キーは小さく保ち、汎用の拡張点は作らない。
  - フックの登録: Claude Code（`.claude/settings.json`）と Codex のフックの設定の両方に、installer-core が自分の印のある項目だけを書く。
  - 運用の区画: CLAUDE.md と AGENTS.md は cc-sdd の導入で標準の文書として作り直し、コミットしない。installer-core が区画の文章を配置し、session-install が導入のたびに末尾へ書き足す。中身は session-install・kiro-gate・subagent-delegation の案内と、プロジェクト独自の決まり（`.kiro/steering/`）を読む案内（2026-11-23、利用者の指示）。
  - ツール起動前のフック: kiro-gate と subagent-delegation が同じ時点で動く。
  - git の worktree での Codex のフック: Codex は worktree の中でも本体の checkout の `.codex/hooks.json` を読み、スクリプトは worktree 側のものが動く（`poc/codex-worktree-hooks/`、2026-11-24）。本体の checkout が未導入か古い版の間は、worktree の Codex でフックが動かない（kiro-gate・subagent-delegation の強制も効かず、止まらずに通る）。各 spec はこの前提で設計を見直す。このリポジトリで新しいフックを足す spec では、develop に取り込むまでの一時的な状態として扱い、自己適用の後の確認（普通の checkout の写しと、取り込み後の worktree）をタスクに置く（2026-11-24、利用者の指示）。

## Existing Spec Updates

- [x] installer-core -- 要件に戻して削る（記録・改変検出・汎用の取り除き計画・対話・汎用の契約を外す）。Codex への配置（フックの設定・運用の区画の文章）を足す。利用者の CLAUDE.md を保つ管理区画はやめる. Dependencies: none
- [x] session-install -- 要件に戻して削る（keepTemplates・全ファイルの内容照合を外す）。起動前（準備スクリプト）と手元の初回の導入、Codex 向けの導入を足す. Dependencies: installer-core
- [x] kiro-gate -- 要件に戻して先読みの強制だけに削る。Codex への対応を足す. Dependencies: session-install

## Direct Implementation Candidates

- （なし）

## Specs (dependency order)

- [x] subagent-delegation -- 役割表、両ベンダのエージェント定義の生成、子のモデルの拒否（未指定・指揮役と同じ）、別ベンダの CLI を起動する入口と委任の手順の文章. Dependencies: installer-core
- [ ] feasibility-review -- 設計・タスクのレビュー（`/kiro-validate-design`・`/kiro-spec-tasks`）に実現性の観点（一次資料か実機の PoC による根拠）を外から渡し、通るまで `/kiro-spec-tasks`・`/kiro-impl` を止める。実機の確認をタスク計画の最初に置く文章. Dependencies: installer-core, kiro-gate
- [ ] codex-hook-trust -- 導入・更新の行程で Codex のフックの信頼の承認の記録（`~/.codex/config.toml` の `trusted_hash`）を自動で書き、Claude から起動する `codex exec` の子には `--dangerously-bypass-hook-trust` を付ける（併用）。最初にハッシュの計算方法を PoC で特定する. Dependencies: installer-core, subagent-delegation

## 経緯

- 2026-11-18: 最初の discovery で、配置方式＋プラグインのスキル（B＋C）を選び、installer-core・session-install・kiro-gate・subagent-model-policy・codex-delegation・plugin-skill の 6 つに分けた。
- 2026-11-19〜21: installer-core・session-install を実装して develop に取り込んだ。kiro-gate はタスクまで承認した。
- 2026-11-20〜22: subagent-model-policy・codex-delegation を `dev/codex-support` で実装したが、実機の検証のたびに厳密さのための改訂が重なった。
- 2026-11-22: 単純化の discovery で、上の「単純化の決定」のとおり見直した。
- 2026-11-23: 実装中に要件の改訂（subagent-delegation 5.13・5.14）と実機での新しい事実（Codex は追加の文脈に必ず従う）が見つかり、実装が止まった。実現性を設計・タスクの段階で根拠付きで確かめるため、feasibility-review を足した（利用者の指示。cc-sdd には手を入れず外から指示する）。
- 2026-11-24: 改訂した installer-core・session-install・kiro-gate を実装し、develop に取り込んだ（#3）。worktree の中の Codex のフックの道筋を確かめた（`poc/codex-worktree-hooks/`）。
- 2026-11-25: installer-core・session-install・kiro-gate・subagent-delegation の実装が develop に入った（subagent-delegation は PR #4。worktree の Codex での確認 4.8 も OK）。残りは feasibility-review。
- 2026-11-25: Codex のフックの承認の手間を省くため、codex-hook-trust を足した（利用者の指示。承認の記録の自動書き込みと子の回避指定の併用）。
