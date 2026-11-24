# PoC 結果: auto モードでの子（Claude Code の Agent）の起動と、許可の決まり

- 実行日: 2026-11-23
- 環境: Claude Code 2.1.329（指揮役 sonnet、`--permission-mode auto`、`--setting-sources project`）
- 背景: このリポジトリの実装中（installer-core 6.2）に、auto モードの判定が Agent の起動を「Destructive or Unwanted Actions」として拒否し、子が使えなくなった。導入先で同じ停止を防げるかを確かめた

| 確かめたこと | 結果 |
|---|---|
| a. 許可の決まりなし・依頼の中身を依頼文に直接書く（3＋2 回） | すべて起動でき、子が書き込めた |
| b. プロジェクトの `permissions.allow` に `"Agent"`（3＋2 回） | すべて起動でき、子が書き込めた（a と差が無く、許可の決まりの効果は示せない） |
| c. 許可の決まりなし・「指示のファイルを読んで従え」とだけ依頼（2 回） | 2 回とも起動できた（今回止まった依頼の形でも再現しない） |

## 公式の説明（code.claude.com/docs の permission-modes・permissions・settings、2026-11-23 に確認）

- 許可の決まりは deny → ask → allow の順に評価され、決まりに合う操作は判定に回らない。ただし **auto モードに入ると、任意のコードの実行につながる広い許可の決まりは外され、その中に `Agent` の許可の決まりが含まれる**。auto モードでの子の起動は、常に自動の判定に回る。
- 判定は、子に任せる作業の説明を起動の前に評価し、子の中の操作も親と同じ順序と決まりで判定する。
- プロジェクトの `.claude/settings.json` に `permissions` は書けるが、`permissions.allow` はフォルダの信頼の後にだけ効く。`defaultMode` の `auto` はプロジェクトの設定からは効かない。

## 結論

- 導入時に許可の決まりを置いても、auto モードでの子の起動は保証できない（installer-core に仕組みを足さない）。auto モード以外では子の起動に許可は要らない。
- 判定は会話の文脈で揺れ、今回の停止は再現できなかった。止まったときの手順（依頼を自己完結させて 1 度だけ起動し直し、それでも拒否なら利用者に示して止まる）を subagent-delegation の手順の文章に足す。
