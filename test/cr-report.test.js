import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {reconcileCRReports} from '../src/cr-report.js';
import {formatDelivery, replyMessage, sendMessage} from '../src/messaging.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'anle-cr-report-'));
  const store = new Store(dir);
  store.addMember('default', {threadId: 'dev', name: 'backend', cwd: '/repo'});
  const claim = store.claimReviewerPair('default', 'dev');
  store.finishReviewerPair('default', 'dev', claim.pair.attempt_id, 'cr', '/repo', 'Reviewer');
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  return store;
}

function reviewTurn(store, request, {status = 'completed', result = 'No issues found.', phase = 'final_answer'} = {}) {
  return {id: 'turn-1', status, items: [
    {type: 'userMessage', content: [{type: 'text', text: formatDelivery(store.space('default'), request)}]},
    ...(result === null ? [] : [{type: 'agentMessage', phase, text: result}]),
  ]};
}

test('relays a completed CR response to the coding session even when there are no findings', async t => {
  const store = fixture(t);
  const request = await sendMessage(store, {spaceId: 'default', senderId: 'dev', to: 'cr', body: 'Please review', replyExpected: true}, async () => {});
  const sent = [];
  const client = {request: async () => ({data: [reviewTurn(store, request)]})};
  await Promise.all([
    reconcileCRReports(store, client, {queue: async (id, text) => sent.push({id, text})}),
    reconcileCRReports(store, client, {queue: async (id, text) => sent.push({id, text})}),
  ]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 'dev');
  assert.match(sent[0].text, /No issues found/);
  assert.equal(store.messageDetails(request.id).reply_state, 'replied');
  assert.equal(store.humanInbox().length, 0);
});

test('does not duplicate an explicit CR reply or an uncertain reply delivery', async t => {
  const store = fixture(t);
  const request = await sendMessage(store, {spaceId: 'default', senderId: 'dev', to: 'cr', body: 'Please review', replyExpected: true}, async () => {});
  await replyMessage(store, {spaceId: 'default', senderId: 'cr', replyTo: request.id, body: 'Found a bug.'}, async () => {});
  let calls = 0;
  await reconcileCRReports(store, {request: async () => { calls++; return {data: [reviewTurn(store, request)]}; }}, {queue: async () => { calls++; }});
  assert.equal(calls, 0);

  const second = await sendMessage(store, {spaceId: 'default', senderId: 'dev', to: 'cr', body: 'Review again', replyExpected: true}, async () => {});
  const uncertain = store.createMessage({spaceId: 'default', sender: {id: 'cr', name: 'backend CR'}, recipient: {id: 'dev', name: 'backend'}, body: 'Potential issue', replyTo: second.id});
  store.setMessageState(uncertain.id, 'unknown');
  await reconcileCRReports(store, {request: async () => { calls++; return {data: [reviewTurn(store, second)]}; }}, {queue: async () => { calls++; }});
  assert.equal(calls, 0, 'uncertain delivery must not be sent again');
});

test('reports incomplete work honestly and does not act on a running turn', async t => {
  const store = fixture(t);
  const request = await sendMessage(store, {spaceId: 'default', senderId: 'dev', to: 'cr', body: 'Review', replyExpected: true}, async () => {});
  let turn = reviewTurn(store, request, {status: 'inProgress', result: null});
  const sent = [];
  const client = {request: async () => ({data: [turn]})};
  await reconcileCRReports(store, client, {queue: async (id, text) => sent.push({id, text})});
  assert.equal(sent.length, 0);
  turn = reviewTurn(store, request, {status: 'completed', result: null});
  await reconcileCRReports(store, client, {queue: async (id, text) => sent.push({id, text})});
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /No clean result can be assumed/);
  assert.equal(store.humanInbox().length, 0);
});

test('reports a failed review without calling it clean', async t => {
  const store = fixture(t);
  const request = await sendMessage(store, {spaceId: 'default', senderId: 'dev', to: 'cr', body: 'Review', replyExpected: true}, async () => {});
  const turn = {...reviewTurn(store, request, {status: 'failed', result: null}), error: {message: 'Reviewer stopped'}};
  const sent = [];
  await reconcileCRReports(store, {request: async () => ({data: [turn]})}, {queue: async (id, text) => sent.push({id, text})});
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Reviewer stopped/);
  assert.match(sent[0].text, /Do not treat this as a clean review/);
  assert.equal(store.humanInbox().length, 0);
});

test('an interrupted fallback is marked uncertain and is not resent', async t => {
  const store = fixture(t);
  const request = await sendMessage(store, {spaceId: 'default', senderId: 'dev', to: 'cr', body: 'Review', replyExpected: true}, async () => {});
  store.db.prepare("UPDATE cr_report_requests SET state = 'sending', updated_at = '2020-01-01T00:00:00.000Z' WHERE message_id = ?").run(request.id);
  let sent = 0;
  await reconcileCRReports(store, {request: async () => ({data: [reviewTurn(store, request)]})}, {queue: async () => { sent++; }});
  assert.equal(sent, 0);
  assert.equal(store.db.prepare('SELECT state FROM cr_report_requests WHERE message_id = ?').get(request.id).state, 'unknown');
});

test('an answer to the CR’s clarification question remains tracked', async t => {
  const store = fixture(t);
  const question = store.createMessage({spaceId: 'default', sender: {id: 'cr', name: 'backend CR'}, recipient: {id: 'dev', name: 'backend'}, body: 'Which branch?', replyExpected: true});
  store.setMessageState(question.id, 'queued');
  const answer = await replyMessage(store, {spaceId: 'default', senderId: 'dev', replyTo: question.id, body: 'main'}, async () => {});
  assert.equal(store.pendingCRReports().some(item => item.id === answer.id), true);
});

test('after a human clarification, the CR outcome returns to the coding session', async t => {
  const store = fixture(t);
  const question = store.createMessage({spaceId: 'default', sender: {id: 'cr', name: 'backend CR'}, recipient: {id: 'human', name: 'human'}, body: 'Which policy?', replyExpected: true});
  const answer = await replyMessage(store, {spaceId: 'default', senderId: 'human', replyTo: question.id, body: 'Require authentication'}, async () => {});
  const sent = [];
  await reconcileCRReports(store, {request: async () => ({data: [reviewTurn(store, answer, {result: 'Authentication is correctly enforced.'})]})}, {queue: async (id, text) => sent.push({id, text})});
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 'dev');
  assert.match(sent[0].text, /Authentication is correctly enforced/);
  assert.equal(store.humanInbox().length, 1, 'the ordinary review outcome must not be copied back to the human');
});
