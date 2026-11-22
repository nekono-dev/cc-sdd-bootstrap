#!/usr/bin/env python3
"""6.1 の Claude Code 実機確認。一時プロジェクトに導入し、承認待ち・承認後の再探査・通常作業・cc-sdd 作業中の直接起動の拒否・ネイティブ経路を確かめる。

費用を抑えるため、親は claude-haiku-5-5、ネイティブの子は定義どおり claude-sonnet-5-5（1 回の短い依頼）だけを使う。
Claude Code の設定は隔離した CLAUDE_CONFIG_DIR（認証情報のコピーだけを入れ、終了時に削除）を使い、ホストの ~/.claude を変えない。
実行: python3 poc/codex-delegation-live/claude_live.py <一時作業ディレクトリ>
"""

import base64
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BOOTSTRAP = REPO / "bin" / "cc-sdd-bootstrap.mjs"
SERVER = "cc-sdd-codex"
TOOL = f"mcp__{SERVER}__codex_start"
PROBE_ARGS = {"cwd": "/nonexistent-probe-dir", "model": "probe-unknown-model", "effort": "off", "access": "read-only", "instruction": "probe"}
INIT_FLAGS = ["--clients", "claude", "--codex", "yes", "--cc-sdd-version", "3.1.0", "--lang", "ja", "--keep-templates", "no",
              "--claude-models", "manufacture=claude-sonnet-5-5", "--claude-models", "review=claude-sonnet-5-5",
              "--claude-models", "design=claude-sonnet-5-5", "--claude-models", "research=claude-sonnet-5-5",
              "--claude-models", "debug=claude-sonnet-5-5",
              "--effort", "manufacture=high", "--effort", "review=medium", "--effort", "design=high",
              "--effort", "research=medium", "--effort", "debug=high"]


def sh(args, cwd, env=None, timeout=300, stdin=None):
    return subprocess.run(args, cwd=cwd, env=env, input=stdin, text=True, capture_output=True, timeout=timeout)


def init_project(root: Path, name: str, codex: str) -> Path:
    project = root / name
    project.mkdir()
    sh(["git", "init", "-q", str(project)], cwd=project)
    sh(["git", "config", "user.email", "probe@example.invalid"], cwd=project)
    sh(["git", "config", "user.name", "probe"], cwd=project)
    flags = [f for f in INIT_FLAGS]
    flags[flags.index("--codex") + 1] = codex
    result = sh(["node", str(BOOTSTRAP), "init", *flags], cwd=project, timeout=420)
    if result.returncode:
        raise SystemExit(f"導入に失敗しました: {result.stderr[-400:]}")
    return project


def isolated_config(root: Path, credentials: Path) -> Path:
    config = root / "claude-config"
    config.mkdir(mode=0o700)
    shutil.copyfile(credentials, config / ".credentials.json")
    (config / ".credentials.json").chmod(0o600)
    return config


def approve(config: Path, project: Path):
    """承認と信頼を、Claude Code が対話で記録するのと同じ projects 記録へ書く（隔離設定の中だけ）。"""
    path = config / ".claude.json"
    data = json.loads(path.read_text()) if path.exists() else {}
    entry = data.setdefault("projects", {}).setdefault(str(project), {"allowedTools": [], "mcpContextUris": [], "mcpServers": {}})
    entry["hasTrustDialogAccepted"] = True
    entry["enabledMcpjsonServers"] = [SERVER]
    path.write_text(json.dumps(data))


def claude_env(config: Path) -> dict:
    env = dict(os.environ, CLAUDE_CONFIG_DIR=str(config))
    env.pop("CLAUDECODE", None)
    env.pop("CLAUDE_CODE_ENTRYPOINT", None)
    return env


def mcp_status(config: Path, project: Path) -> str:
    result = sh(["claude", "mcp", "list"], cwd=project, env=claude_env(config), timeout=150)
    line = next((item for item in result.stdout.splitlines() if item.startswith(f"{SERVER}:")), "")
    return line.rsplit(" - ", 1)[-1] if " - " in line else (result.stderr[-200:] or "行が見つからない")


def run_turns(config: Path, project: Path, turns: list, model="claude-haiku-5-5", allowed=None, max_turns=10):
    """同じセッションで複数のユーザー発言を順に送り、ツール呼び出しと結果を要約する。"""
    commands = [
        {"type": "control_request", "request_id": "init", "request": {"subtype": "initialize"}},
        {"type": "control_request", "request_id": "switch", "request": {"subtype": "set_model", "model": model}},
    ]
    commands += [{"type": "user", "message": {"role": "user", "content": text}} for text in turns]
    args = ["claude", "-p", "--model", "claude-sonnet-5-5", "--max-turns", str(max_turns),
            "--allowedTools", *(allowed or ["Bash", "Read", "Agent", "ToolSearch", TOOL]),
            "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
    result = sh(args, cwd=project, env=claude_env(config), timeout=320, stdin="\n".join(json.dumps(c) for c in commands) + "\n")
    summary = []
    for line in result.stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "assistant":
            for block in event["message"]["content"]:
                if block.get("type") == "tool_use":
                    summary.append({"tool_use": block["name"], "input_head": json.dumps(block.get("input"), ensure_ascii=False)[:160]})
        if event.get("type") == "user":
            for block in event["message"]["content"] if isinstance(event["message"]["content"], list) else []:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    content = block.get("content")
                    text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
                    summary.append({"tool_result_is_error": block.get("is_error"), "text": text[:220]})
    return {"exit": result.returncode, "events": summary}


def run_resumable(config: Path, project: Path, text: str, resume=None):
    """-p で 1 回のターンを送る。--resume を付けると同じセッションへ戻す。返り値は (セッション ID, 要約)。"""
    args = ["claude", "-p", "--model", "claude-haiku-5-5", "--max-turns", "6",
            "--allowedTools", "Bash", "Read", "Agent", "ToolSearch", TOOL,
            "--output-format", "stream-json", "--verbose", *(["--resume", resume] if resume else []), text]
    result = sh(args, cwd=project, env=claude_env(config), timeout=320)
    session, summary = None, []
    for line in result.stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "system" and event.get("subtype") == "init":
            session = event.get("session_id")
        if event.get("type") == "result":
            # 終了の種類と、エラーがあればその内容を残す（ツールが呼ばれなかった理由の切り分けに使う）
            summary.append({"result_subtype": event.get("subtype"), "is_error": event.get("is_error"),
                            "errors": event.get("errors"), "text": str(event.get("result", ""))[:220]})
        if event.get("type") == "assistant":
            for block in event["message"]["content"]:
                if block.get("type") == "tool_use":
                    summary.append({"tool_use": block["name"]})
        if event.get("type") == "user" and isinstance(event["message"].get("content"), list):
            for block in event["message"]["content"]:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    content = block.get("content")
                    text_out = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
                    summary.append({"tool_result_is_error": block.get("is_error"), "text": text_out[:220]})
    return session, {"exit": result.returncode, "stderr_tail": result.stderr[-200:], "events": summary}


def patch_gate_for_experiment(project: Path, enabled: bool):
    """試験用の一時プロジェクトのコピーだけ、管理委任の有効状態を書き換える。リポジトリの定義は変えない。"""
    gate = project / ".agent-hooks/cc-sdd-bootstrap/delegation-mcp-gate.mjs"
    text = gate.read_text()
    old, new = ("enabled: false", "enabled: true") if enabled else ("enabled: true", "enabled: false")
    gate.write_text(text.replace('claude: Object.freeze({ ' + old, 'claude: Object.freeze({ ' + new, 1))


def main():
    root = Path(sys.argv[1]).resolve()
    credentials = Path.home() / ".claude" / ".credentials.json"
    results = {}

    # 導入（MCP の承認待ちを確かめるため --codex yes）
    project = init_project(root, "mcp-project", "yes")
    config = isolated_config(root, credentials)
    results["pending_before_approval"] = mcp_status(config, project)
    approve(config, project)
    results["after_approval_reprobe"] = mcp_status(config, project)

    # 通常作業（gate は既定の無効のまま）。cc-sdd 作業外では MCP の起動ツールは拒否されない。
    results["normal_work_default_gate"] = run_turns(config, project, [
        f"Call the tool {TOOL} exactly once with arguments {json.dumps(PROBE_ARGS)}. Do not call any other tool. Then report the tool result in one short line."])

    # 試験用のコピーだけ gate を有効にして、cc-sdd 作業中の直接起動を確かめる
    patch_gate_for_experiment(project, enabled=True)
    results["normal_work_gate_enabled"] = run_turns(config, project, [
        f"Call the tool {TOOL} exactly once with arguments {json.dumps(PROBE_ARGS)}. Do not call any other tool. Then report the tool result in one short line."])
    explicit = f"/kiro-impl probe-feature 1.1 Call the tool {TOOL} exactly once with arguments {json.dumps(PROBE_ARGS)}. Do not call any other tool. Report the outcome in one short line."
    natural = (f"tasks.md の 1.1 を kiro-impl の手順で進めたい。まず .claude/skills/kiro-impl/SKILL.md を Read して手順を確認し、"
               f"その後で {TOOL} を {json.dumps(PROBE_ARGS)} で 1 回だけ呼ぶ。拒否されたら理由を一行で答える。")
    results["explicit_kiro_impl_gate_enabled"] = run_turns(config, project, [explicit])
    results["natural_start_gate_enabled"] = run_turns(config, project, [natural])
    # 同じセッションで cc-sdd 作業（1 回目）のあとに、通常の依頼（--resume で同じセッション、2 回目）へ戻したとき拒否されないこと
    session, first = run_resumable(config, project, explicit)
    results["return_to_normal_same_session"] = {"turn1_cc_sdd": first, "turn2_normal": run_resumable(config, project, (
        f"This is a normal request, not cc-sdd work. Call {TOOL} exactly once with arguments {json.dumps(PROBE_ARGS)} and report the tool result in one short line."), resume=session)[1]}
    patch_gate_for_experiment(project, enabled=False)

    # ネイティブ経路（外部 MCP を置かない構成）。管理入口を飛ばした組み込みネイティブの直接起動、事前確認の単独発行を確かめる。
    native = init_project(root, "native-project", "no")
    b64 = base64.urlsafe_b64encode(json.dumps({"requestId": "probe-native-1", "role": "review", "readOnly": True, "toolName": "Agent",
                                                "toolInput": {"subagent_type": "cc-sdd-review", "description": "probe",
                                                              "prompt": "Reply with exactly PROBE-NATIVE-OK. Do not use tools."}}).encode()).decode().rstrip("=")
    native_prompt = (f"/kiro-impl probe-native 1.1 Do these steps in order, one tool call each, and report each step's outcome in one short line. "
                     f"(1) Call the Agent tool with subagent_type \"cc-sdd-review\", description \"probe\", prompt \"Reply with exactly PROBE-NATIVE-OK. Do not use tools.\" (no preflight yet). "
                     f"(2) Run this exact Bash command: node .agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs preflight kiro-impl {b64} "
                     f"(3) Call the Agent tool again with exactly the same arguments as step (1).")
    results["native_direct_and_standalone_preflight"] = run_turns(config, native, [native_prompt], allowed=["Bash", "Agent"], max_turns=12)
    reference_prompt = ("/kiro-impl probe-native 2.1 Run this exact Bash command and report its full output: "
                        "node .agent-hooks/cc-sdd-bootstrap/kiro-delegation-context.mjs enter kiro-impl "
                        "Then say whether the output contains a --reference value (answer yes or no).")
    results["entry_reference_visible_to_model"] = run_turns(config, native, [reference_prompt], allowed=["Bash"], max_turns=6)

    # 隔離設定を消す（認証情報のコピーを残さない）
    shutil.rmtree(config, ignore_errors=True)
    print(json.dumps(results, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
