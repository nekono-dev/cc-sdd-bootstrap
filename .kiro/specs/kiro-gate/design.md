# 設計文書: kiro-gate

> 改訂（2026-11-23）: 単純化後の要件に合わせて書き直した。旧版は git の履歴にある。

## Overview

**Purpose**: `/kiro-*`（Codex では `$kiro-*` も）で始めた依頼で、対応する手順書（SKILL.md）を読むまで、他の作業ツールを拒否する。Claude Code と Codex に同じ規則を適用し、自然文の依頼には対応表の文章で適切なスキルを促す。

**Users**: cc-sdd-bootstrap を導入したリポジトリで、Claude Code または Codex を指揮役にして開発する人。

**Impact**: 新しいフックのスクリプトを 1 つ足し、運用の区画に対応表を足す。

### Goals
- 明示した `/kiro-*` では、エージェントが手順書を読む前に作業を始められない。
- 判定できないときに通常の作業を止めない。
- 状態をリポジトリに残さず、セッションをまたいで持ち越さない。

### Non-Goals
- 自然文の依頼への機械的な強制、手順書が無いときの停止、成果物・承認状態の検査、開始時の通知。
- 子のモデルの判定（subagent-delegation）。

## Boundary Commitments

### This Spec Owns
- `kiro-gate.mjs`（4 つのフックの入口と状態の読み書き）と `kiro-gate-rules.mjs`（純粋な判断と文言）。
- 先読みの状態（OS の一時ディレクトリの下。リポジトリの外）。
- カタログの kiro-gate の項目（スクリプト・両ツールの 4 つのフック・運用の区画の `kiro-gate` の文章と対応表）。

### Out of Boundary
- 導入と導入未完了の停止（session-install）。
- フックの登録・運用の区画の組み立て（installer-core）。
- 子の起動のモデルの確認（subagent-delegation。同じ PreToolUse の時点で別のスクリプトとして動く）。

### Allowed Dependencies
- Node.js 22 の標準モジュール。`lib/` と他の配置物のスクリプトは読み込まない。
- 依存の向き: `kiro-gate-rules`（純粋）→ `kiro-gate`（入出力と入口）。
- 前提: 手順書の場所は session-install の導入物（Claude Code は `.claude/skills/<名前>/SKILL.md`、Codex は `.agents/skills/<名前>/SKILL.md`）。

### Revalidation Triggers
- 手順書の置き場所の変更（session-install・cc-sdd の版）。
- フックの入力の形の変更（Claude Code・Codex の版）。PoC を再実行する。
- 拒否の出力の形の変更 → 同じ時点の subagent-delegation のフックとの関係を見直す。

## Architecture

### Architecture Pattern & Boundary Map

```mermaid
graph TB
    Prompt[UserPromptSubmit] --> Gate[kiro-gate entry]
    Pre[PreToolUse] --> Gate
    Post[PostToolUse] --> Gate
    Stop[Stop] --> Gate
    Gate --> Rules[kiro-gate-rules]
    Gate --> State[state file in os tmpdir]
    Gate --> Skill[SKILL md existence]
```

- 状態のキー: `sha256(<根の絶対の道筋> + "\0" + <session_id>)`。根は `kiro-gate.mjs` の位置から求め（`../..`）、入力の `cwd` は使わない（3.5・3.6）。
- 状態の置き場所: `<os.tmpdir()>/cc-sdd-bootstrap-kiro-gate/<キー>.json`（3.4）。

### Technology Stack

| Layer | Choice / Version | Role in Feature | Notes |
|-------|------------------|-----------------|-------|
| 実行 | Node.js 22（`.mjs`） | フック | 標準モジュールだけ |
| フック | Claude Code・Codex の UserPromptSubmit・PreToolUse・PostToolUse・Stop | 検出・拒否・記録・終了の停止 | 登録は installer-core |

## File Structure Plan

### Directory Structure
```
.agent-hooks/cc-sdd-bootstrap/
├── kiro-gate.mjs           # 入口: 標準入力の JSON を読み、状態を読み書きし、判断を出力する
└── kiro-gate-rules.mjs     # 純粋: コマンドの検出、手順書の道筋、許可の判断、読み取りの判定、文言
test/
├── kiro-gate-rules.test.mjs  # 規則の単体試験
└── kiro-gate.test.mjs        # 一時ディレクトリと標準入力での入口の試験
```

### Modified Files
- `lib/catalog.mjs` — kiro-gate の項目を足す（下の「カタログの項目」）。
- `package.json` — `files` に 2 つのスクリプトを足す。
- `poc/kiro-gate/run.sh` — 実装後の確認に、配置したスクリプトを使う形を足す（Claude Code）。Codex は `poc/req-feasibility/codex.sh` の c・d・e を流用する。

## System Flows

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Unread: kiro コマンドで始まる入力 かつ 手順書がある
    Unread --> Unread: 手順書以外のツール 拒否
    Unread --> Read: 手順書の読み取りの成功を観測
    Unread --> StopBlocked: 終了 1 回目 止める
    StopBlocked --> Read: 手順書の読み取りの成功を観測
    StopBlocked --> Idle: 終了 2 回目 通す
    Read --> Idle: ターンの終わり
    Unread --> Idle: kiro コマンドで始まらない入力
    Read --> Unread: 次の kiro コマンドの入力
    Read --> Idle: kiro コマンドで始まらない入力
```

- `StopBlocked` でもツールの拒否は続く（2.3）。2 回目の終了は通し、状態を消す（2.7）。
- 新しい `/kiro-*` の入力は、前の状態を引き継がずに上書きする（1.4）。

## Requirements Traceability

| Requirement | Summary | Components | Interfaces | Flows |
|-------------|---------|------------|------------|-------|
| 1.1 | 先頭の `/kiro-*`・`$kiro-*` で手順書を対象に | Rules, Gate | `detectCommand` `skillPath` | Idle→Unread |
| 1.2 | 直後が空白か末尾のときだけ | Rules | `detectCommand` | — |
| 1.3 | 先頭以外の言及は対象外 | Rules | `detectCommand` | — |
| 1.4 | 次の依頼は引き継がない | Gate | 状態の上書き | Read→Unread |
| 1.5 | `/kiro-*` で始まらない入力で解除 | Gate | 状態の削除 | →Idle |
| 2.1 | 手順書の場所と先に読む指示を渡す | Rules, Gate | `messageAdditionalContext` | — |
| 2.2 | 手順書の読み取りと探す操作は通す | Rules | `decidePreToolUse` | — |
| 2.3 | それ以外は拒否し理由を示す | Rules | `decidePreToolUse` `messageDeny` | Unread |
| 2.4 | 読み取りの成功で読み取り済み | Rules, Gate | `isSkillRead` | Unread→Read |
| 2.5 | 読み取り済みなら拒否しない | Rules | `decidePreToolUse` | Read |
| 2.6 | 未読の終了を 1 回止める | Rules, Gate | `decideStop` | Unread→StopBlocked |
| 2.7 | 2 回目は止めない | Rules | `decideStop` | StopBlocked→Idle |
| 3.1 | 判定できなければ止めない | Gate | 例外時は出力なし | — |
| 3.2 | 予期しない誤りは日本語で確認できる | Gate | 標準エラー | — |
| 3.3 | 手順書が無ければ独自に止めない | Gate | 状態を作らない | — |
| 3.4 | 状態をリポジトリに残さない | Gate | `statePath` | — |
| 3.5 | 別のリポジトリ・セッションに適用しない | Gate | 状態のキー | — |
| 3.6 | 作業ディレクトリの変更で取り違えない | Gate | 根はスクリプトの位置から | — |
| 4.1 | 対応表を両文書の区画に | カタログの項目 | `agentSections.kiro-gate` | — |
| 4.2 | 表に該当すれば手順書を読んで実行 | カタログの項目 | 同上 | — |
| 4.3 | ツールごとの手順書の読み方 | カタログの項目 | 同上 | — |
| 4.4 | 判断できなければ尋ねる | カタログの項目 | 同上 | — |
| 4.5 | `/kiro-*` では読むまで拒否される旨 | カタログの項目 | 同上 | — |
| 4.6 | AGENTS.md の未承認時の先読みの指示 | カタログの項目（Codex の文章） | 同上 | — |
| 4.7 | 自然文では止めない | Gate | 自然文は状態を消すだけ | →Idle |

## Components and Interfaces

| Component | Domain/Layer | Intent | Req Coverage | Key Dependencies | Contracts |
|-----------|--------------|--------|--------------|------------------|-----------|
| Rules（`kiro-gate-rules.mjs`） | 純粋 | 検出・判断・文言 | 1.1–1.3, 2.1–2.7 | なし | Service |
| Gate（`kiro-gate.mjs`） | 入出力・入口 | 入力の読み取り、状態の読み書き、出力 | 1.4, 1.5, 2.4, 3.1–3.6, 4.7 | Rules (P0) | Event, State |
| カタログの項目 | データ | スクリプト・フック・区画の文章 | 4.1–4.6 | installer-core の Catalog (P0) | State |

### Rules

```typescript
type Tool = "claude" | "codex";
type GateState = { skill: string; skillPath: string; read: boolean; stopBlocked: boolean };

function detectCommand(prompt: string): string | null;
// 先頭の空白を除き、/^[\/$](kiro-[a-z0-9-]+)(?=\s|$)/ に合えば "kiro-xxx"（1.1–1.3）。Claude Code でも $ の形を受け付ける（害が無いため）
function skillPath(tool: Tool, skill: string): string;
// claude: .claude/skills/<skill>/SKILL.md、codex: .agents/skills/<skill>/SKILL.md（根からの相対）

type ToolCall = { toolName: string; toolInput: Record<string, unknown> };
function decidePreToolUse(state: GateState | null, call: ToolCall, root: string): { allow: true } | { allow: false; reason: string };
// state が無い・read が真 → allow（2.5）
// 未読のとき allow: Claude Code の Read で file_path が手順書（絶対の道筋で比べる）、ToolSearch（ツールを探す操作）
//                    Codex の Bash で command に手順書の相対の道筋を含む（2.2）
// それ以外 → 拒否。理由は messageDeny（2.3）
function isSkillRead(state: GateState, call: ToolCall & { toolResponse: unknown }, root: string): boolean;
// decidePreToolUse で手順書の読み取りとして通す条件と同じで、tool_response が誤りを示さないこと（2.4）
function decideStop(state: GateState | null, stopHookActive: boolean): { block: true; reason: string } | { block: false };
// state があり、未読で、stopBlocked でも stopHookActive でもなければ止める（2.6）。それ以外は通す（2.7）

function messageAdditionalContext(state: GateState): string;  // 手順書の場所と、作業の前に読んで手順に従う旨（2.1）
function messageDeny(state: GateState): string;              // 読むべき手順書の場所と、先に読む必要（2.3）
function messageStop(state: GateState): string;              // 同上（2.6）
```
- Codex のまとめたコマンド（`cat SKILL.md && 別のコマンド`）は、手順書の道筋を含むので通り、読んだ扱いになる。コマンドの解析はしない（厳密さのためにコードを増やさない）。

### Gate

##### Event Contract
- 起動: `node <根>/.agent-hooks/cc-sdd-bootstrap/kiro-gate.mjs <user-prompt-submit|pre-tool-use|post-tool-use|stop> --tool <claude|codex>`（コマンドの形は installer-core）。
- 入力: 標準入力の JSON（`session_id`・`prompt`・`tool_name`・`tool_input`・`tool_response`・`stop_hook_active`）。
- 出力:
  - UserPromptSubmit: 対象が決まれば状態を書き、`hookSpecificOutput.additionalContext` に `messageAdditionalContext`。`/kiro-*` で始まらない、または手順書が無い（3.3）なら状態を消し、何も出さない（1.5・4.7）。
  - PreToolUse: 拒否なら `hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason }`。それ以外は何も出さない。
  - PostToolUse: `isSkillRead` なら状態の `read` を真にする。何も出さない。
  - Stop: 止めるなら `{ decision: "block", reason }` を出し `stopBlocked` を真にする。通すときは状態を消す。
- 例外・判定できない入力（`session_id` が無い、JSON でないなど）: 標準エラーに日本語で理由を出し、何も出力せず終了 0（3.1・3.2）。
- 両ツールで出力の形は同じ（PoC で確認）。

##### State Management
- 置き場所とキーは Architecture のとおり。書き込みは一時ファイルに書いて名前を変える。
- 同じセッションの中のフックは順に呼ばれる前提（1 つのセッションの中で並行に書かない）。

### カタログの項目（installer-core の `lib/catalog.mjs` に足す）
- `files`: `kiro-gate.mjs`・`kiro-gate-rules.mjs`。
- `hooks`（`tools: ["claude", "codex"]`、`script: "kiro-gate.mjs"`、引数は `[<イベント>, "--tool", <ツール>]`。ツールごとに別の項目にする）:
  - UserPromptSubmit（timeout 10 秒。session-install の項目の後）、PreToolUse（matcher なし＝すべてのツール、10 秒）、PostToolUse（matcher なし、10 秒）、Stop（10 秒）。
- `agentSections` の `kiro-gate`（両ツールで同じ内容。Codex にだけ 4.6 の一文）:
  - 要件 4.1 の対応表（依頼の種類 → 使うスキル）。
  - 表に該当する依頼は `/kiro-*` で始まっていなくても、対応する手順書を読んで手順を最後まで実行する（4.2）。
  - 手順書の読み方: Claude Code は `.claude/skills/<スキル名>/SKILL.md`、Codex は `.agents/skills/<スキル名>/SKILL.md` を直接読む（4.3）。
  - 依頼の種類を判断できなければ、スキルを使うか利用者に尋ねる（4.4）。
  - `/kiro-*`（Codex は `$kiro-*`）で始めた依頼では、フックが有効なら手順書を読むまで他の作業ツールが拒否される（4.5）。
  - Codex の文章だけ: フックの信頼が承認されていない環境でも、作業の前に対応する手順書を読む（4.6）。

## Error Handling
- 判定できない入力・状態の読み書きの失敗・予期しない例外: 通す（出力なし、終了 0）。理由は標準エラーに日本語で出す（3.1・3.2）。
- 手順書が無い: 状態を作らず通す（3.3）。導入の失敗は session-install が止める。

## Testing Strategy
- **単体（Rules）**:
  - `detectCommand`: `/kiro-spec-init x`・`  $kiro-impl`・`/kiro-steering` を検出、`/kiro-specx` の途中一致や `文中の /kiro-impl` は検出しない（1.1–1.3）。
  - `decidePreToolUse`: 未読で Claude Code の手順書の Read と ToolSearch は通し、Bash・Edit・別のファイルの Read・Agent は拒否して理由に道筋を含む。Codex は `cat .agents/skills/<名前>/SKILL.md` を通し、他の Bash を拒否（2.2・2.3）。読み取り済みなら通す（2.5）。
  - `isSkillRead`: 誤りの応答では読んだ扱いにしない（2.4）。
  - `decideStop`: 未読の 1 回目は止め、`stopBlocked` または `stop_hook_active` なら通す（2.6・2.7）。
- **入口（一時ディレクトリ、標準入力）**: UserPromptSubmit → PreToolUse 拒否 → PostToolUse で読み取り → PreToolUse 通過、の一連。次の `/kiro-*` で未読に戻る、自然文で解除（1.4・1.5・4.7）。手順書が無いと状態を作らない（3.3）。別の `session_id`・別の根の状態を使わない（3.5）。`cwd` を変えても同じ根を使う（3.6）。状態がリポジトリの中に作られない（3.4）。壊れた JSON の入力で出力なし・終了 0・標準エラーに理由（3.1・3.2）。
- **カタログの試験**: 対応表の行が要件 4.1 と同じ、Codex の文章にだけ 4.6 の一文がある。
- **実機（PoC 済み）**: Claude Code は `poc/kiro-gate/run.sh`、Codex は `poc/req-feasibility/codex.sh`（c・d・e）。実装後は配置したスクリプトで同じ確認を行う。
