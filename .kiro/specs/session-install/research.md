# Research & Design Decisions

> 改訂（2026-11-23）: 単純化後の要件（起動前と最初の入力時の導入、Codex 対応、CLAUDE.md・AGENTS.md を標準の文書＋運用の区画として作り直す、内容の照合と雛形の保持を外す）に合わせて書き直した。旧版は git の履歴にある。

## Summary
- **Feature**: `session-install`
- **Discovery Scope**: Extension（develop の `install-cc-sdd.mjs`・`install-rules.mjs`・`install-gate.mjs` を組み直す）
- **Key Findings**:
  - セッション中に入れたスキルは、Claude Code・Codex のどちらでも同じセッションの一覧に載らない。起動前に入れれば最初のセッションから使え、最初の入力時のフックで入れて「手順書を直接読む」よう伝えれば、両方とも手順書を読んでから作業する。
  - 準備スクリプトで起動前に入れたクラウドのセッションでは、CLAUDE.md が無くても最初の `/kiro-steering` がスキルとして実行された。
  - `--overwrite force` の導入で CLAUDE.md・AGENTS.md は標準の文書に丸ごと置き換わり、末尾に区画を足すだけで入れ直しても 1 つになる。
  - Codex の UserPromptSubmit も `decision: "block"` で入力を止められ、`additionalContext` がモデルに届く。Codex のフックはセッションの作業場所で動くので、スクリプトは自分の位置から根を求める。

## Research Log

### 導入の時点
- **Context**: 要件 1・2。
- **Sources Consulted**: 実機検証（両ツールの最初の入力時の導入。確認項目は Claude Code が a〜c、Codex が a〜d）、実機検証（起動前の導入で最初の `/kiro-*`）。
- **Findings**: SessionStart で入れたスキルは一覧に載らない（両ツール）。UserPromptSubmit で導入してから追加の文脈で「SKILL.md を直接読む」と伝えると、モデルは手順書を読む。対話モードの Claude Code では、一覧に無い `/kiro-*` はフックに届く前に拒否される（以前の調査）。
- **Implications**: 導入は「起動前（引数なしの CLI）」と「最初の入力時（UserPromptSubmit）」の 2 か所。SessionStart では導入しない（待ち時間だけ増えて同じセッションで使えない）。SessionStart は状態を知らせるだけにする（3.6）。

### 入れ直しの判断
- **Context**: 要件 4。旧版は導入物の全ファイルの内容の照合をしていた。
- **Findings**: 内容の照合をやめても、版・言語の一致、両ツールの手順書の存在、運用の区画の存在、失敗の記録の有無で判断できる。
- **Implications**: 状態の記録は `{ format, version, lang, files }`（`files` は導入物の道筋だけ。中身は持たない）にする。

### 同時に始まるセッション
- **Context**: 要件 5.5。
- **Findings**: 印を排他的に作る（`wx`）と 1 つの実行に絞れる。ただし失敗の記録と印を兼ねると、残った記録を複数の実行が同時に回収して排他が破れる（設計レビューの指摘）。
- **Implications**: 導入中の印（`.cache/cc-sdd-install.lock`）と失敗の記録（`.cache/cc-sdd-install.failed`）を分ける。失敗の記録からの入れ直しは印の作成で 1 つに絞られる。強制終了で残った印は、フックでは回収せず（止めて再試行を案内する）、CLI も自動では回収しない。古い印は、ほかに導入が進んでいないことを利用者が確かめてから消して再試行する（`rm .cache/cc-sdd-install.lock && node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs`）。自動の回収は、名前の変更による取り上げを含めても、回収の途中で複数の実行が導入を始める経路が残った（設計レビューで 2 度指摘）。厳密さのために仕組みを増やさず、まれな中断の後始末を人の 1 手に任せる。

### 入れ直しの判断の材料（設計レビューの指摘）
- 「手順書が 1 つ以上ある」では一部の欠けを見逃す。成功したときに導入物の道筋だけを状態に記録し、次回は存在を確かめる（中身は比べない）。
- 2 回の npx を合わせた導入全体の期限（540 秒）を、UserPromptSubmit のフックの時間切れ（600 秒）より短くし、印を古いとみなす時間（660 秒）をそれより長くする。

## Design Decisions

### Decision: 入力の停止と最初の入力時の導入を 1 つのフックにまとめる
- **Context**: 要件 2.1・2.2・5.2。旧版は導入（SessionStart）と停止（`install-gate.mjs`）が別のスクリプト。
- **Selected Approach**: `install-cc-sdd.mjs user-prompt-submit` が、状態の確認 → 必要なら導入 → 結果に応じて止めるか追加の文脈を返す、までを行う。`install-gate.mjs` は消す。
- **Rationale**: 判断の材料（設定・状態・印）が同じで、別のスクリプトにすると食い違う。

### Decision: 判定できないときは止める
- **Context**: 要件 5.6（旧版の `install-gate.mjs` は判定できないとき通していた）。
- **Selected Approach**: 例外を捕まえたら入力を止め、理由と再試行のコマンドを示す。

### Decision: 単純化 — 外すもの
- 導入物の内容の照合（指紋）、雛形の保持（`keepTemplates`）とその設定の項目、`install-gate.mjs`、SessionStart での導入、`.kiro/settings/cc-sdd-guide.md` への標準の文書の出力先の差し替え。

### Decision: Build vs Adopt
- cc-sdd の公式の CLI（`npx cc-sdd@<版> --manifest`）をそのまま使う。独自の manifest で出力物を絞る（Codex の既定のエージェント定義 `.codex/agents/spec-reviewer.toml` はモデルを固定するので入れない）。

## Risks & Mitigations
- 対話モードの Claude Code で、未導入のまま `/kiro-*` を最初に打つと拒否される — 利用手順（README と `--help`）で、通常の文の入力か起動前の導入を案内する（2.4・2.5）。
- 最初の入力時の導入は npx の取得で時間がかかる（フックの時間切れ 600 秒、npx は 540 秒で打ち切る）— 打ち切ったら失敗として止める。
- 利用者が `.claude/skills/kiro-*` に独自のスキルを置くと消える — 運用の区画で「`kiro-` で始まる独自のスキルを置かない」と案内する。

## References
- 実機検証（記録は削除済み）: 両ツールの最初の入力時の導入、起動前の導入で最初の `/kiro-*`、Codex のフックのコマンドの書き方
- `.kiro/specs/installer-core/design.md`（カタログ・運用の区画のファイル・フックのコマンドの形）
