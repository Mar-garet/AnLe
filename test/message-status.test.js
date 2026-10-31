import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {replyMessage, sendMessage} from '../src/messaging.js';
import {deliveryLabel, humanNeedsAttention, replyLabel} from '../src/message-status.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'anle-status-'));
  const store = new Store(directory);
  store.addMember('default', {threadId: 'front', name: 'frontend'});
  store.addMember('default', {threadId: 'api', name: 'backend'});
  t.after(() => { store.close(); rmSync(directory, {recursive: true, force: true}); });
  return store;
}

test('delivery and reply states distinguish accepted, failed and uncertain attempts', async t => {
  const store = fixture(t);
  const question = await sendMessage(store, {spaceId: 'default', senderId: 'front', to: 'api', body: 'Question', replyExpected: true}, async () => {});
  assert.equal(deliveryLabel(store.messageDetails(question.id)), 'QUEUED');
  assert.equal(replyLabel(store.messageDetails(question.id)), 'WAITING');
  const undelivered = store.createMessage({spaceId: 'default', sender: {id: 'front', name: 'frontend'}, recipient: {id: 'api', name: 'backend'}, body: 'Not delivered', replyExpected: true});
  store.setMessageState(undelivered.id, 'failed');
  assert.equal(deliveryLabel(store.messageDetails(undelivered.id)), 'FAILED');
  assert.equal(replyLabel(store.messageDetails(undelivered.id)), null);
  await assert.rejects(replyMessage(store, {spaceId: 'default', senderId: 'api', replyTo: question.id, body: 'Failed'}, async () => { throw new Error('offline'); }), error => error.deliveryState === 'failed');
  assert.equal(replyLabel(store.messageDetails(question.id)), 'REPLY FAILED');
  await assert.rejects(replyMessage(store, {spaceId: 'default', senderId: 'api', replyTo: question.id, body: 'Uncertain'}, async () => { const error = new Error('timeout'); error.killed = true; throw error; }), error => error.deliveryState === 'unknown');
  assert.equal(replyLabel(store.messageDetails(question.id)), 'REPLY UNKNOWN');
  const reply = await replyMessage(store, {spaceId: 'default', senderId: 'api', replyTo: question.id, body: 'Answer'}, async () => {});
  assert.equal(reply.reply_expected, 0);
  assert.equal(replyLabel(store.messageDetails(question.id)), 'REPLIED');
  assert.equal(deliveryLabel(store.messageDetails(reply.id)), 'QUEUED');
});

test('the human inbox spans workspaces and keeps read, reply and done states separate', async t => {
  const store = fixture(t);
  const other = store.createSpace('Other workspace');
  store.addMember(other.id, {threadId: 'front', name: 'other frontend'});
  const question = await sendMessage(store, {spaceId: other.id, senderId: 'front', to: 'human', body: 'Decision?', replyExpected: true});
  const info = await sendMessage(store, {spaceId: 'default', senderId: 'api', to: 'human', body: 'FYI', replyExpected: false});
  const legacy = await sendMessage(store, {spaceId: 'default', senderId: 'front', to: 'human', body: 'Unspecified'});
  let inbox = store.humanInbox();
  assert.deepEqual(inbox.map(item => item.space_name), ['Other workspace', 'My Workspace', 'My Workspace']);
  assert.equal(replyLabel(inbox[0]), 'NEEDS REPLY');
  assert.equal(humanNeedsAttention(inbox[0]), true);
  assert.equal(humanNeedsAttention(inbox[1]), false);
  assert.equal(replyLabel(inbox[2]), 'UNREPLIED');
  store.markHumanMessageRead(other.id, question.id);
  assert.equal(humanNeedsAttention(store.messageDetails(question.id)), true, 'reading is not a reply');
  assert.equal(store.setHumanMessageResolved('default', question.id, true), false, 'a different workspace cannot resolve the message');
  assert.equal(store.setHumanMessageResolved(other.id, question.id, true), true);
  assert.equal(replyLabel(store.messageDetails(question.id)), 'DONE');
  assert.equal(humanNeedsAttention(store.messageDetails(question.id)), false);
  assert.equal(store.setHumanMessageResolved(other.id, question.id, false), true);
  await replyMessage(store, {spaceId: other.id, senderId: 'human', replyTo: question.id, body: 'Yes'}, async () => {});
  inbox = store.humanInbox();
  assert.equal(replyLabel(inbox.find(item => item.id === question.id)), 'REPLIED');
  assert.equal(humanNeedsAttention(inbox.find(item => item.id === question.id)), false);
  assert.equal(store.message(info.id).reply_expected, 0);
  assert.equal(store.message(legacy.id).reply_expected, null);
});

test('existing messages migrate without inventing a reply requirement', t => {
  const dir = mkdtempSync(join(tmpdir(), 'anle-migrate-'));
  let store = new Store(dir);
  const original = store.createMessage({spaceId: 'default', sender: {id: 'agent', name: 'agent'}, recipient: {id: 'human', name: 'human'}, body: 'Existing question'});
  const reply = store.createMessage({spaceId: 'default', sender: {id: 'human', name: 'human'}, recipient: {id: 'agent', name: 'agent'}, body: 'Existing reply', replyTo: original.id});
  store.db.exec('DROP TRIGGER messages_fill_conversation; ALTER TABLE messages DROP COLUMN reply_expected');
  store.close();
  store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  assert.equal(store.message(original.id).reply_expected, null);
  assert.equal(store.message(reply.id).reply_expected, 0);
  assert.equal(store.humanInbox()[0].body, 'Existing question');
});

test('interrupted sends become uncertain without retrying or changing active sends', t => {
  const store = fixture(t);
  const sender = {id: 'front', name: 'frontend'};
  const recipient = {id: 'api', name: 'backend'};
  const stale = store.createMessage({spaceId: 'default', sender, recipient, body: 'Interrupted', replyExpected: true});
  const active = store.createMessage({spaceId: 'default', sender, recipient, body: 'Still sending', replyExpected: true});
  store.db.prepare('UPDATE messages SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 180000).toISOString(), stale.id);
  assert.equal(store.recoverStaleDeliveries(), 1);
  assert.equal(store.message(stale.id).state, 'unknown');
  assert.equal(replyLabel(store.messageDetails(stale.id)), null);
  assert.equal(store.message(active.id).state, 'pending');
});
