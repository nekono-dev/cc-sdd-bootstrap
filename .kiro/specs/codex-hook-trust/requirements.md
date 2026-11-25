# Requirements Document

## Project Description (Input)
Codex のフックは信頼の承認が済むまで動かず、利用者は導入・更新のたびに手で承認している（利用者: cc-sdd-bootstrap を使う開発者）。現状、承認の記録（`~/.codex/config.toml` の `trusted_hash`）は導入コマンドが書かず、Claude から起動する `codex exec` の子も未承認のフックは動かない。導入・更新の行程で承認の記録を自動で書き、子の起動には `--dangerously-bypass-hook-trust` を付けて、承認の手間をなくす。詳細は `brief.md` を参照。

## Introduction

Codex は、フック（決まった時点で処理を呼ぶ仕組み）の信頼の承認が済むまで、そのフックを動かさない。承認の記録は利用者全体の Codex の設定に残り、導入・更新でフックの定義が変わるたびに、利用者が確認画面で承認し直す必要がある。本仕様は、導入・更新の行程でこの承認の記録を自動で書き、Claude から起動する Codex の子（別のモデルに任せる作業）では承認の確認を省いて、承認の手間をなくす。

## Boundary Context

- **In scope**: Codex のフックの承認の記録の書き込み・更新・取り除き、書き込みを止める設定、書き込んだ内容の表示、Claude から起動する Codex の子での承認の確認の省略、Codex の版が変わって記録が効かなくなったときの扱い。
- **Out of scope**: Codex の「プロジェクトの信頼」（`[projects."<道筋>"] trust_level`）の付与、フックの登録そのもの（installer-core）、役割表・子のモデルの決まり・委任の手順（subagent-delegation）、Claude Code 側の許可の設定、承認以外の Codex の設定の変更、Codex の承認の確認画面そのものの変更。
- **Adjacent expectations**: Codex は、プロジェクトを信頼していないと `.codex/hooks.json` そのものを読まない（承認を省く指定を付けても読まれない）。プロジェクトの信頼は利用者が最初の確認画面または `codex exec --trust` で与える前提とし、本機能は与えない（`poc/codex-hook-trust/probe.mjs`）。導入コマンドの `init`・`update`・`uninstall` の操作（installer-core）と、起動前の導入（session-install）を、書き込みの契機として使う。フックは承認が済むまで動けないので、フックの中からは書かない。Codex は worktree の中でも、本体の checkout の `.codex/hooks.json` を読んで承認を照合する（`poc/codex-worktree-hooks`）。承認の記録のハッシュの計算方法は Codex の内部実装に依存する（`poc/codex-hook-trust`）。

## Requirements

### Requirement 1: 承認の記録の書き込み

**目的**：利用者として、導入・更新だけで Codex のフックを承認済みの状態にしたい。確認画面で毎回承認する手間をなくすため。

#### 受け入れ基準

1. When 利用者が `init` または `update` を実行した, the 導入コマンド shall 登録した Codex のフックのそれぞれについて、現在の定義に対応する承認の記録を利用者の Codex の設定へ書く。
2. When 登録したフックの定義が更新で変わった, the 導入コマンド shall 変わったフックの承認の記録を新しい定義に対応する内容へ置き換える。
3. When 承認の記録が既に現在の定義と一致している, the 導入コマンド shall 利用者の Codex の設定を変更しない。
4. When 承認の記録を書く, the 導入コマンド shall 該当するフックの記録だけを追加・更新し、承認以外の設定と、他のフック・他のリポジトリの記録を変更しない。
5. When 導入コマンドが承認の記録を書き終えた, the Codex shall 承認の確認画面を出さずに、登録されたフックを動かす。
6. If 利用者の Codex の設定を読み取れない・書き込めない、または形式が想定と合わない, the 導入コマンド shall その設定を変更せず、理由と手で承認する方法を表示して、導入・更新の他の処理は続ける。

### Requirement 2: worktree と複数の checkout での承認

**目的**：利用者として、git の worktree（同じリポジトリの別の作業場所）で Codex を使っても、承認が効いていてほしい。作業場所ごとに承認し直したくないため。

#### 受け入れ基準

1. When 利用者が本体の checkout で `init` または `update` を実行した, the 導入コマンド shall その checkout で Codex を起動した場合と、その worktree で起動した場合の両方で、フックが承認済みとして動く状態にする。
2. When 利用者が worktree の中で `init` または `update` を実行した, the 導入コマンド shall Codex が承認を照合する本体の checkout の記録を書く。
3. If 本体の checkout の `.codex/hooks.json` が未導入、または worktree の登録と内容が異なる, the 導入コマンド shall 承認が効かない可能性があることを表示する。

### Requirement 3: クラウド環境の準備での承認

**目的**：利用者として、クラウドの環境でも Codex のフックを承認なしで使いたい。セッションのたびに手で承認できないため。

#### 受け入れ基準

1. When クラウド環境の準備スクリプトが起動前の導入を実行した, the 起動前の導入 shall 登録した Codex のフックの承認の記録を、Requirement 1 と同じ規則で書く。
2. When Codex がまだ導入されていない環境で承認の記録を書こうとした, the 導入コマンド shall 失敗とせず、記録を書けなかった理由を表示して他の処理を続ける。
3. The 起動前の導入 shall フックの中から承認の記録を書かない。

### Requirement 4: 書き込みを止める設定と表示

**目的**：利用者として、自分の Codex の設定が書き換えられる範囲を知り、必要なら止めたい。利用者全体の設定に触れる処理だから。

#### 受け入れ基準

1. The 導入コマンド shall 承認の記録を書くかどうかを、`.cc-sdd-bootstrap.json` の Codex に関する項目で切り替えられるようにし、既定では書く。
2. While 承認の記録を書かない設定になっている, the 導入コマンド shall 利用者の Codex の設定を変更せず、Requirement 5 の承認の確認の省略も行わない。
3. When 承認の記録を書いた, the 導入コマンド shall 書いた設定ファイルの場所と、追加・更新・変更なしの件数を表示する。
4. When 承認の記録を書かなかった, the 導入コマンド shall 書かなかった理由（設定で止めている、または Requirement 1.6・3.2 の失敗）を表示する。

### Requirement 5: Claude から起動する Codex の子での承認の確認の省略

**目的**：利用者として、Claude から別のモデルに任せる Codex の子が、承認の有無に左右されず動いてほしい。記録が効かなくなった環境でも、委任が止まらないようにするため。

#### 受け入れ基準

1. When 入口のコマンドが Codex の子を起動する, the 入口のコマンド shall 子の起動に、その起動の間だけ承認の確認を省く指定を付ける。
2. When 承認の確認を省く指定を付けた, the 入口のコマンド shall 子の起動の表示に、省く指定を付けたことを含める。
3. The 入口のコマンド shall 承認の確認を省く指定を、利用者の Codex の設定に保存しない。
4. If Codex が承認の確認を省く指定を受け付けない, the 入口のコマンド shall 子を起動せず、指定が受け付けられなかったことと、手で承認する方法を表示して失敗として終わる。

### Requirement 6: 取り除きと Codex の版への追従

**目的**：利用者として、書き込まれた記録を取り除け、Codex の版が上がっても運用が壊れないようにしたい。Codex の内部の形式が変わりうるため。

#### 受け入れ基準

1. When 利用者が本体の checkout で `uninstall` を実行した, the 導入コマンド shall 取り外す自分のフックについて、現在の定義と一致する承認の記録だけを利用者の Codex の設定から取り除き、取り除いた件数を表示する。
2. When 利用者が worktree の中で `uninstall` を実行した, the 導入コマンド shall 本体の checkout の登録が Codex に読まれ続けるので承認の記録を取り除かず、その理由を表示する。
3. If 承認の記録が現在の Codex の照合方法と合わなくなった, the Codex shall そのフックを未承認として扱い、フックは動かないだけで他の動作を壊さない。
4. While 承認の記録が効いていない環境で Codex を指揮役にして作業する, the 運用の区画の文章 shall 手で承認する方法と、効かない場合の補い（手順書を直接読むこと）を案内する。
5. The 承認の記録の計算方法の確認手順 shall Codex の版を上げたときに再実行できる形で残る。
