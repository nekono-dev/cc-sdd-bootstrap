# Research & Design Decisions: kiro-gate

## Summary
- **Feature**: kiro-gate
- **Discovery Scope**: Extension（skyshare の `kiro-gate.mjs` を移し、installer-core のカタログと session-install の失敗の扱いに載せる）
- **Key Findings**:
  - `/kiro-*` で始まる入力は、スキルが無い・一覧に載る・一覧に載らない（`disable-model-invocation`）のどれでも、UserPromptSubmit のフックに `prompt` が入力のまま（手順書に展開されず）届く。スキルが無い `/kiro-ghost` も弾かれず、普通の文としてモデルに渡る（`poc/kiro-gate`）。
  - PreToolUse の deny は、手順書を読む前の Bash を実際に止める。拒否の理由はモデルに届き、モデルは手順書を Read してからやり直す。PostToolUse に matcher `Read` を付けても記録できる。
  - Stop は、終了を止めた後の 2 回目の入力で `stop_hook_active` が真になる。真のときに通せば終了できる。
  - 対話モード（tmux で確認）でも `prompt` は入力のままだが、スキルが無い `/kiro-*` はフックに届かず、Claude Code が「Unknown command」と示してモデルに渡さない。要件 2 の停止が働くのは、未知のコマンドがモデルに渡る使い方（`claude -p` など）に限られる。
  - skyshare の実装は純粋な判定（`decidePreToolUse` など）と入出力（`handlers`・状態の読み書き）が 1 ファイルに同居している。このリポジトリの型（data → 純粋 → 入出力）に合わせて 2 つに分ける。

## Research Log

### フックの入出力（PoC）
- **Context**: brief.md の Constraints にある 3 点（UserPromptSubmit の入力の形、PreToolUse の deny、Stop の `stop_hook_active`）。
- **Sources Consulted**: `poc/kiro-gate/run.sh` と `result.md`（2026-11-20、Claude Code 2.1.328）。
- **Findings**: 上の Key Findings のとおり。
- **Implications**:
  - 検出は `prompt` の先頭だけで足りる。skyshare にあった「入力全体からの代替の検出」は持たない。
  - 手順書が無いときの停止は、フックが自分で行う（Claude Code は止めない）。
  - 拒否の理由に読むべきパスを入れれば、モデルは従う。

### skyshare の実装
- **Context**: 移す元の動き。
- **Sources Consulted**: `/home/ubuntu/git/nekono-dev/skyshare/scripts/agent/kiro-gate.mjs`
- **Findings**: 5 つのイベント（session-start・user-prompt-submit・pre-tool-use・post-tool-use・stop）。状態は `os.tmpdir()` の下にセッションごとの JSON。判定できない例外は標準エラーに出して終了 0。roadmap は最後の「Specs (dependency order)」節の `- [ ]`／`- [x]` の行を読む。
- **Implications**: skyshare 固有の文言（`scripts/agent/install-cc-sdd.sh --claude` の案内、Path C/D/E）は、汎用の文言に置き換える。

### 既存の導入の仕組み（installer-core・session-install）
- **Findings**:
  - フックは、カタログの項目が 1 件ずつ別の組としてイベントの配列の最後に足される。利用者のフックは残る。同じイベントに複数のフックを足せる。
  - 配置物の再配置・取り除きは、カタログとファイルの記録（ledger）で自動になる。取り除きの手当ては要らない。
  - `install-gate.mjs` は `installFailures`（導入の対象ごとの記録の道筋と再試行のコマンド）を公開している。
- **Implications**: 再試行のコマンドは `install-gate.mjs` から読み、重複して書かない。フックの足し方と取り除きは、カタログに項目を足すだけで済む。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 1 ファイル（skyshare のまま） | 判定と入出力を同居 | 移植が速い | このリポジトリの型（純粋と入出力の分離）に反する。単体テストでファイルの読み書きが混じる | 不採用 |
| 純粋な判定 + 入口（採用） | `kiro-gate-rules.mjs`（純粋）と `kiro-gate.mjs`（入出力） | session-install と同じ型。判定は入力だけで試験できる | ファイルが 2 つになる | 採用 |
| install-gate.mjs に統合 | 入力の停止を 1 つのフックにまとめる | フックが減る | session-install の「他が壊れても判定できる」独立性を崩す | 不採用 |

## Design Decisions

### Decision: 判定を純粋にし、ファイルの存在・時刻は入口が集めて渡す
- **Context**: 判定（`decideStop` など）は roadmap・brief.md・手順書の有無に依る。
- **Alternatives Considered**:
  1. 判定が `fs` を直接使う（skyshare の `missingBriefs`）
  2. 入口が結果（存在する brief の名前の集合・roadmap の本文と更新時刻）を集めて渡す
- **Selected Approach**: 2。純粋な処理はファイルを読まない（structure.md）。
- **Rationale**: 単体テストが一時ディレクトリを要らない。
- **Trade-offs**: 入口が少し長くなる。
- **Follow-up**: 通しの試験で入口を実際のファイルで動かす。

### Decision: 再試行のコマンドは install-gate.mjs の記録から読む
- **Selected Approach**: 入口が `installFailures` の `name === "cc-sdd"` の `retry` を読んで判定に渡す。読めなければ（取り込みの失敗）、案内の文章からコマンドを省く。
- **Rationale**: session-install と同じコマンドを保つ（要件 2.1）。コマンドが変わっても 1 か所で済む。
- **Trade-offs**: 配置物同士の依存が 1 本増える。`install-gate.mjs` は標準モジュールだけに依存するので、循環はない。

### Decision: PostToolUse は matcher `Read` を付ける。PreToolUse は付けない
- **Rationale**: 読んだ記録は Read だけが対象で、matcher で他のツールのたびの起動を避けられる（PoC b で確認）。PreToolUse は全ツールの拒否が目的なので付けない。

### Decision: 自然文の案内は CLAUDE.md の文章だけにする
- **Rationale**: 依頼の種類は機械的に判定できず、誤検出が通常の作業を止める（要件 8.4）。SessionStart の知らせにも対応表は重ねず、CLAUDE.md の 1 か所に置く（利用者の指示、2026-11-20）。

### Decision: パスの比較は実体のパスにそろえる
- **Context**: 手順書の Read は、モデルが相対パスや別名の道筋で呼ぶことがある。比較が合わないと、手順書を読めない行き止まりになる。
- **Selected Approach**: 入口が、手順書のパスと Read の対象を、`cwd` を基準に絶対化し、存在すれば `realpath` にして比べる。
- **Trade-offs**: 存在しないファイルは絶対化だけで比べる。

## Risks & Mitigations
- モデルが拒否の理由に従わず、手順書を読まずに終えようとする → Stop が 1 回止め、読むよう求める。それでも読まなければ 2 回目は通す（要件 3.3）。
- サブエージェントのツール呼び出しにもフックが効くか、効いたときに親の状態を共有するかは、この PoC では確かめていない。手順書の読了までは Agent ツールも拒否されるため、影響は読了後に限られる。実装後の通しで観察し、問題があれば再検討する。
- 状態ファイルが一時ディレクトリに溜まる → 1 件が小さいので放置する（今回は掃除しない）。
