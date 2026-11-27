# Research & Design Decisions

> 改訂（2026-11-24）: タスク 7.2 で見つかった、git の worktree での Codex のフックの読まれ方を調べ、設計を直した（下の「git の worktree での Codex のフック」）。
>
> 改訂（2026-11-23）: 単純化後の要件（配置記録・改変検出・対話・強制上書きを外し、Codex への配置と運用の区画の文章を足す）に合わせて書き直した。旧版の調査（`npx github:` での配布、Claude Code のフックの統合）は結論だけを引き継ぐ。旧版は git の履歴にある。

## Summary
- **Feature**: `installer-core`
- **Discovery Scope**: Extension（develop に取り込み済みの導入コマンド `bin/`・`lib/` を削り、Codex 向けを足す）
- **Key Findings**:
  - `.codex/hooks.json` は Claude Code の `hooks` と同じ形で、同じ統合の処理を使える。ただし Codex には `CLAUDE_PROJECT_DIR` 相当の環境変数が無く、フックの作業場所は起動した場所になる。コマンドはシェルの展開で根を求める形にする。
  - cc-sdd の導入（`--overwrite force`）は CLAUDE.md・AGENTS.md を丸ごと置き換える。運用の区画は導入の後に末尾へ足すだけでよく、区画の置き換えの処理は要らない。導入コマンドが CLAUDE.md・AGENTS.md に触れるのは `uninstall` で区画を外すときだけになる。
  - 配置記録をやめても、配置先ディレクトリ（`.agent-hooks/cc-sdd-bootstrap/`）は一式だけの置き場なので、「中のカタログに無いファイルを消し、カタログのファイルを書く」で旧版の片付けができる（要件 3.4）。

## Research Log

### Codex のフックの設定の置き場所と書き方
- **Context**: 要件 4.1 と対象と境界の「設定の置き場所・形式・承認の扱いは、設計前に実際の動作で確認する」。
- **Sources Consulted**: 実機検証の記録（Codex のフックのコマンドの書き方）、実機検証の記録（`.codex/hooks.json` で SessionStart・UserPromptSubmit・PreToolUse・PostToolUse・Stop が動くこと）。Codex CLI 0.167.0。
- **Findings**:
  - プロジェクトの `.codex/hooks.json` は、下のディレクトリで起動しても読まれる。
  - フックの作業場所はセッションの作業場所。相対の道筋は最上位で起動したときだけ解ける。
  - コマンドはシェルで解釈され、`$(git rev-parse --show-toplevel)` の展開が効く。
  - フックを動かすには、利用者による信頼の承認が要る（承認の手順は Codex 側の操作）。
- **Implications**: Codex 向けのコマンドは `node "$(git rev-parse --show-toplevel)/.agent-hooks/cc-sdd-bootstrap/<スクリプト>" <引数>`。Claude Code 向けは `node "$CLAUDE_PROJECT_DIR/.agent-hooks/cc-sdd-bootstrap/<スクリプト>" <引数>`。どちらも `/.agent-hooks/cc-sdd-bootstrap/` を含むので、一式の登録の見分けは共通にできる。

### git の worktree での Codex のフック（2026-11-24）
- **Context**: タスク 7.2（自己適用の後の実機の確認）で、worktree の中で起動した Codex のフックが動かなかった。branch-release-workflow は作業ブランチを worktree で作るため、利用先でも同じことが起こる。
- **Sources Consulted**: 実機検証の記録（git の worktree での Codex のフックの読まれ方）。Codex CLI 0.167.0。信頼の承認の記録の形は利用者の `~/.codex/config.toml`（`[hooks.state."<hooks.json の絶対の道筋>:<イベント>:…"]`）。
- **Findings**:
  - worktree の中でも、読まれるのは本体の checkout の `.codex/hooks.json` だけ。worktree 側のファイルは、本体側に無くても読まれない。
  - フックの作業場所・入力の `cwd` はセッションの作業場所。`$(git rev-parse --show-toplevel)` は worktree の根になり、worktree 側のスクリプトが呼ばれる。
  - 登録が worktree に無いスクリプトを指すと、そのフックは失敗するだけで、セッションもツールの実行も止まらない。
  - 7.2 の失敗は、このリポジトリの本体の checkout（develop）にまだ `.codex/hooks.json` が無いことによる（場面 4 と同じ）。
  - 信頼の承認は本体側のファイルに対して求められ、記録される。1 回の承認で worktree にも効く。`codex exec` は未承認のフックを黙って飛ばす（設計レビューの指摘を受けて、対話の画面で確認。場面 7・8）。
  - 実際の配置物で、本体側の登録から worktree 側の `install-cc-sdd.mjs` が呼ばれ、作業の前に worktree へスキルと AGENTS.md が入る（場面 9、`real-install.sh`）。
- **Implications**: コマンドの形は変えずに、worktree 側のスクリプトが動き、cc-sdd の導入も worktree で行われる。本体側が未導入の間は AGENTS.md もスキルも無いので、補いは「AGENTS.md に従う」では足りない。worktree で Codex を起動する前に導入のコマンドを手で実行するよう案内する（4.5）。7.2 の Codex の確認は普通の checkout の写しで行う。

### CLAUDE.md・AGENTS.md と運用の区画
- **Context**: 要件 5（2026-11-23 の利用者の指示による改訂）。
- **Sources Consulted**: 実機検証の記録（CLAUDE.md が無くても最初の `/kiro-steering` が動く。クラウドでも確認）。
- **Findings**: `--overwrite force` で両文書は標準の文書に置き換わり、末尾へ足した区画は入れ直しても 1 つになる。CLAUDE.md が無いことはセッションの実行を妨げない。
- **Implications**: installer-core は区画の文章を「目印の行を含む完成した区画」のファイルとして配置し、session-install はそれをそのまま末尾に足す。目印の定義は installer-core だけが持つ（`uninstall` で外す側と同じ）。

### 引き継ぐ旧版の結論
- `npx github:nekono-dev/cc-sdd-bootstrap` は認証なしで bin を動かし、カレントは実行した場所のまま、同梱のファイルは `import.meta.url` から読める。`package.json` の `files` で配る範囲を絞る。
- `.claude/settings.json` の同じイベントに利用者の組と一式の組を並べても両方が動く。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 計画してから書く（継続） | 対象を読み、書く内容と中止の理由をすべて計算してから書く | 「変更せずに失敗」を一律に守れる。計算は純粋な関数で試しやすい | 計画と書き込みの間の他の書き込み（同時実行は想定しない） | 今の実装の形を保つ |
| 配置先を消してから写す | 配置先ディレクトリを丸ごと消して写し直す | 単純 | 途中で失敗すると配置物が無くなり、何を消したかも出せない | 不採用。消す対象を計画に載せて同じ結果を得る |

## Design Decisions

### Decision: 配置記録を使わず、配置先ディレクトリの中身で旧版を片付ける
- **Context**: 要件 3.4・9.2。
- **Alternatives Considered**: 1. 廃止の一覧を持つ　2. 配置記録（旧版の `installed.json`）　3. 配置先ディレクトリの中でカタログに無いファイルを消す
- **Selected Approach**: 3。配置先ディレクトリは一式だけの置き場と決め、利用者のファイルを置かない（運用の区画で案内する）。
- **Rationale**: 一覧も記録も保守しなくてよい。旧版の `installed.json` も同じ規則で消える。
- **Trade-offs**: 利用者が配置先に置いたファイルも消える（案内で防ぐ。消した一覧は表示する）。

### Decision: 一般化 — Claude Code と Codex のフックの登録を 1 つの統合の処理にする
- **Context**: 要件 4.1〜4.4。
- **Selected Approach**: 設定の形が同じなので、「各組から一式の見分けの文字列を含むコマンドだけを外し（空になった組は捨てる）、カタログの組を各イベントの最後に足す」処理を両方に使う。違うのはコマンドの組み立て（根の求め方）だけ。
- **Trade-offs**: 片方だけにある設定の項目（Codex の承認など）は扱わない。

### Decision: 運用の区画は「完成した区画」のファイルとして配置する
- **Context**: 要件 5.1〜5.4、session-install 3.8、installer-core 7.1。
- **Selected Approach**: `.agent-hooks/cc-sdd-bootstrap/agent-section-claude.md`・`agent-section-codex.md` に、目印の行で囲んだ区画をそのまま書く。中身はカタログの区画の文章（下流の spec が足す）から組み立てる。
- **Rationale**: 目印の定義と、区画を外す処理の持ち主を installer-core 1 つにできる。session-install は中身を解釈しない。

### Decision: 単純化 — 外すもの
- 配置記録（`lib/ledger.mjs`）、改変の検出、`--force`、設定の値を引数で渡す指定、対話、`.gitignore` の条件つきの行、実行権限の付け直し（フックは `node <スクリプト>` で呼ぶので要らない）。
- CLAUDE.md の管理区画を作る・置き換える処理（区画の文章はファイルとして配置し、文書への書き足しは session-install）。

### Decision: Build vs Adopt
- 外部の道具（git の差分、汎用の設定の統合のライブラリ）は使わない。Node.js 22 の標準だけで足り、利用先に依存を持ち込まない（要件 8.7）。

### Decision: 設定の項目定義の形と旧項目は installer-core で変えない（設計レビューの指摘）
- **Context**: 配置中の `install-rules.mjs` が項目定義の `validate` と `keepTemplates` を使う。
- **Selected Approach**: 形と項目はそのまま残し、`lib/` が対話用の属性を使わなくなるだけにする。旧項目の整理はそれを使う spec（session-install の雛形の扱い、subagent-delegation の役割表）が行う。
- **Rationale**: 互換の仕組みを足さずに、session-install の置き換えまで今の導入フックを動かし続けられる。

### Decision: worktree での Codex のフックは、今のコマンドの形のまま本体の checkout の登録に従う（2026-11-24）
- **Context**: Codex は worktree の中でも本体の checkout の `.codex/hooks.json` を読む（上の調査）。
- **Alternatives Considered**:
  1. 今の形のまま、本体の checkout にも導入が要ることを案内する
  2. 利用者の全体の設定（`~/.codex/`）に登録する — 要件 8.2（リポジトリの外への書き込みの拒否）に反し、リポジトリごとの版も分けられない
  3. 導入コマンドを worktree で実行したとき、本体の checkout の `.codex/hooks.json` も書く — リポジトリの外（別の作業フォルダ）への書き込みになり、本体側の作業中のブランチを変える
  4. 全イベントに 1 つの振り分けのスクリプトを登録し、worktree 側のカタログで振り分ける（登録の版のずれを無くす）— 版のずれを防ぐためだけのコードが増える
- **Selected Approach**: 1。
- **Rationale**: PoC で、今の形でも worktree 側のスクリプトが動くと分かった。ずれが起きても「フックが動かない・一部が動かない」だけでセッションは止まらず、AGENTS.md の指示で補える（信頼の承認が無いときと同じ扱い）。roadmap の「厳密さのためにコードを増やさない」に合う。
- **Trade-offs**: 作業ブランチで登録を変えても、本体の checkout に取り込まれるまで worktree の Codex には効かない。7.2 の Codex の確認は、普通の checkout の写しで行う。
- **Follow-up**: Codex の版を上げたら、実機で worktree での読まれ方を再確認する（結果は PoC 文書に残す。読む場所が worktree に変われば、案内を外せる）。

### Decision: フックの取り外しはコマンド単位（設計レビューの指摘）
- 同じ組に利用者のコマンドが混ざることがあるので、組ごとではなく一式のコマンドだけを外し、空になった組を捨てる（今の `settings-hooks.mjs` の選別を引き継ぐ）。

## Risks & Mitigations
- 利用者が配置先ディレクトリに自分のファイルを置く — 運用の区画とコマンドの案内で「配置先は直接編集しない」を示し、消した対象を必ず表示する。
- Codex のフックの信頼が承認されない — 導入の結果で承認が要ることと、未承認なら AGENTS.md の指示に従うことを示す（要件 4.5）。
- worktree の Codex で、本体の checkout が未導入か古い版のためフックが動かない — 導入の結果で本体の checkout にも導入が要ることと、揃うまでは起動前に導入のコマンドを手で実行することを示す（要件 4.5）。kiro-gate・subagent-delegation の強制もこの間は効かない（roadmap の共有の継ぎ目に記録）。
- 追跡中の CLAUDE.md は `.gitignore` に足しても除外されない — `init` で追跡を外す操作が要ることを示す（要件 5.5）。このリポジトリは `handoff-self-apply.md` の手順で行う。

## References
- 実機検証（記録は削除済み） — Codex のフックのコマンドの書き方
- 実機検証（記録は削除済み） — git の worktree での Codex のフックの読まれ方
- 実機検証（記録は削除済み） — 両ベンダへの導入と、文書の置き換え・区画の書き足し
- 実機検証（記録は削除済み） — CLAUDE.md が無い状態での最初の `/kiro-*`
- `.kiro/specs/installer-core/handoff-self-apply.md` — このリポジトリへの循環的な自己適用

## 参照したスキルと指針（2026-11-24 の改訂）
- `kiro-spec-design` の `rules/design-discovery-light.md`（既存の設計への統合の観点で、変える範囲を Codex のフックの読まれ方に絞った）と `rules/design-review-gate.md`（要件の対応表・境界・実行できる段取りを確かめた）。
