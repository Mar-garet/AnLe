import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexClient} from '../src/codex.js';

test('lists live sessions that have not yet been saved to thread history', async () => {
  const client = new CodexClient('/unused');
  const calls = [];
  client.request = async (method, params) => {
    calls.push({method, params});
    if (method === 'thread/list' && !params.cursor) {
      return {data: [{id: 'saved', cwd: '/repo/old', updatedAt: 10, status: {type: 'notLoaded'}}], nextCursor: 'next'};
    }
    if (method === 'thread/list') return {data: [], nextCursor: null};
    if (method === 'thread/loaded/list') return {data: ['front', 'back']};
    if (method === 'thread/read') {
      return {thread: {id: params.threadId, cwd: `/repo/${params.threadId}`, updatedAt: 20, status: {type: 'idle'}}};
    }
    throw new Error(`Unexpected request: ${method}`);
  };

  const threads = await client.listThreads();
  assert.deepEqual(threads.map(thread => thread.id), ['front', 'back', 'saved']);
  assert.equal(threads[0].cwd, '/repo/front');
  assert.equal(threads[1].status.type, 'idle');
  assert.deepEqual(calls.filter(call => call.method === 'thread/read').map(call => call.params.threadId), ['front', 'back']);
});

test('ignores a loaded session that closes while its metadata is being read', async () => {
  const client = new CodexClient('/unused');
  client.request = async method => {
    if (method === 'thread/list') return {data: [], nextCursor: null};
    if (method === 'thread/loaded/list') return {data: ['gone']};
    if (method === 'thread/read') throw new Error('thread not found');
    throw new Error(`Unexpected request: ${method}`);
  };
  assert.deepEqual(await client.listThreads(), []);
});
