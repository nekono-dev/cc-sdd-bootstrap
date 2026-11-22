#!/usr/bin/env python3
"""既存の Pi MCP と、認証不要の Codex モデルカタログの公開形式を確認する。"""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile


@contextmanager
def connect(command, cwd, env):
    with subprocess.Popen(
        command, cwd=cwd, env=env, text=True,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    ) as process, selectors.DefaultSelector() as ready:
        ready.register(process.stdout, selectors.EVENT_READ)
        next_id = 0

        def request(method, params=None, notification=False):
            nonlocal next_id
            next_id += 1
            message = {"jsonrpc": "2.0", "method": method}
            if params is not None:
                message["params"] = params
            if not notification:
                message["id"] = next_id
            process.stdin.write(json.dumps(message) + "\n")
            process.stdin.flush()
            if notification:
                return None
            while ready.select(timeout=12):
                line = process.stdout.readline()
                if not line:
                    break
                response = json.loads(line)
                if response.get("id") == next_id:
                    if "error" in response:
                        raise RuntimeError(f"{method}: エラーが返りました")
                    return response["result"]
            raise RuntimeError(f"{method}: 応答がありません")

        try:
            yield request
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()


def probe_pi():
    registration = json.loads(subprocess.check_output(
        ["codex", "mcp", "get", "pi-agent", "--json"], text=True,
    ))
    if not registration["enabled"]:
        raise RuntimeError("登録済みの pi-agent が無効です")
    transport = registration["transport"]
    if transport["type"] != "stdio":
        raise RuntimeError("この PoC は stdio の pi-agent を対象にしています")
    command = [transport["command"], *(transport.get("args") or [])]
    env = dict(os.environ, **(transport.get("env") or {}))
    with connect(command, transport.get("cwd") or Path.cwd(), env) as call:
        info = call("initialize", {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "clientInfo": {"name": "cc-sdd-delegation-probe", "version": "1"},
        })
        assert info["serverInfo"]["name"] == "pi-agent"
        call("notifications/initialized", notification=True)
        tools = {tool["name"] for tool in call("tools/list")["tools"]}
        assert {"pi_capabilities", "pi_models", "pi_start", "pi_status", "pi_cancel"} <= tools
        result = call("tools/call", {"name": "pi_capabilities", "arguments": {}})
        assert not result.get("isError")
        capabilities = result.get("structuredContent") or json.loads(result["content"][0]["text"])
        assert capabilities["kind"] == "agent" and capabilities["harness"] == "pi"
        result = call("tools/call", {"name": "pi_models", "arguments": {}})
        assert not result.get("isError")
        model_ids = result["structuredContent"]["result"]
        assert all(isinstance(model, str) for model in model_ids)
        print("Pi MCP:", json.dumps(capabilities), "受付モデル数:", len(model_ids))


def probe_codex():
    with tempfile.TemporaryDirectory(prefix="cc-sdd-codex-catalog-") as directory:
        with connect(["codex", "app-server"], directory, dict(os.environ, CODEX_HOME=directory)) as call:
            call("initialize", {"clientInfo": {"name": "cc-sdd-delegation-probe", "version": "1"}})
            call("initialized", notification=True)
            catalog = call("model/list", {"limit": 100})["data"]
            available = {
                item["model"]: [effort["reasoningEffort"] for effort in item["supportedReasoningEfforts"]]
                for item in catalog
                if item["model"] in {"gpt-6-luna", "gpt-6.1-sol"}
            }
            assert set(available) == {"gpt-6-luna", "gpt-6.1-sol"}
            assert all({"medium", "high"} <= set(levels) for levels in available.values())
            print("Codex:", json.dumps(available), "カタログ件数:", len(catalog))


def probe_managed_registration():
    with tempfile.TemporaryDirectory(prefix="cc-sdd-managed-mcp-") as directory:
        base = Path(directory)
        root = base / "repo with spaces"
        nested = root / "nested"
        nested.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", root], check=True)
        marker = base / "server-ran"
        server = root / ".agent-hooks" / "cc-sdd-bootstrap" / "probe.mjs"
        server.parent.mkdir(parents=True)
        server.write_text(
            'import { writeFileSync } from "node:fs";\n'
            'writeFileSync(process.env.CCSDD_MCP_MARKER, process.cwd());\n'
        )
        launch = (
            'repo_root="$(git rev-parse --show-toplevel)" && '
            'cd "$repo_root" && exec node .agent-hooks/cc-sdd-bootstrap/probe.mjs'
        )
        spec = {"mcpServers": {"cc-sdd-codex": {
            "type": "stdio", "command": "sh", "args": ["-c", launch],
            "env": {"CCSDD_MCP_MARKER": str(marker)},
        }}}
        (root / ".mcp.json").write_text(json.dumps(spec))
        config = base / "claude"
        config.mkdir()
        env = dict(os.environ, CLAUDE_CONFIG_DIR=str(config), CCSDD_MCP_MARKER=str(marker))
        env.pop("CLAUDECODE", None)
        env.pop("CLAUDE_CODE_ENTRYPOINT", None)
        result = subprocess.run(
            ["claude", "mcp", "get", "cc-sdd-codex"],
            cwd=root, env=env, text=True, capture_output=True, timeout=12,
        )
        assert result.returncode == 0 and "Pending approval" in result.stdout, result.stderr
        assert not marker.exists(), "未承認のサーバーが実行された"
        subprocess.run(["sh", "-c", launch], cwd=nested, env=env, check=True, timeout=10)
        assert marker.read_text() == str(root)
        print("Claude Code: 承認待ちでは未起動。固定ランチャーはサブディレクトリからルートで起動。")


if __name__ == "__main__":
    probe_pi()
    probe_codex()
    probe_managed_registration()
