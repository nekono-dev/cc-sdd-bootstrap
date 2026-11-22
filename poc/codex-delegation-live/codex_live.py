#!/usr/bin/env python3
"""Codex クライアントの実機確認の手順書（未実行）。

Codex は利用上限に達しているため、このスクリプトは実行しない。既定では確認の計画を表示して終わる。
上限が解消されたあとに、利用者が --run を付けて実行する想定の手順だけを残す。
--run を付けても、この版では Codex を呼ばず、計画の表示と前提の確認だけを行う（実行の配線は上限解消後に足す）。

確認する項目（result.md の「未実行（Codex）」の対応）:
  1. Codex の MCP 呼び出しを PreToolUse で検出・拒否できるか（mcp__<サーバー>__codex_start の形を実測する）
  2. 管理委任の有効化（delegation-mcp-gate.mjs の codex.enabled）の判断は、上の 1 の拒否を確認してから行う
  3. 同系統（Codex）のクラウド候補を選ばないことの実機確認（selection.mjs は選択関数の単体確認）
"""

import sys

PLAN = """\
Codex 実機確認の計画（未実行）

前提: Codex CLI の利用上限に達しているため、この計画は実行していない。
再開時の手順（一時プロジェクトで、ホストの ~/.codex を変えない）:
  a. 一時プロジェクトへ `node bin/cc-sdd-bootstrap.mjs init --clients codex` で導入する
  b. Codex の設定は CODEX_HOME を一時領域にして隔離する（認証は既存の PoC と同じく、認証ファイルのコピーだけを入れる）
  c. `codex -a never exec --sandbox read-only --model gpt-6.1-sol` で、cc-sdd 作業中（/kiro-impl の指示）に
     mcp__<サーバー>__codex_start を直接呼ばせ、PreToolUse の拒否理由が出ることを確かめる（ツール名の実測）
  d. 通常作業（cc-sdd 外）では同じ呼び出しが拒否されないことを確かめる
  e. 拒否を確認できた場合だけ、delegation-mcp-gate.mjs の codex の enabled を true にする判断を行う（根拠を result.md に書く）
"""


def main():
    if "--run" in sys.argv[1:]:
        print("未実行（Codex の利用上限）。この版では Codex を呼ばない。")
        return 0
    print(PLAN)
    print("未実行（Codex の利用上限）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
