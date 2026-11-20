# Codex のプロジェクトフック登録

- 実行日 2026-11-20。Codex CLI 0.167.0、Linux、Python 3.12。
- 再実行は `python3 poc/codex-hook-registration/run.py`。一時リポジトリと検証専用の Codex 設定ディレクトリで、実物の `codex app-server` に `hooks/list` を送る。モデル呼び出しや認証は不要。

| 確認項目 | 結果 |
|---|---|
| プロジェクトが未信頼 | プロジェクトのフックは一覧に現れない |
| 信頼済みのプロジェクトで `.codex/hooks.json` のみ配置 | SessionStart を検出。フックの信頼状態は `untrusted` |
| 空白を含むリポジトリのサブディレクトリから検索 | ルートと同じ登録・ハッシュが見え、シェルで登録コマンドを実行するとルートのスクリプトが動く |
| 利用者の `.codex/config.toml` のフックと併用 | JSON と TOML の両方の登録が一覧に現れる |
| JSON のコマンド文字列を変更 | 登録のハッシュが変わり、承認待ちの状態で表示される |

この検証は登録の検出と承認状態を対象とする。イベントの実行・入力停止・手順書の読了検知は session-install と kiro-gate の実機検証で扱う。

[Codex フックの仕様](https://learn.chatgpt.com/docs/hooks)
