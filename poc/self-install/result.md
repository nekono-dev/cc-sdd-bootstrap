# PoC 結果: 暫定の cc-sdd 導入の仕組み

- 実行日: 2026-11-18
- 環境: Claude Code 2.1.325、Node.js v22.16.0、cc-sdd 3.1.0
- 実行: `poc/self-install/run.sh`

## 結果（OK 11 件、NG 0 件）

```
OK   1-前提: 導入物が無い
     応答: PONG
OK   1: スキルが入った
OK   1: 雛形が入った
OK   1: 標準の決まりの文書が入った
OK   1: 失敗の記録が無い
OK   1: プロンプトが通った（応答に PONG）
OK   1: CLAUDE.md は変わっていない
OK   1: 導入物は git の変更に出ない
     応答: UserPromptSubmit operation blocked by hook:
導入が完了していないため（失敗・中断を含む）、プロンプトを止めています。新しいセッションを開くと、導入が再試行されます。すぐに直す場合は、Claude の外（通常のターミナル）で次のコマンドを実行してください。成功してから、もう一度入力してください。
- cc-sdd: .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.sh --claude（記録: .cache/cc-sdd-install.failed）（終了コード 0）
OK   2: 失敗の記録が残った
OK   2: 記録に終了コードが書かれた
OK   2: プロンプトが止まった（応答に PONG が無い）
結果: OK 11 件、NG 0 件
```

## 分かったこと

- `claude -p` でもプロジェクトの SessionStart のフックが動き、導入物の無い状態から導入が終わってから最初のプロンプトが処理される。
- 導入に失敗すると、UserPromptSubmit のフックがプロンプトを止める。`claude -p` では止めた理由が標準出力に出て、終了コードは 0。
- 導入物はすべて `.gitignore` の対象で、導入後も `git status` に変更が出ない。CLAUDE.md は書き換わらない。

- 2026-11-19: 導入スクリプトと停止フックの道筋を `.agent-hooks/cc-sdd-bootstrap/` に更新。

## 再実行（2026-11-19、installer-core の自己適用の後）

- 道筋を `.agent-hooks/cc-sdd-bootstrap/` に移した後に `poc/self-install/run.sh` を再実行し、OK 11 件、NG 0 件。導入物の無い状態からの導入、プロンプトの通過、失敗時の停止（再試行の案内は新しい道筋）が、自己適用の後も変わらないことを確かめた。
