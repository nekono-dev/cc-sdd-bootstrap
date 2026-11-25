# Requirements Document

## Project Description (Input)
Codex のフックは信頼の承認が済むまで動かず、利用者は導入・更新のたびに手で承認している（利用者: cc-sdd-bootstrap を使う開発者）。現状、承認の記録（`~/.codex/config.toml` の `trusted_hash`）は導入コマンドが書かず、Claude から起動する `codex exec` の子も未承認のフックは動かない。導入・更新の行程で承認の記録を自動で書き、子の起動には `--dangerously-bypass-hook-trust` を付けて、承認の手間をなくす。詳細は `brief.md` を参照。

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->


