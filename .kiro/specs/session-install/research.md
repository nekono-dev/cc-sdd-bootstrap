# Research & Design Decisions: session-install

## Summary
- **Feature**: session-install
- **Discovery Scope**: Extension（installer-core の配置・カタログ・設定の仕組みに載せて、初期の配置物 2 本を置き換える）
- **Key Findings**:
  - SessionStart のフックの標準出力は会話の文脈に入り、標準エラーは入らない。新しく置いたスキルは、そのセッションのスキル一覧に載らない（`poc/session-hooks`）。
  - フックが時間制限を超えると、フックとその子のプロセスは時間切れの時点で止められ、導入の前に書いた記録は残る。同じリポジトリで同時に始めたセッションのフックは重なって動く（`poc/session-hooks`）。
  - 配置物は導入コマンドの部品を読み込めない（structure.md）。設定の検証の規則を配置物と導入コマンドで共有するには、規則のファイルを配置物の側に置き、導入コマンドがそれを読み込む向きにする必要がある。

## Research Log

### Claude Code のフックの動き（PoC）
- **Context**: 要件 1.5・1.6・3.4・4.1・4.2・5.1 が、フックの出力の行き先・時間切れ・同時実行に依存する。
- **Sources Consulted**: `poc/session-hooks/run.sh` と `result.md`（2026-11-19、Claude Code 2.1.325）、`poc/self-install/result.md`（2026-11-18・19）。
- **Findings**:
  - 標準出力は文脈に入り、標準エラーは入らない。
  - フックで置いたスキルは同じセッションでは一覧に載らず、次のセッションで載る。
  - 時間切れでフックのシェルと子の node が止められ、後続の行は動かない。claude はその後も動き、プロンプトを処理する。
  - 同時に始めた 2 つのセッションのフックは数ミリ秒差で開始し、実行が重なる。
  - フックの標準入力は `session_id`・`transcript_path`・`cwd`・`hook_event_name`・`source` を持つ。圧縮（compact）の後にも SessionStart が動く。
  - `claude -p` でも、SessionStart のフックが終わってから最初のプロンプトが処理される。UserPromptSubmit の `decision: "block"` でプロンプトが止まる（self-install）。
- **Implications**: 結果と案内は標準出力へ、cc-sdd の途中経過は標準エラーへ出す。入れ直したセッションでは `SKILL.md` を直接読む案内が要る。記録は導入の前に書き、成功で消す。排他の仕組みが要り、待つ時間はフックの時間制限より短くする。matcher を付けずに登録し、再開・圧縮でも確認する（入れ直しの省略で軽くなる）。

### cc-sdd の導入の呼び方
- **Context**: 版・言語・導入対象を設定から決める（要件 1.1・7.3・7.4）。
- **Sources Consulted**: 初期の配置物 `install-cc-sdd.sh`、installer-core の discovery の実現可能性の確認（brief.md の Constraints）。
- **Findings**:
  - `npx --yes cc-sdd@<版> --yes --overwrite force --manifest <ファイル> --claude-skills --lang <言語>` で、manifest に書いた対象だけを導入できる。manifest は README に載らない内部の形式で `"version": 1` が必須。非対話では `--yes` が無いと上書きが skip に落ちる。存在しない版は `notarget` で失敗する。
  - manifest の対象は `skills`・`doc_main`（`.kiro/settings/cc-sdd-guide.md` へ名前を変えて出す）・`settings_templates` の 3 つ。雛形を保持するときは `settings_templates` を manifest から外せば、雛形に触れずに導入できる。
- **Implications**: manifest は実行のたびに設定から組み立てる（シェルのヒアドキュメントの固定では足りない）。cc-sdd の形式の変化は、版を上げるときに `poc/self-install` で確かめる。

### installer-core の継ぎ目
- **Context**: 配置・フックの登録・`.gitignore`・CLAUDE.md の管理区画は installer-core の仕組みを使う（要件 5.2・6.1・6.2・6.5・7.1・7.6・7.8）。
- **Sources Consulted**: `lib/catalog.mjs`・`lib/plan.mjs`・`lib/settings-hooks.mjs`・`lib/config-schema.mjs`・`lib/cli.mjs`・`lib/target.mjs`。
- **Findings**:
  - 同梱の配置物は、パッケージの中の同じ道筋から読まれる（`readPackageFiles`）。カタログから外れて記録（`installed.json`）にあるファイルは、`update` で書き換えられていなければ削除される。
  - フックの登録は、見分けの文字列を含む一式のフックを全部取り除いてから、カタログのフックを足す（`mergeHooks`）。古い `install-cc-sdd.sh` の登録は `update` で新しいものに置き換わる。
  - `.gitignore` の管理区画の本文は `catalog.gitignore.join("\n")` の固定の文字列。設定によって書き分ける仕組みは無い。`readSnapshot` は `catalog.gitignore` の行で、取り除きの後に未追跡になる道筋を調べる。
  - 設定の項目は `configFields` に足せば、対話・引数・既定値・検証・`update` の補いが揃う。項目に応じたお知らせを出す仕組みは無い。
- **Implications**: `.gitignore` の行に「設定の値が X のときだけ」という条件を持たせる拡張と、項目ごとのお知らせの拡張を installer-core のデータの形に足す。どちらも既存の項目には影響しない足し算にする。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| シェルスクリプトのまま | `install-cc-sdd.sh` を拡張する | 今の形のまま | JSON の検証・指紋の計算・manifest の組み立て・排他がシェルでは書きにくく、単体テストもしにくい | 不採用 |
| Node（標準の機能だけ）に寄せる | 入口・判定・状態を `.mjs` に分ける | 設定の検証の規則を導入コマンドと共有できる。`node --test` で判定を確かめられる。Node 22 は入力を止めるフックですでに前提 | 配置物が 2 本から 4 本に増える | 採用 |

## Design Decisions

### Decision: 導入処理を Node に寄せ、判定（純粋）と入出力を分ける
- **Context**: 要件 1.7（設定の検証）・2.1（指紋）・4.1（排他）・7.3〜7.7（雛形の保持）。
- **Alternatives Considered**: シェルのまま拡張する。
- **Selected Approach**: 入口 `install-cc-sdd.mjs`（ロック・ファイル・npx の実行・出力）と、判定 `install-rules.mjs`（入れ直すかの判定、manifest、状態の記録、利用者向けの文章）に分ける。
- **Rationale**: lib と同じ「純粋な処理と入出力を分ける」型に合わせ、判定を一時ディレクトリなしで確かめられる。
- **Trade-offs**: ファイルが増えるが、どれも 1 つの役割に収まる。

### Decision: 設定の検証の規則を配置物の側に移し、導入コマンドはそれを読み込む
- **Context**: 要件 1.7 は installer-core と同じ検証の規則を求め、要件 6.4 は導入コマンド無しで動くことを求める。structure.md は「配置物は導入コマンドの部品を読み込まない」と定める。
- **Alternatives Considered**:
  1. 配置物に検証の規則を書き写す（重複。食い違いの危険）。
  2. カタログに「パッケージの中の別の道筋から写す」項目を足す（installer-core の写し方の約束が変わる）。
  3. 規則のファイルを `.agent-hooks/cc-sdd-bootstrap/config-schema.mjs` に移し、`lib/config-schema.mjs` はそれを読み込んで公開し直す。
- **Selected Approach**: 3。
- **Rationale**: 規則は 1 か所のまま、配置物は自分の隣のファイルだけを読み込む。「パッケージの中も導入後と同じ相対位置」という structure.md の方針と、写し方の約束を変えずに済む。`config-schema.mjs` はもともと他を読み込まないデータだけのファイル。
- **Trade-offs**: lib が配置物のファイルを読み込む向きの依存が 1 本できる（逆向きではないので決まりには反しない）。

### Decision: 排他は作成が不可分なディレクトリのロックで行い、取ってから省略の判定をやり直す
- **Context**: 要件 4.1・4.2。PoC d でフックが実際に重なることを確かめた。
- **Alternatives Considered**: ファイルの `wx` 作成によるロック、排他なし。
- **Selected Approach**: `.cache/cc-sdd-install.lock/` を `mkdir` で作れた側が導入する。作れなかった側は 0.5 秒ごとに作成を試し、最大 300 秒待つ。取れたら、他のセッションがすでに揃えたかもしれないので、省略の判定を最初からやり直す。持ち主の情報（pid・ホスト名・開始時刻）をロックの中に書き、持ち主が同じホストで終わっている、または開始から 660 秒を過ぎたロックは古いものとして片付ける。
- **Rationale**: PoC c のとおり時間切れではフックが止められ、ロックが残りうる。古いロックの片付けが無いと、次のセッションが毎回 300 秒待つ。待つ上限 300 秒はフックの時間制限 600 秒の内に、導入そのものの時間を残す。
- **Trade-offs**: 別のホストから同じディレクトリを共有する運用では、660 秒の経過でしか古いと判断できない（想定しない運用）。

### Decision: 失敗の記録の道筋は変えず、状態の記録とロックを同じ接頭辞にそろえる
- **Context**: 要件 2.8・3.10・6.2・6.3。
- **Selected Approach**: 失敗の記録は今と同じ `.cache/cc-sdd-install.failed`。状態の記録を `.cache/cc-sdd-install.state.json`、ロックを `.cache/cc-sdd-install.lock/` にし、`.gitignore` の行を `/.cache/cc-sdd-install.*` に広げる。
- **Rationale**: 置き換えの前後で失敗の記録の場所が同じなので、古い記録も新しい停止のフックが拾う。新しい状態の記録は置き換え後に存在しないため、最初のセッションで必ず入れ直す（要件 6.3）。

### Decision: `.gitignore` の行と設定の項目のお知らせに条件を持たせる（installer-core のデータの形の拡張）
- **Context**: 要件 7.6・7.8・7.9。
- **Selected Approach**: `catalog.gitignore` の要素を「文字列」または「`{ line, when: { path, equals } }`」にする。計画の計算で、設定の値に合う行だけを管理区画に書く。設定の項目に任意の `notice`（値が真のときに示す文章）を足し、`init`・`update` の完了時に示す。
- **Rationale**: 既存の文字列の行はそのまま動く。条件は設定の 1 項目の値の一致だけに絞り、汎用の式にはしない。
- **Trade-offs**: 取り除き（uninstall）での未追跡の調べには、条件に関わらずすべての行（`!` で始まる打ち消しの行を除く）を使う。

## Synthesis Outcomes
- **一般化**: 失敗の記録の一覧（名前・記録の道筋・再試行の方法）は今の `installFailures` の形を保ち、記録の中身（理由）を示す処理だけを足す。対象を足すときは一覧に 1 件足せばよい（要件 3.9）。
- **作るか採るか**: ロック・指紋・JSON の検証は Node の標準の機能（`fs.mkdirSync`・`crypto.createHash`・`JSON.parse`）で足りる。外部パッケージは使わない。
- **簡素化**: 入口は 1 本にし、フックからの呼び出し（`session-start`）と手での再試行（引数なし）は終了コードだけを変える。状態の記録には、入れ直すかの判定に要る値だけを持たせる。

## Risks & Mitigations
- cc-sdd の manifest の形式が版で変わる — 版を上げるときに `poc/self-install/run.sh` を再実行する（CLAUDE.md の決まり）。導入に失敗すれば入力が止まるので、壊れたまま作業は進まない。
- 入れ直しの削除の後に導入が失敗すると、スキルが無い状態になる — 削除の前に失敗の記録を書くので、次の入力が止まる（要件 3.1）。
- 利用者が `kiro-` で始まる独自のスキルを置いていると消える — 要件どおり（利用者の回答で了承済み）。CLAUDE.md の管理区画の文章でこの動きを知らせる。
- `.claude/skills` などがシンボリックリンクだと、リポジトリの外を消すおそれがある — 削除の前に `lstat` で確かめ、導入物の場所の親がシンボリックリンクなら導入をやめて失敗として扱う。

## References
- `poc/session-hooks/result.md` — フックの出力・スキル一覧・時間切れ・同時実行
- `poc/self-install/result.md` — 導入と停止の通し
- `.kiro/specs/installer-core/design.md` — カタログ・計画・管理区画の約束
