import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const unavailable = ['tmux', 'python3'].find(command => spawnSync(command, ['--version']).error);

test('native sidebar and inbox support mouse navigation, replies and resizing', {skip: unavailable && `${unavailable} is not installed`, timeout: 30000}, () => {
  const check = spawnSync('python3', [fileURLToPath(new URL('./native-terminal-check.py', import.meta.url))], {encoding: 'utf8', timeout: 28000});
  assert.equal(check.status, 0, check.stderr || check.stdout || String(check.error));
});
