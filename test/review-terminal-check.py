import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import sqlite3
import struct
import subprocess
import tempfile
import termios
import time


ROOT = Path(__file__).resolve().parents[1]
SERVER = r'''
import http from 'node:http';
import {appendFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {WebSocketServer} = await import(pathToFileURL(process.env.FAKE_WS));
const server = http.createServer();
const wss = new WebSocketServer({server});
let reviewers = 0;
let turns = 0;
const threads = [{id:'dev-1', cwd:process.env.FAKE_REPO, name:'Backend', updatedAt:1, status:{type:'idle'}},
  {id:'new-dev', cwd:process.env.FAKE_REPO, name:'New coding', updatedAt:1, status:{type:'idle'}}];
wss.on('connection', ws => ws.on('message', raw => {
  const req = JSON.parse(raw.toString());
  if (req.id == null) return;
  let result;
  if (req.method === 'initialize') result = {};
  else if (req.method === 'config/read') result = {config:{mcp_servers:{serein:{args:[process.env.FAKE_MCP], env:{SEREIN_HOME:process.env.SEREIN_HOME, SEREIN_CODEX_SOCKET:process.env.FAKE_SOCKET}, default_tools_approval_mode:'approve'}}}};
  else if (req.method === 'thread/list') result = {data:threads, nextCursor:null};
  else if (req.method === 'thread/loaded/list') result = {data:threads.map(thread => thread.id)};
  else if (req.method === 'thread/read') result = {thread:threads.find(thread => thread.id === req.params.threadId)};
  else if (req.method === 'thread/turns/list') result = {data:[{id:`turn-${turns}`,status:'inProgress'}],nextCursor:null};
  else if (req.method === 'thread/start') {
    appendFileSync(process.env.FAKE_EVENTS, JSON.stringify(req) + '\n');
    const thread = {id:`review-${++reviewers}`,cwd:req.params.cwd,name:'Reviewer',updatedAt:2,status:{type:'idle'}};
    threads.push(thread); result = {thread};
  } else if (req.method === 'turn/start') {
    appendFileSync(process.env.FAKE_EVENTS, JSON.stringify(req) + '\n');
    result = {turn:{id:`turn-${++turns}`,status:'inProgress'}};
  } else { ws.send(JSON.stringify({id:req.id,error:{message:`Unsupported ${req.method}`}})); return; }
  ws.send(JSON.stringify({id:req.id,result}));
}));
server.listen(process.env.FAKE_SOCKET);
'''


def drain(master, seconds=.08):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
        if not ready:
            break
        try:
            os.read(master, 65536)
        except OSError:
            break


with tempfile.TemporaryDirectory(prefix='anle-review-terminal-', dir='/tmp') as directory:
    work = Path(directory)
    repo = work / 'backend'
    repo.mkdir()
    subprocess.run(['git', '-C', str(repo), 'init', '-q'], check=True)
    (repo / 'auth.js').write_text('export const auth = false;\n')
    subprocess.run(['git', '-C', str(repo), 'add', 'auth.js'], check=True)
    subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'initial'], check=True)
    (repo / 'auth.js').write_text('export const auth = true;\n')
    (repo / 'new.js').write_text('export const added = true;\n')
    tmux_temp = work / 'tmux'
    tmux_temp.mkdir()
    fake_bin = work / 'bin'
    fake_bin.mkdir()
    fake_codex = fake_bin / 'codex'
    fake_codex.write_text('#!/bin/sh\ncase " $* " in *" queue "*) printf "%s\\n" "$@" >> "$SEREIN_FAKE_LOG"; echo queued; exit 0;; esac\nprintf "%s\\n" "$@" >> "$SEREIN_RESUME_LOG"\nprintf "FAKE CODEX %s\\n" "$2"\nexec cat\n')
    fake_codex.chmod(0o755)
    server_file = work / 'server.mjs'
    server_file.write_text(SERVER)
    env = {**os.environ, 'CODEX_HOME': str(work / 'codex-home'), 'SEREIN_HOME': str(work / 'state'),
           'SEREIN_CODEX_SOCKET': str(work / 'app.sock'), 'FAKE_SOCKET': str(work / 'app.sock'),
           'FAKE_WS': str(ROOT / 'node_modules/ws/wrapper.mjs'), 'FAKE_MCP': str(ROOT / 'src/mcp-server.js'),
           'FAKE_EVENTS': str(work / 'events.jsonl'), 'FAKE_REPO': str(repo), 'SEREIN_FAKE_LOG': str(work / 'queue.log'), 'SEREIN_RESUME_LOG': str(work / 'resume.log'),
           'TMUX_TMPDIR': str(tmux_temp), 'TERM': 'xterm-256color', 'FORCE_COLOR': '2',
           'PATH': f'{fake_bin}:{os.environ["PATH"]}'}
    for name in ('TMUX', 'TMUX_PANE', 'SEREIN_UI'):
        env.pop(name, None)
    setup = """import {Store} from './src/store.js';
      const store = new Store();
      store.addMember('default', {threadId:'dev-1', name:'backend', cwd:process.env.FAKE_REPO});
      store.addMember('default', {threadId:'other', name:'other', cwd:process.env.FAKE_REPO});
      store.close();"""
    subprocess.run(['node', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', setup], cwd=ROOT, env=env, check=True)
    server = subprocess.Popen(['node', str(server_file)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    master = proc = socket = db = None
    try:
        deadline = time.monotonic() + 5
        while not (work / 'app.sock').exists() and time.monotonic() < deadline:
            time.sleep(.02)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
        proc = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'bin/serein.js'], cwd=ROOT, env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
        os.close(slave)

        def until(predicate, label, timeout=8):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                drain(master, .03)
                if predicate():
                    return
            try:
                captured = sidebar() if socket else ''
            except (NameError, subprocess.CalledProcessError):
                captured = ''
            raise AssertionError(f'{label}\n{captured}')

        def find_socket():
            matches = [path for path in tmux_temp.glob(f'tmux-*/serein-{proc.pid}-*') if path.is_socket()]
            return matches[0].name if matches else None

        until(lambda: find_socket(), 'private tmux server did not start')
        socket = find_socket()
        def tmux(*args):
            return subprocess.run(['tmux', '-L', socket, *args], env=env, check=True, capture_output=True, text=True).stdout.strip()
        def panes_started():
            try:
                return len(tmux('list-panes', '-t', 'workspace:0').splitlines()) == 2
            except subprocess.CalledProcessError:
                return False
        until(panes_started, 'panes did not start')
        left = tmux('list-panes', '-t', 'workspace:0', '-F', '#{pane_id}').splitlines()[0]
        def sidebar(): return tmux('capture-pane', '-p', '-t', left)
        def native_pane(): return tmux('list-panes', '-t', 'workspace:0', '-F', '#{pane_id}').splitlines()[1]
        def screen(): return tmux('capture-pane', '-p', '-t', native_pane())
        def send(data):
            os.write(master, data)
            drain(master)
        def events():
            return [json.loads(line) for line in (work / 'events.jsonl').read_text().splitlines()] if (work / 'events.jsonl').exists() else []
        def call_mcp(name, args, thread):
            requests = [
                {'jsonrpc':'2.0', 'id':1, 'method':'initialize', 'params':{'protocolVersion':'2025-03-26'}},
                {'jsonrpc':'2.0', 'id':2, 'method':'tools/call', 'params':{'name':name, 'arguments':args, '_meta':{'threadId':thread}}},
            ]
            result = subprocess.run(['node', '--disable-warning=ExperimentalWarning', str(ROOT / 'src/mcp-server.js')], cwd=ROOT, env=env,
                                    input=''.join(json.dumps(item) + '\n' for item in requests), text=True, capture_output=True, timeout=15, check=True)
            return next(item['result'] for item in map(json.loads, result.stdout.splitlines()) if item.get('id') == 2)

        until(lambda: 'backend CR' in sidebar() and 'other CR' in sidebar(), 'existing coding sessions did not receive their dedicated CRs')
        for _ in range(4):
            send(b'\x1b[B')
        until(lambda: '▸ other CR' in sidebar(), 'dedicated reviewer did not become selected')
        send(b'\x0b')
        until(lambda: 'REVIEW GOAL' in sidebar(), 'review shortcut on a CR did not target its coding session')
        send(b'\x1b')
        for _ in range(3):
            send(b'\x1b[A')
        until(lambda: '▸ backend' in sidebar(), 'developer did not become selected')
        send(b'\x19')
        until(lambda: 'WORKSPACE REVIEW RULES' in sidebar(), 'workspace review rules did not open')
        send(b'Check shared auth helpers')
        send(b'\r')
        until(lambda: 'rules saved' in sidebar(), 'workspace review rules were not saved')
        send(b'\x0b')
        until(lambda: 'REVIEW GOAL' in sidebar(), 'review shortcut did not open')
        send(b'Review login safety')
        send(b'\r')
        until(lambda: 'BASE REF' in sidebar(), 'base step did not open')
        send(b'\r')
        until(lambda: 'PATHS' in sidebar(), 'path step did not open')
        send(b'\r')
        db = sqlite3.connect(f'file:{work / "state/serein.sqlite"}?mode=ro', uri=True)
        def reviews(): return db.execute('SELECT id, reviewer_id, status, current_round FROM reviews').fetchall()
        until(lambda: reviews() and reviews()[0][2:] == ('running', 1), 'first review did not start')
        review_id, reviewer_id, _, _ = reviews()[0]
        assert reviewer_id == 'review-1'
        until(lambda: 'backend CR' in sidebar(), 'reviewer did not join the workspace')
        first = db.execute('SELECT snapshot_path FROM review_rounds WHERE review_id=? AND round=1', (review_id,)).fetchone()[0]
        assert Path(first, 'auth.js').read_text() == 'export const auth = true;\n'
        assert Path(first, 'new.js').read_text() == 'export const added = true;\n'
        send(b'\x1b[B')
        send(b'\x1b[B')
        until(lambda: '▸ backend CR' in sidebar() and 'FAKE CODEX review-1' in screen(), 'native reviewer session did not open')
        resume_log = (work / 'resume.log').read_text()
        reviewer_resume = resume_log.split('resume\nreview-1\n', 1)[1].split('resume\n', 1)[0]
        assert '--sandbox\nread-only\n' in reviewer_resume, 'native reviewer did not retain its read-only policy'
        assert f'--cd\n{first}\n' in reviewer_resume or f'--cd\n{repo}\n' in reviewer_resume, 'native reviewer used an unrelated directory'
        send(b'\x1b[A')
        send(b'\x1b[A')
        until(lambda: '▸ backend' in sidebar(), 'could not return to the developer')
        thread_start = next(event for event in events() if event['method'] == 'thread/start')
        assert thread_start['params']['sandbox'] == 'read-only'
        first_turn = next(event for event in events() if event['method'] == 'turn/start')
        assert first_turn['params']['sandboxPolicy']['type'] == 'readOnly'
        assert first_turn['params']['cwd'] == first, 'snapshot review turn used the wrong working directory'
        assert 'existing implementations and project conventions' in first_turn['params']['input'][0]['text']
        assert 'Check shared auth helpers' in first_turn['params']['input'][0]['text']

        submitted = call_mcp('submit_review', {'space_id':'default', 'review_id':review_id, 'round':1, 'summary':'Authentication needs work',
            'checked':['auth.js'], 'unverified':['integration'], 'findings':[{'severity':'P1', 'title':'Missing validation', 'path':'auth.js', 'line':1, 'detail':'The handler accepts invalid input.'}]}, reviewer_id)
        assert not submitted.get('isError'), submitted
        result = json.loads(submitted['content'][0]['text'])
        assert result['result']['freshness'] == 'current'
        assert result['deliveries']['developer']['state'] in ('queued', 'sending')
        until(lambda: db.execute("SELECT state FROM review_notifications WHERE review_id=? AND round=1 AND recipient_id='dev-1'", (review_id,)).fetchone()[0] == 'queued', 'review result was not queued to the developer')
        until(lambda: '1 NEW' in sidebar(), 'human did not receive the review')
        send(b'\x0e')
        until(lambda: 'REVIEW · Review login safety' in screen(), 'review notification did not reach the inbox')
        send(b'\r')
        until(lambda: 'Authentication needs work' in screen() and 'F1 [P1]' in screen(), 'review findings did not reach the inbox')
        assert 'Authentication needs work' in (work / 'queue.log').read_text()

        send(b'\x1b[17~')
        send(b'\x1b[B')
        until(lambda: '▸ backend' in sidebar(), 'could not return to developer')
        (repo / 'auth.js').write_text('export const auth = "fixed";\n')
        until(lambda: db.execute('SELECT status FROM reviews WHERE id=?', (review_id,)).fetchone()[0] == 'waiting', 'review result was not saved')
        send(b'\x0b')
        until(lambda: 'Review again' in sidebar(), 're-review menu did not open')
        send(b'r')
        until(lambda: db.execute('SELECT status, current_round FROM reviews WHERE id=?', (review_id,)).fetchone() == ('running', 2), 'second round did not start')
        second = db.execute('SELECT snapshot_path FROM review_rounds WHERE review_id=? AND round=2', (review_id,)).fetchone()[0]
        assert Path(first, 'auth.js').read_text() == 'export const auth = true;\n'
        assert Path(second, 'auth.js').read_text() == 'export const auth = "fixed";\n'
        all_events = events()
        assert len([event for event in all_events if event['method'] == 'thread/start']) == 2
        turns = [event for event in all_events if event['method'] == 'turn/start']
        assert len(turns) == 2 and turns[1]['params']['threadId'] == reviewer_id
        assert 'F1 [P1] open auth.js:1' in turns[1]['params']['input'][0]['text']
        (repo / 'auth.js').write_text('export const auth = "changed again";\n')
        submitted = call_mcp('submit_review', {'space_id':'default', 'review_id':review_id, 'round':2, 'summary':'Validation added',
            'findings':[{'id':'F1', 'status':'resolved', 'reason':'The new version validates input.'}]}, reviewer_id)
        assert not submitted.get('isError'), submitted
        assert json.loads(submitted['content'][0]['text'])['result']['freshness'] == 'stale'
        details = call_mcp('get_review', {'space_id':'default', 'review_id':review_id}, 'dev-1')
        assert len(json.loads(details['content'][0]['text'])['rounds']) == 2
        assert call_mcp('get_review', {'space_id':'default', 'review_id':review_id}, 'other').get('isError')
        next_round = call_mcp('request_review', {'space_id':'default', 'review_id':review_id}, 'dev-1')
        assert not next_round.get('isError'), next_round
        assert json.loads(next_round['content'][0]['text'])['round'] == 3
        assert len([event for event in events() if event['method'] == 'thread/start']) == 2
        assert Path(repo, 'auth.js').read_text() == 'export const auth = "changed again";\n'

        peers = call_mcp('list_members', {'space_id':'default'}, 'dev-1')
        members = json.loads(peers['content'][0]['text'])['members']
        assert next(item for item in members if item['id'] == 'dev-1')['reviewer']['id'] == reviewer_id
        sent = call_mcp('send_message', {'space_id':'default', 'to':'backend CR', 'message':'Review the login change.', 'reply_expected':True,
            'review_context':{'project_background':'Shared login service', 'base_branch':'main', 'development_branch':'feature/login'}}, 'dev-1')
        assert not sent.get('isError'), sent
        sent_id = json.loads(sent['content'][0]['text'])['id']
        queued_text = (work / 'queue.log').read_text()
        assert 'Project background: Shared login service' in queued_text and 'Base branch/ref: main' in queued_text
        assert 'Development branch/ref: feature/login' in queued_text and '--sandbox\nread-only\n' in queued_text
        response = call_mcp('reply_message', {'space_id':'default', 'reply_to':sent_id, 'message':'Found an auth regression.'}, reviewer_id)
        assert not response.get('isError'), response
        assert json.loads(response['content'][0]['text'])['human_delivery']['state'] == 'delivered'
        assert db.execute("SELECT count(*) FROM messages WHERE recipient_id='human' AND body='Found an auth regression.'").fetchone()[0] == 1

        send(b'\x1b[17~')
        send(b'\x01')
        until(lambda: 'SELECT SESSION' in sidebar(), 'session picker did not open')
        send(b'/')
        send(b'New coding')
        send(b'\r')
        until(lambda: 'New coding' in sidebar(), 'new coding session did not appear')
        send(b'\r')
        until(lambda: 'NAME THIS SESSION' in sidebar(), 'session name prompt did not appear')
        for _ in 'New coding':
            send(b'\x7f')
        send(b'mobile')
        send(b'\r')
        until(lambda: 'ROLE / DESCRIPTION' in sidebar(), 'session role prompt did not appear')
        send(b'\r')
        until(lambda: db.execute("SELECT status FROM reviewer_pairs WHERE developer_id='new-dev'").fetchone() == ('ready',), 'Ctrl+A did not create a paired CR')
        assert db.execute("SELECT name FROM members WHERE thread_id=(SELECT reviewer_id FROM reviewer_pairs WHERE developer_id='new-dev')").fetchone()[0] == 'mobile CR'
        until(lambda: 'Your dedicated reviewer is mobile CR' in (work / 'queue.log').read_text(), 'coding session did not receive its CR introduction')
        assert len([event for event in events() if event['method'] == 'thread/start']) == 3
        assert len([event for event in events() if event['method'] == 'turn/start']) == 3, 'pairing should not start a model turn'
    finally:
        if db:
            db.close()
        if proc and proc.poll() is None:
            proc.kill()
            proc.wait()
        if socket:
            subprocess.run(['tmux', '-L', socket, 'kill-server'], env=env, capture_output=True)
        if master is not None:
            os.close(master)
        server.terminate()
        server.wait(timeout=5)
