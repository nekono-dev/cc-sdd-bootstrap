# PoC 結果: ファイルで置く役割定義と、別の提供元の CLI の権限

- 実行日: 2026-11-23
- 環境: Claude Code 2.1.329（指揮役 sonnet）、Codex CLI 0.167.0（指揮役 gpt-6.1-sol）
- 実行: `node poc/subagent-defs/run.mjs`（a・b・c を個別にも指定できる）

| 確かめたこと | 結果 |
|---|---|
| a. Claude Code の `.claude/agents/<名前>.md`（`model: haiku`・`effort`・`tools: Read, Grep, Glob`）の子を `subagent_type` で起動できるか | できる。合言葉が返った |
| a. そのとき PreToolUse の `tool_input` にモデルが入るか | 入らない（`subagent_type` だけ）。定義のモデルはフックから見えない |
| a. `tools` を読み取りだけにした子は書けないか | 書けない |
| b. Codex の `.codex/agents/<名前>.toml`（`model`・`model_reasoning_effort`・`sandbox_mode = "read-only"`）の子を `agent_type` で起動できるか | できる。子は `gpt-6-luna` で動き、合言葉が返った。`tool_input` のキーは `task_name`・`agent_type`・`fork_turns`・`message`（モデルは入らない） |
| b. `sandbox_mode = "read-only"` の子は書けないか | **書けた**。定義の権限は効かず、子は親の権限（workspace-write）で動いた（観測） |
| c. `claude -p --tools Read,Grep,Glob` は書けないか | 書けない |
| c. `claude -p --permission-mode acceptEdits` は書けるか | 書ける |
| c. `--permission-mode acceptEdits --allowedTools Bash` でシェル（テストの実行）も使えるか | 使える |

## 設計に引き継ぐこと

- 子のモデルの確認では、`tool_input.model` が無いとき、`subagent_type`・`agent_type` から定義ファイルのモデルを引く。
- Codex の組み込みの子には、定義で読み取り専用を適用できない。読み取り専用の役割を Codex の組み込みの子に割り当てる設定は、適用できない項目として示す（要件 2.3）。Codex が指揮役のときのレビューは、もともと別の提供元（`claude -p --tools Read,Grep,Glob`）で行う。
- 別の提供元の CLI の権限: Claude Code の子は読み取り専用なら `--tools Read,Grep,Glob`、書き込み可なら `--permission-mode acceptEdits`（テストの実行のため Bash も許す）。Codex の子は `--sandbox read-only`・`workspace-write`（今の運用で確認済み）。

## 3.3: フックによる子の起動の拒否と通過（実機）

- 実行日: 2026-11-24
- 環境: Claude Code 2.1.329（d: 指揮役 sonnet と opus）、Codex CLI 0.167.0（e: 指揮役 gpt-6.1-sol、推論量 high）
- 実行: `node poc/subagent-defs/run.mjs d e`（フックを登録せずに動かす確認は `POC_NOHOOK=1`、モデルの一覧を使わず名前を設定で与える切り分けは `POC_MODELIDS=1`）
- 設定: `{"format":1,"ccSdd":{},"subagents":{"maxEffort":{"default":"high","sonnet":"medium"}}}`。役割の規則・フック・入口を `.agent-hooks/cc-sdd-bootstrap/` に写し、フックを包んで入出力を記録（拒否はフックの出力の理由の文言で見分け、ツール側の入力の拒否と区別）
- 先に書いた確認項目は、フック未登録（`POC_NOHOOK=1`）では d の 4 項目・e の 6 項目が NG になることを確認済み（起動はすべて通った）

| 確かめたこと | 結果 | 観測 |
|---|---|---|
| d. 名前を付けない起動（general-purpose）がフックで拒否される | OK | 「理由: 子のモデルが指定されていません。」と `--resolve-model` の案内が出た |
| d. Haiku の定義（cc-sdd-implement-haiku）が通る | OK | フックは通し、子が起動した（子の記録の agentType） |
| d. Haiku（high）の定義を `model: sonnet` で上書きした起動が推論量の理由で拒否される（指揮役 opus） | OK | 「理由: 子の推論量が子のモデルの系統の上限より上です。」「子の推論量: high（上限: medium、系統: sonnet）」 |
| d. 手で書いた推論量 xhigh の定義の起動が上限 high で拒否される | OK | 「子の推論量: xhigh（上限: high …）」 |
| e. モデルを持たない実装の定義＋model 省略の起動が拒否される | OK | 「理由: 子のモデルが指定されていません。」 |
| e. `--resolve-model` で得たモデル・推論量を明示し fork_turns none の起動が通る | OK（直した後の再実行） | `modelIds` なしの既定の設定で、workspace-write の中の `--resolve-model` が `gpt-6.1-terra medium` を返し、その明示の起動が通った。子の記録（turn_context）は `gpt-6.1-terra/medium`、子の発話に合言葉が返った（初回は NG だった。下の食い違いを参照） |
| e. 同じ組（子 Terra）で推論量 high は通る | OK | 子の記録は `gpt-6.1-terra/high` |
| e. 推論量だけを xhigh にすると推論量の理由で拒否される | OK | 「子の推論量: xhigh（上限: high、系統: terra）」 |

### 食い違い（直し済み）

初回の実行では、Codex の指揮役の作業のサンドボックス（workspace-write）の中で `delegate.mjs --resolve-model --from codex ...` が、終了 2 で「terra の最新のモデル名を Codex のモデルの一覧から求められません」となった。サンドボックスの外では `gpt-6.1-terra medium` が得られた。

- 原因: Codex の制限付きサンドボックスでは、Node.js の `spawnSync` が子の標準入力のパイプを閉じるときの `shutdown(fd, SHUT_WR)` が EPERM になり、`r.error` に載る（`timeout` の権限ではない）。`codex debug models` 自体は終了 0 で完全な JSON を返していたが、`fetchCatalog()` が `r.error` を見て一覧を捨てていた
- 直し: `fetchCatalog()` の `spawnSync` に `stdio: ["ignore", "pipe", "pipe"]` を加え、標準入力を使わない。30 秒の期限、`r.error`・非ゼロ終了の判定、JSON の検証は維持（`maxBuffer` 超過は ENOBUFS と終了 0 が同時に返りうるので、終了 0 だけでは採用しない）。`test/delegate.test.mjs` に、標準入力がパイプだと失敗する偽の codex でも一覧が得られる試験と、有効な JSON＋非ゼロ終了・終了 0＋壊れた JSON がどちらも一覧なしで終了 2 になる試験を足した
- 再実行: `POC_MODELIDS` を外した既定の設定で `node poc/subagent-defs/run.mjs d e` を実行し、d・e の全 13 項目が OK（OK 13 件、NG 0 件）。判定は厳しくした: e1（名前の解決と明示）と e2（high・xhigh）は作業場所・CODEX_HOME・フックの記録を別にし、e1 は `--resolve-model` の終了コードと標準出力、それと同じモデル・推論量を明示した spawn_agent、起動された子の記録（turn_context のモデル・推論量と、子の発話の合言葉）を照合する。モデル省略の拒否は理由が「子のモデルが指定されていません」で `--resolve-model` の案内があることまで見る
- 子の対応づけ: e1・e2 の子の記録は、指定した起動の子だけを次で特定する。起動（spawn_agent）の `task_name` から作られる子の記録の `session_meta.source.subagent.thread_spawn.agent_path`（`/root/<task_name>`）が一致し、かつその `parent_thread_id` が親（指揮役）の記録の `session_meta.id` であること。一意に決まらなければ NG。`codex exec --json` の出力には spawn の項目も子の ID も出ない（wait の `receiver_thread_ids` は空）ので、この記録の項目で対応づけた。子の turn_context のモデル・推論量と、子の発話の合言葉は、特定した子の記録だけで照合する
- 判定の自己検査: `node poc/subagent-defs/run.mjs s`（実機なし）で、名前の解決の失敗・子の記録の推論量違い・合言葉なし・拒否の理由違いなどの模擬の記録が NG になることを確認済み（「別の起動の子だけが組と合言葉を満たし、指定した起動の子は満たさない」「指定した起動の子の記録が無い」「task_name が無い」「親が指揮役でない」も NG。全 15 ケース期待どおり）
- 3.4 への注意: 子の CLI に指示のファイルを標準入力で渡すとき、パイプに書いて閉じる形だと同じ EPERM が起きうる。ファイルを開いた記述子（`stdio: [fd, ...]`）を標準入力にするなど、パイプを閉じない形がよい

## 4.3: 配置による確認（実機）

- 実行日: 2026-11-24
- 環境: Claude Code 2.1.329（指揮役 sonnet と opus）、Codex CLI 0.167.0（指揮役 gpt-6.1-sol、higher の格の拒否の確認だけ gpt-6.1-terra。推論量 high）
- 実行: `node poc/subagent-defs/run.mjs p`（片方だけの再確認は `POC_TOOL=claude|codex`、作業場所を残すのは `POC_KEEP=1`）。判定の自己検査は `node poc/subagent-defs/run.mjs s`（実機なし）
- 3.3（d・e）との違い: フックも定義も手で登録せず、一時のリポジトリで `init` → `.cc-sdd-bootstrap.json` に `subagents.maxModel`（`{"claude":"opus","codex":"sol"}`）と `subagents.maxEffort`（`{"default":"high","sonnet":"medium"}`）を書く → `update` で配置したものだけを通す。Codex のフックの信頼は `--dangerously-bypass-hook-trust`（検証専用）、認証の写しは実行後に消す。cc-sdd の導入は最初の入力で `npx` を使い、Claude Code は `--permission-mode acceptEdits --allowedTools Bash`、Codex は `workspace-write` で行った
- 生ログ: `~/.cache/cc-sdd-bootstrap-logs/p-final3.log`（最終の全体の実行。OK 37 件、NG 0 件）。自己検査は 46 件の模擬の記録（わざと失敗させたものを含む）がすべて期待どおり

| 確かめたこと | 結果 | 観測 |
|---|---|---|
| 配置: `init`・設定の書き込み・`update` が通り、Claude Code の PreToolUse（`Agent`）と Codex の PreToolUse に `subagent-check` が登録され、役割定義（`.claude/agents/cc-sdd-implement-{haiku,sonnet,opus}.md`・`.codex/agents/cc_sdd_implement.toml`）と区画の文章（`--resolve-model` の案内）が配置される | OK | sonnet の定義の推論量は上限どおり `medium` |
| 最初の入力での cc-sdd の導入（両ツール） | OK | 入力が通り、手順書と区画の文章が入った |
| Claude Code（指揮役 sonnet）: 名前を付けない起動（general-purpose）の拒否 | OK | 「理由: 子のモデルが指定されていません。」と `--resolve-model` の案内 |
| Claude Code: `--resolve-model` が出した定義の名前（`cc-sdd-implement-haiku`、出力は `cc-sdd-implement-haiku high`）での起動が通り、子が起動した | OK | 子の記録の agentType とモデル（`claude-haiku-5-5`） |
| Claude Code: 指揮役と同じ系統の定義（`cc-sdd-implement-sonnet`）・上の格の定義（`cc-sdd-implement-opus`）の拒否 | OK | 「子が指揮役と同じ系統のモデルです」「子が指揮役より上の格のモデルです」。子は起動していない |
| Claude Code（指揮役 opus）: Haiku（high）の定義を `model: sonnet` で上書きした起動が推論量の理由で拒否される | OK | 「子の推論量: high（上限: medium、系統: sonnet）」 |
| Codex（指揮役 sol）: 実装の定義＋`model` 省略の拒否 | OK | 「子のモデルが指定されていません」と `--resolve-model` の案内 |
| Codex: workspace-write の中の `--resolve-model` が終了 0 で `gpt-6.1-terra medium` を返し、その値を `model`・`reasoning_effort`、`fork_turns` を `none`、`agent_type` を実装の定義にした起動が通る | OK | 子の記録の `turn_context` が `gpt-6.1-terra/medium`（対応づけは `agent_path`・`parent_thread_id`） |
| Codex: 子の応答が指揮役に返る | OK | 子の応答は、親の記録の `agent_message`（宛先 `/root`）として届く。`wait_agent` の結果は `Wait completed.` だけで応答の本文を含まない |
| Codex（3.3 と同じ組: 子 Terra・上限 high）: 推論量 high は通り（子の記録 `gpt-6.1-terra/high`）、xhigh だけ推論量の理由で拒否され子は動かない | OK | 「子の推論量: xhigh（上限: high、系統: terra）」 |
| Codex（指揮役 Terra）: 子の上限・推論量の上限に収まる Sol（medium）の明示の起動が上の格の理由で拒否され、Sol の子は動かない | OK | 「子が指揮役より上の格のモデルです」「指揮役のモデル: gpt-6.1-terra」 |
| 設定を有効な JSON のまま `subagents` だけ不正（`maxModel` に Fable）にした次の入力は止まらず、子の起動だけが設定の誤りの理由で拒否される（両ツール） | OK | 「subagents の設定に問題があるため、直るまで子を起動しません。」と問題の項目（`maxModel`）。答え（合言葉）は返った |
| kiro-gate と同時（設定を有効に戻し、導入済みの状態から）: 許される起動でも手順書が未読なら kiro-gate の理由で拒否され、読んだ後に同じ起動が通る（両ツール） | OK | 「先に手順書 …/kiro-spec-status/SKILL.md を読んでから、作業を進めてください。」（`subagent-check` の理由ではない）。読んだ後の起動（モデル・推論量・定義は同じ）が通った |

### 食い違いと注意

- 製品側の不具合は見つからなかった。確認の側の直しだけを行った（`run.mjs` の判定）。
  - Codex の指揮役への子の応答は `wait_agent` の結果ではなく、親の記録の `agent_message`（宛先 `/root`）で届く。初回は `wait_agent` の結果に合言葉を探して NG になったので、親の記録の `agent_message` を見る判定に直した。
  - 同じ引数かの比較は、`task_name`（起動ごとに一意）と `message`（起動ごとに暗号化の値が変わる）を除き、定義・モデル・推論量・`fork_turns` で比べる。Codex の手順書の読み取りは `custom_tool_call`（`exec`）で記録されるので、その呼び出しも取り出す。
- 指揮役のモデルの従い方による不安定さ（Codex）: kiro-gate は入力のときに「作業の前に手順書を先に読む」旨を開発者の文脈に足すため、Codex の指揮役（sol）は利用者の指示の順序（手順書を読む前に起動）を守らず、先に読んでしまうことがあった（読む前の拒否を観測できない）。この場合だけ、`-c developer_instructions=…` で試験の順序を開発者の指示の側で明示し、それでも先に読んだときだけ最大 3 回までやり直す（判定は緩めない。やり直しは観測の行に残る）。最終の実行はやり直しなしで通った。Claude Code では起きなかった。
- 実行のたびに最初の入力の導入で `npx` の通信が要る。
- `run.mjs` は開始時に作業場所を消すので、`p` の実行中に `s`・ほかの節を同じ作業場所で動かさない（途中で消えて失敗する）。
