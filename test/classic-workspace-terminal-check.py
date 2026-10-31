import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='anle-classic-tree-', dir='/tmp') as directory:
    work = Path(directory)
    socket = f'anle-classic-{os.getpid()}'
    env = {**os.environ, 'SEREIN_HOME': str(work / 'state'), 'CODEX_HOME': str(work / 'codex'),
           'SEREIN_CODEX_SOCKET': str(work / 'missing.sock'), 'TMUX_TMPDIR': str(work), 'TERM': 'xterm-256color'}
    env.pop('TMUX', None)
    env.pop('TMUX_PANE', None)
    setup = '''import {Store} from './src/store.js';
      const store = new Store();
      store.addMember('default', {threadId:'frontend', name:'front', cwd:'/tmp/frontend'});
      const backend = store.createSpace('Backend Team');
      store.addMember(backend.id, {threadId:'backend', name:'back', cwd:'/tmp/backend'});
      store.close();'''
    subprocess.run(['node', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', setup], cwd=ROOT, env=env, check=True)

    def tmux(*args):
        return subprocess.run(['tmux', '-L', socket, '-f', '/dev/null', *args], cwd=ROOT, env=env,
                              text=True, capture_output=True, check=True, timeout=5).stdout.strip()

    def screen():
        return tmux('capture-pane', '-p', '-t', 'workspace:0')

    def until(predicate, label):
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.05)
        raise AssertionError(f'{label}\n{screen()}')

    def key(value):
        tmux('send-keys', '-t', 'workspace:0', value)

    try:
        tmux('new-session', '-d', '-s', 'workspace', '-x', '120', '-y', '32',
             'node', '--disable-warning=ExperimentalWarning', str(ROOT / 'bin/serein.js'), 'classic')
        until(lambda: 'My Workspace' in screen() and 'Backend Team' in screen() and '/tmp/backend' in screen(),
              'workspace hierarchy did not render')
        key('C-w')
        until(lambda: 'WORKSPACE NAME' in screen(), 'workspace name prompt did not open')
        tmux('send-keys', '-t', 'workspace:0', '-l', '--', 'Fresh Space')
        key('Enter')
        until(lambda: '▸ ▾ Fresh Space' in screen(), 'new workspace was not selected')
        db = sqlite3.connect(f'file:{work / "state/serein.sqlite"}?mode=ro', uri=True)
        fresh = db.execute("SELECT id FROM spaces WHERE name='Fresh Space'").fetchone()[0]
        assert db.execute('SELECT count(*) FROM members WHERE space_id=?', (fresh,)).fetchone()[0] == 0
        key('C-w')
        until(lambda: 'WORKSPACE NAME' in screen(), 'workspace name prompt did not reopen')
        tmux('send-keys', '-t', 'workspace:0', '-l', '--', 'Fresh Space')
        key('Enter')
        until(lambda: 'Workspace name already exists' in screen(), 'duplicate workspace error was not visible')
        assert db.execute("SELECT count(*) FROM spaces WHERE name='Fresh Space'").fetchone()[0] == 1
        key('Escape')
        until(lambda: 'WORKSPACE NAME' not in screen(), 'duplicate workspace prompt did not cancel')

        # Click a different workspace's label, then select its child and verify
        # that workspace-scoped actions target the right workspace.
        y = next(index for index, line in enumerate(screen().splitlines(), 1) if 'Backend Team' in line)
        click = f'\x1b[<0;12;{y}M\x1b[<0;12;{y}m'
        tmux('send-keys', '-t', 'workspace:0', '-l', '--', click)
        until(lambda: '▸ ▾ Backend Team' in screen(), 'mouse click did not select another workspace')
        key('Down')
        until(lambda: '▸ back' in screen(), 'keyboard did not select the workspace session')
        key('C-d')
        until(lambda: 'DELETE WORKSPACE' in screen() and 'Backend Team' in screen(), 'session selection did not activate its workspace')
        key('Escape')
        until(lambda: 'DELETE WORKSPACE' not in screen(), 'workspace deletion did not cancel')
        key('C-g')
        until(lambda: '▸ ▾ Fresh Space' in screen(), 'Ctrl+G did not cycle to the next workspace')
        key('C-q')
        db.close()
    finally:
        subprocess.run(['tmux', '-L', socket, 'kill-server'], env=env, capture_output=True)
