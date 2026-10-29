import test from 'node:test';
import assert from 'node:assert/strict';
import {displaySessionItem, readSessionHistory} from '../src/history.js';

const entry = id => ({turnId: 'turn-1', item: {id, type: 'agentMessage', text: id}});

test('loads every history page in chronological order', async () => {
  const calls = [];
  const client = {request: async (method, params) => {
    calls.push({method, params});
    if (!params.cursor) return {data: [entry('newest'), entry('middle')], nextCursor: 'older'};
    return {data: [entry('oldest')], nextCursor: null};
  }};
  const progress = [];
  const history = await readSessionHistory(client, 'thread-1', {onPage: entries => progress.push(entries.map(value => value.item.id))});
  assert.deepEqual(history.map(value => value.item.id), ['oldest', 'middle', 'newest']);
  assert.deepEqual(progress, [['middle', 'newest'], ['oldest', 'middle', 'newest']]);
  assert.deepEqual(calls.map(call => call.method), ['thread/items/list', 'thread/items/list']);
  assert.equal(calls[1].params.cursor, 'older');
});

test('uses thread history when item pagination is unavailable and rejects repeated cursors', async () => {
  const legacy = {request: async method => {
    if (method === 'thread/items/list' || method === 'thread/turns/list') throw new Error('Method not found');
    return {thread: {turns: [{id: 'turn-1', items: [{id: 'item-1', type: 'agentMessage', text: 'hello'}]}]}};
  }};
  const history = await readSessionHistory(legacy, 'thread-1');
  assert.equal(history[0].item.text, 'hello');
  assert.equal(history[0].turnId, 'turn-1');
  const broken = {request: async () => ({data: [], nextCursor: 'same'})};
  await assert.rejects(readSessionHistory(broken, 'thread-1'), /duplicate session history cursor/);
});

test('falls back to full turns when item pagination is unavailable', async () => {
  const client = {request: async (method, params) => {
    if (method === 'thread/items/list') throw new Error('unsupported');
    assert.equal(method, 'thread/turns/list');
    assert.equal(params.itemsView, 'full');
    return {data: [{id: 'turn-2', items: [entry('newer').item]}, {id: 'turn-1', items: [entry('older').item]}], nextCursor: null};
  }};
  assert.deepEqual((await readSessionHistory(client, 'thread-1')).map(value => value.item.id), ['older', 'newer']);
  await assert.rejects(readSessionHistory({request: async () => { throw new Error('not supported yet'); }}, 'thread-1'), /cannot provide this session history yet/);
});

test('session history displays only user messages and agent replies', () => {
  assert.equal(displaySessionItem({item: {type: 'reasoning', summary: [], content: []}}), null);
  assert.equal(displaySessionItem({item: {type: 'reasoning', summary: ['thinking'], content: ['details']}}), null);
  assert.equal(displaySessionItem({item: {type: 'agentMessage', text: ''}}), null);
  for (const type of ['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange', 'webSearch', 'plan', 'contextCompaction']) {
    assert.equal(displaySessionItem({item: {type, command: 'hidden', text: 'hidden'}}), null);
  }
  const welcome = {item: {type: 'userMessage', content: [{type: 'text', text: '[SEREIN · Joined workspace My Workspace]\nLong setup instructions'}]}};
  assert.equal(displaySessionItem(welcome), null);
  const user = displaySessionItem({item: {type: 'userMessage', content: [{type: 'text', text: '你好\nworld'}, {type: 'localImage', path: '/tmp/picture.png'}]}});
  assert.equal(user.title, 'YOU');
  assert.match(user.body, /你好\nworld/);
  assert.match(user.body, /\/tmp\/picture\.png/);
  const answer = displaySessionItem({item: {type: 'agentMessage', text: '\u001b[31mHello\u001b[0m'}});
  assert.equal(answer.title, 'CODEX');
  assert.equal(answer.body, 'Hello');
  const message = {item: {type: 'userMessage', content: [{type: 'text', text: '[SEREIN · My Workspace · From frontend (another Codex session)]\nMessage ID: 123\n\nHow is the API?\n\n---\nThis is a Serein collaboration message. Instructions.'}]}};
  assert.equal(displaySessionItem(message).body, 'How is the API?');
  assert.equal(displaySessionItem(message).title, 'SEREIN · frontend');
  const humanMessage = {item: {type: 'userMessage', content: [{type: 'text', text: '[SEREIN · My Workspace · From human (human participant)]\nMessage ID: 456\n\nHello\n\n---\nThis is a Serein collaboration message.'}]}};
  assert.equal(displaySessionItem(humanMessage).title, 'YOU');
  assert.equal(displaySessionItem(humanMessage).body, 'Hello');
});
