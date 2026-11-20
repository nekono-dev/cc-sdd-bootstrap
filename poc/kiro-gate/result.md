# PoC 結果: kiro-gate の設計の前提（フックの入出力）

- 実行日: 2026-11-20
- 環境: Claude Code 2.1.328、Node.js v22.16.0、モデル haiku（`POC_MODEL` で変えられる）
- 実行: `poc/kiro-gate/run.sh`（一時ディレクトリに小さなリポジトリを作って試す）

## 結果（OK 12 件、NG 0 件）

| # | 確かめたこと | 結果 |
|---|---|---|
| a | UserPromptSubmit の入力の `prompt` に `/kiro-*` はどの形で入るか | スキルが無い・一覧に載る・`disable-model-invocation` で一覧に載らない、のどれでも、フックは動き、`prompt` は入力のまま（`/kiro-xxx 本文`。手順書の中身には展開されない）。入力のキーは `session_id`・`transcript_path`・`cwd`・`prompt_id`・`permission_mode`・`hook_event_name`・`prompt` |
| a2 | スキルが無い `/kiro-ghost` はどう扱われるか | Claude Code は「未知のコマンド」として弾かず、普通の文としてモデルに渡す。フックで止めない限り、モデルは自己流で進められる |
| b | PreToolUse の deny は Bash を止めるか。手順書の Read は通せるか | 手順書を読む前の Bash は拒否され、PostToolUse も来ない。手順書の Read は通り、PostToolUse が来る。読んだ後の Bash は実行される。モデルは拒否の理由を読んで、手順書を Read してからやり直した |
| c | Stop で止めた後、2 回目はどうなるか | 1 回目は `stop_hook_active` が偽、2 回目は真。フックが毎回止めようとしても、`stop_hook_active` が真のときに通せば終了できる |

## 対話モードでの確認（手作業、2026-11-20）

`claude`（対話モード）を tmux で動かし、スキルが一覧に載る `/kiro-listed`・一覧に載らない `/kiro-hidden`・スキルが無い `/kiro-ghost` を順に入力して、UserPromptSubmit のフックの入力を記録した。この確認は `run.sh` には入れていない（tmux と信頼の確認の操作が要るため）。

| 入力 | 結果 |
|---|---|
| `/kiro-listed こんにちは`・`/kiro-hidden こんにちは` | フックは動き、`prompt` は入力のまま（`-p` と同じ）。モデルには手順書の本文が渡り、応答した |
| `/kiro-ghost こんにちは` | **フックは動かない**。Claude Code が「Unknown command: /kiro-ghost」と表示して終わり、モデルには渡らない（`-p` では渡る） |

## 分かったこと（設計への影響）

- `/kiro-*` の検出は、`prompt` の先頭（前の空白を除く）で判定できる。入力全体からの代替の検出は要らない（`prompt` は常にある）。
- スキルが一覧に載るかどうかに依らず、同じに判定できる。手順書が無いときのブロックは、フックが自分で行う（要件 2）。
- 拒否の理由はモデルに届き、モデルはそれに従って手順書を読む。理由には読むべきパスを入れる。
- 読んだ記録は PostToolUse の `tool_input.file_path` で付けられる。
- ToolSearch を通す扱いは、フックの判定としてだけ試験に入れた（`claude -p` では ToolSearch を呼ばせる場面を作っていない）。通すと決めるのは、後ろの設計判断として残す。
- 注意: `--allowedTools` は引数を複数取るため、後ろにプロンプトを置くとプロンプトまで飲み込まれる（PoC の `claude -p` は、プロンプトを先に置く）。
- 対話モードでは、スキルが無い `/kiro-*` はフックに届かず、Claude Code 自身が「Unknown command」と示す。モデルに渡らないので、自己流で進む心配もない。要件 2（手順書が無いときの停止）が実際に働くのは、未知のコマンドがモデルに渡る使い方（`claude -p` など）である。
- 対話モードでも、一覧に載るスキル・載らないスキルの `prompt` は入力のまま届く。検出は `prompt` の先頭だけでよい。
