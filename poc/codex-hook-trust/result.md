# PoC 結果: codex-hook-trust（承認の記録の自動書き込み）

- 実行日: 2026-11-25
- 環境: Codex CLI 0.172.0（gpt-6-luna、推論量 low）、Node.js v22.16.0。一時の `CODEX_HOME` を使う
- 手順: `node poc/codex-hook-trust/run.mjs [--e2e]`（突き合わせは `POC_HOOKS_JSON=<承認済みの hooks.json の絶対の道筋>` で指定）
- 目的: 導入・更新の行程で `~/.codex/config.toml` の `trusted_hash` を計算して書けるかを確かめる

## 計算式（Codex の公式ソースから）

出典: openai/codex の `codex-rs/hooks/src/engine/discovery.rs`（`hook_hash`）と `codex-rs/config/src/fingerprint.rs`（`version_for_toml`）。

- 識別情報 = `{ event_name, matcher（未指定なら無し）, hooks: [ { type:"command", command, timeout, async, statusMessage（指定時のみ）… } ] }`。TOML に変換するため、未指定の項目（null になるもの）は含めない。
- キーを辞書順に並べた JSON を sha256 にして `sha256:<16 進>` とする。
- 設定のキー = `<hooks.json の絶対の道筋>:<イベント名の小文字スネーク>:<グループの番号>:<フックの番号>`。値は `[hooks.state."<キー>"]` の `trusted_hash`。
- `timeout` の既定は 600。`async` の既定は false（SessionEnd 以外）。

## 確かめたこと

| 確かめたこと | 結果 |
|---|---|
| 計算したハッシュが、利用者の承認済みの記録（このリポジトリ本体の `hooks.json` の 8 件）と一致するか | **8 件すべて一致**（Codex の確認画面で承認した記録と同じ値） |
| 1. 記録なしで `codex exec` を起動 | フックは動かない（黙って飛ばされる） |
| 2. 計算したハッシュを一時の `config.toml` に書いて起動 | **フックが動く**（承認の画面は不要） |
| 3. `--dangerously-bypass-hook-trust`（記録なし） | フックが動く |

## 設計に引き継ぐこと

- 案 A（記録の書き込み）は成立する。計算は外部パッケージ不要の数行で書ける。
- キーに `hooks.json` の絶対の道筋が入る。worktree では本体側の道筋で承認される（`poc/codex-worktree-hooks`）ため、書くのは本体の checkout の道筋。worktree の道筋には別の記録が要る可能性があり、設計の前に確かめる。
- フックの定義（command・timeout・matcher）を変えるとハッシュも変わる。導入・更新のたびに計算し直して書く。
- 計算式は Codex の内部実装で、版が変わると合わなくなりうる。合わないときは未承認として扱われるだけで動作は壊れない（案 B と文章による補いが残る）。この PoC を Codex の版を上げるたびに再実行して互換を確かめる。
- 案 B（`--dangerously-bypass-hook-trust`）は `codex exec` で効く。

## 計算式の履歴（openai/codex、2026-11-25 に調査）

- 承認の仕組み: 2026-05-05（#20321）。`--dangerously-bypass-hook-trust`: 2026-05-13（#21768）。
- 識別情報 `{event_name, matcher, hooks:[{type, command, timeout, async, statusMessage}]}` は導入から変わっていない。その後に増えたフックの項目（`commandWindows`・`onFailure`・`additionalContextLimit` など）は、未指定なら TOML に出ないため、既存のフックのハッシュは変わらない。
- `version_for_toml` は 2026-09-29（#49295）に辞書順の整え方を書き直したが、出力は同じと読める（旧版の実行は未確認）。
- プラグイン由来のフックだけ、2026-10-16（#54619）で中身のハッシュが足された。プロジェクトの `hooks.json` には影響しない。
- 以前の版で承認した 8 件の記録が、Codex 0.172.0 の計算と一致した。
- 版との対応はコミットの日付で追った（リリースのタグとの厳密な対応は未確認）。

## 設計の前提の確認（`probe.mjs`、2026-11-25、Codex CLI 0.172.0）

| 確かめたこと | 結果 |
|---|---|
| A1. リポジトリをシンボリックリンク経由の道筋で開き、記録を実体の道筋で書いた | **フックは動かない** |
| A2. 同じく、記録を見かけの道筋（開いた道筋）で書いた | 動く。キーの道筋は Codex を起動した道筋そのまま（実体に直されない） |
| B. `[hooks.state]` の見出しが無く、`[hooks.state."<キー>"]` の表だけを書いた | 動く |
| C. コメント・他の表のある `config.toml` の末尾へ追記した | 動く。既存の行は変わらない |
| D1. 承認を省く指定が `codex exec --help` に出る | 出る（`--dangerously-bypass-hook-trust`） |
| D2. 未知の指定を渡したときの失敗 | 終了コード 2、`error: unexpected argument '…' found`（標準エラー出力の先頭行） |

設計に引き継ぐこと: キーの道筋は「Codex を起動した道筋」で決まる。導入側が知れるのは `git rev-parse --show-toplevel`（実体の道筋）なので、通常の起動（実体の道筋）に合わせて書き、シンボリックリンク経由の起動では効かない場合があることを案内する。

## プロジェクトの信頼との関係（2026-11-25、設計の確認で判明）

| 確かめたこと | 結果 |
|---|---|
| 信頼していないプロジェクト（`[projects]` の信頼なし）で `--dangerously-bypass-hook-trust` を付けて起動 | `Untrusted project-local configuration is disabled` と表示され、**フックは 1 つも動かない**。承認を省く指定はプロジェクトの信頼の代わりにならない |
| 信頼済みのプロジェクトの worktree で、承認を省く指定を付け、読み取り専用で起動 | SessionStart・UserPromptSubmit・Stop のフックが動いて完了し、子は約 4.5 秒で応答した（フックは子を止めなかった） |

これまでの PoC（`run.mjs --e2e`・`probe.mjs`）の一時の設定は、すべてプロジェクトの信頼（`[projects.<道筋>] trust_level = "trusted"`）を書いてから確かめている。本機能の範囲は承認の記録だけで、プロジェクトの信頼は利用者が与える前提（利用者の決定）。

## Codex クラウドでの確認（2026-11-25、`cloud-result.md`）

結果は大半が未確認だった。確認できたのは次のとおり。

- セッションの開始時の作業場所は `/workspace` で、Git リポジトリではなかった（対象のリポジトリは開始後に clone した）。そのため、対象のリポジトリでのセッション開始フックは観察できていない。
- `codex-cli 0.172.0-alpha.2`。`~/.codex`（`/home/agent/.codex`）は**読み取り専用**で、`config.toml` は 0 バイト（`[projects]`・`[hooks.state]` とも記録なし）。`touch` は `Read-only file system` で失敗した。
- セッションの中の `codex exec` は `failed to initialize in-process app-server client: Read-only file system` で初期化に失敗し、プロジェクトの信頼・フックの承認・承認を省く指定の挙動は確かめられなかった。`codex exec --help` には指定が出る。
- 通常の実行ではネットワークに接続できず（`Failed to connect to proxy port 8080`）、ネットワークの権限を足すと GitHub の clone は成功した。

設計への引き継ぎ: クラウドのセッションの中から `~/.codex/config.toml` へ書くことはできない（読み取り専用）。本機能の書き込みは、要件 1.6 と設計のとおり `failed`（設定を変えず、理由と手での承認の案内を表示し、導入・更新は続ける）になる。準備スクリプトがセッションより前に、書き込める状態で動くかは未確認。Codex のクラウドは利用者の決定（クラウドは対象外の認識）どおり、本機能の保証の範囲外として扱う。

再実行（2 回目、一度実行済みの状態）でも結果は同じで、判断のまとめの 4 点はすべて未確認だった（作業ツリーは開始時に空、`~/.codex` は読み取り専用、`codex exec` は初期化に失敗）。確認の続行は難しいと判断し、Codex のクラウドセッションは要件の対象外とした（利用者の決定、2026-11-25）。

## 実機の確認（`real-install.mjs`、2026-11-25、Codex CLI 0.172.0）

一時の `CODEX_HOME`・`HOME` で、導入コマンド（`bin/cc-sdd-bootstrap.mjs`）と実際の `codex exec` を動かした。利用者の `~/.codex/config.toml` は読まず・書かない（更新時刻は実行の前後で変わらなかった）。`auth.json` だけは利用者の実ホームから一時の `CODEX_HOME` へ写すが、内容は読まず表示しない。手順: `node poc/codex-hook-trust/real-install.mjs`（終了コード 0 で全件 PASS、結果は `PASS 8 / 8`）。

| 確認 | 結果 | 根拠（実際の出力の要点） |
|---|---|---|
| 導入: 記録が 8 件書かれる | PASS | 標準出力「Codex のフックの承認の記録を書きました: …（追加 8・更新 0・変更なし 0）」。導入先の表 8 件 |
| 確認 1: 承認を省く指定なしで、フックが動く（要件 1.5） | PASS | 終了コード 0。「hook: SessionStart」「hook: SessionStart Completed」の行 |
| 確認 2: 記録のハッシュを全部 0 にすると、フックは動かないが回答する（要件 6.3） | PASS | (a) 書き換えた記録 8 件（導入時と一致）、(b) 書き換え後の全 0 の記録 8 件、(c) 最終の回答「OK」、(d) 終了コード 0、(e) 「hook: SessionStart」の行なし |
| 確認 3 の準備: 壊した記録を update で正しいハッシュに戻す | PASS | 「（追加 0・更新 8・変更なし 0）」 |
| 確認 2b: update が書いた記録で、承認を省く指定なしでフックが動く（要件 1.5） | PASS | 終了コード 0。「hook: SessionStart Completed」の行。最終の回答「OK」 |
| 確認 3a: uninstall で記録の表が 0 件になる（要件 6.1） | PASS | 「取り除きました（取り除き 8・残した 0）」。取り除き後の表 0 件（前は 8 件） |
| 確認 3b: 承認を省く指定で、記録が合わなくてもフックが動く（要件 5.3） | PASS | 再導入後に記録を全部 0 にし、`codex exec --dangerously-bypass-hook-trust` で「hook: SessionStart Completed」 |
| 確認 3c: 承認を省く指定の実行の前後で config.toml が変わらない（要件 5.1） | PASS | 実行の前後でバイト単位の一致 |

手順の読み替え（仕様との差）:
- 確認 3 の前に、確認 2 で壊した記録を `update` で戻した。壊したままでは取り除きの照合が合わず、何も外れないため。確認 2b は、その戻した記録（`update` が書いた記録）で動くことを確かめる。
- 取り除き後の再導入は `init` ではなく `update` を使った。取り除きは `.cc-sdd-bootstrap.json` を残すため、`init` は既存の設定があるとして失敗する（`CONFIG_EXISTS`）。

### 突き合わせと probe（同日、同じ Codex CLI 0.172.0）

| 確かめたこと | 結果 |
|---|---|
| `run.mjs`（`POC_HOOKS_JSON` に本体の `.codex/hooks.json` を指定し、利用者の承認済みの記録と突き合わせ） | 一致 8 / 不一致 0 / 記録なし 0（終了コード 0） |
| probe A1: シンボリックリンク経由で開き、記録を実体の道筋で書いた | フックは動かなかった（前回と同じ） |
| probe A2: 同じく、記録を見かけの道筋で書いた | フックが動いた（前回と同じ） |
| probe B: `[hooks.state]` の見出し無しで表だけ書いた | フックが動いた（前回と同じ） |
| probe C: 既存の設定（コメント・他の表）の末尾に追記した | フックが動き、既存の行は残っていた（前回と同じ） |
| probe D1: `codex exec --help` に承認を省く指定が出る | 出た（前回と同じ） |
| probe D2: 未知の指定 | 終了コード 2、`error: unexpected argument … found`（前回と同じ） |

結論: 承認の記録の計算式・導入・取り除き・承認を省く指定が、Codex CLI 0.172.0 の実機で想定どおりに動くことを確かめた。承認を省く指定は設定に保存されず、記録が合わない場合はその回の起動だけフックが動く。
