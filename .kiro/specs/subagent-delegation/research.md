# Research & Design Decisions

## Summary
- **Feature**: `subagent-delegation`
- **Discovery Scope**: New Feature（撤回した subagent-model-policy・codex-delegation の後継。`dev/codex-support` の実装は引き継がず、PoC の事実だけを使う）。2026-11-24 の改訂は Extension として、installer-core・session-install の実装済みの接点に絞った軽い調査で行った
- **Key Findings**:
  - 子の起動は両ツールで PreToolUse から拒否でき、理由は指揮役に届く。Claude Code は `Agent`、Codex は `spawn_agent`（フックの `tool_name` は `collaborationspawn_agent` を含む）。`tool_input.model` は明示したときだけ入る。定義ファイルで起動した子のモデルは `tool_input` に出ない（`poc/subagent-defs/`、`poc/req-feasibility/`）。
  - 指揮役のモデルは、Codex ではすべてのフックの入力に `model` がある。Claude Code はフックの入力に無く、会話の記録（`transcript_path`）の最後の応答から読む。セッションの最初のツール呼び出しでは読めない（`poc/req-feasibility/claude.sh` の e）。
  - Claude Code の `.claude/agents/<名前>.md` の `model`・`effort`・`tools` は効く。Codex の `.codex/agents/<名前>.toml` の `model`・`model_reasoning_effort` は効くが、`sandbox_mode = "read-only"` は効かず、子は親の権限で動く（Codex 0.167.0、`poc/subagent-defs/`）。
  - 推論量: Codex は `spawn_agent` の `reasoning_effort` で起動ごとに指定でき、起動前のフックから見える。子の推論量は「定義の `model_reasoning_effort` → 起動の指定 → モデルの既定値」の順に決まる。Claude Code の `Agent` には推論量の引数が無く、子の推論量は定義の `effort`（無ければ medium）。どちらも指揮役の推論量を引き継がない。環境変数 `CLAUDE_CODE_EFFORT_LEVEL` は指揮役と子を一律に上書きする（`poc/subagent-effort/`、2026-11-24）。
  - session-install の設定の読み取りは、入力のたびに項目定義の全項目を検証し、誤りで入力を止める（`install-rules.mjs` の `readInstallConfig`・`decideInstall`）。`subagents` を項目定義に足すと、役割表の誤りで入力が止まる。
  - 別の提供元の CLI: `codex -a never exec --sandbox <read-only|workspace-write> --model <M> --config 'model_reasoning_effort="<E>"' --cd <根> -`（今の運用）。`claude -p --model <M> --effort <E>` に、読み取り専用は `--tools Read,Grep,Glob`、書き込み可は `--permission-mode acceptEdits --allowedTools Bash`（`poc/subagent-defs/` の c）。Codex から `claude -p` を呼ぶには、Codex のシェルに通信の許可が要る（`poc/req-feasibility/codex.sh` の g）。

## Research Log

### 子のモデルの見え方
- **Sources Consulted**: `poc/subagent-defs/run.mjs`、`poc/req-feasibility/claude.sh`・`codex.sh`、`dev/codex-support` の `poc/subagent-model-policy/result.md`。
- **Findings**: `tool_input` のキー — Claude Code: `subagent_type`・`description`・`prompt`（`model` は明示時）。Codex: `task_name`・`agent_type`・`fork_turns`・`message`（`model` は明示時）。Codex は履歴の引き継ぎを省くと親と同じモデルになる。
- **Implications**: 子のモデル = `tool_input.model` → 無ければ `subagent_type`・`agent_type` の定義ファイルの `model` → どちらも無ければ「未指定」（拒否）。定義の `model: inherit` も引き継ぎとして拒否する。

### モデルの名前の揺れ
- **Findings**: Claude Code の子は別名（`sonnet`）、会話の記録の指揮役は正式な ID（`claude-sonnet-5-5`）。Codex は `gpt-6-luna` のような ID。
- **Implications**: 比較は「系統」（`haiku`・`sonnet`・`opus`・`luna`・`sol`・`astra` などの語）で行う。モデルの ID を小文字にして、格の表のキーの語を含むかで系統を決める。系統が決まらないモデルは「格を確認できない」扱い（3.6）。

### Codex の組み込みの子の権限
- **Findings**: 定義の `sandbox_mode` は効かない。
- **Implications**: Codex の組み込みの子に読み取り専用の役割を割り当てることはできない。要件 2.3 に従い、Codex の定義は書き込み可の役割だけ作り、読み取り専用の役割は「Codex の組み込みの子では読み取り専用を適用できない」と示す。Codex が指揮役のときのレビュー・調査・原因調査は、既定どおり別の提供元（`claude -p --tools Read,Grep,Glob`）で行い、別の提供元が使えなければ入口の `--to same`（`codex exec --sandbox read-only`）で行う。

### 組み込みの子の推論量（2026-11-24）
- **Context**: 要件 1.13（推論量の上限）・3.10（組み込みの子の起動で上限より上を拒否）の守り方を決める。
- **Sources Consulted**: `poc/subagent-effort/run.mjs`・`result.md`（Claude Code 2.1.329、Codex CLI 0.167.0）。`codex debug models` の `supported_reasoning_levels`・`default_reasoning_level`。`claude --help` の `--effort`。
- **Findings**:
  - 指定できる値: Claude Code は `low`・`medium`・`high`・`xhigh`・`max`。Codex は同じ 5 つに `ultra`（「最大の推論と作業の自動の委任」）を足した 6 つで、Luna の系統は `ultra` を受け付けない。Codex のモデルの既定値は low か medium。
  - Claude Code の `Agent` の `tool_input` は `description`・`prompt`・`subagent_type`・`run_in_background`（ほかに `model`・`isolation`）で、推論量の引数は無い。定義の `effort: low`・`xhigh` はそのとおりに効き、`effort` の無い定義は medium だった（指揮役は high）。
  - Codex の `spawn_agent` の `tool_input` に `reasoning_effort` が入る。定義に `model_reasoning_effort` があると起動の指定は効かない（定義 low＋起動 xhigh → low）。定義が無いか推論量の無い定義なら起動の指定が効く。どちらも無ければモデルの既定値（指揮役が high でも gpt-6-luna は medium）。
  - `CLAUDE_CODE_EFFORT_LEVEL` は指揮役・子・定義の `effort` をすべて上書きする（固定値であって上限ではない）。このリポジトリのクラウドのセッションでは `medium` が設定されていた。
- **Implications**: 推論量の上限は、生成する定義（設定の検証）・Codex の起動（フックが子の実際の推論量を求めて比べる）・Claude Code の起動（フックが `subagent_type` の定義ファイルの `effort` を読む）の 3 か所で守る。定義が無い型や推論量を決められないときは確かめられないものとして通す（3.10）。依頼文の言葉による推論の深まりは対象外。

### 格の訂正と子の上限（2026-11-24、利用者の指示）
- **Context**: 旧版の格（格 2：Sonnet・Sol、格 3：Opus・Astra）は誤りだった。Codex には Terra がある（`codex debug models` に `gpt-6.1-terra`・`gpt-5.6-terra`）。
- **Findings**: 格 1：Haiku・Luna、格 2：Sonnet・Terra、格 3：Opus・Sol、格 4：Fable・Astra。格 4 は指揮役だけが使う。格は性能の目安で、料金の並びとは一致しない（Sol と Sonnet が同程度）。
- **Implications**: 既定値は 1 つの決まりで計算できる（実装：同じ提供元で指揮役 −1、レビュー・デバッグ：別の提供元で指揮役以下の最上位、調査：別の提供元で指揮役 −2、最低は格 1。どれも格 4 を除き、子の上限まで下げる）。料金の都合は、提供元ごとの子の上限（系統の名前）で調整する。

## Design Decisions

### Decision: 4 つの部品に絞る
- 役割表の解釈（純粋）、役割定義の生成（installer-core のカタログの「設定から作るファイル」）、子の起動の確認のフック、別の提供元の入口。手順と作業の流れは運用の区画の文章。
- 撤回した前身の入口の認証・MCP・ジョブの管理・自動切り替えは持たない。

### Decision: 役割表は「指揮役の提供元 × 役割」で持つ（設計レビューの指摘）
- **Context**: 要件 1.1（指揮役の提供元ごとに、同じ・別とモデル・推論量・権限を指定）・1.3。
- **Selected Approach**: `roles[指揮役の提供元][役割] = { provider: same|other, model, effort, permission }`。既定値は 1.3 の表そのもの。役割定義のファイルは、提供元 V については `roles[V]` だけから作る（V が指揮役のときの組み込みの子）。`provider=other` の役割は、別の提供元が使えないときの予備としてモデル無しで作る。2 人の指揮役の設定を 1 つのファイルに集めると衝突するため（設計レビューの再指摘）。
- **Rationale**: 最初の案（受け持ちの `assign` と提供元ごとの `roles` に分ける）では、「Claude Code が指揮役のときの Codex の実装」と「Codex が指揮役のときの Codex の実装」に別の推論量を設定できなかった。

### Decision: モデルは系統の名前で持ち、起動の名前は実行時に求める（利用者の指示）
- モデルの名前（Luna・Sol・Astra など）はしばらく変わらないが、版の値は頻繁に変わる。既定値・判定・コミットするファイルに版を含む名前を書かない。
- Claude Code は別名（`haiku`・`sonnet`・`opus`）が最新を指すので、そのまま使う。
- Codex は `codex debug models` がモデルの一覧（`slug`・`visibility`・`priority`）を返す（2026-11-23、Codex 0.167.0 で確認。一覧は優先度順で `gpt-6.2-sol`・`gpt-6.2-astra`・…・`gpt-6-luna`）。起動のときに、`-<系統>` で終わる表示対象の slug のうち優先度が最も高いものを使う。版を固定したいときだけ設定の `modelIds` に書く。
- Codex の役割定義（コミットする）には `model` を書かず、起動時に明示する。Opus の指揮役のレビューの既定は Sol（1.4。2026-11-24 の格の訂正で Astra から変わった）。

### Decision: 同じ提供元の CLI も入口で起動できる（設計レビューの指摘）
- 別の提供元が使えないとき（5.7）、Codex の組み込みの子は読み取り専用にできない。入口に `--to same` を足し、`codex exec --sandbox read-only` を指揮役と異なるモデルで起動できるようにする。

### Decision: 格 2 以外の指揮役の既定値は、起動のときに決める
- **Context**: 要件 1.4・1.5。役割定義のファイルは指揮役のモデルを知らない。
- **Selected Approach**: 役割定義のファイルは格 2 の既定値で作る。別の提供元の入口は、指揮役のモデルを受け取ったら 1.4 の規則で既定のモデルを決める。組み込みの子では、指揮役がモデルを明示し、フックが格と同一を確かめる。手順の文章で 1.4・1.5 を示す。

### Decision: フックは「明らかな違反だけ」止める
- 未指定・引き継ぎは常に止める。同じモデル・上の格は、両方のモデルの系統と格が分かるときだけ止める（3.6）。フックの内部の誤りは通す（設定が壊れていても、未指定の拒否だけは既定の格の表で続ける）。`allow` は出さない（kiro-gate の拒否を解かない、3.8）。

### Decision: 既定のモデルは 1 つの決まりで計算する（2026-11-24）
- **Context**: 要件 1.3・1.4・1.10。旧版は格 2 の表（`DEFAULT_ROLES` のモデル）と、格 2 以外の計算の 2 本立てだった。
- **Alternatives Considered**:
  1. 格 2 の表を持ち、ほかの格は計算する（旧版）
  2. 表は提供元・推論量・権限だけにし、モデルはすべて計算する
- **Selected Approach**: 2。役割ごとに「目標の格」（実装 = 指揮役 −1、レビュー・デバッグ = 指揮役、調査 = max(指揮役 −2, 1)）を決め、`min(目標の格, 子の上限の格, 3)` 以下で最も上の格の、委任先の提供元の系統を選ぶ。実装の目標の格が 1 未満なら指揮役自身（1.5）。1.3 の表は、この決まりの格 2 の場合として試験で確かめる。
- **Rationale**: 上限（1.10）を足すと、表と計算の 2 か所で同じ下げ方を持つことになる。一般化すると 1 か所で済む。
- **Trade-offs**: 表を見ても既定値が直接は読めない。運用の区画の文章に、指揮役ごとの既定値の表を載せて補う。

### Decision: 役割表の検証は Roles に置き、項目定義はそれを使う（2026-11-24）
- **Context**: 旧版は検証の規則を `config-schema.mjs` に置き、`subagent-roles.mjs` がそれを使う向きだった。子の上限・推論量の上限の検証には、格の表・系統の判定・提供元の判定が要る。
- **Selected Approach**: `subagent-roles.mjs`（何も読み込まない純粋な部品）が `validateSubagents` を持ち、`config-schema.mjs` は `subagents` の項目の `validate` でそれを呼ぶ。配置物どうしの向きは `subagent-roles` ← `config-schema` ← `install-rules`・`lib/config-schema.mjs`。
- **Rationale**: 格・系統の知識を 1 か所に保つ。`subagent-roles.mjs` は何も読み込まないので、循環しない。

### Decision: session-install は導入に使う項目だけを検証する（2026-11-24、利用者の確認。要件 1.12）
- **Context**: 入力のたびの検証が全項目に及ぶと、役割表の誤りで入力が止まる。
- **Alternatives Considered**:
  1. 項目定義の `subagents` の検証を浅くし、細かい検証を Roles に任せる
  2. session-install の検証を `ccSdd.version`・`ccSdd.lang` に絞る
- **Selected Approach**: 2。`install-rules.mjs` の `readInstallConfig` が検証する項目を、導入に使う 2 つに限る。変更は session-install の持ち物だが、引き金がこの spec なので、この spec のタスクで行い、session-install の design.md に境界の注記を足す。
- **Rationale**: 案 1 は、項目が増えるたびに同じ問題が再び起きる。`update` は全項目を検証して失敗するだけで、セッションは止めない。

### Decision: 推論量の上限は 3 か所で守り、確かめられないときは通す（2026-11-24）
- **Context**: 要件 1.11・1.13・3.10・4.8。PoC の結果（上の「組み込みの子の推論量」）。
- **Selected Approach**: 生成する定義と設定は `validateSubagents` で上限より上を誤りにする。委任の入口は `--effort` を上限と比べる。フックは、Codex では「定義の `model_reasoning_effort` → `tool_input.reasoning_effort`」、Claude Code では「`subagent_type` の定義の `effort`」を子の推論量とし、上限と比べる。決められなければ通す。`CLAUDE_CODE_EFFORT_LEVEL` はフックで見ず、運用の区画の文章で、設定されていると定義の推論量が効かないことを知らせる。
- **Rationale**: フックが見える範囲だけで判定し、厳密さのための仕組みを増やさない（roadmap の制約）。環境変数がフックに渡るかは確かめていないため、判定に使わない。

### Decision: Codex の役割定義に推論量を書かない（2026-11-24）
- **Context**: Codex は定義の `model_reasoning_effort` が起動の `reasoning_effort` より優先される（`poc/subagent-effort/`）。定義に書くと、要件 1.6（作業ごとに推論量を選ぶ）が組み込みの子でできなくなる。
- **Selected Approach**: 生成する Codex の定義には `model` と同じく推論量も書かない。指揮役は `delegate.mjs --resolve-model` が出す名前と推論量（または上限以下で選んだ値）を `spawn_agent` に明示する。フックは起動の値を上限と比べる。Claude Code は起動ごとに変えられないので定義の `effort` に書き、別の推論量が要るときは `delegate.mjs --to same`（`claude -p --effort`）を使う。
- **Trade-offs**: Codex の定義だけを見ても推論量は分からない（要件 2.2 は `--resolve-model` で補う）。

### Decision: Build vs Adopt
- 別の提供元の実行は既存の CLI（`codex exec`・`claude -p`）をそのまま使う。MCP や自作のサーバーは使わない。

## Risks & Mitigations
- `CLAUDE_CODE_EFFORT_LEVEL` が設定された環境では、役割定義の推論量が効かず、上限より上の値で子が動きうる — 運用の区画で知らせる。上限より上の値を設定しないのは利用者と環境の責任とする。
- Claude Code に最初からある子の種類（`general-purpose` など）の推論量は確かめていない — 定義が無い型は確かめられないものとして通す。
- Claude Code の最初のツール呼び出しで指揮役のモデルが分からない — 子のモデルが明示されていれば通す（3.6）。手順の文章で、子のモデルを常に明示するよう示す。
- Codex の組み込みの子が読み取り専用にできない — 定義を作らず示す（2.3）。読み取り専用の役割は別の提供元か指揮役自身が行う。
- 別名の対応のずれ（新しいモデルの名前）— 格の表は設定で足せる（1.2）。分からないモデルは格を確認できない扱いで通す。

## References
- `poc/subagent-defs/result.md`、`poc/req-feasibility/result.md`、`poc/subagent-effort/result.md`
- `dev/codex-support` の `poc/subagent-model-policy/result.md`（Codex の履歴の引き継ぎとモデル）
- `.kiro/specs/installer-core/design.md`（カタログ・設定の項目定義・フックのコマンドの形）

## 参照した手順と指針（2026-11-24）
- `kiro-spec-design` の `rules/design-discovery-light.md`（既存の接点の確認）、`design-synthesis.md`（既定値の計算の一般化、検証の置き場所の単純化）、`design-review-gate.md`、`design-principles.md`。
- `.kiro/steering/structure.md` の「配置物は入出力の入口と判定だけの処理の組に分ける」「両方が使うデータは配置物の側に置く」。
