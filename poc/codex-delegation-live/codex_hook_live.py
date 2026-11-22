#!/usr/bin/env python3
"""Codex の PreToolUse フックの実機確認（A: 入力の書き換え、B: MCP ツール名と拒否）。

確かめること:
  A. シェル呼び出しの PreToolUse が返す `updatedInput` で、実行されるコマンドが書き換わるか。
  B. MCP ツール呼び出しが PreToolUse に `mcp__<サーバー>__<ツール>` の形で現れるか。
     `permissionDecision: deny` を返すと、MCP ツールが実行されずに拒否されるか。

費用を抑えるため、Codex は 1 回だけ起動する（gpt-6-luna・推論量 low・短い依頼）。
一時領域に作るもの: 作業リポジトリ（.codex/hooks.json と観測フック）、MCP 用の最小サーバー、
検証専用の CODEX_HOME（認証ファイルは ~/.codex/auth.json からコピーし、終了時に必ず削除する）。
ホストの ~/.codex や作業ツリーは変更しない。

使い方: python3 poc/codex-delegation-live/codex_hook_live.py
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile


# 観測と書き換えを行うフック。stdin の JSON を読み、イベントを追記する。
HOOK_SCRIPT = r'''
import json, os, sys

payload = json.load(sys.stdin)
tool_name = payload.get("tool_name")
tool_input = payload.get("tool_input")
record = {
    "event": payload.get("hook_event_name"),
    "tool_name": tool_name,
    "tool_input_type": type(tool_input).__name__,
    "tool_input_keys": sorted(tool_input) if isinstance(tool_input, dict) else None,
    "model": payload.get("model"),
    "turn_id_present": bool(payload.get("turn_id")),
}
with open(os.environ["CCSDD_POC_EVENTS"], "a", encoding="utf-8") as out:
    out.write(json.dumps(record, ensure_ascii=False) + "\n")

if str(tool_name).startswith("mcp__"):
    # B: 既定では MCP 呼び出しを拒否する。対照実験（--allow-mcp）では何も返さず通す。
    if os.environ.get("CCSDD_POC_MCP") == "deny":
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "CCSDD-POC-MCP-DENIED",
        }}))
elif isinstance(tool_input, dict):
    # A: シェル系の入力（command または cmd の文字列）の末尾に目印の引数を足す。
    key = next((k for k in ("command", "cmd") if isinstance(tool_input.get(k), str)), None)
    if key:
        updated = dict(tool_input)
        updated[key] = tool_input[key] + " CCSDD-POC-MARK"
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "updatedInput": updated,
        }}))
'''

# 最小の stdio MCP サーバー。ツールは ping の 1 つだけで、呼ばれた回数を記録ファイルに書く。
MCP_SCRIPT = r'''
import json, sys

LOG = sys.argv[1]


def send(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    message = json.loads(line)
    method = message.get("method")
    request_id = message.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": request_id, "result": {
            "protocolVersion": message.get("params", {}).get("protocolVersion", "2025-03-26"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "ccsddpoc", "version": "1"},
        }})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"tools": [{
            "name": "ping",
            "description": "PoC 用の疎通確認。PONG を返す。",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        }]}})
    elif method == "tools/call":
        with open(LOG, "a", encoding="utf-8") as out:
            out.write("called\n")
        send({"jsonrpc": "2.0", "id": request_id, "result": {
            "content": [{"type": "text", "text": "PONG"}], "isError": False}})
    elif request_id is not None:
        send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "method not found"}})
'''

PROMPT = (
    "次の 2 つだけを順に行い、結果を 1 行で答えてください。"
    "1) シェルで `echo hello` を実行する。"
    "2) MCP ツール ccsddpoc の ping を 1 回呼ぶ。"
    "どちらかが拒否されても再試行しないでください。"
)


def run_codex(repo, state, events, mcp_log, mcp_mode):
    env = dict(os.environ, CODEX_HOME=str(state), CCSDD_POC_EVENTS=str(events), CCSDD_POC_MCP=mcp_mode)
    for key in ("CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_TOOL_CALL_ID"):
        env.pop(key, None)
    command = [
        "codex", "-a", "never", "exec",
        "--json", "--ignore-rules", "--dangerously-bypass-hook-trust",
        "-s", "read-only", "--model", "gpt-6-luna",
        "--config", 'model_reasoning_effort="low"',
        "--cd", str(repo), PROMPT,
    ]
    # 子プロセスを同じプロセスグループにまとめ、終了時に残さない。
    # 標準入力は閉じる（指定しないと codex が追加入力を待つ警告を出す）。
    process = subprocess.Popen(command, env=env, text=True, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=240)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
        print("タイムアウトしました（240 秒）。")
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    print("codex の終了コード:", process.returncode)
    if stderr.strip():
        print("codex の標準エラー（末尾 300 文字）:", stderr[-300:])
    return stdout


def show_events(events):
    print("== 観測したフックのイベント ==")
    if not events.is_file():
        print("（フックは呼ばれなかった）")
        return
    for line in events.read_text(encoding="utf-8").splitlines():
        print(line)


def show_codex_items(stdout):
    print("== Codex の JSON イベント（要点） ==")
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        item = event.get("item", {})
        kind = item.get("type")
        if event.get("type") == "item.completed" and kind == "command_execution":
            print(json.dumps({"command": item.get("command"), "status": item.get("status"),
                              "exit_code": item.get("exit_code"),
                              "output": str(item.get("aggregated_output", ""))[:300]}, ensure_ascii=False))
        elif event.get("type") in ("item.completed", "item.started") and kind == "mcp_tool_call":
            print(json.dumps({"event": event.get("type"), "server": item.get("server"), "tool": item.get("tool"),
                              "status": item.get("status"), "error": str(item.get("error"))[:300]}, ensure_ascii=False))
        elif event.get("type") == "item.completed" and kind == "agent_message":
            print(json.dumps({"agent_message": str(item.get("text", ""))[:300]}, ensure_ascii=False))
        elif event.get("type") in ("error", "turn.failed"):
            print(json.dumps(event, ensure_ascii=False)[:500])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--allow-mcp", action="store_true",
                        help="対照実験: MCP 呼び出しを拒否せず通す（ping が実行されることを確かめる）")
    options = parser.parse_args()
    mcp_mode = "allow" if options.allow_mcp else "deny"
    if shutil.which("codex") is None:
        raise SystemExit("codex が見つかりません。")
    auth = Path.home() / ".codex" / "auth.json"
    if not auth.is_file():
        raise SystemExit("Codex の認証ファイルが見つかりません（内容は表示しない）。")

    with tempfile.TemporaryDirectory(prefix="codex-hook-live-") as raw:
        base = Path(raw).resolve()
        repo = base / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "--quiet", str(repo)], check=True)

        # 観測フックを作業リポジトリの .codex/hooks.json に登録する（前例: poc/subagent-model-policy）。
        hook = base / "observe_hook.py"
        hook.write_text(HOOK_SCRIPT, encoding="utf-8")
        hooks_dir = repo / ".codex"
        hooks_dir.mkdir()
        (hooks_dir / "hooks.json").write_text(json.dumps({"hooks": {"PreToolUse": [{"hooks": [
            {"type": "command", "command": f"python3 -I {hook}", "timeout": 20},
        ]}]}}), encoding="utf-8")

        mcp_dir = base / "mcp"
        mcp_dir.mkdir()
        mcp_script = mcp_dir / "ping_server.py"
        mcp_script.write_text(MCP_SCRIPT, encoding="utf-8")
        mcp_log = base / "mcp-called.log"
        events = base / "events.jsonl"

        # 検証専用の CODEX_HOME。認証ファイルだけコピーし、終了時に必ず削除する。
        state = base / "codex-home"
        state.mkdir(mode=0o700)
        copied = state / "auth.json"
        try:
            shutil.copyfile(auth, copied)
            copied.chmod(0o600)
            (state / "config.toml").write_text(
                f'[projects.{json.dumps(str(repo))}]\ntrust_level = "trusted"\n\n'
                # 承認は既定で承認済みにする（-a never では MCP に承認が要るため）。違いはフックの判定だけにする。
                f'[mcp_servers.ccsddpoc]\ncommand = "python3"\ndefault_tools_approval_mode = "approve"\n'
                f'args = ["-I", {json.dumps(str(mcp_script))}, {json.dumps(str(mcp_log))}]\n',
                encoding="utf-8")
            stdout = run_codex(repo, state, events, mcp_log, mcp_mode)
        finally:
            if copied.exists():
                copied.unlink()

        print("== 実行条件 ==", "MCP:", mcp_mode)
        show_events(events)
        show_codex_items(stdout)
        print("== MCP サーバーの呼び出し記録 ==")
        print("ping の実行回数:", mcp_log.read_text(encoding="utf-8").count("called") if mcp_log.is_file() else 0)


if __name__ == "__main__":
    main()
