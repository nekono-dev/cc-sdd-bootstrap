# cc-sdd-bootstrap

[cc-sdd](https://github.com/gotalab/cc-sdd)（Kiro 方式の仕様駆動開発を Claude Code のスキルとして提供するツール）の運用一式を、各プロジェクトへ 1 つのコマンドで導入・更新する仕組み。

> 開発中。仕様は [.kiro/steering/roadmap.md](.kiro/steering/roadmap.md) と [.kiro/specs/](.kiro/specs/) を参照。

## 導入するもの（予定）

- セッション開始時に、設定ファイルで指定した版の cc-sdd を入れ直すフック（cc-sdd の導入物はリポジトリにコミットしない）
- `/kiro-*` で始めた作業で手順書を先に読ませるフック（kiro-gate）
- サブエージェントの役割ごとのモデル固定と、指揮役と同じモデルでの起動を拒否するフック
- Codex MCP サーバーによる委任（導入時に選択）

## ライセンス

[Unlicense](LICENSE)。cc-sdd 本体（MIT）は含まない。
