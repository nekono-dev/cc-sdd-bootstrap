#!/usr/bin/env python3
"""認証済みの両クライアントで、サブエージェントの起動とフックの境界を調べる。"""

import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
from textwrap import dedent


CLAUDE_HOOK = '''
import json, os, sys
from pathlib import Path
payload = json.load(sys.stdin)
def models(path):
    if not path or not Path(path).is_file():
        return []
    values = []
    for line in Path(path).read_text().splitlines():
        try:
            event = json.loads(line)
            if event.get("type") == "assistant" and event.get("message", {}).get("model"):
                values.append(event["message"]["model"])
        except (ValueError, TypeError):
            pass
    return list(dict.fromkeys(values))
signal = payload.get("hook_event_name")
args = payload.get("tool_input", {})
with open(os.environ["ROLE_PROBE_EVENTS"], "a") as file:
    file.write(json.dumps({
        "event":signal, "tool":payload.get("tool_name"), "hook_model":payload.get("model"),
        "input_keys":list(args),
        "subagent_type":args.get("subagent_type"), "requested_model":args.get("model"),
        "requested_effort":args.get("effort"), "agent_type":payload.get("agent_type"),
        "parent_models":models(payload.get("transcript_path")),
        "child_models":models(payload.get("agent_transcript_path"))
    }) + "\\n")
if signal == "PreToolUse" and os.environ["ROLE_PROBE_MODE"] == "deny":
    print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse",
        "permissionDecision":"deny", "permissionDecisionReason":"CCSDD-POC-DENIED"}}))
'''

CODEX_HOOK = '''
import json, os, sys
from pathlib import Path
payload = json.load(sys.stdin)
args = payload.get("tool_input", {})
context = []
transcript = payload.get("transcript_path")
if transcript and Path(transcript).is_file():
    for line in Path(transcript).read_text().splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if row.get("type") == "turn_context":
            item = row.get("payload", {})
            context.append({k: item[k] for k in ("turn_id","model","effort","sandbox_policy","approval_policy","permission_profile") if k in item})
with open(os.environ["ROLE_PROBE_EVENTS"], "a") as file:
    file.write(json.dumps({"event":payload.get("hook_event_name"), "tool":payload.get("tool_name"), "parent_model":payload.get("model"),
        "turn_id":payload.get("turn_id"), "context":context[-1:],
        "permission_mode":payload.get("permission_mode"), "input_keys":list(args),
        "model_arg":args.get("model"), "effort_arg":args.get("reasoning_effort"), "fork_turns":args.get("fork_turns"), "fork_context":args.get("fork_context"),
        "agent_type":args.get("agent_type")}) + "\\n")
if str(payload.get("tool_name")).endswith("spawn_agent") and os.environ["ROLE_PROBE_MODE"] == "deny":
    print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse",
        "permissionDecision":"deny", "permissionDecisionReason":"CCSDD-POC-DENIED"}}))
'''


def probe_claude():
    for mode in ('allow', 'deny'):
        with tempfile.TemporaryDirectory(prefix='cc-sdd-claude-probe-') as target:
            repo = Path(target)
            hook = repo / 'observe.py'
            hook.write_text(CLAUDE_HOOK)
            events = repo / 'events.jsonl'
            cmd = f'python3 {shlex.quote(str(hook))}'
            settings = {
                'hooks': {
                    name: [{'matcher': 'Agent' if name == 'PreToolUse' else '', 'hooks': [
                        {'type': 'command', 'command': cmd},
                    ]}]
                    for name in ('SessionStart','PreToolUse','SubagentStart','SubagentStop')
                },
            }
            agents = {'cc-sdd-probe': {'description': 'An agent for recording a harmless PoC result.',
                'prompt': 'Answer with exactly CCSDD-PROBE-CHILD. Do not call any tools.',
                'model': 'haiku', 'effort': 'high', 'tools': []}}
            env = dict(os.environ, ROLE_PROBE_MODE=mode, ROLE_PROBE_EVENTS=str(events))
            env.pop('CLAUDECODE', None)
            env.pop('CLAUDE_CODE_ENTRYPOINT', None)
            run = subprocess.run(
                ['claude','-p','--model','sonnet','--effort','medium','--setting-sources','project',
                 '--strict-mcp-config','--settings',json.dumps(settings),'--agents',json.dumps(agents),
                 '--allowedTools','Agent','--output-format','stream-json','--verbose','--max-turns','3',
                 'Use the Agent tool with subagent_type cc-sdd-probe to ask it to output its marker, and include that marker in your answer. Use the agent default model and effort. If the tool is denied, report the reason and do not retry.'],
                cwd=repo, env=env, text=True, capture_output=True, timeout=50,
            )
            print('mode', mode, 'exit', run.returncode, flush=True)
            if events.exists():
                print(events.read_text(), end='', flush=True)
            for line in run.stdout.splitlines():
                try:
                    event = json.loads(line)
                    if event.get('type') == 'result':
                        print(json.dumps({'result': str(event.get('result',''))[:240], 'is_error': event.get('is_error'),
                          'model_ids': list(event.get('modelUsage', {}))}), flush=True)
                except ValueError:
                    pass
            if run.returncode:
                print(run.stderr[-350:], flush=True)


def probe_claude_switch():
    with tempfile.TemporaryDirectory(prefix='cc-sdd-claude-switch-') as dirname:
        root = Path(dirname)
        hooks = root / 'observe.py'
        log = root / 'events.jsonl'
        hooks.write_text(dedent('''
    import json, os, sys
    p = json.load(sys.stdin)
    keys = ("hook_event_name","model","from_model","to_model","requested_model","source")
    with open(os.environ["ROLE_PROBE_EVENTS"],"a") as out:
        print(json.dumps({k:p.get(k) for k in keys}),file=out)
    '''))
        settings = {'hooks': {
            event:[{'hooks':[{'type':'command','command':f'python3 {shlex.quote(str(hooks))}'}]}]
            for event in ('SessionStart','PreModelSwitch','PostModelSwitch')
        }}
        commands = [
            {'type':'control_request','request_id':'init','request':{'subtype':'initialize'}},
            {'type':'control_request','request_id':'switch','request':{'subtype':'set_model','model':'haiku'}},
            {'type':'user','message':{'role':'user','content':'Return exactly CCSDD-PROBE-SWITCH.'}},
        ]
        env = dict(os.environ, ROLE_PROBE_EVENTS=str(log))
        env.pop('CLAUDECODE', None)
        env.pop('CLAUDE_CODE_ENTRYPOINT', None)
        run = subprocess.run(
            ['claude','-p','--model','sonnet','--effort','medium','--setting-sources','project',
             '--strict-mcp-config','--settings',json.dumps(settings),
             '--input-format','stream-json','--output-format','stream-json','--verbose'],
            input='\n'.join(map(json.dumps,commands))+'\n', cwd=root, env=env, text=True,
            capture_output=True, timeout=45,
        )
        if log.exists():
            print(log.read_text(), end='')
        print('exit',run.returncode)
        for line in run.stdout.splitlines():
            e = json.loads(line)
            if e.get('type') == 'control_response':
                r=e.get('response',{})
                print(json.dumps({k:r.get(k) for k in ('subtype','request_id','error')}))
            if e.get('type') == 'result':
                print(json.dumps({'models':list(e.get('modelUsage',{})),'is_error':e.get('is_error')}))


def probe_codex():
    for mode in ('allow', 'deny'):
        with tempfile.TemporaryDirectory(prefix='cc-sdd-codex-probe-') as target:
            base = Path(target)
            repo = base / "repo"
            repo.mkdir()
            subprocess.run(['git','init','--quiet'], cwd=repo, check=True)
            settings = repo / '.codex'
            agents = settings / 'agents'
            agents.mkdir(parents=True)
            (agents / 'cc_sdd_probe.toml').write_text(
                'name = "cc_sdd_probe"\ndescription = "Record a harmless PoC marker."\n'
                'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n'
                'developer_instructions = "Answer CCSDD-PROBE-CHILD. Do not use tools."\n')
            hook = repo / 'observe.py'
            hook.write_text(CODEX_HOOK)
            events = repo / 'events.jsonl'
            (settings / 'hooks.json').write_text(json.dumps({'hooks': {event: [{
                'hooks':[{'type':'command','command':f'python3 {shlex.quote(str(hook))}'}],
            }] for event in ('SessionStart', 'PreToolUse')}}))
            state = base / 'isolated-codex'
            state.mkdir(mode=0o700)
            auth = Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / 'auth.json'
            if not auth.is_file():
                raise SystemExit('Codex の認証済みファイルが見つかりません。')
            # 認証済みの検証専用状態を作る。認証ファイルは作業先に入れず、内容も出力しない。
            shutil.copyfile(auth, state / 'auth.json')
            (state / 'auth.json').chmod(0o600)
            (state / 'config.toml').write_text(f'[projects.{json.dumps(str(repo))}]\ntrust_level = "trusted"\n')
            env = dict(os.environ, ROLE_PROBE_MODE=mode, ROLE_PROBE_EVENTS=str(events), CODEX_HOME=str(state))
            for key in ('CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID'):
                env.pop(key, None)
            run = subprocess.run(
                ['codex','-a','never','-c',f'projects.{json.dumps(str(repo))}.trust_level="trusted"',
                 '--disable','multi_agent_v2','--dangerously-bypass-hook-trust','exec','--ignore-rules',
                 '-s','read-only','-m','gpt-6.1-sol','--json',
                 'Use spawn_agent once with agent_type cc_sdd_probe and fork_turns none (do not fork history) to request the marker CCSDD-PROBE-CHILD. Use model gpt-6-luna and reasoning_effort high if the tool exposes them. '
                 'If started, use wait_agent and report the result. If denied, report the reason and do not retry.'],
                cwd=repo, env=env, text=True, capture_output=True, timeout=55,
            )
            print('mode', mode, 'exit', run.returncode, flush=True)
            if events.exists():
                print(events.read_text(), end='', flush=True)
            for file in (state / 'sessions').rglob('*.jsonl'):
                for line in file.read_text().splitlines():
                    row = json.loads(line)
                    if row.get('type') == 'turn_context':
                        config = row.get('payload', {})
                        print(json.dumps({'observed_config': {k: config[k] for k in ('model','effort','reasoning_effort','model_reasoning_effort','sandbox_policy') if k in config}}))
                        break
            for line in run.stdout.splitlines():
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                item = event.get('item', {})
                if item.get('type') in ('agent_message','collab_tool_call','error') and event.get('type') == 'item.completed':
                    print(json.dumps(item)[:1250], flush=True)
                elif event.get('type') in ('error','turn.failed'):
                    print(json.dumps(event)[:1000], flush=True)
            if run.returncode:
                print(run.stderr[-550:], flush=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("client", choices=("claude", "codex"), help="確認するクライアント")
    client = parser.parse_args().client
    if client == "claude":
        probe_claude()
        probe_claude_switch()
    else:
        probe_codex()


if __name__ == "__main__":
    main()
