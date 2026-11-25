# 技術スタック

## アーキテクチャ

2 つの面を持つ。

- **導入コマンド**（このリポジトリで動く）: 利用先のリポジトリへファイルを配置・更新する CLI。
- **配置物**（利用先で動く）: Claude Code と Codex のフックから呼ばれるスクリプト群と設定。導入後は導入コマンドなしで動き、利用先のリポジトリだけで完結する（クラウドセッションで、プラグインの導入を待たずに動かすため）。

プラグインとしては配らない（2026-11-22、plugin-skill を撤回）。

## 中心となる技術

- **言語**: JavaScript（ESM、`.mjs`）
- **実行環境**: Node.js 22 以上
- **外部パッケージ**: 使わない（Node の標準モジュールだけ）。`npx` での取得を速くし、利用先に依存を持ち込まないため。

## 開発の決まり

### コード
- コード内のコメントと利用者向けの出力は日本語で書く。
- フックは「判定できないときは通す」か「止める」かを部品ごとに決めて明記する。導入の失敗は止める側、手順書の強制は判定できなければ通す側。

### テスト
- 単体テストは `node --test`。
- Claude Code の動作に依存する前提（フックの入出力、許可の判定の優先順位、サブエージェントのモデルの決まり方など）は、PoC（実際の `claude -p` を一時ディレクトリで動かす検証）で確かめ、再実行できるスクリプトとして残す。cc-sdd や Claude Code の版を上げたときに同じ PoC で互換を確かめる。

## 開発環境

### 必要なもの
- Node.js 22 以上、git
- PoC の実行には Claude Code（`claude`）とその認証

### よく使うコマンド
```bash
npm test                                      # node --test "test/**/*.test.mjs"
node bin/cc-sdd-bootstrap.mjs init            # このリポジトリへの適用
node bin/cc-sdd-bootstrap.mjs update          # 適用内容の確認・更新
node bin/cc-sdd-bootstrap.mjs uninstall       # 適用内容の取り除き
poc/<名前>/run.sh                            # 個別の前提確認
```

設定ファイルに保存した cc-sdd の版と言語で、起動前（環境の準備スクリプトから `node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs`）か、セッション開始・最初の入力のフックで導入物を揃える。導入物が揃っていれば入れ直しを省く。Codex の利用設定（`codex.enabled`）と役割ごとのモデル（`models`）は今は保存だけで、後続の仕様（subagent-delegation）で役割表に置き換える。`ccSdd.keepTemplates` は単純化で廃止し、残っていても読まない（このリポジトリの設定からも外した）。

2026-11-22 の単純化の discovery で要件に戻した installer-core・session-install・kiro-gate は、改訂後の実装を develop に取り込んだ（2026-11-24、#3）。

## 主要な技術判断

- **配布は `npx github:nekono-dev/cc-sdd-bootstrap`**: 公開リポジトリなので認証が要らない。GitHub Packages（認証が要る）は使わない。
- **cc-sdd の導入物はリポジトリに含めない**: 利用先でも `.gitignore` の対象にする。セッション開始時に設定ファイルの版と言語で導入物を揃え、揃っていれば入れ直しを省く。
- **CLAUDE.md・AGENTS.md は cc-sdd の標準の文書＋運用の区画として作り直す**（2026-11-23、利用者の指示。2026-11-18 の「管理区画だけを書き換え、標準の文書は `.kiro/settings/cc-sdd-guide.md` へ出して `@` で取り込む」判断を置き換える）: cc-sdd の導入で CLAUDE.md（Claude Code 向け）・AGENTS.md（Codex 向け）を標準の文書として書き出し、その後に cc-sdd-bootstrap の運用の区画（目印の行で囲んだ案内）を末尾へ書き足す。導入物なのでコミットしない。プロジェクト独自の決まりは `.kiro/steering/` に置く（`poc/req-feasibility/doc-append.sh` で確認）。
- **フックは Claude Code と Codex の両方へ同じスクリプトを登録する**（2026-11-24）: 同じ配置物を `--tool claude|codex` の引数で呼び分ける。登録先は `.claude/settings.json`（`$CLAUDE_PROJECT_DIR` で道筋を作る）と `.codex/hooks.json`（`git rev-parse --show-toplevel` で道筋を作る。worktree の中でもその worktree の配置物が動く）。導入コマンドは印（`/.agent-hooks/cc-sdd-bootstrap/` を含むコマンド）のある項目だけを書き換え、利用者の他のフックは保つ。
- **フックの止め方の向き**: 導入の失敗・未完了は次の入力を止める（session-install）。手順書の先読みの強制は、判定できない入力・状態の読み書きの失敗・手順書が無いときは通す（kiro-gate）。未読のままの終了は 1 回だけ止める。
- **uninstall はフックの登録と運用の区画だけを外す**: 配置物や設定ファイルは消さない（利用者が git で確かめて消す）。
- **このリポジトリ自身にも適用する**: 導入コマンドができたら、このリポジトリにも同じ方法で導入し、作るものを自分で使って確かめる。

---
_依存の一覧ではなく、決まりと判断を書く_

_updated_at: 2026-11-24（単純化した 3 つの spec の取り込みと Codex への登録を反映）_
