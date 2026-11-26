# PoC 結果: install-freshness の外部の動作に依存する前提

- 実行日: 2026-11-26
- 環境: Node.js v22.16.0、npm 10.9.2、Claude Code 2.1.329、Codex CLI 0.172.0（Linux）
- 実行: `node poc/install-freshness/run.mjs [ブランチ]`（既定 `dev/base-branch-sync`。取得は一時のキャッシュで行い、リポジトリには書かない）

## 結果（OK 11 件、NG 0 件）

| # | 確かめたこと | 結果 |
|---|---|---|
| A1 | `npx -y github:nekono-dev/cc-sdd-bootstrap#<ブランチ> help` で配布物が動く | OK |
| A2 | 取得した配布物（`<キャッシュ>/_npx/<hash>/node_modules/cc-sdd-bootstrap`）の 1 つ上の `.package-lock.json` の `packages["node_modules/cc-sdd-bootstrap"].resolved`（`git+ssh://…#<40 桁のコミット>`）から、取得したコミットを取り出せる | OK（`b4c2633b…`） |
| A3 | 取り出したコミットが、その時点の配布元のブランチの先頭（`git ls-remote`）と一致する | OK |
| A4 | 配布物の `package.json` にはコミットが無い（`version` は `0.1.0` のまま。`gitHead`・`_resolved` も無い）。版では古さを判定できない | OK |
| A5 | 取得したときの指定（`#ブランチ`）は、配布物の 2 つ上の `package-lock.json` の `packages[""].dependencies["cc-sdd-bootstrap"]`（`github:nekono-dev/cc-sdd-bootstrap#dev/base-branch-sync`）に残る | OK |
| B1 | 認証なしで `git ls-remote https://github.com/nekono-dev/cc-sdd-bootstrap HEAD` が成功する（約 1.3 秒） | OK |
| B2 | 接続できないとき（`127.0.0.1:9`）、非 0 で即座に返る | OK |
| B3 | 応答が無いとき（経路の無いアドレス）、呼び出し側の待ち時間の上限（2 秒）で打ち切れる（`SIGTERM`） | OK |
| B4 | 存在しない・非公開のとき（`GIT_TERMINAL_PROMPT=0`）、認証を求めず非 0 で返る | OK |
| D（claude） | SessionStart のフックの `hookSpecificOutput.additionalContext` の合言葉を、Claude Code のエージェントが答えた | OK |
| D（codex） | 同じ形の出力の合言葉を、Codex のエージェントが答えた（`--dangerously-bypass-hook-trust` を付けた `codex exec`） | OK |

## 追加の確認（手で実行、再実行は下の手順）

`npx` のキャッシュに古い版が残るか（前提 2）。使い捨てのブランチ `dev/poc-freshness-tmp` を push し、同じ一時キャッシュで 2 回 `npx -y github:nekono-dev/cc-sdd-bootstrap#dev/poc-freshness-tmp help` を実行した。1 回目と 2 回目の間に、ブランチへ新しいコミットを push した。

| 回 | ブランチの先頭 | `.package-lock.json` の `resolved` のコミット |
|---|---|---|
| 1 回目 | `b4c2633b…` | `b4c2633b…` |
| 2 回目（ブランチが動いた後） | `8da51133…` | `8da51133…`（キャッシュの組は 1 つのまま、古い版は使われなかった） |
| 空のキャッシュで再取得 | `8da51133…` | `8da51133…` |

- 結論: 枝・タグ指定の `npx github:…#ref` は、実行のたびに `ref` を解決し直す（npm 10.9.2）。キャッシュが古い版を返す現象は、この環境では再現しなかった。
- 再実行: 使い捨てのブランチを push → 一時キャッシュ（`npm_config_cache`）で `npx` を実行 → 新しいコミットを push → 同じキャッシュで再実行 → ブランチを削除、の順。
- 指定を省いた `npx github:nekono-dev/cc-sdd-bootstrap`（既定の先頭）と、ほかの npm の版は未確認。そのため、記録するコミットは「実際に配置した配布物から取り出した値」とし、最新と偽らない設計にする（要件 1.3・1.4）。

## 分かったこと（設計への影響）

- 配布元のコミットは、`npx` が配布物の隣に残す `.package-lock.json` から取り出せる。取り出せない場合（手元の checkout からの実行など）は、記録に「取り出せなかった」と書く。
- 取得したときの `#ref` も取り出せるため、ブランチ指定の利用先では、そのブランチの先頭と比べられる（既定の先頭と比べると常に差が出てしまう）。
- 最新の取得は `git ls-remote`（外部パッケージ不要、認証不要）で足りる。失敗・待ち時間の超過は、案内を省く側（通す）に倒せる。
- 追加の文脈は両ツールで届く。ただし「利用者へ伝える」かはエージェントの動作に依る。案内文に、利用者へ短く伝える指示を入れる。
