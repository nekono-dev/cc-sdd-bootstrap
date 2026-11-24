# PoC 結果: 組み込みの子の起動での推論量の指定と、起動前のフックからの見え方

- 実行日: 2026-11-24
- 環境: Claude Code 2.1.329（指揮役 sonnet、`--effort high`）、Codex CLI 0.167.0（指揮役 gpt-6.1-sol、推論量 medium と high の 2 回）、Node.js v22.16.0
- 実行: `node poc/subagent-effort/run.mjs [a b]`（`POC_CODEX_PARENT_EFFORT=high` で Codex の指揮役の推論量を変える）
- 目的: subagent-delegation 要件 1.13（推論量の上限）・3.10（組み込みの子の起動で上限より上の推論量を拒否）の実現の方法を設計で決める
- 子が実際に使った推論量は、子の記録から読んだ（Claude Code は `~/.claude/projects/<作業場所>/<会話>/subagents/*.jsonl` の API 要求の `output_config.effort`、Codex は `CODEX_HOME/sessions` の `turn_context` の `effort`）

## a. Claude Code の Agent

| 確かめたこと | 結果 |
|---|---|
| 起動の入力（PreToolUse の `tool_input`）に推論量の項目があるか | **無い**。キーは `description`・`prompt`・`subagent_type`・`run_in_background`（指揮役の答えによると、ほかに `model`・`isolation` を受け付ける。推論量の引数は無い） |
| 定義の `effort: low` の子 | low で動いた |
| 定義の `effort: xhigh` の子 | xhigh で動いた |
| 定義に `effort` が無い子（指揮役は high） | medium で動いた（指揮役の推論量は引き継がない） |
| 環境変数 `CLAUDE_CODE_EFFORT_LEVEL=low` を付けた場合 | 指揮役も 3 つの子もすべて low になった（定義の `effort` も `--effort` も上書きされる） |

## b. Codex の spawn_agent

| 場面 | `tool_input` の推論量 | 子が動いた推論量（指揮役 medium / high） |
|---|---|---|
| 1. 定義（`model_reasoning_effort = "low"`）＋起動で `xhigh` | `"reasoning_effort":"xhigh"` が見える | low / low（**定義が優先され、起動の指定は効かない**） |
| 2. 定義なし（`model` だけ）＋起動で `high` | `"reasoning_effort":"high"` | high / high |
| 3. 定義なし、推論量の指定なし | 項目なし | medium / medium（指揮役の推論量は引き継がず、モデルの既定値。gpt-6-luna の既定は medium） |
| 4. 推論量の無い定義＋起動で `high` | `"reasoning_effort":"high"` | high / high |

`codex debug models` の `default_reasoning_level` は、モデルによって low か medium だった（high 以上の既定値は無い）。

## 分かったこと

- **Codex**: 起動ごとに推論量を指定でき（`reasoning_effort`）、起動前のフックから見える。子が実際に使う推論量は「定義の `model_reasoning_effort` → 起動の `reasoning_effort` → モデルの既定値」の順に決まる。指揮役の推論量は引き継がない。
- **Claude Code**: 起動ごとに推論量を指定する方法が無く、子の推論量は定義の `effort` で決まる（無ければ medium）。起動前のフックから推論量は見えないが、`subagent_type` は見えるので、その定義のファイルの `effort` は読める。
- **両方**: 推論量を指定しない子が、指揮役の高い推論量を引き継ぐことは無かった。
- **環境変数 `CLAUDE_CODE_EFFORT_LEVEL`**: 指揮役と子の推論量を一律に上書きする。上限ではなく固定値なので、上限の手段にはならない。この変数が設定された環境では、役割定義の `effort` が効かない。このリポジトリのクラウドのセッションでは `medium` が設定されていた。

## 設計に引き継ぐこと

- 推論量の上限は、次の 3 か所で守れる。
  1. 生成する役割定義: 設定の検証で、上限より上の推論量を誤りにする（要件 1.11）。
  2. Codex の組み込みの子の起動: フックで、子が実際に使う推論量（上の決まり方の順）を求めて上限と比べる。
  3. Claude Code の組み込みの子の起動: フックで、`subagent_type` の定義のファイル（`.claude/agents/<名前>.md`）の `effort` を読んで上限と比べる。定義が無い型（組み込みの型）や読めないときは、確かめられないものとして通す（要件 3.10）。
- 組み込みの型（`general-purpose`・`Explore` など）の子の推論量は確かめていない。
- 依頼文に書く言葉（「ultrathink」など）で推論が深くなる経路は、推論量の設定とは別で、この PoC の対象外。
- `CLAUDE_CODE_EFFORT_LEVEL` が設定された環境では、役割定義の推論量が効かない。運用の区画の文章で知らせるかどうかを設計で決める。
