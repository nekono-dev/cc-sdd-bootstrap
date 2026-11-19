# Research & Design Decisions

## Summary
- **Feature**: `installer-core`
- **Discovery Scope**: New Feature（このリポジトリに製品のコードはまだ無い。既存のものは暫定の導入の仕組み `scripts/agent/` と PoC だけ）
- **Key Findings**:
  - `npx github:nekono-dev/cc-sdd-bootstrap#<ref>` は認証なしで bin を動かし、カレントは実行した場所のまま、同梱のファイルは `import.meta.url` から読める。`files` で配る範囲を絞れる（PoC: `poc/npx-bin/`）。
  - `.claude/settings.json` の同じイベントに利用者の組と一式の組を並べても両方が動く。HTML のコメントの目印で囲んだ CLAUDE.md の区画の中でも `@` の取り込みが効く（PoC: `poc/settings-merge/`）。
  - 暫定の 2 本（`scripts/agent/install-cc-sdd.sh`・`install-gate.mjs`）は、リポジトリのルートを自分の位置から `../..` で求めている。`.agent-hooks/cc-sdd-bootstrap/` も同じ深さなので、場所を移すだけでそのまま動く。

## Research Log

### `npx github:` での配布
- **Context**: brief の制約「PoC: `npx github:<owner>/<repo>` で bin が動くこと」と、実現可能性の確認の指摘（shebang 必須、`#<タグ>` での固定、`name` と `bin` が要る）。
- **Sources Consulted**: `poc/npx-bin/run.sh` の実行結果（`poc/npx-bin/result.md`）。npm 10.9.2、Node.js v22.16.0。
- **Findings**:
  - 一時ブランチを `#<ref>` で指定して取得・実行できた。引数はそのまま渡る。
  - `files` に無いファイルは同梱されない。
  - 同梱のシェルスクリプトの実行権限は保たれた（775）が、npm の版と umask に依る。
- **Implications**: 導入先＝カレントディレクトリでよい。配置物の元はパッケージのルートから読む。写したスクリプトには実行権限を明示して付け直す（4.7）。`package.json` の `files` に `.agent-hooks/cc-sdd-bootstrap/` を含める。

### Claude Code のフックの統合と管理区画
- **Context**: CLAUDE.md の決まり「Claude Code の動作に依存する前提は設計の承認前に PoC で確かめる」。統合の形（一式の組を後ろに足す）と、管理区画からの取り込みが効くかを確かめる。
- **Sources Consulted**: `poc/settings-merge/run.sh` の実行結果（`poc/settings-merge/result.md`）。Claude Code 2.1.325。2026-11-18 の取り込みの PoC（`poc/self-install/`、brief の Constraints）。
- **Findings**:
  - 同じ SessionStart に 2 つの組があれば両方が動く。
  - `"$CLAUDE_PROJECT_DIR/.agent-hooks/cc-sdd-bootstrap/..."` で隠しディレクトリの下のスクリプトを呼べる。
  - `<!-- cc-sdd-bootstrap:begin ... -->` と `<!-- cc-sdd-bootstrap:end -->` で囲んだ区画の中の `@.kiro/settings/cc-sdd-guide.md` が効く。
- **Implications**: 一式のフックは「コマンドに `/.agent-hooks/cc-sdd-bootstrap/` を含む」ことで見分け、取り除いてから後ろに足し直す。CLAUDE.md の目印は HTML のコメントにする（表示に出ない）。

### 暫定の導入の仕組みの扱い（自己適用）
- **Context**: Requirement 10.2 は暫定の仕組みを消すことを求める。一方で、cc-sdd を入れ直す部品の中身は session-install の担当で、installer-core の時点ではまだ無い。
- **Sources Consulted**: `scripts/agent/install-cc-sdd.sh`、`scripts/agent/install-gate.mjs`、`.kiro/specs/session-install/brief.md`。
- **Findings**: 暫定の 2 本を消すだけだと、このリポジトリで cc-sdd が入らなくなる。2 本はルートを `../..` で求めるので、`.agent-hooks/cc-sdd-bootstrap/` に移せばそのまま動く。
- **Implications**: installer-core は 2 本を最初の配置物（以下「初期の配置物」）として `.agent-hooks/cc-sdd-bootstrap/` に移し、カタログに載せる。中身の変更は場所に依る文言（再試行のコマンドの道筋・コメント）だけにする。中身の汎用化（設定ファイルの版を読む、など）は session-install が引き継ぐ。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 計画してから書く（採用） | 対象の今の内容を読み、書く内容をすべて計算し、中止の条件をすべて確かめてから書く | 「ファイルを変更せずに失敗」を一律に守れる。計算部分は純粋な関数で単体テストしやすい | 計画と書き込みの間に他が書くと食い違う（同時実行は想定しない） | 要件の多くが「変更せずに中止」を求めるため |
| 書きながら確かめる | ファイルごとに確かめて書く | 単純 | 途中で中止すると一部だけ変わる | 不採用 |
| 差分の当て方を外部の道具に任せる（git apply など） | 配置を差分として当てる | 3 方向のマージができる | git などへの依存、利用者の書き換えの扱いが要件と合わない | 不採用 |

## Design Decisions

### Decision: 配置物は「カタログ」で明示し、ディレクトリをまるごと写さない
- **Context**: 4.4（他のファイルに触れない）、5.4（外れたファイルの削除）、下流の spec がファイル・フック・行・文章を足す（Adjacent expectations）。
- **Alternatives Considered**:
  1. `.agent-hooks/cc-sdd-bootstrap/` をまるごと写す
  2. 写すファイル・フックの登録・`.gitignore` の行・CLAUDE.md の文章を 1 つのカタログに明示する
- **Selected Approach**: 2。カタログは `lib/catalog.mjs` のデータで、下流の spec は項目を足すだけにする。
- **Rationale**: 配置の記録（`installed.json`）や利用者のファイルを誤って写さない。外れたファイルを記録との比較で見つけられる。
- **Trade-offs**: ファイルを足すたびにカタログにも書く必要がある（テストで、カタログのファイルが実在することを確かめる）。

### Decision: 一般化 — 3 つの統合を「目印の区画」と「フックの登録」の 2 つの型にまとめる
- **Context**: `.gitignore`（Requirement 7）と CLAUDE.md（Requirement 8）は、どちらも「自分が加えた範囲だけを置き換える・取り除く」。
- **Selected Approach**: 目印の行で囲んだ区画を作る・置き換える・取り除く処理を 1 つにし、`.gitignore`（`# >>> cc-sdd-bootstrap` / `# <<< cc-sdd-bootstrap`）と CLAUDE.md（HTML のコメント）で目印だけを変える。`.claude/settings.json` は JSON なので別の処理（一式の組を見分けて取り除き、後ろに足す）にする。
- **Rationale**: 壊れた目印の検出（8.5）を `.gitignore` にも同じ規則で効かせられる。「自分が加えた行」を記録で覚えなくてよい。
- **Trade-offs**: このリポジトリの既存の `.gitignore` の行と区画の中の行が重なる。自己適用のときに既存の行を手で整理する。

### Decision: 外部パッケージを使わず自作する（Build）
- **Context**: steering（tech.md）が外部パッケージを禁じる。
- **Selected Approach**: 引数の解析は `node:util` の `parseArgs`、対話は `node:readline/promises`、内容の照合は `node:crypto` の SHA-256、テストは `node:test`。
- **Rationale**: いずれも Node 22 の標準で足りる。`parseArgs` の `allowNegative`（`--no-xxx`）は 22.4 以降なので使わず、真偽の項目も `--codex yes|no` の文字列で受ける。

### Decision: 単純化 — 「配置の記録」は 1 ファイル、フックと区画は記録しない
- **Context**: 4.5・4.6（書き換えの検出）。
- **Selected Approach**: `.agent-hooks/cc-sdd-bootstrap/installed.json` に、導入コマンドの版と、配置したファイルごとの種類（共通・固有）と SHA-256 だけを書く。フックの登録はコマンドの道筋で、`.gitignore` と CLAUDE.md は目印で見分けるので記録しない。
- **Rationale**: 記録が無い・壊れたときにも、フックと区画は正しく扱える。
- **Follow-up**: 記録が無いのに設定ファイルがあるときは、新しい版と内容が違う共通部分をすべて「書き換えられた」とみなす（安全側）。

### Decision: 自己適用では、暫定の 2 本を初期の配置物として移す
- **Context**: 上の「暫定の導入の仕組みの扱い」。
- **Selected Approach**: `scripts/agent/install-cc-sdd.sh`・`install-gate.mjs` を `.agent-hooks/cc-sdd-bootstrap/` に移し、カタログ（ファイル 2 つ・フック 2 つ・`.gitignore` の行）に載せる。中身は session-install が引き継いで書き換える。
- **Rationale**: 自己適用の後もこのリポジトリで cc-sdd が入り続ける。利用先にも skyshare と同じ水準の一式がすぐ届く。
- **Trade-offs**: 初期の配置物は cc-sdd の版を自分の中に直書きしており、設定ファイルの `ccSdd.version` をまだ読まない。session-install までは、設定ファイルの版を変えても効かない（init の既定値を直書きの版と同じ `3.1.0` にしておく）。

## 設計レビューの反映（2026-11-19、`/kiro-validate-design`）
- `map` の項目（`models`）は、項目があっても既定値のキーのうち無いキーだけを補う。下流の spec が役割を足したとき、導入済みのリポジトリの `update` で既定値が届かないことを防ぐ（3.5）。
- `uninstall` の後、`.gitignore` の除外が外れて cc-sdd の導入物が未追跡のファイルとして残る。導入物が実在すれば道筋つきで知らせる（9.7 で消さないものを誤ってコミットさせないため）。
- `--force` を `init` でも受け付ける。記録も設定も無いのに配置先に同名の違うファイルがある（手で置いた、skyshare から移す）ときに進めなくなるのを防ぐ。

## Risks & Mitigations
- `.claude/settings.json` を書き直すと、利用者の書式（字下げ・改行）が整形される — 中身が変わらないときは書かない。書くときは 2 文字の字下げに揃えると README に書く。
- npm の版によって同梱の権限やドットで始まるディレクトリの扱いが変わる — 写したあとに実行権限を付け直す。`npm pack --dry-run` で `.agent-hooks/` が同梱されることをテストで確かめる。
- 同じリポジトリで導入コマンドを同時に 2 回動かす — 想定しない（README に書く）。書き込みはファイルごとに一時ファイルと名前の変更で行い、壊れたファイルは残さない。
- 初期の配置物が設定ファイルの版を読まない — session-install の Revalidation Trigger に書く。

## References
- `poc/npx-bin/result.md` — `npx github:` の bin の PoC
- `poc/settings-merge/result.md` — フックの統合と管理区画の PoC
- `poc/self-install/result.md` — 暫定の導入の仕組みの PoC（取り込みの確認を含む）
- Node.js 22 の `util.parseArgs`・`readline/promises`・`crypto`・`node:test` の文書
