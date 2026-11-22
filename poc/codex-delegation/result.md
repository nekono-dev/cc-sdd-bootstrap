# エージェント MCP と Codex モデルカタログの探査

2026-11-21（JST）に、登録済みの Pi MCP と Codex CLI 0.167.0 で確認した。

```sh
python3 poc/codex-delegation/run.py
```

| 確認 | 実測 |
|---|---|
| Claude Code の管理対象登録 | 一時リポジトリの登録は承認待ちと表示され、未起動だった。固定ランチャーは空白を含むリポジトリのサブディレクトリからルートで動いた。 |
| 登録された MCP | `codex mcp get pi-agent --json` から有効な stdio 登録を取得した。 |
| Pi MCP の操作 | 初期化で `pi-agent` を取得し、能力・モデル一覧・起動・状態・停止のツールを確認した。 |
| Pi の受付モデルと能力 | モデル ID は 6 件。`read-only` と `workspace-write` を公開し、推論量は `off` のみだった。 |
| Codex のカタログ | 認証を持たない一時設定で `model/list` を呼び、9 件を取得した。Luna と Sol は `medium` と `high` を公開した。 |

この検証では委任ジョブを起動していない。Codex の公開カタログは、利用するアカウントでのモデル利用権を保証しない。
