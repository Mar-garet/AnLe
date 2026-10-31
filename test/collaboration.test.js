import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.js';
import {peerList, replyMessage, sendMessage} from '../src/messaging.js';
import {groupConversations} from '../src/conversations.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'anle-collab-'));
  let store = new Store(dir);
  store.addMember('default', {threadId: 'front', name: 'frontend', role: 'UI and forms', cwd: '/repo/frontend'});
  store.addMember('default', {threadId: 'api', name: 'backend', role: 'User API', cwd: '/repo/backend'});
  store.addMember('default', {threadId: 'other', name: 'other'});
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  return {store, dir, reopen() { store.close(); store = new Store(dir); return store; }};
}

test('presence separates self-reported tasks from observed and stale Codex status', t => {
  const {store} = fixture(t);
  store.updatePresence('default', 'front', {task: 'Implementing login form', status: 'working'});
  store.recordSessionObservations([{id: 'front', status: {type: 'active'}}, {id: 'not-registered', status: {type: 'idle'}}]);
  let front = peerList(store, 'default').find(member => member.id === 'front');
  assert.equal(front.role, 'UI and forms');
  assert.equal(front.current_task, 'Implementing login form');
  assert.equal(front.task_status, 'working');
  assert.ok(front.task_updated_at);
  assert.equal(front.codex_status.state, 'busy');
  assert.equal(front.codex_status.stale, false);
  assert.equal(store.sessionObservations().some(item => item.thread_id === 'not-registered'), false);
  store.db.prepare('UPDATE session_observations SET observed_at = ? WHERE thread_id = ?').run('2020-01-01T00:00:00.000Z', 'front');
  front = peerList(store, 'default').find(member => member.id === 'front');
  assert.equal(front.codex_status.state, 'unknown');
  assert.equal(front.codex_status.stale, true);
  store.updatePresence('default', 'front', {task: '', status: 'available'});
  assert.equal(store.member('default', 'front').current_task, '');
  assert.throws(() => store.updatePresence('default', 'front', {status: 'magical'}), /Invalid task status/);
});

test('third-party questions and replies form one chain without merging unrelated messages', async t => {
  const {store} = fixture(t);
  const deliveries = [];
  const queue = async (thread, text) => deliveries.push({thread, text});
  const root = await sendMessage(store, {spaceId: 'default', senderId: 'front', to: 'backend', body: 'Which API?', replyExpected: true}, queue);
  const escalation = await sendMessage(store, {spaceId: 'default', senderId: 'api', to: 'human', body: 'Which policy?', contextMessageId: root.id, replyExpected: true}, queue);
  const humanReply = await replyMessage(store, {spaceId: 'default', senderId: 'human', replyTo: escalation.id, body: 'Use policy A'}, queue);
  const answer = await replyMessage(store, {spaceId: 'default', senderId: 'api', replyTo: root.id, body: 'Use API A'}, queue);
  const unrelated = await sendMessage(store, {spaceId: 'default', senderId: 'front', to: 'backend', body: 'Another question'}, queue);
  assert.equal(root.conversation_id, root.id);
  assert.deepEqual([escalation, humanReply, answer].map(message => message.conversation_id), [root.id, root.id, root.id]);
  assert.deepEqual(store.conversation('default', root.id).map(message => message.id), [root.id, escalation.id, humanReply.id, answer.id]);
  assert.equal(escalation.parent_message_id, root.id);
  assert.equal(humanReply.parent_message_id, escalation.id);
  assert.notEqual(unrelated.conversation_id, root.id);
  const groups = groupConversations(store.messages('default', null));
  assert.equal(groups.length, 2);
  const thread = groups.find(group => group.conversation_id === root.id);
  assert.equal(thread.conversation_size, 4);
  assert.deepEqual(thread.participants.map(participant => participant.name), ['frontend', 'backend', 'human']);
  assert.match(deliveries[0].text, new RegExp(`Conversation ID: ${root.id}`));
  assert.match(deliveries[1].text, new RegExp(`context_message_id=${humanReply.id}`));
  await assert.rejects(sendMessage(store, {spaceId: 'default', senderId: 'other', to: 'human', body: 'Not my context', contextMessageId: root.id}, queue), /context not found/);
  const second = store.createSpace('Second');
  store.addMember(second.id, {threadId: 'api', name: 'backend'});
  await assert.rejects(sendMessage(store, {spaceId: second.id, senderId: 'api', to: 'human', body: 'Wrong workspace', contextMessageId: root.id}, queue), /context not found/);
});

test('older direct replies are migrated into their original conversation', async t => {
  const f = fixture(t);
  const queue = async () => {};
  const root = await sendMessage(f.store, {spaceId: 'default', senderId: 'front', to: 'backend', body: 'Old question'}, queue);
  const reply = await replyMessage(f.store, {spaceId: 'default', senderId: 'api', replyTo: root.id, body: 'Old answer'}, queue);
  f.store.db.exec('DROP TRIGGER messages_fill_conversation; DROP INDEX messages_conversation; ALTER TABLE messages DROP COLUMN parent_message_id; ALTER TABLE messages DROP COLUMN conversation_id');
  const reopened = f.reopen();
  assert.equal(reopened.message(root.id).conversation_id, root.id);
  assert.equal(reopened.message(reply.id).conversation_id, root.id);
  assert.equal(reopened.message(reply.id).parent_message_id, root.id);
  assert.deepEqual(reopened.conversation('default', root.id).map(message => message.body), ['Old question', 'Old answer']);
});

test('a pre-upgrade database keeps existing roles, messages and replies', t => {
  const dir = mkdtempSync(join(tmpdir(), 'anle-old-db-'));
  const db = new DatabaseSync(join(dir, 'serein.sqlite'));
  db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE members (space_id TEXT NOT NULL, thread_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL, PRIMARY KEY(space_id, thread_id));
    CREATE TABLE messages (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, recipient_id TEXT NOT NULL, recipient_name TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT, state TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO spaces VALUES ('default', 'Existing', '2020-01-01T00:00:00.000Z');
    INSERT INTO members VALUES ('default', 'front', 'frontend', 'User interface', '/repo/front', '2020-01-01T00:00:00.000Z');
    INSERT INTO messages VALUES ('root', 'default', 'front', 'frontend', 'human', 'human', 'Question', NULL, 'delivered', NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    INSERT INTO messages VALUES ('reply', 'default', 'human', 'human', 'front', 'frontend', 'Answer', 'root', 'queued', NULL, '2020-01-01T00:00:01.000Z', '2020-01-01T00:00:01.000Z');`);
  db.close();
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  assert.equal(store.member('default', 'front').role, 'User interface');
  assert.equal(store.member('default', 'front').current_task, '');
  assert.equal(store.message('root').reply_expected, null);
  assert.equal(store.message('reply').reply_expected, 0);
  assert.deepEqual(store.conversation('default', 'root').map(message => message.body), ['Question', 'Answer']);
});

test('navigation requests stay scoped to the requesting console', t => {
  const {store} = fixture(t);
  store.requestNavigation('console-a', 'default', 'front');
  store.requestNavigation('console-b', 'default', 'api');
  assert.equal(store.takeNavigation('console-a').thread_id, 'front');
  assert.equal(store.takeNavigation('console-a'), undefined);
  assert.equal(store.takeNavigation('console-b').thread_id, 'api');
  assert.throws(() => store.requestNavigation('console-a', 'default', 'removed'), /no longer in this workspace/);
});

test('older running clients can add members and direct replies after an upgrade', t => {
  const {store} = fixture(t);
  store.db.prepare('INSERT INTO members VALUES (?, ?, ?, ?, ?, ?)').run('default', 'legacy', 'legacy', 'Old agent', '/repo/legacy', new Date().toISOString());
  assert.equal(store.member('default', 'legacy').task_status, 'unknown');
  const insert = store.db.prepare(`INSERT INTO messages
    (id, space_id, sender_id, sender_name, recipient_id, recipient_name, body, reply_to, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const timestamp = new Date().toISOString();
  insert.run('legacy-root', 'default', 'front', 'frontend', 'api', 'backend', 'Old question', null, 'queued', timestamp, timestamp);
  insert.run('legacy-reply', 'default', 'api', 'backend', 'front', 'frontend', 'Old reply', 'legacy-root', 'queued', timestamp, timestamp);
  assert.equal(store.message('legacy-root').conversation_id, 'legacy-root');
  assert.equal(store.message('legacy-reply').conversation_id, 'legacy-root');
  assert.equal(store.message('legacy-reply').parent_message_id, 'legacy-root');
  assert.equal(store.message('legacy-reply').reply_expected, 0);
  assert.deepEqual(store.conversation('default', 'legacy-root').map(message => message.body), ['Old question', 'Old reply']);
});
