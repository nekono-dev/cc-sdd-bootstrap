# 引き継ぎ: このリポジトリへの循環的な自己適用（CLAUDE.md の置き換え）

> 作成: 2026-11-23（利用者の指示）。今の CLAUDE.md はすぐには書き換えず、改訂版の cc-sdd-bootstrap をこのリポジトリ自身に導入する（循環的な導入）ことで置き換える。そのための手順と注意をここに残す。対応する要件: installer-core 要件 9（特に 9.4）、session-install 要件 3.7〜3.9。

## 目指す状態

- `CLAUDE.md`・`AGENTS.md` は cc-sdd の標準の文書＋運用の区画として、導入のたびに作り直される。コミットせず `.gitignore` の対象にする。
- このリポジトリ独自の決まりは `.kiro/steering/project-rules.md`（名前は設計で確定してよい）に置き、コミットする。運用の区画がこの文書を読むよう案内する。
- 旧配置記録 `.agent-hooks/cc-sdd-bootstrap/installed.json` が無い（要件 9.2）。

## 今の CLAUDE.md の各節の行き先

| 今の節 | 行き先 | 備考 |
|---|---|---|
| 冒頭（このリポジトリの説明と、steering・roadmap を読む案内） | `project-rules.md` の冒頭 | |
| このリポジトリの決まり：cc-sdd の手順で進める、段階を飛ばさない、`/kiro-impl` でだけ実装、PoC で確かめる | `project-rules.md` | このリポジトリ固有の開発の決まり |
| このリポジトリの決まり：`/kiro-*` は SKILL.md を Read して実行 | 削除 | 運用の区画（session-install・kiro-gate の案内）が受け持つ |
| このリポジトリの決まり：サブエージェントの model 指定、子に Codex を使う（呼び方・モデル・指示の書き方） | 削除し、subagent-delegation の役割表と運用の区画へ | 「子はすべて Codex」は 2026-11-23 の方針（作る役は同じ提供元、レビューは別の提供元）で置き換わる。指示のファイルの置き場所・Codex は CLAUDE.md を読まない点は運用の区画にある |
| cc-sdd の導入（SessionStart フック、失敗時の停止、再試行） | 削除 | 運用の区画（session-install の案内）が受け持つ |
| cc-sdd の導入：配置物や導入コマンドを変えたら `node bin/cc-sdd-bootstrap.mjs update` を実行してコミット、版を上げたら `poc/self-install/run.sh` で確かめる | `project-rules.md` | このリポジトリ固有。PoC のスクリプト名は実装後の名前に合わせる |
| ブランチ（BRW の宣言、push・PR・マージの許可） | `project-rules.md` | |
| 書き方（日本語、専門用語の言い換え） | `project-rules.md` | |
| 管理区画と `@.kiro/settings/cc-sdd-guide.md` の取り込み | 削除 | 標準の文書そのものが CLAUDE.md になる |

## 手順（installer-core と session-install の実装が済んでから）

1. **決まりを先に移す**: `project-rules.md` を作り、上の表の行き先どおりに中身を写してコミットする。CLAUDE.md が置き換わる前に済ませる（置き換わった後は作業ツリーから消え、git の履歴にしか残らない）。
2. **追跡を外す**: `git rm --cached CLAUDE.md` で追跡を外す（導入コマンドは git の操作をしない。要件 5.5 の案内に従い、人か指揮役が行う）。
3. **導入する**: `node bin/cc-sdd-bootstrap.mjs update` を実行する。`.gitignore` に CLAUDE.md・AGENTS.md が加わり、運用の区画の文章とフックの登録が揃う。続けて cc-sdd の導入（`install-cc-sdd` 相当）を実行し、CLAUDE.md・AGENTS.md が標準の文書＋運用の区画になることを確かめる。
4. **新しいセッションで確かめる**: 一時ディレクトリではなくこのリポジトリで `claude -p` を起動し、運用の区画が `project-rules.md` を読むよう案内していること、`/kiro-spec-status` がスキルとして動くことを確かめる。Codex でも同じことを確かめる（`$kiro-spec-status`）。
5. 手順 1〜3 の変更を 1 つのコミットにまとめる（途中の状態で別のセッションが始まると、古いフックか新しいフックのどちらかで CLAUDE.md が作り直されるため）。

## 注意

- **実装の途中は古い仕組みで動いている**: このリポジトリのフックは develop の旧実装（`install-cc-sdd.mjs`・`install-gate.mjs`）のまま。新しい導入の仕組みを実装しても、自己適用するまでこのリポジトリのセッションには効かない。実装中のテストは一時ディレクトリで行う。
- **自己適用の順序**: installer-core と session-install が揃えば自己適用できる。kiro-gate と subagent-delegation は、後から `update` を再実行して足す（運用の区画の文章が増えるだけ）。
- **CLAUDE.md の今の「子はすべて Codex」の決まり**: 自己適用までは今のまま守る（2026-11-23、利用者の指示で今は書き換えない）。
- **利用者の全体の指示（`~/.claude/CLAUDE.md`）は対象外**: このリポジトリの CLAUDE.md だけが置き換わる。
- **Codex の信頼の承認**: 自己適用で `.codex/hooks.json` が入ると、Codex での最初の利用時にフックの信頼の承認が要る。
