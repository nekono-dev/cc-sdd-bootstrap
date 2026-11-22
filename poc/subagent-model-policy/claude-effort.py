#!/usr/bin/env python3
"""模擬 API で Claude Code が送る親と子の推論量を確認する。"""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tempfile
from threading import Thread

requests = []
class Model(BaseHTTPRequestHandler):
    def do_POST(self):
        args = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        model = args.get('model')
        requests.append({'endpoint':self.path.split('?')[0], 'model':model, 'effort':(args.get('output_config') or {}).get('effort')})
        if self.path.split('?')[0] != '/v1/messages':
            self.send_error(404)
            return
        child = 'haiku' in model
        messages = args.get('messages', [])
        returning = any(
            item.get('type') == 'tool_result'
            for item in (messages[-1].get('content') or [])
            if isinstance(item, dict)
        )
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        def send(kind, **body):
            body.update(type=kind)
            self.wfile.write(('event: ' + kind + '\ndata: ' + json.dumps(body) + '\n\n').encode())
        send('message_start', message={'id':'msg_poc','type':'message','role':'assistant','model':model,'content':[],
            'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':1,'output_tokens':0}})
        if child or returning:
            send('content_block_start',index=0,content_block={'type':'text','text':''})
            send('content_block_delta',index=0,delta={'type':'text_delta','text':'CCSDD-PROBE-CHILD'})
            stop = 'end_turn'
        else:
            send('content_block_start',index=0,content_block={'type':'tool_use','id':'toolu_poc',
                'name':'Agent','input':{}})
            send('content_block_delta',index=0,delta={'type':'input_json_delta','partial_json':json.dumps(
                {'description':'Check the marker','prompt':'Return the marker only.','subagent_type':'cc-sdd-probe'})})
            stop = 'tool_use'
        send('content_block_stop',index=0)
        send('message_delta',delta={'stop_reason':stop,'stop_sequence':None},usage={'output_tokens':1})
        send('message_stop')

server = ThreadingHTTPServer(('127.0.0.1',0),Model)
Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix='cc-sdd-claude-effort-') as ctx:
        cwd=Path(ctx)
        env=dict(os.environ, CLAUDE_CONFIG_DIR=str(cwd/'config'),
            ANTHROPIC_BASE_URL=f'http://127.0.0.1:{server.server_port}',
            ANTHROPIC_API_KEY='poc-placeholder', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1')
        for name in ('CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_EFFORT_LEVEL'):
            env.pop(name,None)
        agents={'cc-sdd-probe':{'description':'Mark whether the child ran.',
            'prompt':'Return the marker.', 'model':'haiku', 'effort':'high'}}
        run=subprocess.run(['claude','-p','--model','sonnet','--effort','medium','--setting-sources','project',
            '--strict-mcp-config','--agents',json.dumps(agents),'--allowedTools','Agent',
            '--output-format','json','--max-turns','3','Use cc-sdd-probe only.'],
            text=True,capture_output=True,timeout=25,env=env,cwd=cwd)
        print('exit',run.returncode)
        print(json.dumps(requests))
        if run.returncode:
            print(run.stderr[-360:])
        assert run.returncode == 0, run.stderr[-360:]
        assert any(r['model'] and 'sonnet' in r['model'] and r['effort'] == 'medium' for r in requests)
        assert any(r['model'] and 'haiku' in r['model'] and r['effort'] == 'high' for r in requests)
finally:
    server.shutdown()
