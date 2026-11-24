<!-- cc-sdd-bootstrap:begin（この区画は cc-sdd の導入のたびに書き足される。編集しない） -->

この区画は cc-sdd-bootstrap の導入のたびに書き足されるため、直接編集しないでください。

共通の配置物（`.agent-hooks/cc-sdd-bootstrap/`）を直接編集しないでください。変更は導入コマンドの更新で反映し、差分は git で確認してください。

プロジェクト独自の決まりは、作業を始める前に `.kiro/steering/` の `product.md`・`tech.md`・`structure.md` と独自の文書を読んでください。

cc-sdd の導入は起動前（環境の準備スクリプト）か最初の入力時に行われ、必要なファイルが揃っていれば省かれます。`kiro-` で始まる独自のスキルを置かないでください。

導入が未完了なら入力は止まります。再試行は通常の端末で `node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs` を実行してください。

スキル一覧に載らないスキルは `.claude/skills/<名前>/SKILL.md` を直接読んで手順を最後まで実行してください。手順書が見つからなければ導入を確かめて再試行し、手順書が使えるまで開発作業を進めないでください。

プロジェクト独自の決まりは `.kiro/steering/` から読んでください。

| 依頼の種類 | 使うスキル |
|---|---|
| 新機能・新プロジェクトの相談、分割の検討 | `kiro-discovery` |
| 次にやること・進み具合の確認 | `kiro-spec-status` |
| 既存コードと要件の差の確認 | `kiro-validate-gap` |
| 設計のレビュー | `kiro-validate-design` |
| 実装後の最終確認 | `kiro-validate-impl` |
| プロジェクトの方針の整備・更新 | `kiro-steering` |
| 完了・成功と報告する前 | `kiro-verify-completion` |

表に該当する依頼では `/kiro-*` で始まっていなくても、対応する手順書を読んで手順を最後まで実行してください。

手順書は `.claude/skills/<スキル名>/SKILL.md` を直接読んでください。

依頼の種類を判断できなければ、スキルを使うか利用者に尋ねてください。

`/kiro-*` で始めた依頼では、フックが有効なら手順書を読むまで他の作業ツールが拒否されます。

プロジェクト独自の決まりは `.kiro/steering/` から読んでください。

<!-- cc-sdd-bootstrap:end -->
