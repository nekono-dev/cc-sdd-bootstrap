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
