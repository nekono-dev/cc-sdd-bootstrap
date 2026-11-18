# cc-sdd-bootstrap

cc-sdd（Kiro 方式の仕様駆動開発）の運用一式を、各プロジェクトへ 1 コマンドで導入・更新する仕組み。目的と方針は `.kiro/steering/`（product.md・tech.md・structure.md）、全体の分割と順序は `.kiro/steering/roadmap.md` を読む。

## 作業の進め方

- このリポジトリ自身も cc-sdd の手順で進める。仕様は `.kiro/specs/<spec名>/`、プロジェクト全体の決まりは `.kiro/steering/` に置く。決めたことは会話や自動メモリに残さず、これらのファイルに書く。
- cc-sdd の導入物（`.claude/skills/kiro-*/`・`.kiro/settings/`）は `.gitignore` の対象で、コミットしない。無ければ次で入れる（導入コマンドで自己適用できるまでの暫定の手順）:

  ```sh
  M=$(mktemp) && printf '%s' '{"version":1,"artifacts":[{"id":"skills","source":{"type":"templateDir","fromDir":"templates/agents/{{AGENT}}/skills","toDir":"{{AGENT_COMMANDS_DIR}}"}},{"id":"settings_templates","source":{"type":"templateDir","fromDir":"templates/shared/settings/templates","toDir":"{{KIRO_DIR}}/settings/templates"}}]}' > "$M" && npx --yes cc-sdd@3.1.0 --yes --overwrite force --manifest "$M" --claude-skills --lang ja; rm -f "$M"
  ```

- `/kiro-*` を頼まれたら、`.claude/skills/<名前>/SKILL.md` を Read し、その手順を最後まで実行する（スキル一覧に載らないスキルがあるため）。手順が「提示して止まる」なら、そこで利用者に返す。
- Claude Code の動作に依存する前提は、設計の承認前に PoC（一時ディレクトリで実際の `claude -p` を動かす検証）で確かめ、再実行できるスクリプトと結果を残す。推測で設計しない。
- サブエージェント（Agent ツール）を使うときは、必ず `model` を指定し、指揮役（このセッション）と同じモデルにしない。強制のフック（spec: subagent-model-policy）ができるまでは、この決まりを手順で守る。

## ブランチ

- 作業ブランチは `develop` と `dev/*`、保護ブランチは `main`（`.branch-release-workflow.json`）。`main` への commit・push・merge は利用者の許可を得てから行う。

## 書き方

- 文書・コードのコメント・利用者向けの出力は日本語で書く。専門用語は一般的な言葉に言い換えるか、初出で意味を添える。
