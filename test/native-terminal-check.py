import fcntl
import os
from pathlib import Path
import pty
import re
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
import {pathToFileURL} from 'node:url';
const {WebSocketServer} = await import(pathToFileURL(process.env.FAKE_WS));
const server = http.createServer();
const wss = new WebSocketServer({server});
wss.on('connection', ws => ws.on('message', raw => {
  const req = JSON.parse(raw.toString());
  if (req.id == null) return;
  const threads = [
    {id:'mock-agent', cwd:'/tmp/frontend', name:'Frontend', updatedAt:2, status:{type:'idle'}},
    {id:'mock-backend', cwd:'/tmp/backend', name:'Backend', updatedAt:1, status:{type:'idle'}},
    {id:'mock-long', cwd:'/tmp/多仓库/very-long-path-with-a-space/nested/前端', name:'Long session', updatedAt:1, status:{type:'idle'}},
    {id:'mock-backend-two', cwd:'/tmp/backend', name:'Backend two', updatedAt:1, status:{type:'idle'}},
    {id:'mock-unjoined', cwd:'/tmp/backend', name:'New backend', updatedAt:1, status:{type:'idle'}},
    {id:'mock-fallback', cwd:'', name:'Fallback session', updatedAt:1, status:{type:'idle'}},
  ];
  let result;
  if (req.method === 'initialize') result = {};
  else if (req.method === 'config/read') result = {config:{mcp_servers:{serein:{args:[process.env.FAKE_MCP], env:{SEREIN_HOME:process.env.SEREIN_HOME, SEREIN_CODEX_SOCKET:process.env.FAKE_SOCKET}, default_tools_approval_mode:'approve'}}}};
  else if (req.method === 'thread/list') result = {data:threads, nextCursor:null};
  else if (req.method === 'thread/loaded/list') result = {data:threads.map(thread => thread.id)};
  else { ws.send(JSON.stringify({id:req.id,error:{message:`Unsupported ${req.method}`}})); return; }
  ws.send(JSON.stringify({id:req.id,result}));
}));
server.listen(process.env.FAKE_SOCKET);
'''


def drain(master, duration=0.1):
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
        if not ready:
            break
        try:
            os.read(master, 65536)
        except OSError:
            break


# Keep Unix socket paths short enough on macOS, where TMPDIR is deeply nested.
with tempfile.TemporaryDirectory(prefix='serein-terminal-', dir='/tmp') as directory:
    work = Path(directory)
    tmux_temp = work / 'tmux'
    tmux_temp.mkdir()
    fake_bin = work / 'bin'
    fake_bin.mkdir()
    fake_codex = fake_bin / 'codex'
    fake_codex.write_text('#!/bin/sh\nif [ "$1" = queue ]; then printf "%s\\n" "$@" >> "$SEREIN_FAKE_LOG"; echo queued; exit 0; fi\nprintf "FAKE CODEX %s\\n" "$2"\nexec cat\n')
    fake_codex.chmod(0o755)
    server_file = work / 'server.mjs'
    server_file.write_text(SERVER)
    env = {**os.environ, 'CODEX_HOME': str(work / 'codex-home'), 'SEREIN_HOME': str(work / 'state'),
           'SEREIN_CODEX_SOCKET': str(work / 'app.sock'), 'FAKE_SOCKET': str(work / 'app.sock'),
           'FAKE_WS': str(ROOT / 'node_modules/ws/wrapper.mjs'), 'FAKE_MCP': str(ROOT / 'src/mcp-server.js'),
           'SEREIN_FAKE_LOG': str(work / 'queue.log'),
           'TMUX_TMPDIR': str(tmux_temp), 'TERM': 'xterm-256color', 'FORCE_COLOR': '2',
           'PATH': f'{fake_bin}:{os.environ["PATH"]}'}
    for key in ('TMUX', 'TMUX_PANE', 'SEREIN_UI'):
        env.pop(key, None)
    setup = r'''import {Store} from './src/store.js';
      const store = new Store();
      store.addMember('default', {threadId:'mock-agent', name:'frontend', cwd:'/tmp/frontend'});
      store.addMember('default', {threadId:'mock-backend', name:'backend', cwd:'/tmp/backend'});
      store.addMember('default', {threadId:'mock-long', name:'long-session', cwd:'/tmp/多仓库/very-long-path-with-a-space/nested/前端'});
      store.addMember('default', {threadId:'mock-backend-two', name:'backend-two', cwd:'/tmp/backend'});
      store.addMember('default', {threadId:'mock-fallback', name:'fallback', cwd:'/tmp/fallback-repo'});
      store.createMessage({spaceId:'default', sender:{id:'mock-agent',name:'frontend'}, recipient:{id:'human',name:'human'}, body:'Need your decision'});
      store.createMessage({spaceId:'default', sender:{id:'mock-backend',name:'backend'}, recipient:{id:'human',name:'human'}, body:'Backend needs review'});
      const second = store.createSpace('Second Workspace');
      store.addMember(second.id, {threadId:'mock-backend', name:'backend', cwd:'/tmp/backend'});
      store.createMessage({spaceId:second.id, sender:{id:'mock-backend',name:'backend'}, recipient:{id:'human',name:'human'}, body:'Second workspace message'});
      store.close();'''
    subprocess.run(['node', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', setup], cwd=ROOT, env=env, check=True)
    server = subprocess.Popen(['node', str(server_file)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    master = None
    proc = None
    socket = None
    try:
        deadline = time.monotonic() + 5
        while not (work / 'app.sock').exists() and time.monotonic() < deadline:
            if server.poll() is not None:
                raise RuntimeError(server.stderr.read().decode())
            time.sleep(.05)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 272, 0, 0))
        proc = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'bin/serein.js'],
                                cwd=ROOT, env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
        os.close(slave)

        def until(predicate, label, timeout=6):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                drain(master, .05)
                if predicate():
                    return
            screen = sidebar() if 'sidebar' in globals() else ''
            raise AssertionError(f'{label}\n{screen}')

        def find_socket():
            matches = list(tmux_temp.glob(f'tmux-*/serein-{proc.pid}-*'))
            return matches[0].name if matches else None

        until(lambda: find_socket() is not None, 'private tmux server did not start')
        socket = find_socket()

        def tmux(*args):
            return subprocess.run(['tmux', '-L', socket, *args], env=env, check=True,
                                  capture_output=True, text=True).stdout.strip()

        until(lambda: len(tmux('list-panes', '-t', 'workspace:0').splitlines()) == 2, 'panes did not start')
        left = tmux('list-panes', '-t', 'workspace:0', '-F', '#{pane_id}').splitlines()[0]

        def sidebar():
            return tmux('capture-pane', '-p', '-t', left)

        def selected(name):
            return f'▸ {name}' in sidebar()

        def native_pane():
            return tmux('list-panes', '-t', 'workspace:0', '-F', '#{pane_id}').splitlines()[1]

        def native_screen():
            return tmux('capture-pane', '-p', '-t', native_pane())

        def send(data):
            os.write(master, data)
            drain(master, .1)

        until(lambda: selected('human') and 'frontend' in sidebar() and 'backend-two' in sidebar() and '/tmp/frontend' in sidebar(), 'sidebar and paths did not render')
        brand_header = '\n'.join(sidebar().splitlines()[:5])
        assert '▄█▀▀█▄' in brand_header and '▀█▄▄▄' in brand_header and 'erein' in brand_header, 'Serein mark and wordmark did not render'
        assert 'serein' not in brand_header.lower(), 'the wordmark duplicated the S in the logo'
        if os.environ.get('SEREIN_SIDEBAR_DUMP'):
            print(sidebar(), flush=True)
        assert sidebar().count('/tmp/backend') == 2
        lines = sidebar().splitlines()
        frontend_name = next(i for i, line in enumerate(lines) if 'frontend' in line and '/tmp/frontend' not in line)
        assert '/tmp/frontend' in lines[frontend_name - 1], 'directory must appear above its session name'
        long_name = next(i for i, line in enumerate(lines) if 'long-session' in line)
        long_path = '/tmp/多仓库/very-long-path-with-a-space/nested/前端'
        parts = []
        while ''.join(parts) != long_path and len(parts) < 5:
            parts.insert(0, lines[long_name - 1 - len(parts)].strip(' │'))
            assert long_path.endswith(''.join(parts)), 'wrapped path was clipped or changed'
        assert len(parts) > 1 and ''.join(parts) == long_path
        until(lambda: tmux('display-message', '-p', '-t', left, '#{mouse_any_flag}') == '1', 'sidebar did not enable mouse reporting')
        until(lambda: 'YOUR INBOX' in native_screen() and 'Need your decision' in native_screen() and 'Reply to backend' in native_screen(), 'human inbox and reply input did not render')
        # Ctrl+A uses the same path-first layout for existing and new sessions.
        send(b'\x01')
        until(lambda: 'SELECT SESSION' in sidebar() and 'New backend' in sidebar() and '[ADDED]' in sidebar(), 'session picker did not render')
        picker_lines = sidebar().splitlines()
        new_name = next(i for i, line in enumerate(picker_lines) if 'New backend' in line)
        assert '/tmp/backend' in picker_lines[new_name - 1], 'picker directory must appear above its session name'
        picker_long = next(i for i, line in enumerate(picker_lines) if '[ADDED]' in line and 'long' in line)
        picker_parts = []
        while ''.join(picker_parts) != long_path and len(picker_parts) < 5:
            picker_parts.insert(0, picker_lines[picker_long - 1 - len(picker_parts)].strip(' │'))
            assert long_path.endswith(''.join(picker_parts)), 'picker path was clipped or changed'
        assert len(picker_parts) > 1 and ''.join(picker_parts) == long_path
        picker_color = tmux('capture-pane', '-p', '-e', '-t', left).splitlines()
        picker_front = next(line for line in picker_color if '/tmp/frontend' in line)
        picker_back = next(line for line in picker_color if '/tmp/backend' in line)
        styles = lambda line, path: re.findall(r'\x1b\[[0-9;]*m', line.split(path)[0])
        assert styles(picker_front, '/tmp/frontend') != styles(picker_back, '/tmp/backend'), 'picker selection color was not visible'
        # Clicking a path selects the matching session, including a new session in a shared directory.
        send(f'\x1b[<0;8;{new_name}M\x1b[<0;8;{new_name}m'.encode())
        until(lambda: '▸ New backend' in sidebar(), 'clicking picker path selected the wrong session')
        send(b'\r')
        until(lambda: 'NAME THIS SESSION' in sidebar(), 'new session did not open its name form')
        send(b'\x1b')
        until(lambda: selected('human'), 'session picker did not close')
        send(b'\x01')
        until(lambda: 'SELECT SESSION' in sidebar() and '/tmp/frontend' in sidebar(), 'session picker did not reopen')
        send(b'/')
        send(b'backend')
        send(b'\r')
        until(lambda: 'New backend' in sidebar() and '/tmp/frontend' not in sidebar(), 'picker search no longer filters by directory')
        send(b'\x1b')
        until(lambda: selected('human'), 'filtered picker did not close')
        send(b'\x01')
        until(lambda: 'SELECT SESSION' in sidebar() and '/tmp/frontend' in sidebar(), 'session picker did not reopen for fallback search')
        send(b'/')
        send(b'/tmp/fallback-repo')
        send(b'\r')
        until(lambda: '/tmp/fallback-repo' in sidebar() and '▸ fallback' in sidebar(), 'picker did not show or search the saved directory when thread metadata was missing')
        send(b'\x1b')
        until(lambda: selected('human'), 'fallback picker did not close')
        send(b'\x1b[B')
        until(lambda: selected('frontend'), 'down did not select frontend')
        colored = tmux('capture-pane', '-p', '-e', '-t', left).splitlines()
        front_path = next(line for line in colored if '/tmp/frontend' in line)
        back_path = next(line for line in colored if '/tmp/backend' in line)
        foregrounds = lambda line, path: re.findall(r'\x1b\[[0-9;]*m', line.split(path)[0])
        front_styles = foregrounds(front_path, '/tmp/frontend')
        back_styles = foregrounds(back_path, '/tmp/backend')
        assert front_styles and back_styles and front_styles != back_styles, 'selected and unselected paths were not highlighted distinctly'
        until(lambda: 'FAKE CODEX mock-agent' in native_screen(), 'frontend native pane did not open')
        frontend_pane = native_pane()
        send(b'\r')
        until(lambda: tmux('display-message', '-p', '-t', 'workspace:0', '#{pane_id}') != left, 'Enter did not focus Codex')
        send(b'unsent draft')
        until(lambda: 'unsent draft' in native_screen(), 'native pane did not receive typing')
        # A click from the native pane selects both the sidebar and the clicked node.
        send(b'\x1b[<0;8;9M\x1b[<0;8;9m')
        until(lambda: selected('backend'), 'click did not select backend')
        until(lambda: 'FAKE CODEX mock-backend' in native_screen(), 'backend native pane did not open after clicking')
        assert tmux('display-message', '-p', '-t', 'workspace:0', '#{pane_id}') == left
        # A click on a wrapped continuation line must select its own session.
        wrapped_path_y = long_name
        send(f'\x1b[<0;8;{wrapped_path_y}M\x1b[<0;8;{wrapped_path_y}m'.encode())
        until(lambda: selected('long-session'), 'click on wrapped directory selected the wrong session')
        until(lambda: 'FAKE CODEX mock-long' in native_screen(), 'long-path native pane did not open')
        send(b'\x1b[A')
        until(lambda: selected('backend'), 'up did not return to backend')
        send(b'\x1b[A')
        until(lambda: selected('frontend'), 'up did not select frontend after clicking')
        until(lambda: native_pane() == frontend_pane and 'unsent draft' in native_screen(), 'native draft did not survive switching')
        # Mouse dragging and the wheel must not trap keys in tmux copy mode.
        send(b'\x1b[<0;8;7M\x1b[<32;8;8M\x1b[<0;8;8m')
        assert tmux('display-message', '-p', '-t', left, '#{pane_in_mode}') == '0'
        send(b'\x1b[B')
        until(lambda: selected('backend'), 'down stopped working after mouse drag')
        send(b'\x1b[<64;8;8M')
        until(lambda: selected('frontend'), 'mouse wheel did not select frontend')
        assert tmux('display-message', '-p', '-t', left, '#{pane_in_mode}') == '0'
        client_pid = int(tmux('list-clients', '-F', '#{client_pid}').splitlines()[0])
        for width in (208, 120, 300, 64, 208):
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, width, 0, 0))
            os.kill(client_pid, signal.SIGWINCH)
            until(lambda: tmux('display-message', '-p', '-t', left, '#{window_width} #{pane_width}') == f'{width} 32',
                  f'sidebar width was not retained after resizing to {width}')
        send(b'\x0e')
        until(lambda: selected('human') and 'YOUR INBOX' in native_screen() and 'Reply to backend' in native_screen(), 'inbox did not open')
        assert tmux('display-message', '-p', '-t', 'workspace:0', '#{pane_id}') == native_pane()
        send(b'backend reply')
        until(lambda: 'backend reply' in native_screen(), 'reply text did not appear in the input')
        send(b'\r')
        db = sqlite3.connect(f'file:{work / "state/serein.sqlite"}?mode=ro', uri=True)
        def replies():
            return db.execute('SELECT sender_id, recipient_id, body, reply_to, state FROM messages WHERE sender_id = ? ORDER BY rowid', ('human',)).fetchall()
        until(lambda: replies() and replies()[-1][2] == 'backend reply' and replies()[-1][4] == 'queued', 'reply was not queued')
        backend_reply = replies()[-1]
        assert backend_reply[1] == 'mock-backend'
        assert db.execute('SELECT body FROM messages WHERE id = ?', (backend_reply[3],)).fetchone()[0] == 'Backend needs review'
        assert '--thread\nmock-backend\n' in (work / 'queue.log').read_text()
        # Clicking a different message changes the reply destination and correlation.
        send(b'\x1b[<0;40;5M\x1b[<0;40;5m')
        until(lambda: 'Reply to frontend' in native_screen(), 'clicking a message did not select its sender')
        send('前端答复'.encode())
        until(lambda: '前端答复' in native_screen(), 'frontend reply did not appear in the input')
        send(b'\r')
        until(lambda: len(replies()) == 2 and replies()[-1][4] == 'queued', 'frontend reply was not queued')
        front_reply = replies()[-1]
        assert front_reply[1:3] == ('mock-agent', '前端答复')
        assert db.execute('SELECT body FROM messages WHERE id = ?', (front_reply[3],)).fetchone()[0] == 'Need your decision'
        assert '--thread\nmock-agent\n' in (work / 'queue.log').read_text()
        # Return to the sidebar, click human and type directly without another shortcut.
        send(b'\x1b[17~')
        send(b'\x1b[<0;8;7M\x1b[<0;8;7m')
        until(lambda: selected('frontend'), 'could not select frontend')
        send(b'\x1b[<0;8;6M\x1b[<0;8;6m')
        until(lambda: selected('human') and 'YOUR INBOX' in native_screen(), 'clicking human did not show the inbox')
        send(b'unsent inbox draft')
        until(lambda: 'unsent inbox draft' in native_screen(), 'typing from the human node did not focus the inbox')
        # Each workspace has its own inbox and keeps its draft while switching.
        send(b'\x1b[17~')
        send(b'\x07')
        until(lambda: 'Second workspace message' in native_screen(), 'second workspace inbox did not open')
        assert 'Need your decision' not in native_screen()
        send(b'\x07')
        until(lambda: 'unsent inbox draft' in native_screen(), 'inbox draft did not survive workspace switching')
        second_id = db.execute('SELECT id FROM spaces WHERE name = ?', ('Second Workspace',)).fetchone()[0]
        send(b'\x07')
        until(lambda: 'Second workspace message' in native_screen(), 'second workspace did not reopen')
        second_inbox = native_pane()
        send(b'\x04')
        until(lambda: 'DELETE WORKSPACE' in sidebar() and 'Second Workspace' in sidebar() and 'Y delete' in sidebar(), 'workspace deletion confirmation did not appear')
        assert 'Removes 1 node' in sidebar() and 'and 1 Serein message' in sidebar()
        assert 'Codex sessions/repos stay' in sidebar()
        send(b'\x1b')
        until(lambda: 'DELETE WORKSPACE' not in sidebar(), 'workspace deletion did not cancel')
        assert db.execute('SELECT COUNT(*) FROM spaces WHERE id = ?', (second_id,)).fetchone()[0] == 1
        send(b'\x04')
        until(lambda: 'DELETE WORKSPACE' in sidebar(), 'workspace confirmation did not reopen')
        send(b'y')
        until(lambda: db.execute('SELECT COUNT(*) FROM spaces WHERE id = ?', (second_id,)).fetchone()[0] == 0, 'workspace was not deleted')
        until(lambda: 'unsent inbox draft' in native_screen(), 'deleting the workspace did not restore the other inbox')
        until(lambda: second_inbox not in tmux('list-panes', '-a', '-F', '#{pane_id}').splitlines(), 'deleted workspace inbox pane was not removed')
        assert db.execute('SELECT COUNT(*) FROM messages WHERE space_id = ?', (second_id,)).fetchone()[0] == 0
        assert db.execute('SELECT COUNT(*) FROM members WHERE space_id = ?', ('default',)).fetchone()[0] == 5
        # With a short terminal, Page Down reveals nodes below the viewport.
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 18, 208, 0, 0))
        os.kill(client_pid, signal.SIGWINCH)
        until(lambda: tmux('display-message', '-p', '-t', left, '#{pane_height}') == '18' and 'Pg scroll' in sidebar(), 'short sidebar did not show its scroll hint')
        assert 'backend-two' not in sidebar()
        send(b'\x1b[6~')
        until(lambda: 'backend-two' in sidebar(), 'Page Down did not scroll the node list')
        send(b'\x1b[5~')
        until(lambda: 'human / inbox' in sidebar(), 'Page Up did not return to the top of the node list')
        send(b'\x01')
        until(lambda: 'SELECT SESSION' in sidebar() and '/tmp/frontend' in sidebar() and 'Pg scroll' in sidebar(), 'short session picker did not show its scroll hint')
        send(b'\x1b[6~')
        until(lambda: 'backend-two' in sidebar(), 'first Page Down did not scroll the session picker')
        send(b'\x1b[6~')
        until(lambda: 'New backend' in sidebar(), 'Page Down did not scroll the session picker')
        send(b'\x1b[5~')
        send(b'\x1b[5~')
        until(lambda: '/tmp/frontend' in sidebar(), 'Page Up did not return to the start of the session picker')
        send(b'\x1b')
        until(lambda: 'human / inbox' in sidebar(), 'session picker did not close after paging')
        # Removing a session does not delete its Codex pane or workspace messages.
        send(b'\x1b[B')
        until(lambda: selected('frontend'), 'frontend was not selected for removal')
        send(b'\x18')
        until(lambda: 'REMOVE SESSION' in sidebar() and 'Codex session is kept' in sidebar(), 'session removal confirmation did not appear')
        send(b'\x1b')
        until(lambda: 'REMOVE SESSION' not in sidebar(), 'session removal did not cancel')
        assert db.execute('SELECT COUNT(*) FROM members WHERE space_id = ? AND thread_id = ?', ('default', 'mock-agent')).fetchone()[0] == 1
        send(b'\x18')
        send(b'y')
        until(lambda: db.execute('SELECT COUNT(*) FROM members WHERE space_id = ? AND thread_id = ?', ('default', 'mock-agent')).fetchone()[0] == 0, 'session was not removed from the workspace')
        assert db.execute('SELECT COUNT(*) FROM messages WHERE sender_id = ?', ('mock-agent',)).fetchone()[0] == 1
        assert tmux('display-message', '-p', '-t', frontend_pane, '#{pane_dead}') == '0'
        assert 'unsent draft' in tmux('capture-pane', '-p', '-t', frontend_pane)
        # Deleting the final workspace offers and creates an empty replacement.
        send(b'\x04')
        until(lambda: 'DELETE WORKSPACE' in sidebar() and 'Creates an empty workspace' in sidebar() and 'Y delete' in sidebar(), 'last-workspace confirmation did not explain the replacement')
        send(b'y')
        until(lambda: db.execute('SELECT name FROM spaces').fetchall() == [('New Workspace',)], 'empty replacement workspace was not created')
        until(lambda: 'New Workspace' in sidebar(), 'replacement workspace did not appear')
        until(lambda: 'No messages for you yet.' in native_screen() and '▄█████████▄' in native_screen(), 'empty inbox did not show the pixel dog')
        assert '█▀▄    ▄▀█' not in native_screen()
        if os.environ.get('SEREIN_SIDEBAR_DUMP'):
            print(native_screen(), flush=True)
        assert db.execute('SELECT COUNT(*) FROM messages').fetchone()[0] == 0
        assert db.execute('SELECT COUNT(*) FROM members').fetchone()[0] == 0
        assert tmux('display-message', '-p', '-t', frontend_pane, '#{pane_dead}') == '0'
        db.close()
        send(b'\x11')
        proc.wait(timeout=5)
    finally:
        if proc and proc.poll() is None:
            proc.kill()
            proc.wait()
        if socket:
            subprocess.run(['tmux', '-L', socket, 'kill-server'], env=env, capture_output=True)
        if master is not None:
            os.close(master)
        server.terminate()
        server.wait(timeout=5)
