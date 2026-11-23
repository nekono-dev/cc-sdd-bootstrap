# PoC 結果: CLAUDE.md の無いリポジトリで、最初の入力 `/kiro-steering` がスキルとして実行されるか

- 実行日: 2026-11-23
- 環境: Claude Code 2.1.329（`claude -p`、指揮役 sonnet）、cc-sdd 3.1.0。対象は `dev/poc-cloud-first-run`（develop から CLAUDE.md だけを取り除いたブランチ。検証用で取り込まない）のアーカイブ
- 目的: CLAUDE.md・AGENTS.md をコミットしない方針で、新しい環境の最初の `/kiro-*` が手順書を読み込んだうえで実行されるかを確かめる
- クラウドで試さなかった理由: 別のセッションから起動するクラウドセッションは、最初の入力を `/` で始められない。別のセッションから送る文も、スラッシュコマンドとしては扱われない。クラウドでの確認は、利用者が手で入力して行う（下の「クラウドでの確認手順」）

| 経路 | 結果 |
|---|---|
| A. 起動前に導入（クラウドの準備スクリプトに相当）→ `/kiro-steering` | 起動時のスキル一覧に載り、`/kiro-steering` がスキルとして展開された（会話の記録に `<command-name>/kiro-steering</command-name>` と手順書の本文がある）。モデルは SKILL.md を自分で読まず、手順書が指す決まり（`rules/steering-principles.md`）を読み、同期の手順で `.kiro/steering` を更新した |
| B. 起動前に導入せず、SessionStart フックだけで導入 → `/kiro-steering` | 導入はされたが、スキル一覧に載らず、展開もされなかった。フックの案内に従い、モデルが SKILL.md を自分で Read して手順を実行した |

- CLAUDE.md が無いことは、A・B のどちらの実行も妨げなかった（cc-sdd の標準の決まりの文書は `.kiro/settings/cc-sdd-guide.md` にあるが、CLAUDE.md からの取り込みが無いので読み込まれていない）。
- B が動いたのは `claude -p` だからで、対話モードでは一覧に無い `/kiro-*` は「Unknown command」になりモデルに届かない（session-install の要件 2.5 の前提）。初回から `/kiro-*` を使うには、起動前の導入（A）が要る。

## 判定の注意（スクリプトの改訂の経緯）

- 展開された手順書の本文は stream-json の出力に出ないため、会話の記録（`~/.claude/projects/*/<session_id>.jsonl`）で判定する。
- ツール呼び出しの判定は、全件に対する `any` で行う（`jq -e` は最後の出力しか見ない）。
- 取得はアーカイブで行い、版管理のコマンドを使わない（BRW のフックは、版管理のコマンドを含むスクリプトの実行を止める）。

## クラウドでの確認手順（利用者が行う）

1. claude.ai/code の環境の設定で、準備スクリプトに次の 1 行を入れた環境を作る。
   `if [ -d cc-sdd-bootstrap ]; then (cd cc-sdd-bootstrap && node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs); fi`
2. その環境で、`nekono-dev/cc-sdd-bootstrap` の `dev/poc-cloud-first-run` を選んで新しいセッションを始める。
3. 最初の入力に `/kiro-steering` だけを打つ。
4. 「Unknown command」にならず、スキルとして手順が進めば成功（比べるなら、準備スクリプトの無い Default 環境で同じことをする）。
