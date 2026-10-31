import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {notifyHumanMessages} from '../src/notifications.js';

test('desktop alerts are opt-in and persist locally', t => {
  const dir = mkdtempSync(join(tmpdir(), 'anle-alerts-'));
  let store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  assert.equal(store.desktopNotificationsEnabled(), false);
  store.setDesktopNotifications(true);
  store.close();
  store = new Store(dir);
  assert.equal(store.desktopNotificationsEnabled(), true);
  store.setDesktopNotifications(false);
  assert.equal(store.desktopNotificationsEnabled(), false);
});

test('desktop alerts pass sender information as data and never include the message body', async () => {
  const calls = [];
  const run = async (...args) => calls.push(args);
  const messages = [{sender_name: 'agent "quoted"', space_name: 'Project', body: 'private message'}];
  assert.equal(await notifyHumanMessages(messages, {platform: 'darwin', run}), true);
  assert.equal(calls[0][0], '/usr/bin/osascript');
  assert.match(calls[0][1][1], /item 1 of argv/);
  assert.equal(calls[0][1][2], 'New message from agent "quoted" · Project');
  assert.doesNotMatch(JSON.stringify(calls), /private message/);
  assert.equal(await notifyHumanMessages(messages, {platform: 'unsupported', run}), false);
  assert.equal(calls.length, 1);
});
