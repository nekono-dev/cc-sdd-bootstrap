# cc-sdd-bootstrap

[cc-sdd](https://github.com/gotalab/cc-sdd)（Kiro 方式の仕様駆動開発を Claude Code のスキルとして提供するツール）の運用一式を、Git リポジトリへ導入・更新・削除するコマンドです。

## 必要なもの

- Node.js 22 以上
- git

## 使い方

リポジトリの最上位ディレクトリで実行します。

```sh
npx github:nekono-dev/cc-sdd-bootstrap init
npx github:nekono-dev/cc-sdd-bootstrap update
npx github:nekono-dev/cc-sdd-bootstrap uninstall
```

- `init`: cc-sdd の運用一式を導入します。
- `update`: 設定を保ち、同梱ファイルやフック登録を更新します。
- `uninstall`: このコマンドが管理するものを取り除きます。

入手するコマンドの版を固定するには、`#<タグ>` を `github:nekono-dev/cc-sdd-bootstrap` の末尾に空白なしで付けます。たとえば `npx github:nekono-dev/cc-sdd-bootstrap#v1.2.3 init` のようにします。

### オプション

```text
--cc-sdd-version <値>   cc-sdd の版
--lang <値>             cc-sdd の言語（例: ja、en、pt-BR）
--codex yes|no           Codex を使うか
--model <役割>=<モデル>  役割ごとのモデル（繰り返し指定可能）
--force                 内容が変更された共通ファイルも置き換える
--help                  使い方を表示する
```

設定オプション（`--cc-sdd-version`、`--lang`、`--codex`、`--model`）は `init` と `update` でだけ使えます。`--force` と `--help` は3つの操作で使えます。

設定は `.cc-sdd-bootstrap.json` に保存されます。初めて `init` を端末から実行するときは、引数で指定していない設定項目を尋ねます。役割ごとのモデル一覧は空のままでも質問しません。入力と出力が端末につながっていない場合は、未指定の項目を既定値で補います。`update` は既存の設定に引数で指定した値を重ねて使い、質問はしません。`uninstall` も質問しません。

現在、保存した cc-sdd の版と言語は実際の導入には反映されません。導入スクリプトは版 `3.1.0`・言語 `ja` を固定して実行します。Codex の利用設定と役割ごとのモデルも現時点では保存だけで、後続の機能で反映する予定です。

## 配置されるもの

- `.cc-sdd-bootstrap.json`: cc-sdd の版・言語、Codex の利用、役割ごとのモデル設定。
- `.agent-hooks/cc-sdd-bootstrap/`: フックから使うスクリプト。`installed.json` は配置内容と版の記録です。
- `.claude/settings.json`: セッション開始時と入力時に動くフックの登録。
- `.gitignore` と `CLAUDE.md`: cc-sdd の導入物や標準の決まりを案内する、コマンド管理の区画。

設定ファイル、配置されたスクリプトと記録、フック設定、`.gitignore` と `CLAUDE.md` の変更をまとめてコミットしてください。cc-sdd が生成する `.claude/skills/kiro-*/` や `.kiro/settings/` は `.gitignore` の対象で、コミットしません。

## ファイルの変更と削除

共通ファイルが配置後に書き換えられていると、`update` と `uninstall` は何も変更せず中止します。内容を確認したうえで `--force` を付けると、共通ファイルを上書きまたは削除できます。`init` と `update` は、プロジェクト固有の配置ファイルが既にあれば保持します。`uninstall` は、配置したときから変わっていないプロジェクト固有ファイルを削除し、変更されていれば残します。管理区画の外にある利用者の記述やフック設定も保持します。

`uninstall` はこのコマンドが配置したファイルと登録・管理区画を取り除きます。cc-sdd 自体が導入した出力（`.claude/skills/kiro-*/` など）と `.kiro/` の内容は削除しません。

`.claude/settings.json` は書き込み時に空白2つの字下げで整形されます。同じリポジトリでコマンドを同時に実行することはサポートしていません。

## 終了コード

- `0`: 成功、変更なし、またはヘルプ表示
- `1`: 実行時の失敗や前提条件の不足
- `2`: 操作名やオプションなど、使い方の誤り

## ライセンス

[Unlicense](LICENSE)。cc-sdd 本体は MIT ライセンスで、ここには含まれません。
