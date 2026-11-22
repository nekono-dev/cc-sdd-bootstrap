# codex-delegation の実機の通し検証（タスク 6.1・6.2）

2026-11-22（UTC）に、worktree `/tmp/cc-sdd-bootstrap-codex-support` で実行した。Claude の結果は最後の全体実行（`claude_live.py` の 3 回目）による。管理委任は有効化していない（後述の判断）。

## 再実行の方法

いずれも一時領域（`mktemp -d`、`~/.cache/cc-sdd-bootstrap-scratch/` 配下）を引数に取る。リポジトリの中には一時ファイルを置かない。

```sh
python3 poc/codex-delegation-live/claude_live.py "$(mktemp -d ~/.cache/cc-sdd-bootstrap-scratch/claude-live-XXXX)"   # 6.1（Claude Code）
python3 poc/codex-delegation-live/pi_live.py "$(mktemp -d ~/.cache/cc-sdd-bootstrap-scratch/pi-live-XXXX)"           # 6.2（Pi の権限・推論量）
node poc/codex-delegation-live/faults.mjs "$(mktemp -d ~/.cache/cc-sdd-bootstrap-scratch/faults-XXXX)"              # 6.2（障害の再現）
node poc/codex-delegation-live/selection.mjs                                                                       # 6.1（候補選択）
python3 poc/codex-delegation-live/codex_live.py                                                                    # Codex: 計画の表示のみ（未実行）
```

前提は、Claude Code の認証（`~/.claude/.credentials.json`）、ローカル Ollama（`192.168.3.120:11434`）と登録済みの `pi-agent`、`node`・`python3`。

## 隔離と認証

- Claude Code は隔離した `CLAUDE_CONFIG_DIR` を使い、認証情報のコピー（mode 600）だけを入れた。終了時に削除する。承認と信頼は、この隔離設定の `projects` 記録へ書いた（対話の承認画面の代わり。記録の項目は Claude Code が書くものと同じ）。ホストの `~/.claude`・`~/.codex`・`~/.pi` は変更していない。
- Pi は既存の `pi-agent`（stdio）へ直接接続した。Pi 自身のジョブ記録（`~/.local/share/pi-agent/sessions`）は増える。
- 実 HOME の `~/.cache/cc-sdd-model-policy/` に、導入済みの観測ストアの記録が作られる（`runtimeFor` の仕様）。

## 6.1 Claude Code（実機）

親は `claude-haiku-5-5`、ネイティブの子は定義どおり `claude-sonnet-5-5`。依頼はどれも 1 回の短いものにした。

| 確認 | 結果 | 根拠（実測の要約） |
|---|---|---|
| 導入（`--codex yes`） | 成功 | `.mcp.json` に `cc-sdd-codex` が入った |
| MCP の承認待ち | 表示された | `claude mcp list` → `⏸ Pending approval` |
| 承認後の再探査 | 接続 | `claude mcp list` → `✔ Connected` |
| MCP ツール名 | `mcp__cc-sdd-codex__codex_start` | 遅延読み込みのため、呼ぶ前に ToolSearch で読み込まれた |
| 通常作業（gate は既定で無効） | 拒否されない | `codex_start` が届き `not-started`（無効なモデル名のため起動はしていない） |
| 通常作業（gate を試験コピーで有効化） | 拒否されない | 同上。cc-sdd 外では gate が通す |
| 明示の `/kiro-impl` 中の直接起動 | 拒否 | `PreToolUse:mcp__cc-sdd-codex__codex_start hook error: cc-sdd の作業中は、エージェント MCP の起動（codex_start）を直接呼べません…` |
| 自然文（`SKILL.md` を Read した後） | 拒否 | 同じ拒否理由 |
| 同じセッションで cc-sdd 作業のあと通常依頼（`--resume`） | 拒否されない | 1 回目（`/kiro-impl`）は拒否、2 回目（`--resume` の別ターン）は `not-started`。1 つのストリームに 2 件を入れると 1 ターンにまとめられたため、ターンは別プロセスに分けた |
| 組み込みネイティブ（事前確認なしの `Agent`） | 拒否 | `一致する一回限りの事前確認記録がありません` |
| ネイティブの単独事前確認（`preflight`） | 拒否 | `外部委任の配置を検出したため単独発行できません`（外部 MCP を置かない構成でも同じ） |
| 管理入口の参照（`enter`） | モデルに届かない | `enter kiro-impl` の結果は `{"ok":true,"skill":"kiro-impl"}` だけで、`--reference` の値は出ない |
| クライアント別の候補選択（`selection.mjs`） | 仕様どおり | 指揮役 Claude・順位 [Claude クラウド, Codex クラウド] → Codex クラウド（同系統を除外）。指揮役 Codex・順位 [Codex クラウド, Claude クラウド] → Claude クラウド。同系統のクラウドしか無い → ネイティブへ移る |

確認できなかったこと:

- ネイティブの成功経路（事前確認 → `Agent` の起動 → 同じ事前確認の再利用の拒否）。上の 2 つの拒否（単独発行の配置チェックと、入口の参照がモデルに届かない）のため、成功経路に到達できなかった。消費の仕組みは単体テスト側で確認されている範囲に留まる。
- 管理入口（`delegate.mjs start --reference`）を通した起動。参照が届かないため実行できない。
- Codex の MCP 直接起動の拒否（後述「未実行（Codex）」）。

## 6.2 Pi（実機、ローカル Ollama）

モデルは `leeplenty/forgotten-safeword:12b`（ツール対応・13GB）。ほかのモデルは次の理由で外した。

- `deepseek-coder-v2:16b`: Ollama が `does not support tools` で 400 を返した。
- `qwen3-coder:30b`・`qwen2.5-coder:32b`: 編集の呼び出しを構造化せず、本文に書いた（ファイルは作られない）。
- `huihui_ai/Qwen3.8-abliterated:latest` も書き込みを確認したが、サイズが大きいため採用しなかった。

| 確認 | 結果 | 根拠 |
|---|---|---|
| 能力の公開 | 実応答は `execution: local`、`access_modes: [read-only, workspace-write]`、`thinking_levels: [off]` | `pi_capabilities` の実測 |
| 読み取り専用 | 編集ツールは無く、ファイルは作られない | 作業先に `probe.txt` は無し。モデルが呼べたのは `read` だけで、`--tools read,grep,find,ls` の範囲（`write` は存在しない） |
| 書き込み許可 | 一時作業先に `out.txt`（内容 `PI-WRITE-OK`）を作成 | `write` の呼び出しが成功（1 回目で成功） |
| 要求推論量に合わない構成 | 起動前に拒否 | `Thinking level unavailable: medium` |
| 受付モデル外 | 起動前に拒否 | `Unknown model; use pi_models` |
| 権限の列挙外 | 引数の検証で拒否 | `access` が `read-only` / `workspace-write` 以外（`shell`）で拒否 |

## 6.2 障害の再現（実ストア・実ワーカー・実 Pi 接続）

`createPiAdapter` に、実 `pi_mcp.py` の stdio 接続を渡した。障害は接続の包みで注入した。実ストアは一時領域のディスク上の記録。所有者喪失は実プロセス（`sleep`）で再現した。`starts` は、作業先に対して Pi が作ったジョブ記録の数で数えた。

| 障害 | 観測 | 別の依頼 ID での再送 | 同じ依頼 ID での再送 | 起動回数 |
|---|---|---|---|---|
| 応答欠落（Pi には届き、ジョブは起動する） | 呼び出し側は「起動要求の送信後に結果を確認できません」（未確定）。Pi は `out.txt` を書いた | `blocked`（終了を確認できません） | `blocked` | 1 |
| 接続断（送信直後にサーバーを終了） | 未確定。起動も無し（ファイルなし） | `blocked` | （未実施） | 0 |
| 所有者喪失（記録したプロセスの終了） | 制御先は `unavailable`（制御所有者を確認できません） | 再予約は `blocked` | （未実施） | 0 |

- 応答欠落と接続断のどちらも、再送は起動されなかった。接続断では起動の有無を呼び出し側から判別できないため、安全側に倒して拒否する。
- 部分書き込み（途中で止まった書き込み）は再現できなかった。Pi は 1 ファイルを一度に書いたため。応答欠落で書き込み完了後に未確定となる例で代替したが、途中で止まる書き込みは未確認。

### 試験ハーネスでの変換（重要）

実 `pi_capabilities` の応答は、adapter が要求する契約（`tier` と `models[].accepted`）と一致しない。そのまま渡すと、能力の確認で必ず「Pi の能力応答を確認できません」となり、実 Pi の登録は候補にならない。このため `faults.mjs` の接続の包みで、応答を次のように写した（`execution`→`tier`、`access_modes`×`thinking_levels`→`models[].accepted`）。adapter 本体は変えていない。研究メモの「既設の Pi MCP は能力として read-only・workspace-write・off を公開した」という記述とも、実際の応答の形が一致していない。

## Codex（未実行）

Codex は利用上限のため実行していない。`codex_live.py` は計画の表示だけを行い、Codex を呼ばない。次の項目は未確認のまま残る。

- Codex の MCP 呼び出しを PreToolUse で検出・拒否できるか（ツール名 `mcp__<サーバー>__codex_start` の形の実測を含む）。
- 同系統（Codex）のクラウド候補を、実機の Codex 登録で除外すること（選択関数の単体の確認は上の `selection.mjs` の範囲）。

## 管理委任の有効化の判断

- `claude`: 有効化しない（`enabled: false` のまま）。
  - 根拠の一部は確認できた。明示の `/kiro-impl` と自然文の両方で、MCP の直接起動は拒否された。cc-sdd 外と、同じセッションでの cc-sdd 後の通常依頼では拒否されなかった。
  - ただし、拒否理由が案内する管理入口を使えない。`enter` の参照がモデルに届かず、`delegate.mjs start --reference` を実行できない。また単独の事前確認は、導入台帳の `delegate.mjs` により常に拒否される。
  - このまま有効化すると、直接の起動だけが止まり、代わりの経路が動かない。そのため有効化の前提（管理入口が使えること）を満たさないと判断した。
- `codex`: 有効化しない。未実行（上限）のため、拒否の確認ができていない。

## 見つかった問題（今回は直していない）

今回の許可範囲は管理 gate とそのテストだけだったため、次は修正していない。利用者の判断が必要。

1. **管理入口の参照がモデルに届かない**（`kiro-delegation-context.mjs` の `enter` の経路）。`enter` の参照は内部で消費され、結果は `{"ok":true,"skill":"kiro-impl"}` だけ。`delegate.mjs start` は `--reference` を必須とする。参照をどう届けるか（例: 結果に含める、別の受け渡し）の設計が要る。
2. **Pi の能力応答の形の不一致**（`delegation-mcp.mjs` の `createPiAdapter.capabilities`）。実応答は `execution`・`access_modes`・`thinking_levels`。adapter は `tier`・`models[].accepted` を要求する。テスト（`test/delegation-mcp.test.mjs`）の偽の応答はこの形で、実機とは違う。
3. **単独の事前確認が導入台帳の `delegate.mjs` で常に拒否される**（`kiro-delegation-context.mjs` の外部委任の配置チェック）。現行の導入は `delegate.mjs` を常に配置するため、ネイティブだけの構成でも単独発行が使えない。

## npm test

`timeout 500 npm test` を同期で実行。630 件中 626 件が通過。失敗は指定の無関係な 3 件（`subagent-model-policy` の Claude 起動: 38・43・45）のみ。

## Codex フックの実機確認（2026-11-22）

- 再実行: `python3 poc/codex-delegation-live/codex_hook_live.py`（対照実験は `--allow-mcp`）。Codex CLI 0.167.0、Linux。モデル `gpt-6-luna`・推論量 `low`・`-a never exec --sandbox read-only`。CODEX_HOME は一時領域で、認証ファイルは一時コピーを終了時に削除する。ホストの `~/.codex` と作業ツリーは変えない。
- Codex の呼び出しは全体で 5 回（上限 6 回）。内訳: 拒否の初回、stdin 修正後の再実行、対照（承認設定なし）、対照（承認設定あり）、拒否の再実行。
- 上の「Codex（未実行）」の節は、フックの項目について今回の結果で置き換わる。

| 確認項目 | 結果 | 根拠 |
|---|---|---|
| (A) シェルの PreToolUse の tool_name | `Bash`。tool_input はオブジェクトで、`command` の文字列 | フックの観測ログ |
| (A) `updatedInput` による書き換え | 実行されたのは書き換え後のコマンド `/bin/bash -lc 'echo hello CCSDD-POC-MARK'`。出力は `hello CCSDD-POC-MARK` | `command_execution` の JSON イベント（2 回とも同じ） |
| (B) MCP の PreToolUse の tool_name | `mcp__ccsddpoc__ping`（`mcp__<サーバー名>__<ツール名>`）。tool_input は空のオブジェクト | フックの観測ログ |
| (B) フックの deny | ツールは実行されず（呼び出し記録 0 回）。Codex は `Tool call blocked by PreToolUse hook: CCSDD-POC-MCP-DENIED` として扱い、理由はモデルの応答にも届いた | 観測ログ・stderr・agent_message |
| (B) 対照（deny なし・承認設定あり） | ping が 1 回実行され、結果は PONG | 呼び出し記録 1 回 |
| (B) 対照（deny なし・承認設定なし） | フックは通したが Codex が `MCP tool call requires approval, but approval policy is never` で失敗し、実行されない | `mcp_tool_call` の error |

確認できたことの要点:

- `updatedInput` は Codex の PreToolUse でも効く。書き換えたコマンドが実際に実行されることを、実行ログの command で確かめた。
- MCP の拒否は、Codex が MCP を承認対象として扱う前にフックで止まる。拒否理由は stderr と応答の両方に出る。
- `-a never` では MCP 呼び出しに承認が要る。承認を与えない MCP 登録は、フックが通しても失敗する。これは `default_tools_approval_mode = "approve"` で解消した（今回の PoC で確認）。

Codex の入力・出力のスキーマ（バイナリに埋め込まれた JSON Schema の文字列を読んだ結果。実機のログでは未記録）:

- 入力には `model`・`turn_id`・`transcript_path`・`tool_use_id`・`permission_mode` があり、`transcript_path`・`turn_id` は必須。`turn_id` は実機で存在を確認した。`transcript_path` の実値は未確認。
- 出力は `hookSpecificOutput.permissionDecision`（allow・deny・ask）と `updatedInput`。`updatedInput` の注記は「PermissionRequest では将来用」。PreToolUse では実機で使えた。

未確認（今回の範囲外）:

- 実際の命令（`node .agent-hooks/cc-sdd-bootstrap/delegate.mjs start …`）に対する書き換えの成立。今回は `echo` の末尾に目印の引数を足しただけ。
- 書き換えたコマンドの文字列（参照）がモデルに見えないこと。今回は目印がコマンドの出力に出て、モデルがそれを報告した。管理入口の出力が参照を返さないかは、`delegate.mjs` 側の出力に依存するため未確認。
- 観測ログの `transcript_path` の実値と、Codex の `permissionDecision` の matcher（どの表記で MCP 名を絞るか）。今回は matcher を付けず、全イベントを対象にした。
- シェル以外の名前（`shell` など）。今回の確認は `Bash` の 1 種類だけ。

設計への示唆:

- G1 の案 B（PreToolUse で `updatedInput` を使い、`delegate.mjs` の命令の末尾に参照を付け足す）は、Codex の Bash でも成立する見込みが高い。実際の `delegate.mjs` の命令で再確認するのが次の段階。
- MCP の拒否は `mcp__<サーバー名>__<ツール名>` の名前で判定できる。Codex の MCP 直接起動の拒否（ガード）は、この名前を条件にすれば書ける見込み（matcher の表記は未確認）。
- cc-sdd が Codex に登録する MCP（`cc-sdd-codex` など）に、承認設定（`default_tools_approval_mode`）が必要かどうかを確認すべき。承認がなければ、フックで許可しても実行されない。
- 警告の扱い: `codex exec` は標準入力が閉じていても「Reading additional input from stdin...」を出す（PoC の結果には影響しない）。また一時領域の `/tmp` 配下では「helper binaries を作らない」警告が出る（PATH の別名が作られないだけで、今回の確認には影響しない）。

実行ログの抜粋（2 回目の拒否の実行。認証情報は含まない）:

```
{"event": "PreToolUse", "tool_name": "Bash", "tool_input_type": "dict", "tool_input_keys": ["command"], "model": "gpt-6-luna", "turn_id_present": true}
{"event": "PreToolUse", "tool_name": "mcp__ccsddpoc__ping", "tool_input_type": "dict", "tool_input_keys": [], "model": "gpt-6-luna", "turn_id_present": true}
{"command": "/bin/bash -lc 'echo hello CCSDD-POC-MARK'", "status": "completed", "exit_code": 0, "output": "hello CCSDD-POC-MARK\n"}
ping の実行回数: 0
```
