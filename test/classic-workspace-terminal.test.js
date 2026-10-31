import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const unavailable = ['tmux', 'python3'].find(command => spawnSync(command, ['--version']).error);

test('classic view groups and switches workspaces with keyboard and mouse', {skip: unavailable && `${unavailable} is not installed`, timeout: 20000}, () => {
  const check = spawnSync('python3', [fileURLToPath(new URL('./classic-workspace-terminal-check.py', import.meta.url))], {encoding: 'utf8', timeout: 18000});
  assert.equal(check.status, 0, check.stderr || check.stdout || String(check.error));
});
