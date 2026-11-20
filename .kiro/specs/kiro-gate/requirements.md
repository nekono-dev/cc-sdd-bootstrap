# Requirements Document

## Project Description (Input)
**誰が困っているか**: cc-sdd-bootstrap で cc-sdd の運用を導入したリポジトリの開発者と、そのリポジトリで作業する Claude Code。

**今の状況**: cc-sdd のスキルには、`disable-model-invocation: true` のものや導入直後のものがあり、スキル一覧に載らない。そのため `/kiro-*` と入力しても、エージェントが手順書（SKILL.md）を読まずに自己流で進めることがある。また、kiro-discovery で複数の spec に分けたのに、分割を会話の中だけに残し、各 spec の brief.md を書かずに終えることがある。skyshare の `kiro-gate.mjs` はこの 2 つを強制しているが、skyshare 専用で、他のリポジトリには無い。

**何が変わるべきか**:
- `/kiro-*` で始めたターンでは、対応する SKILL.md を Read するまで他のツールの実行が拒否される。
- そのセッションで roadmap.md が更新され、最後の「Specs (dependency order)」節に載った spec の brief.md が欠けていれば、ターンの終了が 1 回だけ止まる。
- 上の 2 つが、導入先のどのリポジトリでも同じに動く。roadmap の判定は付けるが、他のファイルの判定は付けない。
- 書式が想定と違う（cc-sdd の版で見出しが変わった等）ときは、何もしない。
- 手順書が無いとき（導入の失敗）は、導入の再試行を案内して止める。
- 状態は OS の一時ディレクトリに置き、リポジトリに残さない。判定できないときは通し、通常の作業を止めない。

**範囲外**: spec.json の承認や tasks.md のチェックの判定（cc-sdd のスキル自身が管理する）、自然文の依頼（`/kiro-*` で始まらない）の強制、サブエージェントのモデルの判定（subagent-model-policy）。

詳細は同じディレクトリの `brief.md` を参照。

## Introduction
cc-sdd のスキルは、スキル一覧に載らないものがあり、`/kiro-*` と入力しても手順書を読まずに進められてしまう。また、discovery で複数の spec に分けても、各 spec の brief.md を書かずに終えられてしまう。この spec は、cc-sdd-bootstrap を導入したリポジトリで、この 2 つを会話の指示ではなくフック（Claude Code の動作の節目で自動実行される処理）で強制する仕組み（以下「kiro-gate」）を定める。

## Boundary Context
- **In scope**: セッション開始時の spec の状態の知らせ、`/kiro-*` で始まる入力の検出、手順書を読むまでの他のツールの拒否、手順書が無いときの停止と再試行の案内、ターン終了時の未読と roadmap・brief の欠けの判定（1 回だけ止める）、導入・更新・取り除きでの配置と登録。
- **Out of scope**: spec.json の承認や tasks.md のチェックの判定、roadmap.md 以外のファイルの判定、`/kiro-*` で始まらない自然文の依頼の強制、サブエージェントのモデルの判定（subagent-model-policy）、cc-sdd の導入そのもの（session-install）、cc-sdd のスキルの内容の改変、強制を設定で無効にする仕組み。
- **Adjacent expectations**:
  - session-install が、スキルを `.claude/skills/kiro-*/SKILL.md` に導入し、導入の失敗の記録と再試行のコマンドを定める。kiro-gate は手順書が無いとき、その再試行のコマンドを案内する。
  - installer-core が、kiro-gate のファイルの配置、フックの登録、CLAUDE.md の管理区画、uninstall の仕組みを提供する。この spec はそれに載せるものを定める。
  - subagent-model-policy も同じツール呼び出しの直前のフックで動く。互いの判定は独立で、一方が通しても他方の拒否は残る。
  - 強制が働くのは、直近の入力が `/kiro-*` で始まるターンだけである（自然文の依頼は対象外）。

## Requirements

### Requirement 1: `/kiro-*` で始めた作業での手順書の先読み
**Objective:** As a 導入先のリポジトリの開発者, I want `/kiro-*` で始めた作業では、エージェントが対応する手順書を読むまで他の操作をできないようにしたい, so that スキル一覧に載らないスキルでも自己流で進められない

#### Acceptance Criteria
1. When 利用者が `/kiro-` で始まるコマンド名を先頭に持つプロンプトを送り、対応する手順書（`.claude/skills/<コマンド名>/SKILL.md`）がある, the kiro-gate shall そのターンの作業の前に手順書を Read して手順を最後まで実行するよう、セッションの文脈に入る形で指示する。
2. While 直近のプロンプトの `/kiro-*` の手順書をまだ読んでいない, when エージェントがツールを呼び出す, the kiro-gate shall そのツールの実行を拒否し、先に読むべき手順書のパスを理由に示す。
3. While 手順書をまだ読んでいない, when エージェントがその手順書を Read で読む, the kiro-gate shall その呼び出しを拒否せず、読んだことを記録する。
4. While 手順書をまだ読んでいない, the kiro-gate shall ツールの検索（ToolSearch）の呼び出しを拒否しない。
5. When 手順書を読んだ後, the kiro-gate shall 以後そのターンのツールの呼び出しを拒否しない。
6. When 利用者が `/kiro-` で始まらないプロンプトを送る, the kiro-gate shall 以前の `/kiro-*` による強制を解除し、ツールの呼び出しを拒否しない。
7. When 利用者が `/kiro-` で始まるコマンドを続けて送る, the kiro-gate shall 最新のコマンドの手順書の読了だけを要求する。
8. The kiro-gate shall `/kiro-` で始まるコマンド名の判定を、プロンプトの先頭（前の空白を除く）に置かれたものに限り、文中に現れる `/kiro-*` では強制を始めない。

### Requirement 2: 手順書が無いときの停止
**Objective:** As a 導入先のリポジトリの開発者, I want 手順書が無いときは、読めないまま進めずに導入の再試行を案内してほしい, so that cc-sdd の導入に失敗したまま作業が自己流で進むことがない

#### Acceptance Criteria
1. If `/kiro-` で始まるコマンドの手順書（`.claude/skills/<コマンド名>/SKILL.md`）が無い, the kiro-gate shall そのプロンプトを止め、そのコマンドが使えないこと、cc-sdd の導入が完了していない可能性があること、および session-install と同じ再試行のコマンドを示す。
2. If 手順書が無くてプロンプトを止める, the kiro-gate shall 以後のツールの呼び出しを拒否しない状態にする。
3. The kiro-gate shall 再試行の案内を、Claude の外（通常のターミナル）で実行する形で示す。

### Requirement 3: ターン終了時の判定（1 回だけ止める）
**Objective:** As a 導入先のリポジトリの開発者, I want 手順書を読まないまま、または spec の brief.md が欠けたまま作業を終えさせないでほしい, so that 分割の結果が会話の中だけに残らない

#### Acceptance Criteria
1. While 直近の `/kiro-*` の手順書を読んでいない, when エージェントがターンを終えようとする, the kiro-gate shall 終了を止め、読むべき手順書のパスを示して読んで手順を実行するよう求める。
2. While 直近の `/kiro-*` の手順書を読んでいる, when エージェントがターンを終えようとする, and `.kiro/steering/roadmap.md` が直近の `/kiro-*` の入力の後に更新され、最後の「Specs (dependency order)」節に載った spec のうち `.kiro/specs/<spec 名>/brief.md` が無いものがある, the kiro-gate shall 終了を止め、brief.md が無い spec の名前を示して brief.md を作成してから終えるよう求める。
3. If 終了を止めた後にエージェントが再度ターンを終えようとする, the kiro-gate shall 2 回目以降は終了を止めない。
4. When roadmap.md が直近の `/kiro-*` の入力の後に更新されていない, the kiro-gate shall brief.md の欠けを理由に終了を止めない。
5. When `/kiro-*` による強制が働いていない（直近のプロンプトが `/kiro-` で始まらない、または手順書が無くて止めた）, the kiro-gate shall 終了を止めない。
6. The kiro-gate shall roadmap.md 以外のファイル（spec.json の承認、tasks.md のチェックなど）の状態を、終了を止める理由にしない。

### Requirement 4: roadmap の書式の判定
**Objective:** As a 導入先のリポジトリの開発者, I want roadmap の書式が想定と違うときは何もしないでほしい, so that cc-sdd の版による書式の変更で、誤った理由で作業が止まらない

#### Acceptance Criteria
1. The kiro-gate shall roadmap.md の最後の「Specs (dependency order)」の見出し（見出しの水準は 2 または 3）に続く、次の見出しまでの範囲の「`- [ ]` または `- [x]` の後に spec 名と ` --` が続く行」を、spec の一覧として読む。spec 名は英小文字・数字・ハイフンからなる。
2. If roadmap.md が無い、「Specs (dependency order)」の見出しが無い、または見出しの後に想定の書式の行が 1 つも無い, the kiro-gate shall brief.md の欠けを理由に終了を止めない。
3. When roadmap.md に「Specs (dependency order)」の見出しが複数ある, the kiro-gate shall 最後の見出しの節だけを spec の一覧として読む。
4. The kiro-gate shall 一覧に載った spec のうち、完了済み（`- [x]`）のものも、未完了のものと同じく brief.md の有無を調べる。

### Requirement 5: セッション開始時の spec の状態の知らせ
**Objective:** As a 導入先のリポジトリで作業を始める開発者, I want セッションの開始時に spec の進み具合と roadmap の有無を知りたい, so that どこから再開するかをすぐに判断できる

#### Acceptance Criteria
1. When セッションが開始する, the kiro-gate shall `.kiro/specs/` の下の spec ごとに、名前・段階（`phase`）・要件／設計／タスクの承認の済・未を、セッションの文脈に入る形で知らせる。
2. When セッションが開始する, the kiro-gate shall `.kiro/steering/roadmap.md` の有無と、ある場合は既存の内容を上書きせず追補する旨を知らせる。
3. If `.kiro/specs/` が無い, the kiro-gate shall 無いことを知らせる。
4. If spec.json が読めない、または JSON として不正, the kiro-gate shall その spec を「spec.json を読めない」として知らせ、他の spec の知らせを妨げない。
5. If spec.json が無いディレクトリがある（brief.md だけを持つ等）, the kiro-gate shall そのディレクトリを知らせの対象に含めない。

### Requirement 6: 失敗時の方針と状態の扱い
**Objective:** As a 導入先のリポジトリの開発者, I want 判定そのものが失敗しても通常の作業が止まらず、状態がリポジトリに残らないようにしたい, so that 強制の仕組みが作業の妨げやゴミになることがない

#### Acceptance Criteria
1. If 判定の途中で予期しない誤り（入力の JSON が読めない、状態が読めない等）が起きる, the kiro-gate shall 誤りの内容を標準エラーに出し、プロンプトの停止・ツールの拒否・終了の停止のいずれも行わない。
2. The kiro-gate shall セッションごとの状態（強制の有無、読むべき手順書、読んだ記録、`/kiro-*` を受けた時刻）を、OS の一時ディレクトリに置き、導入先のリポジトリの中に作らない。
3. If 状態が無い、または読めない, the kiro-gate shall `/kiro-*` による強制が働いていないものとして扱う。
4. The kiro-gate shall 導入先のリポジトリのルートを自分の位置から求め、呼び出し元のカレントディレクトリに依らず判定する。
5. The kiro-gate shall 導入先のリポジトリの中だけで動き、cc-sdd-bootstrap のパッケージやプラグインが無くても動く。

### Requirement 7: 導入・更新・取り除き
**Objective:** As a cc-sdd-bootstrap の利用者, I want installer-core の導入・更新のコマンドで kiro-gate が配置され、取り除けるようにしたい, so that 導入先ごとに手作業の設定が要らない

#### Acceptance Criteria
1. When 利用者が installer-core の導入（`init`）または更新（`update`）を実行する, the cc-sdd-bootstrap shall kiro-gate のファイルを配置し、セッション開始・プロンプト送信・ツール呼び出しの直前・ツール呼び出しの直後・ターン終了の各フックを登録した状態にする。
2. When 利用者が `init` または `update` を実行する, the cc-sdd-bootstrap shall 導入先の既存のフック（利用者が書いたもの、session-install のもの）を残したまま、kiro-gate のフックを足す。
3. When 利用者が `update` を実行する, the cc-sdd-bootstrap shall kiro-gate のファイルとフックの登録を、このリポジトリの配置物の内容に揃える。
4. When 利用者が `uninstall` を実行する, the cc-sdd-bootstrap shall kiro-gate のファイルとフックの登録を取り除き、利用者が書いたフックは残す。
5. The cc-sdd-bootstrap shall CLAUDE.md の管理区画に、`/kiro-*` で始めた作業は手順書を読むまで他の操作が拒否されること、および roadmap に載せた spec の brief.md が欠けたままではターンの終了が止まることを、installer-core の管理区画の仕組みを通して載せる。
