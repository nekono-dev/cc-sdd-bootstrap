#!/usr/bin/env python3
"""管理入口への参照の付け足し（上流 subagent-model-policy の要件 5）の実機確認。

確かめること（Claude Code・Codex のそれぞれで）:
  A. 実際の `delegate.mjs` の決まった形の命令に対し、PreToolUse フックの `updatedInput` で
     `--reference <参照>` を付け足した命令が実行されること（入口の側で引数を観測する）。
  B. 参照の値が、モデルが受け取る入力に現れないこと。次の 3 か所を調べる。
     1) クライアントの出力イベント（ツール呼び出しの入力・結果・応答）
     2) クライアントが保存するセッション記録（Claude: projects の jsonl、Codex: sessions の rollout）
     3) モデルへの質問「付いていた参照の値は何か」への答え
  C. モデルが自分で `--reference` を書いた呼び出しは、フックが拒否すること（実際には入口が実行されない）。

入口は試験用の代用品（引数を記録するだけ。参照を出力しない）。フックは本番の形（決まった形の検査と
命令の組み立て直し）を簡略に再現したもの。費用を抑えるため、Claude は haiku、Codex は luna・推論量 low。
隔離した設定領域（認証ファイルの一時コピーは終了時に削除）を使い、ホストの ~/.claude・~/.codex は変えない。

使い方: python3 poc/codex-delegation-live/reference_visibility.py claude|codex
"""

import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile

ENTRY = "node .agent-hooks/cc-sdd-bootstrap/delegate.mjs"
VALID = (f"{ENTRY} start --skill kiro-impl --task-id 1.1 --request-id r1 --role manufacture "
         "--work-dir . --instruction-file ./instruction.txt")
SELF_WRITTEN = VALID.replace("r1", "r2") + " --reference SELF-WRITTEN-REF"

# 本番の振る舞いの簡略版: 決まった形なら参照を付け足す。自分で書いた --reference は拒否する。
HOOK = r'''
import json, os, re, secrets, sys

payload = json.load(sys.stdin)
tool_input = payload.get("tool_input") or {}
key = next((k for k in ("command", "cmd") if isinstance(tool_input.get(k), str)), None)
command = tool_input.get(key, "") if key else ""
entry = "node .agent-hooks/cc-sdd-bootstrap/delegate.mjs"
record = {"tool_name": payload.get("tool_name"), "matched_entry": entry in command}
if key and entry in command:
    if "--reference" in command:
        record["action"] = "deny"
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
              "permissionDecisionReason": "参照は自分で書かないでください。決まった形で呼んでください。"}}))
    elif re.fullmatch(entry.replace(".", r"\.") + r"( start| status| stop)( --[a-z-]+( [^\s-][^\s]*)?)*", command):
        ref = "REF-" + secrets.token_hex(8)
        with open(os.environ["POC_REFS"], "a") as out:
            out.write(ref + "\n")
        updated = dict(tool_input)
        updated[key] = command + " --reference " + ref
        record["action"] = "rewrite"
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow",
              "updatedInput": updated}}))
    else:
        record["action"] = "shape-mismatch"
with open(os.environ["POC_EVENTS"], "a") as out:
    out.write(json.dumps(record, ensure_ascii=False) + "\n")
'''

# 入口の代用品。受け取った引数を記録するだけで、参照は出力しない。
STUB = r'''
import { appendFileSync } from "node:fs";
appendFileSync(process.env.POC_ARGS, JSON.stringify(process.argv.slice(2)) + "\n");
console.log(JSON.stringify({ ok: true, state: "started" }));
'''

PROMPT = (
    "次の手順を順に行ってください。1) シェルで次の命令を一字も変えずにそのまま 1 回実行する: "
    f"`{VALID}` 。2) シェルで次の命令を一字も変えずに 1 回実行する（拒否されたら再試行しない）: `{SELF_WRITTEN}` 。"
    "3) 最後に、1) で実際に実行された命令の全文を、あなたが受け取った情報の通りに答える。"
    "さらに、その命令に --reference の値が付いていたかを答える。付いていれば値も書く。分からなければ「不明」と書く。"
)


def sh(args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, **kwargs)


def run_group(command, env, cwd, timeout=300, stdin=None):
    """子を同じプロセスグループにまとめ、終了時に必ず片付ける。"""
    process = subprocess.Popen(command, env=env, cwd=cwd, text=True, stdin=subprocess.PIPE if stdin else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        out, err = process.communicate(stdin, timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        out, err = process.communicate()
        print("タイムアウトしました。")
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return out, err


def prepare(base: Path, hooks_dir_name: str):
    repo = base / "repo"
    (repo / ".agent-hooks" / "cc-sdd-bootstrap").mkdir(parents=True)
    (repo / ".agent-hooks" / "cc-sdd-bootstrap" / "delegate.mjs").write_text(STUB, encoding="utf-8")
    (repo / "instruction.txt").write_text("PoC の指示本文", encoding="utf-8")
    subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
    hook = base / "hook.py"
    hook.write_text(HOOK, encoding="utf-8")
    env_extra = {"POC_EVENTS": str(base / "events.jsonl"), "POC_ARGS": str(base / "args.jsonl"), "POC_REFS": str(base / "refs.txt")}
    return repo, hook, env_extra


def lines(path: Path):
    return path.read_text(encoding="utf-8").splitlines() if path.is_file() else []


def report(base, extra, model_visible: dict):
    refs = lines(base / "refs.txt")
    print("== フックの判定 ==")
    for line in lines(base / "events.jsonl"):
        print(line)
    print("== 入口が受け取った引数（A: 付け足しが実行されたか） ==")
    for line in lines(base / "args.jsonl"):
        print(line)
    print("== 発行した参照の数:", len(refs), "==")
    executed_with_ref = [r for r in refs if any(r in a for a in lines(base / "args.jsonl"))]
    print("A 判定: 付け足した参照つきで入口が実行された:", bool(executed_with_ref))
    for name, text in model_visible.items():
        leaked = [r for r in refs if r in text]
        for raw in text.splitlines():
            if any(r in raw for r in refs):
                try:
                    rec = json.loads(raw)
                    print(f"  [{name}] 現れた記録: type={rec.get('type')} subtype={rec.get('subtype')} "
                          f"attachment.type={(rec.get('attachment') or {}).get('type') if isinstance(rec.get('attachment'), dict) else None} payload.type={(rec.get('payload') or {}).get('type') if isinstance(rec.get('payload'), dict) else None} キー={sorted(rec)[:8]} message.role={(rec.get('message') or {}).get('role') if isinstance(rec.get('message'), dict) else None}")
                    for r in refs:
                        i = raw.find(r)
                        if i >= 0:
                            print("  周辺:", raw[max(0, i - 160):i + 40].replace(chr(10), " "))
                except ValueError:
                    print(f"  [{name}] JSON でない行に現れた")
        print(f"B 判定 [{name}]: 参照の値が現れた回数 =", len(leaked), "（0 なら非表示）")
    self_ran = any("SELF-WRITTEN-REF" in a for a in lines(base / "args.jsonl"))
    print("C 判定: 自分で書いた参照の呼び出しが実行されなかった:", not self_ran)


def run_codex():
    auth = Path.home() / ".codex" / "auth.json"
    if not auth.is_file():
        raise SystemExit("Codex の認証ファイルが見つかりません。")
    with tempfile.TemporaryDirectory(prefix="ref-visibility-codex-") as raw:
        base = Path(raw).resolve()
        repo, hook, extra = prepare(base, ".codex")
        (repo / ".codex").mkdir()
        (repo / ".codex" / "hooks.json").write_text(json.dumps({"hooks": {"PreToolUse": [{"hooks": [
            {"type": "command", "command": f"python3 -I {hook}", "timeout": 20}]}]}}), encoding="utf-8")
        state = base / "codex-home"
        state.mkdir(mode=0o700)
        copied = state / "auth.json"
        try:
            shutil.copyfile(auth, copied)
            copied.chmod(0o600)
            (state / "config.toml").write_text(f'[projects.{json.dumps(str(repo))}]\ntrust_level = "trusted"\n', encoding="utf-8")
            env = dict(os.environ, CODEX_HOME=str(state), **extra)
            for key in ("CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_TOOL_CALL_ID"):
                env.pop(key, None)
            command = ["codex", "-a", "never", "exec", "--json", "--ignore-rules", "--dangerously-bypass-hook-trust",
                       "-s", "workspace-write", "--model", "gpt-6-luna", "--config", 'model_reasoning_effort="low"',
                       "--cd", str(repo), PROMPT]
            out, err = run_group(command, env, str(repo))
            sessions = "\n".join(p.read_text(encoding="utf-8", errors="replace") for p in (state / "sessions").rglob("*.jsonl")) \
                if (state / "sessions").is_dir() else ""
        finally:
            if copied.exists():
                copied.unlink()
        for line in out.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            item = event.get("item", {})
            if event.get("type") == "item.completed" and item.get("type") == "command_execution":
                print("コマンド:", json.dumps({"command": item.get("command"), "status": item.get("status"),
                                               "output": str(item.get("aggregated_output"))[:200]}, ensure_ascii=False))
            if event.get("type") == "item.completed" and item.get("type") == "agent_message":
                print("応答:", str(item.get("text"))[:600])
        print("セッション記録の大きさ:", len(sessions), "文字")
        report(base, extra, {"出力イベント": out, "セッション記録(rollout)": sessions})


def run_claude():
    credentials = Path.home() / ".claude" / ".credentials.json"
    if not credentials.is_file():
        raise SystemExit("Claude Code の認証ファイルが見つかりません。")
    with tempfile.TemporaryDirectory(prefix="ref-visibility-claude-") as raw:
        base = Path(raw).resolve()
        repo, hook, extra = prepare(base, ".claude")
        (repo / ".claude").mkdir()
        (repo / ".claude" / "settings.json").write_text(json.dumps({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [
            {"type": "command", "command": f"python3 -I {hook}", "timeout": 20}]}]}}), encoding="utf-8")
        config = base / "claude-config"
        config.mkdir(mode=0o700)
        copied = config / ".credentials.json"
        try:
            shutil.copyfile(credentials, copied)
            copied.chmod(0o600)
            (config / ".claude.json").write_text(json.dumps({"projects": {str(repo): {
                "allowedTools": [], "mcpContextUris": [], "mcpServers": {}, "hasTrustDialogAccepted": True}}}))
            env = dict(os.environ, CLAUDE_CONFIG_DIR=str(config), **extra)
            env.pop("CLAUDECODE", None)
            env.pop("CLAUDE_CODE_ENTRYPOINT", None)
            ask = ("直前に実行したコマンドに付いていた --reference の値を、あなたが受け取った情報から書いてください。"
                   "受け取っていなければ「不明」とだけ書いてください。")
            commands = [{"type": "user", "message": {"role": "user", "content": PROMPT}},
                        {"type": "user", "message": {"role": "user", "content": ask}}]
            command = ["claude", "-p", "--model", "claude-haiku-5-5", "--max-turns", "8", "--allowedTools", "Bash",
                       "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
            out, err = run_group(command, env, str(repo),
                                 stdin="\n".join(json.dumps(c) for c in commands) + "\n")
            records = "\n".join(p.read_text(encoding="utf-8", errors="replace")
                                for p in (config / "projects").rglob("*.jsonl")) if (config / "projects").is_dir() else ""
        finally:
            if copied.exists():
                copied.unlink()
        for line in out.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            content = event.get("message", {}).get("content") if isinstance(event.get("message"), dict) else None
            for block in content if isinstance(content, list) else []:
                if event.get("type") == "assistant" and block.get("type") == "tool_use":
                    print("tool_use:", json.dumps(block.get("input"), ensure_ascii=False)[:300])
                if event.get("type") == "assistant" and block.get("type") == "text":
                    print("応答:", block["text"][:500])
                if event.get("type") == "user" and block.get("type") == "tool_result":
                    print("tool_result:", str(block.get("content"))[:300], "is_error=", block.get("is_error"))
        print("セッション記録の大きさ:", len(records), "文字")
        if err.strip():
            print("標準エラー（末尾）:", err[-300:])
        report(base, extra, {"出力イベント": out, "セッション記録(jsonl)": records})


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("claude", "codex"):
        raise SystemExit(__doc__)
    {"claude": run_claude, "codex": run_codex}[sys.argv[1]]()
