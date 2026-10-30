import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.js';

test('MCP uses Codex metadata to identify the sender and can reply to a human', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'serein-mcp-test-'));
  const store = new Store(dir);
  const space = store.spaces()[0];
  store.addMember(space.id, {threadId: 'thread-real', name: 'agent'});
  for (let n = 0; n < 35; n++) store.addMember(space.id, {threadId: `service-${n}`, name: `service-${n}`, role: 'backend'});
  const original = store.createMessage({spaceId: space.id, sender: {id: 'human', name: 'human'}, recipient: {id: 'thread-real', name: 'agent'}, body: 'question'});
  const script = fileURLToPath(new URL('../src/mcp-server.js', import.meta.url));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], {env: {...process.env, SEREIN_HOME: dir}, stdio: ['pipe', 'pipe', 'pipe']});
  const responses = new Map();
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const message = JSON.parse(line);
      const resolve = responses.get(message.id);
      if (resolve) { responses.delete(message.id); resolve(message); }
    }
  });
  let id = 0;
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => reject(new Error('MCP response timed out')), 5000);
      responses.set(requestId, value => { clearTimeout(timer); resolve(value); });
      child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: requestId, method, params})}\n`);
    });
  }
  t.after(() => { child.kill(); store.close(); rmSync(dir, {recursive: true, force: true}); });
  const init = await request('initialize', {protocolVersion: '2025-03-26'});
  assert.equal(init.result.serverInfo.name, 'anle');
  const noIdentity = await request('tools/call', {name: 'list_members', arguments: {space_id: space.id}});
  assert.equal(noIdentity.result.isError, true);
  const found = await request('tools/call', {name: 'list_members', arguments: {space_id: space.id, query: 'backend', limit: 5}, _meta: {threadId: 'thread-real'}});
  const page = JSON.parse(found.result.content[0].text);
  assert.equal(page.total, 35);
  assert.equal(page.members.length, 5);
  assert.equal(page.next_offset, 5);
  const reply = await request('tools/call', {name: 'reply_message', arguments: {space_id: space.id, reply_to: original.id, message: 'TEST_OK'}, _meta: {threadId: 'thread-real'}});
  assert.equal(reply.result.isError, undefined);
  assert.equal(store.messages(space.id).at(-1).body, 'TEST_OK');
  const wrongThread = await request('tools/call', {name: 'send_message', arguments: {space_id: space.id, to: 'human', message: 'spoof'}, _meta: {threadId: 'thread-other'}});
  assert.equal(wrongThread.result.isError, true);
});
