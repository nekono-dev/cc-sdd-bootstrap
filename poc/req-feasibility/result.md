# PoC 結果: 要件の実現性（installer-core・session-install・kiro-gate・subagent-delegation）

- 実行日: 2026-11-23
- 環境: Claude Code 2.1.329、Codex CLI 0.167.0、cc-sdd 3.1.0、Node.js v22.16.0。指揮役のモデルは Claude Code が haiku、Codex が gpt-6-luna（推論量 low）
- 目的: 要件を承認する前に、要件が頼っている Claude Code・Codex の動作を実機で確かめる

| スクリプト | 内容 | 結果 |
|---|---|---|
| `install.sh` | 両ベンダへの cc-sdd の導入 | OK 20・NG 0 |
| `claude.sh` | Claude Code を指揮役にした初回の導入と子の起動の拒否 | OK 9・NG 0 |
| `codex.sh` | Codex を指揮役にした初回の導入・手順書の強制・子の起動の拒否・`claude -p` の起動 | OK 17・NG 0 |
| `doc-append.sh` | CLAUDE.md・AGENTS.md を cc-sdd の標準の文書として書き出し、運用の区画を書き足す | OK 26・NG 0 |
| `../kiro-gate/run.sh`（再実行） | Claude Code の手順書の強制（拒否・Read の観測・終了を 1 回止める） | OK 12・NG 0 |

Codex の PoC は一時の `CODEX_HOME` を使い、フックの信頼の承認は `--dangerously-bypass-hook-trust` で省いた（実際の利用では承認が要る）。

## 要件ごとの確認

| 要件 | 確かめたこと | 結果 |
|---|---|---|
| session-install 1.2・3.1〜3.3、installer-core 5 | 独自の manifest（導入の計画を書いた JSON）で、Claude Code（`--claude-skills`）と Codex（`--codex-skills`）へ非対話で続けて導入できる。標準の文書は `.kiro/settings/cc-sdd-guide.md`・`cc-sdd-guide-codex.md` に出せ、既存の CLAUDE.md・AGENTS.md（管理区画と利用者の記述）は変わらない。cc-sdd 既定の `.codex/agents/spec-reviewer.toml`（モデル固定）は入れずに済む。入れ直しても同じ | 実現できる |
| session-install 3.7〜3.9、installer-core 5・6（2026-11-23 の改訂） | 標準の文書の出力先を既定（リポジトリの直下）にすると、`--overwrite force` で既存の CLAUDE.md・AGENTS.md（利用者の記述・古い区画）は丸ごと置き換わる。Claude Code 向けと Codex 向けを続けて入れても互いの文書は壊れず、導入の後に末尾へ区画を足すだけで、入れ直しても区画は 1 つになる | 実現できる。`install.sh` の標準の文書を `.kiro/settings` へ出す形は、この改訂で使わなくなった |
| session-install 1.3 | 起動前に導入すると、最初のセッションで使える。Claude Code は起動時のスキル一覧に kiro-* が載る。Codex は `$kiro-spec-status` と明示すると手順書の本文がモデルに渡る | 実現できる |
| session-install 2.1〜2.3 | セッション中（Claude Code の SessionStart、Codex の SessionStart）に入れたスキルは、同じセッションでは使えない（対照）。最初の入力時のフック（UserPromptSubmit）で導入し、追加の文脈で「手順書を直接読む」よう伝えると、Claude Code も Codex も SKILL.md を読んでから作業した | 実現できる（要件どおり、手順書を直接読ませる形） |
| session-install 5 | Codex の UserPromptSubmit で `decision: block` を返すと、入力が止まりモデルの応答が無い（Claude Code は session-install の PoC で確認済み） | 実現できる |
| kiro-gate 1 | 入力は UserPromptSubmit の `prompt` にそのままの形で届く。Claude Code は `/kiro-*`、Codex は `/kiro-*` と `$kiro-*` のどちらも、先頭から検出できた | 実現できる（要件 1.1 に `$kiro-*` を追記） |
| kiro-gate 2.1〜2.5 | Claude Code は Read のツールで、Codex はシェルのコマンド（`cat .agents/skills/<名前>/SKILL.md`）で手順書を読む。どちらも PreToolUse で、読む前の他の操作を拒否でき（Codex は Bash の拒否を観測）、読み取りを観測できた。Codex にも PostToolUse がある | 実現できる |
| kiro-gate 2.6・2.7 | Stop のフックで終了を止めるとモデルが続けて応答し、2 回目は `stop_hook_active` が真になって終われる（Claude Code・Codex の両方） | 実現できる |
| subagent-delegation 3.2・3.6 | Claude Code の Agent、Codex の子の起動（ツール名 `collaborationspawn_agent`）を PreToolUse で観測でき、`tool_input.model` が無い起動を拒否できた。理由はモデルに届き、model を明示して呼び直すと子が動いた（Codex は子にだけ教えた合言葉が返ることで確認） | 実現できる |
| subagent-delegation 3.3〜3.5 | 指揮役のモデルは、Claude Code ではどのフックの入力にも入らない（PreToolUse は `effort` だけ）。会話の記録（transcript）の最後の応答からは読めるが、セッションの最初のツール呼び出しの時点では読めない。Codex はすべてのフックの入力に `model` が入る | 実現できる（Claude Code の最初の呼び出しでは不明になる。要件 3.5 のとおり、子のモデルが明示されていれば通す） |
| subagent-delegation 4.1 | Codex の中から `claude -p --model haiku` を子として起動できた。ただし Codex のシェルに通信の許可（`sandbox_workspace_write.network_access=true`）が要り、許可が無いと応答を返せない | 条件つきで実現できる（要件 5.7 に通信の許可の案内を追記） |

## 設計に引き継ぐこと

- Codex 向けの cc-sdd のスキルは、ほとんどが `allow_implicit_invocation: false` で、モデルが自分からは使わず一覧にも出さない。利用者が `$kiro-*` と明示して呼ぶ前提になる。
- CLAUDE.md・AGENTS.md は導入のたびに丸ごと作り直されるので、運用の区画は「導入の後に末尾へ足す」だけでよい（区画の置き換えや目印の検査は要らない）。入れ直しを省くときは、区画があることも確かめる。
- Codex の子の定義（`.codex/agents/*.toml`）のモデルは、`tool_input` に出ない。`agent_type` から定義のモデルを引くか、明示を求めるかを設計で決める（Claude Code の `subagent_type` も同じ）。
- モデル名は別名と正式な ID が混ざる（Claude Code の子は `sonnet`、記録の指揮役は `claude-haiku-5-5`）。一致の判定には別名の対応が要る。
- 手順書の強制は、Codex で `cat SKILL.md && 別のコマンド` のように 1 つのコマンドにまとめられると、読んだ扱いで一緒に通る。厳密さのためにコードを増やさない方針なので、許容するかを設計で決める。
- Codex の子の起動は、モデルが呼び直さない・子の返事を待たないなど、振る舞いが揺れることがあった（PoC では子の返事を待つよう指示して安定した）。
- 対話モードの Claude Code で「起動前に導入すれば最初の `/kiro-*` が通る」ことは、起動時のスキル一覧（`claude -p` の init）で代わりに確かめた。対話モードでの直接の確認は、tmux の操作が要るためしていない。
