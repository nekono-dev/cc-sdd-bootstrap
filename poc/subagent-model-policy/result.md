# サブエージェントの起動・拒否・実効設定

2026-11-20 に Claude Code 2.1.329 と Codex CLI 0.167.0 で検証した。一時リポジトリに短いテスト用エージェントとフックを置いた。

```sh
python3 poc/subagent-model-policy/run.py claude
python3 poc/subagent-model-policy/run.py codex
python3 poc/subagent-model-policy/claude-effort.py
```

`run.py` には認証済みの各 CLI と Python 3 が必要。`claude-effort.py` は実アカウントを使わず、Claude Code のリクエストをループバック上の模擬 API で確認する。Codex の検証では、利用者設定と分離した一時的な Codex 設定を使い、終了時に削除する。フック実行許可の例外はテストが作るフックだけを置いた一時環境に限る。

| 確認内容 | 観測 |
|---|---|
| Claude Code の子の許可・拒否 | `Agent` の `subagent_type` を観測。許可時は Sonnet と Haiku の利用を確認。拒否時は子の開始がなく、親に拒否理由が届いた。 |
| Claude Code の指揮役モデル取得 | 初回の起動と判定ではモデル欄や会話記録から値を得られない例があった。モデル切り替えの前後のフックでは Sonnet から Haiku への切り替えを正規 ID で取得した。 |
| Claude Code の子の推論量 | 模擬 API へのリクエストで親 Sonnet の `medium` と子 Haiku の `high` を確認。 |
| Codex の子の許可・拒否 | 隔離設定で `collaborationspawn_agent` を観測。拒否した試行では子は起動せず、親に理由が届いた。 |
| Codex のモデル・推論量 | 履歴の引き継ぎを省略した試行で親と同じモデルが使われた。引き継ぎを `none` とし、Luna と `high` を指定した試行では子の記録で両方を確認した。 |
| Codex の権限 | 親のフックの `turn_id` に対応する記録と子の記録で `read-only` を確認。フックの `permission_mode` は権限判定には使えなかった。 |

今後クライアントを更新する際は、設定と呼び出し時の値の優先順、外部の上書き、モデル変更後のフック判定を再検証する。
