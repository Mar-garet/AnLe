import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {peerList, sendMessage, welcomeText} from '../src/messaging.js';
import {ensureReviewerPair, prepareReviewer} from '../src/reviewer.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'anle-paired-cr-'));
  const store = new Store(dir);
  store.addMember('default', {threadId: 'dev', name: 'backend', cwd: '/repo/backend'});
  const calls = [];
  let count = 0;
  let status = 'idle';
  const client = {async request(method, params) {
    calls.push({method, params});
    if (method === 'config/read') return {config: {developer_instructions: 'Follow existing project rules.'}};
    if (method === 'thread/start') return {thread: {id: `cr-${++count}`}};
    if (method === 'thread/name/set') return {};
    if (method === 'thread/read') return {thread: {id: params.threadId, cwd: '/repo/backend', status: {type: status}}};
    if (method === 'thread/resume') { status = 'idle'; return {thread: {id: params.threadId}}; }
    throw new Error(`Unexpected ${method}`);
  }};
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  return {store, client, calls, setStatus: value => { status = value; }};
}

test('creates exactly one discoverable CR per coding session and workspace', async t => {
  const {store, client, calls} = fixture(t);
  store.setReviewSettings('default', 'Reuse existing auth helpers.');
  const [first, simultaneous] = await Promise.all([
    ensureReviewerPair({store, spaceId: 'default', developerId: 'dev', client}),
    ensureReviewerPair({store, spaceId: 'default', developerId: 'dev', client}),
  ]);
  assert.equal(first.reviewer.name, 'backend CR');
  assert.equal(simultaneous.pair.status, 'creating');
  assert.equal(calls.filter(call => call.method === 'thread/start').length, 1);
  const params = calls.find(call => call.method === 'thread/start').params;
  assert.equal(params.cwd, '/repo/backend');
  assert.equal(params.sandbox, 'read-only');
  assert.match(params.developerInstructions, /Follow existing project rules/);
  assert.doesNotMatch(params.developerInstructions, /Reuse existing auth helpers/, 'workspace rules are supplied per message so they can be changed');
  assert.match(params.developerInstructions, /base branch\/ref, development branch\/ref/);
  assert.ok(!calls.some(call => call.method === 'turn/start'), 'pairing should not consume a model turn');
  const peers = peerList(store, 'default');
  assert.deepEqual(peers.find(peer => peer.id === 'dev').reviewer, {id: 'cr-1', name: 'backend CR', status: 'ready'});
  assert.deepEqual(peers.find(peer => peer.id === 'cr-1').reviewer_for, {id: 'dev', name: 'backend'});
  const introduction = welcomeText(store.space('default'), store.member('default', 'dev'), {reviewer: first.reviewer});
  assert.match(introduction, /After meaningful code changes/);
  assert.match(introduction, /project background.*base branch\/ref.*development branch\/ref/);
  assert.match(introduction, /initial round and one re-review/);
  const second = store.createSpace('Other');
  store.addMember(second.id, {threadId: 'dev', name: 'api', cwd: '/repo/backend'});
  const other = await ensureReviewerPair({store, spaceId: second.id, developerId: 'dev', client});
  assert.equal(other.reviewer.name, 'api CR');
  assert.notEqual(other.reviewer.thread_id, first.reviewer.thread_id);
  assert.throws(() => store.claimReviewerPair('default', first.reviewer.thread_id), /coding session/);
});

test('ordinary messages carry explicit project and branch context to the assigned CR', async t => {
  const {store, client} = fixture(t);
  store.setReviewSettings('default', 'Reuse existing auth helpers.');
  await ensureReviewerPair({store, spaceId: 'default', developerId: 'dev', client});
  const delivered = [];
  const message = await sendMessage(store, {spaceId: 'default', senderId: 'dev', to: 'backend CR', body: 'Review the authentication change.', replyExpected: true,
    reviewContext: {project_background: 'A shared login service', base_branch: 'main', development_branch: 'feature/login'}}, async (id, text) => delivered.push({id, text}));
  assert.equal(message.recipient_id, 'cr-1');
  assert.match(message.body, /Project background: A shared login service/);
  assert.match(message.body, /Base branch\/ref: main/);
  assert.match(message.body, /Development branch\/ref: feature\/login/);
  assert.match(delivered[0].text, /independent code reviewer/);
  assert.match(delivered[0].text, /Reuse existing auth helpers/);
  await assert.rejects(sendMessage(store, {spaceId: 'default', senderId: 'dev', to: 'backend CR', body: 'Review', reviewContext: {project_background: 'API', base_branch: 'main'}}, async () => {}), /Development branch/);
});

test('restarts an offline CR with read-only policy and its preset', async t => {
  const {store, client, calls, setStatus} = fixture(t);
  await ensureReviewerPair({store, spaceId: 'default', developerId: 'dev', client});
  setStatus('notLoaded');
  await prepareReviewer(client, store, 'default', 'cr-1');
  const resume = calls.find(call => call.method === 'thread/resume').params;
  assert.equal(resume.sandbox, 'read-only');
  assert.equal(resume.approvalPolicy, 'never');
  assert.match(resume.developerInstructions, /Dedicated CR/);
});

test('renaming and removing a coding node keeps its CR pair consistent', async t => {
  const {store, client} = fixture(t);
  await ensureReviewerPair({store, spaceId: 'default', developerId: 'dev', client});
  store.updateMember('default', 'dev', {name: 'service', role: 'API'});
  assert.equal(store.member('default', 'cr-1').name, 'service CR');
  store.removeMember('default', 'dev');
  assert.equal(store.member('default', 'cr-1'), undefined);
  assert.equal(store.reviewerPair('default', 'dev'), undefined);
});

test('removing just the CR disables recreation and uncertain creation is not repeated', async t => {
  const {store, client} = fixture(t);
  await ensureReviewerPair({store, spaceId: 'default', developerId: 'dev', client});
  store.removeMember('default', 'cr-1');
  assert.equal(store.reviewerPair('default', 'dev').status, 'disabled');
  assert.equal((await ensureReviewerPair({store, spaceId: 'default', developerId: 'dev', client})).pair.status, 'disabled');
  const reenabled = await ensureReviewerPair({store, spaceId: 'default', developerId: 'dev', client, retry: true});
  assert.equal(reenabled.reviewer.thread_id, 'cr-2');
  assert.equal(reenabled.pair.intro_state, 'pending');
  store.addMember('default', {threadId: 'other', name: 'frontend', cwd: '/repo/frontend'});
  let starts = 0;
  const request = client.request;
  client.request = async (method, params) => {
    if (method === 'thread/start') { starts++; throw new Error('Codex request timed out'); }
    return request(method, params);
  };
  await assert.rejects(ensureReviewerPair({store, spaceId: 'default', developerId: 'other', client}), /timed out/);
  assert.equal(store.reviewerPair('default', 'other').status, 'unknown');
  await ensureReviewerPair({store, spaceId: 'default', developerId: 'other', client, retry: true});
  assert.equal(starts, 1);
});
