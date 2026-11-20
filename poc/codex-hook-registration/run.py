#!/usr/bin/env python3
"""認証やモデル呼び出しなしで Codex の登録と信頼の前提を確認する。"""

import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile


def list_hooks(repo, state, cwd):
    tool_env = dict(os.environ, CODEX_HOME=str(state))
    with subprocess.Popen(
        ["codex", "app-server"], cwd=repo, env=tool_env, text=True,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    ) as server, selectors.DefaultSelector() as monitor:
        monitor.register(server.stdout, selectors.EVENT_READ)

        def request(message):
            server.stdin.write(json.dumps(message) + "\n")
            server.stdin.flush()
            if "id" not in message:
                return None
            while monitor.select(timeout=10):
                line = server.stdout.readline()
                if not line:
                    break
                response = json.loads(line)
                if response.get("id") == message["id"]:
                    if "error" in response:
                        raise RuntimeError(response["error"])
                    return response["result"]
            raise RuntimeError("Codex app-server から応答がありません")

        try:
            request({"id": 0, "method": "initialize", "params": {
                "clientInfo": {"name": "installer-core-poc", "version": "1"},
            }})
            request({"method": "initialized"})
            return request({"id": 1, "method": "hooks/list", "params": {
                "cwds": [str(cwd)],
            }})["data"][0]
        finally:
            server.kill()


def main():
    with tempfile.TemporaryDirectory(prefix="codex-hook-registration-") as raw:
        base = Path(raw).resolve()
        repo = base / "repo with spaces"
        subdir = repo / "src"
        subdir.mkdir(parents=True)
        state = base / "codex-probe-state"
        state.mkdir()
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        project = repo / ".codex"
        project.mkdir()
        hooks = project / "hooks.json"
        script = repo / ".agent-hooks" / "cc-sdd-bootstrap" / "probe.mjs"
        script.parent.mkdir(parents=True)
        script.write_text('console.log("hook-probe")\n', encoding="utf-8")
        command = (
            'repo_root="$(git rev-parse --show-toplevel)" && '
            'node "$repo_root/.agent-hooks/cc-sdd-bootstrap/probe.mjs" '
            '# cc-sdd-bootstrap:managed'
        )

        def write_json(hook_command):
            hooks.write_text(json.dumps({"description": "登録の検証", "hooks": {
                "SessionStart": [{"hooks": [
                    {"type": "command", "command": hook_command, "timeout": 10},
                ]}],
            }}), encoding="utf-8")

        def trust(value):
            (state / "config.toml").write_text(
                f'[projects.{json.dumps(str(repo))}]\ntrust_level = "{value}"\n',
                encoding="utf-8",
            )

        write_json(command)
        trust("untrusted")
        assert not list_hooks(repo, state, repo)["hooks"]
        print("OK 未信頼のプロジェクトでは登録が見えない")

        trust("trusted")
        root = list_hooks(repo, state, repo)
        assert not root.get("errors"), root
        (registered,) = root["hooks"]
        assert registered["eventName"] == "sessionStart", root
        assert registered["command"] == command, root
        assert registered["trustStatus"] == "untrusted", root
        print("OK hooks.json 単体で登録され、個別の承認が保留になる")

        (nested,) = list_hooks(repo, state, subdir)["hooks"]
        assert nested["currentHash"] == registered["currentHash"], nested
        shell = subprocess.run(
            ["sh", "-c", command], cwd=subdir, check=True, text=True, capture_output=True,
        )
        assert shell.stdout.strip() == "hook-probe", shell.stdout
        print("OK サブディレクトリから同じ登録が見え、登録コマンドでルートのスクリプトを呼べる")

        (project / "config.toml").write_text(
            '[[hooks.UserPromptSubmit]]\n[[hooks.UserPromptSubmit.hooks]]\n'
            'type = "command"\ncommand = "printf user-hook"\n',
            encoding="utf-8",
        )
        both = list_hooks(repo, state, subdir)
        assert not both.get("errors"), both
        assert {h["command"] for h in both["hooks"]} == {command, "printf user-hook"}, both
        print("OK hooks.json と config.toml の登録が共存する")

        updated_command = command.replace(" #", " updated #")
        write_json(updated_command)
        changed = list_hooks(repo, state, repo)
        new = next(h for h in changed["hooks"] if h["command"] == updated_command)
        assert new["currentHash"] != registered["currentHash"], new
        assert new["trustStatus"] == "untrusted", new
        print("OK コマンド変更時は承認判定のハッシュが変わる")


if __name__ == "__main__":
    main()
