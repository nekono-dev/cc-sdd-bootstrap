# 調査と差分の分析: poc-records

実施日: 2026-11-26（`/kiro-validate-gap`）。対象: `requirements.md`（10 要件、未承認）。結論だけ先に書くと、**変更の中心は小さい（文章・テスト・steering）が、移行（要件 8）は量が多く、要件の取りこぼしが 3 点ある**。

## 1. 現状の調査

### 1.1 変更の対象になる実体

| 対象 | 場所 | 現状 | 要件 |
|---|---|---|---|
| 運用の区画の文章（元） | `lib/catalog.mjs` の `feasibilityReviewSection`（157〜161 行） | 「再実行できる PoC」を根拠に認める。置き場所の定めなし | 6 |
| 運用の区画の文章（生成物） | `.agent-hooks/cc-sdd-bootstrap/agent-section-claude.md`・`agent-section-codex.md`（git 管理。`update` で再生成） | 上の複製 | 6.6・10.4 |
| **入力のたびに届く追加の指示（フック）** | `.agent-hooks/cc-sdd-bootstrap/feasibility-gate-rules.mjs` の `messageContext`（318 行・334 行） | 「実機の PoC（再実行…）」と書いている。**配布物に入る** | **未カバー（後述）** |
| 配布物のコメント | `.agent-hooks/cc-sdd-bootstrap/codex-trust-rules.mjs` 3 行目 | 「出典: `poc/codex-hook-trust/run.mjs`」。**配布物に入る** | 8.7（間接） |
| steering | `structure.md` 34 行（`## PoC` の項）、`project-rules.md` 9〜11 行、`tech.md` 26・32・40・57 行付近、`roadmap.md` 35・47・62・91 行付近 | 再実行できるスクリプト＋ `result.md`、`poc/<名前>/run.sh` | 7 |
| テスト | `test/feasibility-records.test.mjs`（`poc/` の実在を 3 種類のテストで確認）、`test/package.test.mjs` 59 行（`poc/` が同梱されない）、`test/catalog.test.mjs` 389 行・`test/feasibility-gate-rules.test.mjs` 411・425 行（「再実行」の語を必須にしている） | 要件 9 で置き換え。**「再実行」の語を含むことを検査しているので、文言を直すとテストが失敗する** | 9.4 |
| 既存の `poc/` | 18 ディレクトリ（49 ファイル、`result.md` は全ディレクトリにあり計約 1,000 行） | スクリプトのみで結果の文書が無いものは**無い** | 8 |

### 1.2 参照の量（移行で付け替えが要る箇所）

`poc/` を含む参照は、`poc-records` 以外の spec 8 つの文書に **約 150 箇所**ある（`feasibility.md` だけでなく、`design.md`・`research.md`・`tasks.md`・`requirements.md`・`brief.md`、`installer-core/handoff-self-apply.md` にもある）。steering にも 7 箇所ある。

### 1.3 PoC ディレクトリと根拠にしている spec（`feasibility.md` の参照から）

| `poc/` | 根拠にしている spec（`feasibility.md`） | 置き先の候補（要件 1.6 の「1 つの spec にだけ置く」） |
|---|---|---|
| codex-hook-path | installer-core | installer-core |
| codex-hook-trust | codex-hook-trust・install-freshness | codex-hook-trust |
| codex-worktree-hooks | installer-core | installer-core |
| feasibility-review | feasibility-review・work-branch-flow | feasibility-review |
| first-kiro-command | session-install | session-install |
| install-freshness | install-freshness | install-freshness |
| kiro-gate | kiro-gate | kiro-gate |
| npx-bin | installer-core | installer-core |
| req-feasibility | feasibility-review・kiro-gate・session-install | feasibility-review（最初に作った spec ではなく、内容に近いもの） |
| self-apply | installer-core | installer-core |
| self-install | session-install | session-install |
| session-hooks | session-install | session-install |
| settings-merge | installer-core | installer-core |
| subagent-defs・subagent-effort・subagent-permission | subagent-delegation | subagent-delegation |
| work-branch-flow | work-branch-flow・feasibility-review | work-branch-flow |

`feasibility.md` が挙げていない `poc/` はない（17 項目がどれかの spec に対応する）。ただし `roadmap.md` が挙げる `poc/subagent-model-policy`・`poc/codex-delegation-live` は、このブランチには存在しない（`dev/codex-support` 側）。

### 1.4 規約と制約

- 配布物の範囲は `package.json` の `files` と `lib/catalog.mjs` の配置一覧で決まり、`.kiro/` と `poc/` は元から同梱されない（`test/package.test.mjs` が確認）。**要件 9.3 は、PoC 文書が増えても配布物に入らないことの確認で、既存のテストで足りる**（`.kiro/` の検査が効く）。
- 関門（`feasibility-gate-rules.mjs` の `parseRecord`）は `- 判定:` の行だけを読み、根拠の表は読まない。**根拠の表の書式を変えても、関門は影響を受けない**（要件 5.5・10.1 と整合）。
- 一時ディレクトリの先例は、`~/.cache/cc-sdd-bootstrap-scratch/`（steering と運用の区画で既に使用）。Codex の `workspace-write` ではリポジトリの外に書けないという既存の観察（`poc/work-branch-flow/result.md`）があり、`feasibility.md` の前提 (a) として PoC の対象にした。

## 2. 要件の実現性と、取りこぼし

| 要件 | 実現の見通し | 備考 |
|---|---|---|
| 1・2・4 | 文章と書式の定義。新しいコードは不要 | 書式は運用の区画の文章とテンプレート（steering）で示す |
| 3 | 文章で求めるだけ。機械的な強制は無い | 「管理対象に残さない」ことを自動で検査する手段（`git status` の比較）は要件に無い。**文章で求めるにとどまる**ことを設計で明記する |
| 5.2・5.3・9.1・9.2 | `feasibility-records.test.mjs` の置き換え。表の出典欄から `poc-*.md` の相対パスを抽出して実在確認 | 現状の抽出の正規表現は `` `poc/…` `` だけを拾う。新しい書式を決めてから書く |
| 6 | `catalog.mjs` を直し、`update` でエージェント向けの 2 文書（git 管理）を再生成 | 要件 10.4 と合う |
| 8 | 量が多い。17 ディレクトリ・約 1,000 行を 40 前後の文書へ書き直し、約 150 箇所の参照を付け替える | 下の取りこぼしと合わせて分割を決める |

### 2.1 要件の取りこぼし（要件の修正が必要）

1. **フックが入力のたびに出す追加の指示（`feasibility-gate-rules.mjs` の `messageContext`）が要件に無い。** 文面に「実機の PoC（再実行…）」があり、運用の区画の文章（要件 6）を直しても、入力のたびに古い基準が届く。要件 6 に「入力のたびに届く追加の指示」を含める必要がある。これは配布物の変更なので、導入先全体に効く。
2. **1 つの `poc/` ディレクトリに前提が複数ある場合の移行の単位が、要件 1.2（前提ごとに 1 ファイル）と 8.1（`poc/<名前>/` の内容を文書に移す）で食い違う。** 例: `work-branch-flow` は場面 A〜E（`result.md` 122 行）、`subagent-defs` は 139 行で複数の前提を持つ。前提ごとに分けると文書は 40 前後になり、`feasibility.md` の既存の根拠の行（ディレクトリ単位で挙げている）との対応も変わる。選択肢は次のとおり。
   - (i) 1.2 のとおり前提ごとに分割する。根拠の行が前提と 1 対 1 になるが、移行が重い。
   - (ii) 移行に限り、ディレクトリごとに 1 文書（前提ごとの節を持つ）にする。軽いが、1.2 の例外を要件に書く必要がある。
3. **過去の経緯を書いた文書（`design.md`・`research.md`・`tasks.md` など約 150 箇所）の扱いが、8.4（`feasibility.md` のみ付け替え）と 8.7（現行の参照先として書かない）の間で決まっていない。** 付け替えの対象を、(i) `feasibility.md` と steering だけにして、経緯の文書は「当時の場所」と注記するか、(ii) すべて新しい文書の場所に機械的に置換するか、を要件で決める必要がある。置換する場合、承認済みの文書を書き換えることになる。

### 2.2 その他の確認点（設計で扱う）

- `codex-trust-rules.mjs` のコメントの出典は、`poc/codex-hook-trust/run.mjs`（削除されるスクリプト）を指す。コメントは配布物に入るため、新しい PoC 文書を指すか、出典を文書の名前だけにする。**配布物の変更になり、導入先の配置内容の更新を伴う**（要件 10.3 の「配置動作は変えない」とは別に、ファイルの中身は変わる）。
- 繰り返し使う確認手順（要件 8.6）の候補は、`poc/self-install/run.mjs`（`project-rules.md` が cc-sdd の版を上げるときの確認として参照）と `poc/install-freshness/e2e.mjs`。`test/` には `cli.e2e.test.mjs`・`install-cc-sdd.test.mjs`・`freshness-integration.test.mjs` があり、**版を上げたときの導入と停止の確認が既存のテストで足りるか**は、設計で調べて決める（Research Needed）。
- `poc/codex-hook-trust/` には `cloud-result.md`・`cloud-verify-prompt.md` もある（クラウドの確認用の入力文）。PoC 文書へ移すときに、入力文の要点を方法に含めるか決める。

## 3. 実装の方針の選択肢

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| A: 既存の仕組みを直す（推奨） | `catalog.mjs`・`feasibility-gate-rules.mjs`・テスト・steering を直し、移行は文書の書き直しとして行う。新しいコードは書かない | 変更が小さく、関門・導入の動きを変えない（要件 10 と整合） | 移行の量が多い（文書 40 前後・参照 150 箇所） |
| B: 移行用の補助スクリプトを作る | `result.md` から `poc-*.md` への変換と参照の置換をスクリプトで行う | 参照の置換が漏れにくい | 一度しか使わないコードを作ることになり、「リポジトリにスクリプトを置かない」方針（要件 3）に反する。使い捨てなら一時ディレクトリで動かして残さない |
| C: 新しいコマンドで PoC 文書を作る | 導入コマンドに PoC 文書の雛形を出す機能を足す | 書式が揃う | 要件の範囲外で、コードが増える（product.md の「コードを増やさない」と反する） |

推奨は **A**。参照の置換だけは、B のように一時ディレクトリの使い捨てスクリプトで行ってよい（残さない）。

## 4. 設計に持ち込む未決事項（Research Needed）

1. 要件 6 に、入力のたびに届く追加の指示（`messageContext`）を含める（取りこぼし 1）。
2. 移行の単位（取りこぼし 2）と、過去の文書の参照の扱い（取りこぼし 3）。
3. 繰り返し使う確認手順を `test/` に移す必要があるか（`self-install`・`install-freshness`）。
4. 前提 (a)(b) の PoC（`feasibility.md` 参照）。新方式の PoC 文書として、設計の承認の前に作る。
5. 根拠の表の出典欄の書式（相対パスの書き方。テストが抽出できる形にする）。
6. 移行する PoC 文書の書式の検証（要件 2 の項目が、元の `result.md` から欠けずに移せるか。例: 実行した環境の版が `result.md` に書かれていないものがあるか）。
