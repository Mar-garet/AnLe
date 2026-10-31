import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.js';

test('CLI can report a task and retain context when contacting a third party', t => {
  const dir = mkdtempSync(join(tmpdir(), 'anle-cli-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  store.addMember('default', {threadId: 'front', name: 'frontend'});
  store.addMember('default', {threadId: 'api', name: 'backend'});
  const root = store.createMessage({spaceId: 'default', sender: {id: 'front', name: 'frontend'}, recipient: {id: 'api', name: 'backend'}, body: 'API question'});
  const script = fileURLToPath(new URL('../bin/serein.js', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args],
    {encoding: 'utf8', env: {...process.env, SEREIN_HOME: dir, CODEX_THREAD_ID: 'api'}});
  const presence = run('presence', '--task', 'Implementing login', '--status', 'working');
  assert.equal(presence.status, 0, presence.stderr);
  assert.equal(store.member('default', 'api').current_task, 'Implementing login');
  const send = run('send', '--to', 'human', '--message', 'Need a decision', '--context-message', root.id, '--reply-expected', 'true');
  assert.equal(send.status, 0, send.stderr);
  const sent = JSON.parse(send.stdout);
  assert.equal(sent.conversation_id, root.id);
  assert.equal(store.message(sent.id).parent_message_id, root.id);
  assert.equal(store.message(sent.id).reply_expected, 1);
  const conversation = run('conversation', '--message-id', root.id);
  assert.equal(conversation.status, 0, conversation.stderr);
  assert.deepEqual(JSON.parse(conversation.stdout).messages.map(message => message.body), ['API question', 'Need a decision']);
  const invalid = run('send', '--to', 'human', '--message', 'No', '--reply-expected', 'maybe');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /must be true or false/);
});
