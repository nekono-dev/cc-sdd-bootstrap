# Research & Design Decisions

## ギャップ分析（2026-11-25、`/kiro-validate-gap`）

対象: `.kiro/specs/work-branch-flow/requirements.md`（7 要件）。要件は未承認だが、設計の前に分かる食い違いを先に洗い出した。実機の前提は実機検証で確認済み（記録は削除済み）。

### 1. 現状の調査

- **配置物の型**: 入口（`<名前>.mjs`）と純粋な判定（`<名前>-rules.mjs`）の組。導入対象は `lib/catalog.mjs` の `hooks`・`agentSections`・`files` と `package.json` の `files` の 3 か所に登録する（structure.md）。
- **kiro-gate**（再利用できるもの）:
  - `kiro-gate-rules.mjs` の `detectCommand(prompt)` は、先頭の `/kiro-*`・`$kiro-*` を取り出す。**任意の `kiro-*` に使えるので、対象コマンドの検出はそのまま共有できる**（要件 2。重複して作らない）。
  - 状態は `os.tmpdir()` の下に「根の絶対の道筋＋`session_id`」のハッシュ名のファイル（リポジトリに残らない。要件 3.11・5.6 と同じ形）。保存・読み込み（`loadState`・`saveState`・`savePromptState`）は `kiro-gate.mjs` の中にあり、公開されていない。
  - 失敗時は標準エラーに書いて終了コード 0（通す側）。要件 7.5 と同じ方針。
- **フックの登録**: `catalog.hooks` の 1 件が、ツールごと・イベントごとの 1 行。Claude Code の `PreToolUse` は `matcher` で対象のツールを絞れる（`Agent`）。Codex は絞らない。
- **設定の項目**: `.agent-hooks/.../config-schema.mjs` の `configFields`（種類は `string`・`boolean`・`map` の 3 つ）。`codex.trustHooks`（boolean、既定 true）が同種の先例。`init`・`update` が欠けた項目を既定値で補う仕組みがあり、要件 1.7 は既存の仕組みでそのまま満たせる。
- **フック側の設定の読み取り**: 配置物は導入コマンドの `lib/` を読み込めない。`subagent-check.mjs`・`install-cc-sdd.mjs`・`codex-trust.mjs` が、それぞれ `.cc-sdd-bootstrap.json` を自前で読んでいる（3 通り）。
- **運用の区画の文章**: `catalog.agentSections` に `id` ごと・ツールごとに静的な文字列を置く。導入のたびの書き足しは session-install が行い、文章が新しくなると `rewrite-section` で自動で書き直される（既存の導入先にも `update` で届く）。
- **入力の停止の先例**: `install-cc-sdd.mjs` の `UserPromptSubmit` が `{"decision":"block","reason":…}` を標準出力に出して止める。work-branch-flow は入力を止めず、ツール操作の拒否（`permissionDecision: "deny"`）と終了の停止（Stop の `decision: "block"`）だけを使う。
- **テストの置き方**: `test/<名前>-rules.test.mjs`（判定）、`test/<名前>.test.mjs`（入口）、`test/entry-harness.test.mjs`（入口の共通の補助）。

### 2. 要件の実現性とギャップ

| 要件 | 必要なもの | 現状 | ギャップ |
|---|---|---|---|
| 1 設定のオプション | 2 つの boolean と基底ブランチの一覧 | boolean の先例あり。**一覧（配列）を表す種類が無い** | **Missing**: 一覧の種類。カンマ区切りの文字列にするか、新しい種類 `list` を足す（`lib/config.mjs` の補い・検証・書き出しに影響） |
| 1.6・7.5 通す側の失敗 | 設定が読めない・内部の失敗で通す | kiro-gate に同じ方針あり | 新しい入口に同じ構えを置くだけ |
| 2 対象の検出 | 先頭の `kiro-*` の取り出し | `detectCommand` が共有できる | 対象の 5 コマンドの一覧と、`kiro-validate-impl`（要件 4）の判定を足す |
| 3 基底ブランチでの 1 回だけの拒否 | 現在のブランチの取得、拒否済みの状態、拒否の理由 | git の呼び出しは配置物のどこにも無い。状態の形は kiro-gate に先例 | **Missing**: ブランチの取得（`git` を子プロセスで実行）。**Constraint**: 判定の場所（下の 3 点目） |
| 3.2 ブランチなしの扱い | `git branch --show-current` が空 | — | 空文字を基底と同じに扱うだけ |
| 3.6 読み取り・切り替えを拒否しない | 操作の分類 | kiro-gate の `isReadCommand`（`cat`・`head`・`nl`）は手順書専用 | **Missing**: 汎用の分類。ただし 1 回だけの拒否なので、粗い分類で足りる（下の設計の示唆） |
| 4 PR の案内 | `kiro-validate-impl` の入力で追加の文脈 | `UserPromptSubmit` の追加の文脈の出し方は先例あり | 文章の中身だけ |
| 5 終了時の停止 | `validate-impl` を見たかの記録、PR の有無の確認 | Stop の 1 回だけの停止の型は kiro-gate にある | **Missing**: PR の有無の確認（`gh` の呼び出し）。**Research Needed**: 所要時間（下の 4 点目） |
| 6 運用の区画 | 新しい `id` の区画（両ツール分） | 仕組みあり | 文章だけ。ただし「特定の仕組みの名前を含めない」（6.5）を守る |
| 7.2 拒否の併存 | kiro-gate の拒否と同時に出ても両方届く | 未確認 | **Research Needed**（下の 5 点目） |

### 3. 設計に引き継ぐ制約と発見

1. **フックが見ている場所と、作業している場所が違いうる。** kiro-gate は根を「スクリプトの位置」から求める。Claude Code のフックは `$CLAUDE_PROJECT_DIR`（セッションを始めた場所）のスクリプトを呼ぶので、worktree の中で作業していても根は本体の checkout になる。work-branch-flow は「いま作業しているブランチ」を見たいので、スクリプトの位置ではなく、入力の `cwd`（Codex は Bash の作業場所も入る）を使う必要がある。PoC では、Claude Code の `cwd` は Bash の `cd` に追随せず、Codex の Bash は指定した作業場所になることを確認した。
2. **1 回だけの拒否にすると、操作の分類を粗くできる。** 「最初の、読み取りでも切り替えでもないと見えるツール操作」を 1 回止めるだけなので、読み取り専用かどうかの判定を厳密にしなくてよい（誤って止めても、エージェントが読み直すだけ）。厳密にすると brw との行き詰まりが出る（PoC E2）。編集ツールの対象ファイルのパスを調べる必要もなくなる。
3. **既存の kiro-gate に足すか、新しい入口にするかで形が変わる**（下の方式）。
4. **PR の有無の確認は外部への通信を含みうる。** フックの timeout は既存の入口で 10 秒。`gh pr list` が遅い・無応答のときは、timeout で通す（要件 5.3）。所要時間は未計測。
5. **同じイベントに複数のフックが拒否を返したとき、理由が両方エージェントに届くか**は未確認。kiro-gate の拒否（手順書の先読み）と同時に出る場面（`/kiro-discovery` を基底ブランチで始め、手順書も未読）で起きる。PoC の C・E3 は brw との併存だけを確かめた。
6. **要件 3.4（`kiro-impl` の案内）は、拒否の理由の文章で扱う**（フックにリモートの探索は持たせない）。

### 4. 実装方式の選択肢

- **A: kiro-gate を拡張する**
  - 内容: `kiro-gate.mjs`・`kiro-gate-rules.mjs` に、ブランチの判定と終了時の PR の確認を足す。`detectCommand`・状態の保存を再利用する。
  - 良い点: 新しいファイルが少ない。登録（`catalog.hooks`）の増分も小さい。
  - 悪い点: kiro-gate の役割が「手順書の先読み」から広がる。kiro-gate の spec（「先読みの強制だけ」）の境界を越え、再検証（Revalidation）が要る。2 つの設定のオン・オフが 1 つの入口に混ざる。
- **B: 新しい入口を作る（`work-branch-gate.mjs` と `-rules.mjs`）**
  - 内容: `detectCommand` を kiro-gate-rules から読み込み、状態と設定の読み取りは自前（または小さな共通部品）で持つ。`catalog.hooks` に `UserPromptSubmit`・`PreToolUse`・`Stop` を両ツール分足し、`files` と `package.json` の `files` に登録する。
  - 良い点: 境界が明確（brief の境界の候補と一致）。kiro-gate に影響しない。
  - 悪い点: 状態の保存・読み込みの重複（約 40 行）。設定の読み取りが 4 通り目になる。
- **C: 新しい入口＋共通部品の切り出し（推奨）**
  - 内容: B に加え、状態の保存・読み込みと設定の読み取りを小さな共通の配置物（例 `gate-common.mjs`）に切り出し、kiro-gate もそれを使うよう直す。
  - 良い点: 重複が増えず、feasibility-review も同じ部品を使える（後述）。
  - 悪い点: kiro-gate の改修を含むため、その spec の再検証が要る。範囲が広がる。**B で始め、feasibility-review の設計と合わせて共通化の要否を決める**のが安全。

### 5. 労力とリスク

- **労力: M**（入口と判定が 1 組、設定の項目 3 つ、運用の区画の文章、登録、テスト。既存の型どおり）。
- **リスク: 中**。主なものは、(a) 「いま作業しているブランチ」の判定が Claude Code の `cwd` に頼れない点（1 回だけの拒否で影響を抑えられる）、(b) 拒否の併存が未確認、(c) 一覧の設定の種類の追加が導入コマンド側に波及しうる点。

### 6. 設計での調査事項（Research Needed）

1. 基底ブランチの一覧の設定の形（カンマ区切りの `string` か、新しい `list` か）と、`lib/config.mjs`・`lib/cli.mjs` への影響の範囲。
2. kiro-gate と work-branch-flow の拒否が同じ操作に重なったときの、理由の届き方（両ツール）。PoC で確かめる。
3. `gh pr list --head <ブランチ>` の所要時間と、フックの timeout の決め方。
4. 「origin の既定ブランチ」の取得方法（`git symbolic-ref refs/remotes/origin/HEAD` は clone 直後でないと無いことがある）と、無いときの扱い。
5. Codex の `apply_patch` や Bash 以外の経路（MCP のツールなど）を「作業の開始」としてどこまで拒否するか（粗い分類の範囲）。
6. Stop の入口で「`kiro-validate-impl` を見たか」を持つ状態を、拒否済みの状態と同じファイルにするか。
7. 設計のレビューで、要件 3.1 の「最初の作業の開始」と、PoC の E3（`cd <worktree> && …` の誤検出）の関係を整理する。1 回だけの拒否に変えたので、E3 の誤検出は 1 回の再試行に収まる見込み。

### 7. 他の spec との接点（再検証の引き金）

- **installer-core**: `catalog` の `hooks`・`agentSections`・`files`、設定の項目定義。項目の種類を足す場合は、設定の補い・検証・書き出しの試験を直す。
- **kiro-gate**: `detectCommand` の公開が前提。共通部品を切り出す場合は、kiro-gate の状態の読み書きを書き換える（要件・設計の再検証が要る）。
- **feasibility-review**: 同じ `UserPromptSubmit` で別の拒否・停止を返す。共通部品の切り出しの判断を、2 つの設計で合わせる。

---

## 設計の調査と判断（2026-11-25、`/kiro-spec-design`）

- **Discovery Scope**: Extension（既存の配置物の型・設定の項目・フックの登録に沿って足す）。軽い調査（`rules/design-discovery-light.md` 相当）で足りる。外部の資料は要らず、前提は実機検証（記録は削除済み）で確かめた。
- **Key Findings**:
  - 同じ操作に複数のフックが拒否すると、理由は 1 つしか届かない（Claude Code は後に登録したもの、Codex は先に登録したもの）。追加の文脈は Claude Code で両方届く。
  - Claude Code のフックの `cwd` は Bash の `cd` に追随しない。
  - モデルは単純なファイルをシェルで作るので、編集ツールだけを関門にすると抜ける。
  - Bash を関門にすると、brw の `brw create` が拒否されて行き詰まる（brw を許可すると解けるが、brw を知らない前提に反する）。

### 設計の判断

| 判断 | 選択 | 理由 |
|---|---|---|
| 実装方式 | 新しい入口＋判定（研究の方式 B）。`detectCommand` は kiro-gate-rules から読み込む | 境界が明確。共通部品の切り出し（方式 C）は、feasibility-review の設計と合わせて見て、今回は見送る（重複は状態の読み書きの約 30 行と設定の読み取りだけ） |
| 一般化（synthesis 1） | 「基底ブランチ判定」と「操作の分類」を純粋な関数にまとめ、PreToolUse と Stop の両方で同じ判定を使う | 要件 3 と 5 の両方が「いまのブランチが基底か」を使う |
| 簡素化（synthesis 3） | 拒否は「最大 2 回」＋「ブランチの作成・切り替えを試みたら、以後は拒否しない」。操作の許可リスト（brw など特定のコマンド）は持たない | brw を知らずに行き詰まりを避けられる（E2・E3）。設定の項目が増えない |
| 作るか採るか（synthesis 2） | 設定の読み取り・状態の保存は既存の型に倣って自前（新しい依存なし） | Node の標準モジュールだけで済む。外部の部品は要らない |
| 基底ブランチの一覧の設定 | `workflow.baseBranches` をカンマ区切りの文字列（種類は `string`） | 新しい項目の種類（`list`）を足すと `lib/config.mjs`・`lib/cli.mjs` に波及する。値は短く、カンマ区切りで足りる |
| 操作の分類 | 読み取り専用の道具と、単純な読み取り・ブランチ操作の Bash だけを「作業ではない」とし、それ以外はすべて「作業」とみなす（粗い分類） | 最大 2 回の拒否なので、誤って止めても再試行で済む。厳密にするとコードが増える |
| 現在のブランチの取得 | 入力の `cwd`（なければプロセスの作業場所）で `git branch --show-current` | スクリプトの位置は worktree の外を指しうる（本体の checkout）。編集の対象のパスの解析は持たない |
| PR の有無 | `gh pr list --head=<ブランチ> --state all --json number --limit 1`（timeout 8 秒）。失敗・未導入・未認証は「判定できない」として通す | PoC D で、どの失敗も終了コードが 0 以外になることを確認した |

### 残る未確認（実装の最初のタスクで実機確認する）
- 実際の配置物（`work-branch-gate.mjs`）での、拒否→切り替え→作業の流れ（Claude Code・Codex）。PoC は試作のプローブで確かめた。
- brw を重ねたときの同じ流れ（Claude Code。Codex は brw の登録に信頼の承認が要るため、確認の可否を設計の外で決める）。


---

## 設計の更新（2026-11-25、設計レビューを受けた `/kiro-spec-design` の再実行）

- **契機**: `/kiro-validate-design` の指摘 2 件（対話を挟むコマンドで拒否が書き込みの前に解除される。brw の worktree で PR の案内と停止が働かない）。要件 2.4・3.5・4.1・4.4・5.1 を直した。
- **判断**:
  - `turn` は別の kiro コマンドの入力か、基底でないと判定できた PreToolUse まで保つ。通常の入力では `denials` だけ 0 に戻す（`resetDenials`）。`switchTried` は戻さない（brw が切り替えを拒否した後に行き詰まらないため）。
  - `classifyPrompt` に `other-kiro` を足し、「コマンドなしの通常の入力」と区別する。
  - PR の案内と `validated` は、現在のブランチの判定によらず作る。Stop の停止はフックが基底でないと判定できたときだけ働く。
- **残るリスク**: 基底のまま別の作業を頼むと入力ごとに最大 2 回拒否される。brw の worktree へ同じセッションで移った場合、PR は案内だけに頼る。


---

## 設計の更新 2（2026-11-25、`/kiro-validate-design` 再レビューを受けた `/kiro-spec-design` の再実行）

- **契機**: 再レビューの指摘 2 件と、「作業場所のブランチは機械的に判断できる範囲ではないか」という利用者の指摘。
- **判断**:
  - 要件 3.13 を足した。現在のブランチは、操作の入力から求めた作業場所（`workDirOf`）→ 状態の `location`（直近の作業場所）→ 入力の `cwd` の順に判定する。PoC の C・E3 で、対象パスの場所のブランチが worktree の作業に正しく効くことを確認済み。Stop は操作の入力が無いので `location` を使う。
  - Non-Goals の「対象パスの解析」を「網羅的な解析はしない。作業場所の判定に使う取り出しだけを持つ」に改めた。
  - 通常の入力での案内の再送をやめた（要件 3.12 は対象の入力ごとに 1 回）。
  - Risks に、パスの無い操作が続くと記録が古いままになること、別の仕組みのブランチ作成のコマンドを先に実行すると最大 2 回拒否されることを足した。
- **未確認（実装の最初のタスクで実機確認する）**: Codex の `apply_patch` の対象パスの形（`cwd` からの相対）と、`location` の記録を使った Stop の判定（brw の worktree。Claude Code）。
