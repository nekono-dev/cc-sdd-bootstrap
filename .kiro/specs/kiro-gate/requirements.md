# Requirements Document

## Project Description (Input)
**誰が困っているか**: cc-sdd-bootstrap で cc-sdd の運用を導入したリポジトリの開発者と、そのリポジトリで作業する Claude Code。

**今の状況**: cc-sdd のスキルには、`disable-model-invocation: true` のものや導入直後のものがあり、スキル一覧に載らない。そのため `/kiro-*` と入力しても、エージェントが手順書（SKILL.md）を読まずに自己流で進めることがある。また、kiro-discovery で複数の spec に分けたのに、分割を会話の中だけに残し、各 spec の brief.md を書かずに終えることがある。skyshare の `kiro-gate.mjs` はこの 2 つを強制しているが、skyshare 専用で、他のリポジトリには無い。

**何が変わるべきか**:
- `/kiro-*` で始めたターンでは、対応する SKILL.md を Read するまで他のツールの実行が拒否される。
- そのセッションで roadmap.md が更新され、最後の「Specs (dependency order)」節に載った spec の brief.md が欠けていれば、ターンの終了が 1 回だけ止まる。
- 上の 2 つが、導入先のどのリポジトリでも同じに動く。roadmap の判定は付けるが、他のファイルの判定は付けない。
- 書式が想定と違う（cc-sdd の版で見出しが変わった等）ときは、何もしない。
- 手順書が無いとき（導入の失敗）は、導入の再試行を案内して止める。
- 状態は OS の一時ディレクトリに置き、リポジトリに残さない。判定できないときは通し、通常の作業を止めない。

**範囲外**: spec.json の承認や tasks.md のチェックの判定（cc-sdd のスキル自身が管理する）、自然文の依頼（`/kiro-*` で始まらない）の強制、サブエージェントのモデルの判定（subagent-model-policy）。

詳細は同じディレクトリの `brief.md` を参照。

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->
