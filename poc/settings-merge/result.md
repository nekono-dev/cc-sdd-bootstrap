# PoC 結果: フックの登録の統合と CLAUDE.md の管理区画

- 実行日: 2026-11-19
- 環境: Claude Code 2.1.325
- 実行: `poc/settings-merge/run.sh`

## 結果（OK 3 件、NG 0 件）

```
     応答: ASAGAO-7319
OK   1: 利用者のフックが動いた
OK   1・2: 一式のフック（.agent-hooks の下）が動いた
OK   3・4: 管理区画の中の取り込みが効いた（応答に合言葉）
結果: OK 3 件、NG 0 件
```

## 分かったこと

- `.claude/settings.json` の同じイベントに、利用者のフックの組（matcher とフックの一覧のまとまり）と一式のフックの組を並べても、両方が動く。統合は「一式の組を後ろに足す」形でよい。
- `"$CLAUDE_PROJECT_DIR/.agent-hooks/cc-sdd-bootstrap/<スクリプト>"` の形で、隠しディレクトリの下のスクリプトを呼べる。
- HTML のコメントの目印の行（`<!-- cc-sdd-bootstrap:begin ... -->`・`<!-- cc-sdd-bootstrap:end -->`）で囲んだ区画の中でも、`@.kiro/settings/cc-sdd-guide.md` の取り込みが効く。
