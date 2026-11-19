# PoC 結果: `npx github:` で bin が動くこと

- 実行日: 2026-11-19
- 環境: Node.js v22.16.0、npm 10.9.2
- 実行: `poc/npx-bin/run.sh`（一時ブランチ `dev/poc-npx-bin` を push して `npx github:nekono-dev/cc-sdd-bootstrap#dev/poc-npx-bin` で実行し、最後に消す）

## 結果（OK 5 件、NG 0 件）

```
     出力: {"cwd":"/tmp/tmp.pjfG54rHz0/target","args":["init","--lang","ja"],"payload":"payload-ok","excludedShipped":false,"shMode":"775"}（終了コード 0）
OK   1: bin が実行された（終了コード 0）
OK   2: カレントは npx を実行した場所
OK   3: 同梱のファイルを読める
OK   4: files に無いファイルは同梱されない
OK   6: 引数がそのまま渡る
     5: 同梱のシェルスクリプトの権限 = 775（755 なら保たれる。644 なら導入時に付け直す）
結果: OK 5 件、NG 0 件
```

## 分かったこと

- 公開リポジトリなら、認証なしの `npx github:<owner>/<repo>#<ref>` で bin が動く。`#<ref>` にブランチ名を書けば、その先端を取る（タグでも同じ書き方で版を固定できる）。
- bin のカレントディレクトリは npx を実行した場所のまま。導入先をカレントにできる。
- bin は `import.meta.url` から自分のパッケージのルートを求め、同梱のファイルを読める。
- `package.json` の `files` に無いファイルは同梱されない。配る範囲は `files` で絞れる。
- 同梱のシェルスクリプトの実行権限は保たれた（775。手元の umask による）。ただし npm の版や環境に依るため、導入コマンドは写したあとに実行権限を明示して付け直す。
