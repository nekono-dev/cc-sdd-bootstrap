# Requirements Document

## Project Description (Input)
`/kiro-spec-quick <spec 名>` のような入力を送ったのに、画面に何も出ず入力待ちに戻る。利用者は、止められたのか・作業中なのか・失敗したのかが分からず、別の指示を送るまで状況を知れない。

原因（リモートセッションの記録で確認済み）: 実現性の関門（`feasibility-gate`）が入力を `decision: "block"` で止めると、モデルが 1 回も動かず（`num_turns=0`）、止めた理由はシステムの通知と結果の文字列に入るだけで、リモートセッションの画面には出ない。導入の停止（`install-cc-sdd`）にも同じ型の止め方がある。

変えたいこと: フックが入力を止める場面でも、利用者が必ず「止めたこと・理由・次にやること」を応答の文章として画面で読めるようにする。入力を `block` で止めず、追加の文脈（`additionalContext`）で「この入力は止めている。理由と手順を利用者に伝え、他の作業はしない」ことを渡し、モデルに話させる。対象は実現性の関門と導入の停止の両方。リモートセッション・コマンドライン・Codex のどれでも読めるようにする。

詳細は `.kiro/specs/visible-stop/brief.md`（discovery の結果）を参照。

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->
