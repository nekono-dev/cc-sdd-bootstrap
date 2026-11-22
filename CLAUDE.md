# cc-sdd-bootstrap

cc-sdd（Kiro 方式の仕様駆動開発）の運用一式を、各プロジェクトへ 1 コマンドで導入・更新する仕組み。目的と方針は `.kiro/steering/`（product.md・tech.md・structure.md）、全体の分割と順序は `.kiro/steering/roadmap.md` を読む。

## このリポジトリの決まり

- このリポジトリ自身も cc-sdd の手順で進める。仕様は `.kiro/specs/<spec名>/`、プロジェクト全体の決まりは `.kiro/steering/` に置く。決めたことは会話や自動メモリに残さず、これらのファイルに書く。
- 段階を飛ばさない: discovery → spec-init → requirements → design → tasks → impl。各段階の成果物は利用者の承認を得てから次へ進む（`-y` は利用者が明示したときだけ使う）。
- **実装は `/kiro-impl` でだけ行う。** tasks.md が承認される前に、このリポジトリのコード（配置物・導入コマンド・テスト）を書かない。PoC のスクリプトは設計の根拠を集めるためのもので、実装には数えない。
- `/kiro-*` を頼まれたら、`.claude/skills/<名前>/SKILL.md` を Read し、その手順を最後まで実行する（スキル一覧に載らないスキルがあるため）。手順が「提示して止まる」なら、そこで利用者に返す。
- Claude Code の動作に依存する前提は、設計の承認前に PoC（一時ディレクトリで実際の `claude -p` を動かす検証）で確かめ、再実行できるスクリプトと結果を残す。推測で設計しない。
- サブエージェント（Agent ツール）を使うときは、必ず `model` を指定し、指揮役（このセッション）と同じモデルにしない。強制のフック（spec: subagent-delegation）ができるまでは、この決まりを手順で守る。
- 子のエージェントには Codex を使う（2026-11-19、利用者の指示）。cc-sdd のスキル（`kiro-impl`・`kiro-review`・`kiro-debug` など）が「Agent ツールで新しいサブエージェントに任せる」と書く箇所も、同じ雛形（テンプレート）と手順で Codex の CLI に送る。Codex が使えないときだけ Agent ツールに戻す。
  - 呼び方: `codex -a never exec --sandbox <read-only|workspace-write> --model <モデル> --config 'model_reasoning_effort="medium"' --cd <リポジトリのルート> - < <指示のファイル>`。指示のファイルは `~/.cache/cc-sdd-bootstrap-scratch/` に置く（`/tmp` とリポジトリの中には置かない）。
  - 実装・修正は `workspace-write` で Luna（`gpt-6-luna`）、レビュー・調査・デバッグは `read-only` で Sol（`gpt-6.1-sol`）。書き込みの呼び出しは 1 つずつ行い、読み取りと重ねない。
  - Codex は CLAUDE.md を読まない。指示には、必要な決まり（日本語のコメント、git の操作をしない、`tasks.md`・`spec.json` を変えない、範囲）と、返す形式（`## Status Report` など）を書く。結果は未確認として扱い、`git diff` とテストで確かめてから完了とする。

## cc-sdd の導入

導入物（`.claude/skills/kiro-*/`・`.kiro/settings/`）は `.gitignore` に記載し、コミットしない。セッション開始のたびに SessionStart フック（`node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs session-start`）が `.cc-sdd-bootstrap.json` の `ccSdd.version`・`ccSdd.lang` で導入物を揃える。揃っていて中身が変わっていなければ入れ直しを省く。このリポジトリでは自分自身の導入コマンド（`node bin/cc-sdd-bootstrap.mjs`）で一式を導入し、CLAUDE.md の管理区画とフックの登録は導入コマンドが保守する。

導入に失敗または中断すると `.cache/cc-sdd-install.failed` が残り、UserPromptSubmit フック（`.agent-hooks/cc-sdd-bootstrap/install-gate.mjs`）が次の入力を止める。再試行は Claude の外で `node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs` を実行する。

SKILL.md が見つからない場合は、導入が完了していないと利用者に伝え、上記の再試行を勧める。

配置するファイルまたは導入コマンドを変更したときは、`node bin/cc-sdd-bootstrap.mjs update` を実行して結果をコミットする。cc-sdd の版を上げるときは `.cc-sdd-bootstrap.json` の `ccSdd.version` を変更し、`poc/self-install/run.sh` で導入と停止を確かめる。

## ブランチ

- 作業ブランチは `develop` と `dev/*`、切り出し元は `develop`、保護ブランチは `main`（`.branch-release-workflow.json`）。作業ブランチへの push と、作業ブランチから `develop` への PR の作成は許可なしで行う（宣言の `autoApprove` でフックが確認を省く）。`main` への commit・push・merge と、`develop` へのマージは利用者の許可を得てから行う。

## 書き方

- 文書・コードのコメント・利用者向けの出力は日本語で書く。専門用語は一般的な言葉に言い換えるか、初出で意味を添える。

<!-- cc-sdd-bootstrap:begin この区画は cc-sdd-bootstrap が管理する。手で書き換えると update で戻る -->
## cc-sdd の導入（セッション開始時）
- `.claude/skills/kiro-*` と `.kiro/settings/` は、セッションの開始時に `.cc-sdd-bootstrap.json` の版・言語で導入され、揃っていれば入れ直しを省く。
- 入れ直すときは `.claude/skills/kiro-*` を消してから導入するため、`kiro-` で始まる独自のスキルは置かない。
- 導入が完了していない（失敗・中断）と次の入力は止まる。理由が示される。Claude の外で `node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs` を実行して再試行する。新しいセッションを開いても再試行される。
- スキル一覧に載らないスキルは、対応する `.claude/skills/<名前>/SKILL.md` を Read して手順を最後まで実行する。`SKILL.md` が見つからないときは導入が完了していないと利用者に伝え、上の再試行を勧める。

## cc-sdd の標準の決まり
次の取り込みは、cc-sdd が生成する標準の決まりの文書で、セッションの開始のたびに入れ直すためコミットしない。

@.kiro/settings/cc-sdd-guide.md
<!-- cc-sdd-bootstrap:end -->
