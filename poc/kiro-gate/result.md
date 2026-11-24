# PoC 結果: kiro-gate の先読み

- 実行日: 2026-11-23
- 環境: Claude Code 2.1.329（モデル haiku）、Codex CLI 0.167.0（既定のモデル）、Node.js v22.16.0
- 実行: `node poc/kiro-gate/run.mjs`
- 必要なもの: 認証済みの `claude`・`codex`、Node.js 22、git。
- 作業場所: `~/.cache/cc-sdd-bootstrap-scratch/kiro-gate`。各場面で一時リポジトリを作り、このリポジトリの `init` と導入スクリプトで設定・手順書を配置する。
- 注意: Codex の認証ファイルは一時 CODEX_HOME に複写して使い、終了時に複写を削除する。認証ファイルの中身は表示しない。kiro-gate の OS 一時ディレクトリの状態は読み書き・削除しない。

## 確認すること

- A-1: セッション開始後に手順書が導入された依頼で、追加の文脈、手順書より前の拒否、手順書より前に Bash が完了しないこと、読んだ後の `after-read` を確認する。拒否の理由と追加の文脈がモデルに届くかも観測として出す。
- A-2: 別セッションで、未読のまま終えるときに最初の Stop だけが `decision: "block"` になり、その入力の `stop_hook_active` が偽であることと正常終了を確認する。
- B: 起動前から手順書が一覧にある Claude Code の `/kiro-spec-status` と Codex の `$kiro-spec-status` で、拒否・追加の文脈・停止がなく、実行が正常で回答があることを確認する。
- 各一時リポジトリでは設定にある kiro-gate の呼び出しだけを `.poc/logwrap.mjs` 経由にし、フック入力と実際の kiro-gate 出力を `.poc/log.jsonl` に記録する。

## 結果（OK 21 件、NG 0 件）

| 場面 | Claude Code | Codex |
|---|---|---|
| A-1 拒否と通過 | 追加の文脈が出て、手順書を読む前の `touch before-read` は拒否された。拒否の理由に従って手順書を Read し、その後の Bash は通った | 同じ（ただし下の注のとおり、追加の文脈を包みで外した） |
| A-2 終了の 1 回の停止 | 未読の 1 回目の Stop だけ止まり（`stop_hook_active` は偽）、モデルは手順書を読んでから終えた | 同じ（追加の文脈を外した） |
| B 一覧にある場合 | `/kiro-spec-status` で拒否・追加の文脈・停止が 1 つも無く、手順書の見出しを答えた | `$kiro-spec-status` で同じ |

- Claude Code の A は、1 つのセッションの中で 2 回入力した（1 回目の入力のフックが手順書を導入し、2 回目に `/kiro-spec-status`）。セッション開始時の一覧に無いので、読み取り済みにならない。
- Codex の A は、導入済みのリポジトリで `/kiro-spec-status`（Codex ではスキルとして扱われず本文が渡らない形）で確かめた。

## 分かったこと

- **Codex は追加の文脈に必ず従い、先に手順書を読む**（3 回とも。依頼で「先に touch せよ」と明示しても同じ）。そのため、自然な実行では拒否・終了の停止が起きない。Codex の A-1・A-2 では、包みが UserPromptSubmit の出力（追加の文脈）をツールへ返さないようにして（文脈に従わないモデルの代わり）、配置した kiro-gate の拒否・停止を確かめた。
- 拒否の理由・終了を止める理由はモデルに届き、両ツールのモデルはそれに従って手順書を読んでからやり直した。

## RED（壊すと NG になること）

このリポジトリの `.agent-hooks/cc-sdd-bootstrap/kiro-gate.mjs` の `if (!decision.allow) {` を一時的に `if (false && !decision.allow) {` にして流すと、終了 1・OK 17 件・NG 4 件（両ツールの A-1 の「手順書より前の作業が拒否された」「手順書より前に Bash が完了していない」）。戻して、コミット済みの版と一致することを確かめた。

旧版の PoC 結果は git の履歴にある。
