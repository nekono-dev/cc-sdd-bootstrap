#!/usr/bin/env python3
"""6.2 の Pi 実機確認。登録済みの pi-agent（stdio）に直接接続し、権限・推論量・書き込み先を確かめる。

費用は掛からない。Ollama のローカルモデル（既定 leeplenty/forgotten-safeword:12b。deepseek-coder-v2:16b は tools 非対応、qwen3-coder:30b と qwen2.5-coder:32b は編集の呼び出しを構造化せず書けなかったため、書き込みが確認できたモデルを使う）を使う。
実行: python3 poc/codex-delegation-live/pi_live.py <一時作業ディレクトリ>
一時作業ディレクトリは呼び出し側が mktemp -d で作る（リポジトリの中には置かない）。
"""

import json
import os
import selectors
import subprocess
import sys
import time
from pathlib import Path

PI_COMMAND = ["/home/ubuntu/.local/share/ollama-mcp/venv/bin/python", "/home/ubuntu/.local/share/pi-agent/pi_mcp.py"]
MODEL = os.environ.get("PI_LIVE_MODEL", "leeplenty/forgotten-safeword:12b")
POLL_LIMIT_SECONDS = 420


class PiClient:
    """stdio の JSON-RPC を 1 本の接続で扱う。ジョブの状態照会は同じ接続で行う。"""

    def __init__(self):
        self.process = subprocess.Popen(PI_COMMAND, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True)
        self.ready = selectors.DefaultSelector()
        self.ready.register(self.process.stdout, selectors.EVENT_READ)
        self.next_id = 0

    def request(self, method, params=None, notification=False, timeout=180):
        message = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        if not notification:
            self.next_id += 1
            message["id"] = self.next_id
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()
        if notification:
            return None
        while self.ready.select(timeout=timeout):
            line = self.process.stdout.readline()
            if not line:
                break
            response = json.loads(line)
            if response.get("id") == self.next_id:
                return response
        raise RuntimeError(f"{method}: 応答がありません")

    def tool(self, name, arguments):
        response = self.request("tools/call", {"name": name, "arguments": arguments})
        result = response.get("result", {})
        if "error" in response:
            return {"isError": True, "error": response["error"]}
        text = result.get("content", [{}])[0].get("text", "")
        return {"isError": bool(result.get("isError")), "text": text,
                "structured": result.get("structuredContent")}

    def close(self):
        try:
            self.process.stdin.close()
            self.process.wait(timeout=5)
        except Exception:
            self.process.kill()


def tool_events(events_text):
    """ジョブログの JSON 行から、ツール実行の開始・終了を名前と結果の先頭だけで要約する。"""
    summary = []
    for line in events_text.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "tool_execution_start":
            summary.append({"event": "start", "tool": event.get("toolName")})
        elif event.get("type") == "tool_execution_end":
            result = json.dumps(event.get("result", ""), ensure_ascii=False)
            summary.append({"event": "end", "tool": event.get("toolName"), "isError": event.get("isError"), "result": result[:160]})
    return summary


def wait_finished(client, job_id):
    deadline = time.time() + POLL_LIMIT_SECONDS
    while time.time() < deadline:
        status = client.tool("pi_status", {"job_id": job_id, "tail_chars": 64000})
        payload = json.loads(status["text"]) if status.get("text") else {}
        if payload.get("status") == "finished":
            return payload
        time.sleep(3)
    return {"status": "timeout"}


def start(client, **arguments):
    result = client.tool("pi_start", arguments)
    if result["isError"]:
        return {"started": False, "reason": result.get("text") or result.get("error")}
    return {"started": True, "job": json.loads(result["text"])}


def main():
    work = Path(sys.argv[1]).resolve()
    (work / "read-only-dir").mkdir(parents=True, exist_ok=True)
    (work / "write-dir").mkdir(parents=True, exist_ok=True)
    client = PiClient()
    client.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                  "clientInfo": {"name": "cc-sdd-live-probe", "version": "1"}})
    client.request("notifications/initialized", notification=True)
    observations = {}

    capabilities = client.tool("pi_capabilities", {})
    observations["capabilities"] = json.loads(capabilities["text"])
    models = client.tool("pi_models", {})
    observations["model_count"] = len(models["structured"]["result"])
    observations["model_listed"] = MODEL in models["structured"]["result"]

    # 1. 読み取り専用: 書き込みを依頼しても、作業先にファイルが増えないことを確かめる
    ro_dir = work / "read-only-dir"
    started = start(client, instruction="Use the write tool to create a file named probe.txt in the current directory whose content is PROBE. If the write tool is not available, say so.",
                    cwd=str(ro_dir), model=MODEL, access="read-only", thinking="off")
    if started["started"]:
        final = wait_finished(client, started["job"]["job_id"])
        observations["read_only"] = {"status": final.get("status"), "exit_code": final.get("exit_code"),
                                     "files_after": sorted(p.name for p in ro_dir.iterdir()),
                                     "tool_events": tool_events(final.get("events", ""))}
    else:
        observations["read_only"] = started

    # 2. 書き込み許可: 一時作業先の中のファイルを作れることを確かめる。
    # モデルはツールを呼ばずに本文だけ返すことがあるため、最大 3 回まで試し、試行ごとの結果を残す。
    write_dir = work / "write-dir"
    attempts = []
    for _ in range(3):
        out = write_dir / "out.txt"
        out.unlink(missing_ok=True)
        started = start(client, instruction="Create a file named out.txt in the current directory whose content is exactly PI-WRITE-OK. Use the write tool.",
                        cwd=str(write_dir), model=MODEL, access="workspace-write", thinking="off")
        if not started["started"]:
            attempts.append(started)
            break
        final = wait_finished(client, started["job"]["job_id"])
        attempts.append({"status": final.get("status"), "exit_code": final.get("exit_code"),
                         "out_exists": out.exists(),
                         "out_content": out.read_text(errors="replace")[:80] if out.exists() else None,
                         "tool_events": tool_events(final.get("events", ""))})
        if out.exists():
            break
    observations["workspace_write"] = {"attempts": attempts, "succeeded": any(a.get("out_exists") for a in attempts)}

    # 3. 要求推論量に合わない構成は起動前に拒否される（現行 Pi は off のみ）
    observations["refuse_thinking_medium"] = start(client, instruction="probe", cwd=str(write_dir), model=MODEL,
                                                   access="workspace-write", thinking="medium")
    # 4. 受付モデル外は起動前に拒否される
    observations["refuse_unknown_model"] = start(client, instruction="probe", cwd=str(write_dir),
                                                 model="probe-unknown-model", access="workspace-write", thinking="off")
    # 5. 権限の列挙外（read-only でも workspace-write でもない値）は引数の検証で拒否される
    observations["refuse_unknown_access"] = start(client, instruction="probe", cwd=str(write_dir), model=MODEL,
                                                  access="shell", thinking="off")
    client.close()
    print(json.dumps(observations, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
