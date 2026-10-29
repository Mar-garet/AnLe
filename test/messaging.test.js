import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {peerList, replyMessage, resolveAgentSpace, sendMessage, welcomeText} from '../src/messaging.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'serein-test-'));
  const store = new Store(dir);
  const space = store.spaces()[0];
  store.addMember(space.id, {threadId: 'thread-front', name: 'front', role: '前端', cwd: '/repo/shared'});
  store.addMember(space.id, {threadId: 'thread-api', name: 'api', role: '后端', cwd: '/repo/shared'});
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  return {store, space};
}

test('several sessions can share a repository and belong to separate spaces', t => {
  const {store, space} = fixture(t);
  assert.equal(store.members(space.id).length, 2);
  assert.deepEqual(peerList(store, space.id).map(peer => peer.name), ['human', 'front', 'api']);
  assert.equal(resolveAgentSpace(store, 'thread-front').id, space.id);
  const other = store.createSpace('另一个项目');
  store.addMember(other.id, {threadId: 'thread-front', name: 'client'});
  assert.throws(() => resolveAgentSpace(store, 'thread-front'), /multiple workspaces/);
  assert.equal(resolveAgentSpace(store, 'thread-front', other.id).id, other.id);
  assert.throws(() => resolveAgentSpace(store, 'thread-api', other.id), /not in this workspace/);
});

test('questions and replies retain sender, recipient and correlation', async t => {
  const {store, space} = fixture(t);
  const deliveries = [];
  const queue = async (thread, text) => deliveries.push({thread, text});
  const question = await sendMessage(store, {spaceId: space.id, senderId: 'thread-front', to: 'api', body: '状态字段为什么为空？'}, queue);
  assert.equal(question.state, 'queued');
  assert.equal(deliveries[0].thread, 'thread-api');
  assert.match(deliveries[0].text, /From front/);
  assert.match(deliveries[0].text, /状态字段为什么为空/);
  const reply = await replyMessage(store, {spaceId: space.id, senderId: 'thread-api', replyTo: question.id, body: '已定位问题。'}, queue);
  assert.equal(reply.reply_to, question.id);
  assert.equal(deliveries[1].thread, 'thread-front');
  assert.match(deliveries[1].text, /no automatic reply is needed/);
  await assert.rejects(replyMessage(store, {spaceId: space.id, senderId: 'thread-front', replyTo: question.id, body: '伪造回复'}, queue), /No message found to reply to/);
  const toHuman = await sendMessage(store, {spaceId: space.id, senderId: 'thread-api', to: 'human', body: '需要你的决定'}, queue);
  assert.equal(toHuman.state, 'delivered');
  assert.equal(deliveries.length, 2);
});

test('legacy default workspace name is updated without changing custom names or messages', t => {
  const dir = mkdtempSync(join(tmpdir(), 'serein-legacy-'));
  const original = new Store(dir);
  original.db.prepare('UPDATE spaces SET name = ? WHERE id = ?').run('我的协作空间', 'default');
  original.createSpace('My Workspace');
  original.addMember('default', {threadId: 'thread-legacy', name: '原始节点'});
  original.createMessage({spaceId: 'default', sender: {id: 'thread-legacy', name: '原始节点'}, recipient: {id: 'human', name: 'human'}, body: '保留原文'});
  original.close();
  const reopened = new Store(dir);
  t.after(() => { reopened.close(); rmSync(dir, {recursive: true, force: true}); });
  assert.equal(reopened.space('default').name, 'My Workspace 2');
  assert.equal(reopened.space('My Workspace').name, 'My Workspace');
  assert.equal(reopened.members('default')[0].name, '原始节点');
  assert.equal(reopened.messages('default')[0].body, '保留原文');
});

test('built-in introduction text is English while supplied content stays unchanged', t => {
  const {store, space} = fixture(t);
  const intro = welcomeText(space, {name: 'backend', role: 'API'});
  assert.doesNotMatch(intro, /\p{Script=Han}/u);
  assert.match(intro, /Joined workspace/);
});

test('a delivery failure stays visible in the message history', async t => {
  const {store, space} = fixture(t);
  await assert.rejects(sendMessage(store, {spaceId: space.id, senderId: 'thread-front', to: 'api', body: 'hello'}, async () => { throw new Error('离线'); }), /离线/);
  const [message] = store.messages(space.id);
  assert.equal(message.state, 'failed');
  assert.match(message.error, /离线/);
});

test('human inbox read state persists, is scoped to the workspace, and keeps all messages', t => {
  const dir = mkdtempSync(join(tmpdir(), 'serein-inbox-'));
  let store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const other = store.createSpace('Another');
  const sender = {id: 'thread-1', name: 'agent'};
  const human = {id: 'human', name: 'human'};
  const first = store.createMessage({spaceId: 'default', sender, recipient: human, body: 'Question'});
  const agentMessage = store.createMessage({spaceId: 'default', sender, recipient: {id: 'thread-2', name: 'other'}, body: 'Agent message'});
  assert.equal(store.markHumanMessageRead(other.id, first.id), false);
  assert.equal(store.markHumanMessageRead('default', agentMessage.id), false);
  assert.equal(store.markHumanMessageRead('default', first.id), true);
  assert.equal(store.markHumanMessageRead('default', first.id), false);
  for (let i = 0; i < 205; i++) store.createMessage({spaceId: 'default', sender, recipient: human, body: `Message ${i}`});
  assert.equal(store.messages('default').length, 100);
  assert.equal(store.messages('default', null).length, 207);
  store.close();
  store = new Store(dir);
  const messages = store.messages('default', null);
  assert.ok(messages.find(message => message.id === first.id).human_read_at);
  assert.equal(messages.at(-1).human_read_at, null);
  assert.equal(store.messages(other.id, null).length, 0);
});
