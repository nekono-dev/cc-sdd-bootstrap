<!-- cc-sdd-bootstrap:begin この区画は cc-sdd-bootstrap が管理する。手で書き換えると update で戻る -->
## cc-sdd のサブエージェント
- 実装・修正は `manufacture`、レビューは `review`、設計は `design`、調査は `research`、原因調査は `debug` に委任する。
- ネイティブの定義名は `cc_sdd_<role>`。読み取り専用の設計では `cc_sdd_design_read_only` を選び、事前確認に `readOnly: true` を渡す。
- cc-sdd の手順を始めるときは、導入済みの手順名を指定して `node .agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs enter <kiro-skill>` をシェルツールで単独実行する。
- ネイティブだけを導入した構成では、起動直前に `node .agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs preflight <kiro-skill> <base64url>` をシェルツールで単独実行する。最後の引数は `{requestId, role, readOnly?, toolName, toolInput}` の JSON を UTF-8・base64url にしたもの。依頼ごとに異なる `requestId` を使う。
- `toolName` は実行する `collaborationspawn_agent` または `spawn_agent`、`toolInput.agent_type` は役割定義名。起動引数一式を `toolInput` に入れ、`fork_turns: "none"`（旧形式では `fork_context: false`）を指定する。
- 事前確認が成功したら、同じ引数で起動ツールを一度呼ぶ。確認に失敗した場合は理由を確認する。設定と権限が確認できる役割だけを利用する。
<!-- cc-sdd-bootstrap:end -->
