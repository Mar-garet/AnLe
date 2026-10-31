import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativePaneManager} from '../src/native.js';

const first = {thread_id: 'thread-one', cwd: '/not-a-real-directory'};
const second = {thread_id: 'thread-two', cwd: '/not-a-real-directory'};

test('native panes are reused when switching sessions and receive input literally', async () => {
  const manager = new NativePaneManager({socketName: 'test', session: 'workspace', welcomePane: '%0'});
  const calls = [];
  let nextPane = 1;
  manager.tmux = async args => {
    calls.push(args);
    if (args[0] === 'new-window') return `%${nextPane++}`;
    if (args[0] === 'display-message') return '0';
    return '';
  };
  await manager.show(first, '/tmp/server.sock');
  await manager.show(second, '/tmp/server.sock');
  await manager.show(first, '/tmp/server.sock');
  assert.equal(calls.filter(args => args[0] === 'new-window').length, 2);
  assert.deepEqual(calls.filter(args => args[0] === 'swap-pane').map(args => args.slice(-3)), [
    ['%1', '-t', '%0'], ['%2', '-t', '%1'], ['%1', '-t', '%2'],
  ]);
  const literal = 'hello $(not-a-command) `text`';
  await manager.forward(first, '/tmp/server.sock', literal);
  assert.equal(calls.find(args => args[0] === 'send-keys').at(-1), literal);
  assert.deepEqual(calls.at(-1), ['select-pane', '-t', '%1']);
});

test('activity reuses its pane and preserves the original native session', async () => {
  const manager = new NativePaneManager({socketName: 'test', session: 'workspace', welcomePane: '%0', welcomeSpaceId: 'default'});
  const calls = [];
  let nextPane = 1;
  manager.tmux = async args => {
    calls.push(args);
    if (args[0] === 'new-window') return `%${nextPane++}`;
    if (args[0] === 'display-message') return '0';
    return '';
  };
  await manager.show(first, '/tmp/server.sock');
  const original = manager.visiblePane;
  await manager.showActivity('default');
  const activity = manager.visiblePane;
  assert.notEqual(activity, original);
  await manager.discardActivity('default');
  assert.equal(calls.some(args => args[0] === 'kill-pane'), false);
  await manager.show(first, '/tmp/server.sock');
  assert.equal(manager.visiblePane, original);
  await manager.showActivity('default');
  assert.equal(manager.visiblePane, activity);
  assert.equal(calls.filter(args => args[0] === 'new-window').length, 2);
  await manager.show(first, '/tmp/server.sock');
  await manager.discardActivity('default');
  assert.ok(calls.some(args => args[0] === 'kill-pane' && args.at(-1) === activity));
});

test('forwards Ctrl+T from the sidebar to the active activity or inbox pane', async () => {
  const manager = new NativePaneManager({socketName: 'test', session: 'workspace', welcomePane: '%0', welcomeSpaceId: 'default'});
  const calls = [];
  manager.tmux = async args => {
    calls.push(args);
    if (args[0] === 'new-window') return '%1';
    if (args[0] === 'display-message') return '0';
    return '';
  };
  await manager.forwardPanelShortcut('default', 'activity', 'C-t');
  assert.ok(calls.some(args => args[0] === 'send-keys' && args.includes('%1') && args.at(-1) === 'C-t'));
  assert.deepEqual(calls.at(-1), ['select-pane', '-t', '%1']);
  await manager.forwardPanelShortcut('default', 'inbox', 'C-t');
  assert.ok(calls.some(args => args[0] === 'send-keys' && args.includes('%0') && args.at(-1) === 'C-t'));
  assert.deepEqual(calls.at(-1), ['select-pane', '-t', '%0']);
});

test('forwards Ctrl+T from the sidebar to the selected native session', async () => {
  const manager = new NativePaneManager({socketName: 'test', session: 'workspace', welcomePane: '%0'});
  const calls = [];
  manager.tmux = async args => {
    calls.push(args);
    if (args[0] === 'new-window') return '%1';
    if (args[0] === 'display-message') return '0';
    return '';
  };
  await manager.forwardSessionShortcut(first, '/tmp/server.sock', 'C-t');
  assert.ok(calls.some(args => args[0] === 'send-keys' && args.includes('%1') && args.at(-1) === 'C-t'));
  assert.deepEqual(calls.at(-1), ['select-pane', '-t', '%1']);
});

test('checks a reviewer before opening it without unsupported remote overrides', async () => {
  const manager = new NativePaneManager({socketName: 'test', session: 'workspace', welcomePane: '%0'});
  const calls = [];
  const reviewer = {...first, space_id: 'default', review_snapshot_path: '/tmp/snapshot'};
  manager.tmux = async args => {
    calls.push(args);
    if (args[0] === 'new-window') return '%1';
    return '';
  };
  manager.prepareReviewer = async member => { assert.equal(member, reviewer); };
  await manager.show(reviewer, '/tmp/server.sock');
  const start = calls.find(args => args[0] === 'new-window');
  assert.ok(start.includes('--remote'));
  assert.equal(start.some(arg => ['--sandbox', '--ask-for-approval', '--cd'].includes(arg)), false);
  manager.prepareReviewer = async () => { throw new Error('not read-only'); };
  await assert.rejects(manager.show(reviewer, '/tmp/server.sock'), /not read-only/);
  assert.equal(calls.filter(args => args[0] === 'new-window').length, 1);
});

test('a rapid selection change does not display or type into the wrong session', async () => {
  const manager = new NativePaneManager({socketName: 'test', session: 'workspace', welcomePane: '%0'});
  const calls = [];
  let releaseFirst;
  const firstPane = new Promise(resolve => { releaseFirst = resolve; });
  manager.tmux = async args => {
    calls.push(args);
    if (args[0] === 'new-window' && args.includes('thread-one')) return firstPane;
    if (args[0] === 'new-window') return '%2';
    if (args[0] === 'display-message') return '0';
    return '';
  };
  const firstRequest = manager.forward(first, '/tmp/server.sock', 'hello');
  const secondRequest = manager.show(second, '/tmp/server.sock');
  releaseFirst('%1');
  await assert.rejects(firstRequest, /selected session changed/);
  await secondRequest;
  assert.deepEqual(calls.filter(args => args[0] === 'swap-pane').map(args => args.slice(-3)), [['%2', '-t', '%0']]);
  assert.equal(calls.some(args => args[0] === 'send-keys'), false);
});

test('input remains attached to its original native pane if selection changes mid-send', async () => {
  const manager = new NativePaneManager({socketName: 'test', session: 'workspace', welcomePane: '%0'});
  const calls = [];
  let nextPane = 1;
  let beginSend;
  let finishSend;
  const sendStarted = new Promise(resolve => { beginSend = resolve; });
  const sendCanFinish = new Promise(resolve => { finishSend = resolve; });
  manager.tmux = async args => {
    calls.push(args);
    if (args[0] === 'new-window') return `%${nextPane++}`;
    if (args[0] === 'display-message') return '0';
    if (args[0] === 'send-keys') { beginSend(); await sendCanFinish; }
    return '';
  };
  await manager.show(first, '/tmp/server.sock');
  const forwarded = manager.forward(first, '/tmp/server.sock', 'hello');
  await sendStarted;
  await manager.show(second, '/tmp/server.sock');
  finishSend();
  await assert.rejects(forwarded, /input remains in its native pane/);
  assert.deepEqual(calls.find(args => args[0] === 'send-keys').slice(0, 3), ['send-keys', '-t', '%1']);
  assert.equal(calls.some(args => args[0] === 'select-pane'), false);
});

test('switches real tmux panes without restarting the previous native client', {skip: spawnSync('tmux', ['-V']).error ? 'tmux is not installed' : false}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'serein-native-'));
  const socketName = `serein-test-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const env = {...process.env, PATH: `${dir}:${process.env.PATH}`};
  delete env.TMUX;
  delete env.TMUX_PANE;
  writeFileSync(join(dir, 'codex'), '#!/bin/sh\nprintf "NATIVE %s\\n" "$2"\nexec cat\n', {mode: 0o755});
  const tmux = args => execFileSync('tmux', ['-L', socketName, ...args], {encoding: 'utf8', env, timeout: 5000}).trim();
  t.after(() => {
    try { tmux(['kill-server']); } catch {}
    rmSync(dir, {recursive: true, force: true});
  });
  const left = tmux(['new-session', '-d', '-s', 'workspace', '-x', '100', '-y', '30', '-P', '-F', '#{pane_id}', 'sleep', '30']);
  const welcome = tmux(['split-window', '-h', '-l', '65', '-t', left, '-d', '-P', '-F', '#{pane_id}', 'sleep', '30']);
  const manager = new NativePaneManager({socketName, session: 'workspace', welcomePane: welcome});
  manager.env = env;
  await manager.show(first, '/tmp/test.sock');
  const firstPane = manager.visiblePane;
  tmux(['send-keys', '-t', firstPane, '-l', '--', 'draft-one']);
  await manager.show(second, '/tmp/test.sock');
  const secondPane = manager.visiblePane;
  await manager.show(first, '/tmp/test.sock');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.notEqual(firstPane, secondPane);
  assert.equal(manager.visiblePane, firstPane);
  assert.match(tmux(['capture-pane', '-p', '-t', firstPane]), /draft-one/);
  assert.ok(tmux(['list-panes', '-a', '-F', '#{pane_id}']).split('\n').includes(secondPane));
});
