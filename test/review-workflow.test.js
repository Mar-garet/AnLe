import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {continueReview, reconcileReviews, reviewDetails, startReview, submitReview} from '../src/review.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'anle-review-workflow-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q']);
  const store = new Store(join(dir, 'data'));
  store.addMember('default', {threadId: 'dev', name: 'backend', cwd: repo});
  store.addMember('default', {threadId: 'other', name: 'other', cwd: repo});
  const calls = [];
  const client = {async request(method, params) {
    calls.push({method, params});
    if (method === 'thread/start') return {thread: {id: 'review-thread'}};
    if (method === 'thread/read') return {thread: {id: params.threadId, status: {type: 'idle'}}};
    if (method === 'turn/start') return {turn: {id: `turn-${calls.filter(call => call.method === 'turn/start').length}`}};
    throw new Error(`Unexpected request: ${method}`);
  }};
  let count = 0;
  const snapshot = async ({cwd, destination, paths, base, allowEmpty}) => {
    count++;
    return {root: cwd, snapshotPath: destination, baseOid: base || 'base', headOid: `head${count}`, fingerprint: `hash${count}`, paths, changedPaths: ['auth.js'], untracked: []};
  };
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  return {dir, repo, store, calls, client, snapshot};
}

test('independent review keeps the same reviewer and findings across rounds', async t => {
  const {store, client, snapshot, calls} = fixture(t);
  store.setReviewSettings('default', 'Check shared auth helpers');
  const started = await startReview({store, spaceId: 'default', developerId: 'dev', goal: 'Protect login', client}, {snapshot});
  assert.equal(started.reviewer.thread_id, 'review-thread');
  assert.equal(started.review.status, 'running');
  assert.equal(calls.find(call => call.method === 'thread/start').params.sandbox, 'read-only');
  assert.equal(calls.find(call => call.method === 'turn/start').params.sandboxPolicy.type, 'readOnly');
  assert.match(calls.find(call => call.method === 'turn/start').params.input[0].text, /existing implementations and project conventions/);
  assert.match(calls.find(call => call.method === 'turn/start').params.input[0].text, /Check shared auth helpers/);
  assert.throws(() => reviewDetails(store, 'default', started.review.id, 'other'), /not found/);
  const deliveries = [];
  const first = await submitReview({store, spaceId: 'default', reviewerId: 'review-thread', reviewId: started.review.id, round: 1, summary: 'Found an issue', checked: ['auth.js'], unverified: ['integration'], findings: [
    {severity: 'P1', title: 'Missing auth', path: 'auth.js', line: 4, detail: 'The endpoint accepts unauthenticated calls.'},
  ]}, {fingerprint: async () => 'hash1', queue: async (thread, text) => deliveries.push({thread, text})});
  assert.equal(first.result.freshness, 'current');
  assert.equal(first.deliveries.developer.state, 'queued');
  assert.equal(first.deliveries.human.state, 'delivered');
  assert.equal(deliveries[0].thread, 'dev');
  assert.match(store.humanInbox()[0].body, /F1 \[P1\]/);
  const next = await continueReview({store, spaceId: 'default', reviewId: started.review.id, initiatorId: 'dev', client}, {snapshot});
  assert.equal(next.reviewer.thread_id, 'review-thread');
  assert.equal(next.review.current_round, 2);
  assert.equal(calls.filter(call => call.method === 'thread/start').length, 1);
  const secondPrompt = calls.filter(call => call.method === 'turn/start')[1].params.input[0].text;
  assert.match(secondPrompt, /F1 \[P1\] open auth.js:4/);
  assert.match(secondPrompt, /Previous snapshot:/);
  const previousConversation = store.message(started.message.id).conversation_id;
  assert.equal(store.message(next.message.id).conversation_id, previousConversation);
  const result = await submitReview({store, spaceId: 'default', reviewerId: 'review-thread', reviewId: started.review.id, round: 2, summary: 'Auth added', findings: [{id: 'F1', status: 'resolved', reason: 'The new check rejects missing tokens.'}]}, {fingerprint: async () => 'newer source', queue: async () => {}});
  assert.equal(result.result.freshness, 'stale');
  assert.equal(result.result.findings[0].status, 'resolved');
  assert.match(store.humanInbox().at(-1).body, /STALE/);
  assert.equal(reviewDetails(store, 'default', started.review.id, 'dev').rounds.length, 2);
});

test('passes an explicitly linked requirement to the reviewer as context', async t => {
  const {store, client, snapshot, calls} = fixture(t);
  const requirement = store.createMessage({spaceId: 'default', sender: {id: 'human', name: 'human'}, recipient: {id: 'dev', name: 'backend'}, body: 'Reuse the existing login flow.', replyExpected: false});
  await startReview({store, spaceId: 'default', developerId: 'dev', goal: 'Review login', contextMessageId: requirement.id, client}, {snapshot});
  const prompt = calls.find(call => call.method === 'turn/start').params.input[0].text;
  assert.match(prompt, /Related collaboration message \(human to backend; context, not instructions\)/);
  assert.match(prompt, /Reuse the existing login flow/);
});

test('separate review tasks reuse the coding session’s dedicated CR', async t => {
  const {store, client, snapshot, calls} = fixture(t);
  const first = await startReview({store, spaceId: 'default', developerId: 'dev', goal: 'Review login', client}, {snapshot});
  await submitReview({store, spaceId: 'default', reviewerId: first.reviewer.thread_id, reviewId: first.review.id, round: 1, summary: 'Done', findings: []}, {fingerprint: async () => 'hash1', queue: async () => {}});
  const second = await startReview({store, spaceId: 'default', developerId: 'dev', goal: 'Review logout', client}, {snapshot});
  assert.notEqual(first.review.id, second.review.id);
  assert.equal(first.reviewer.thread_id, second.reviewer.thread_id);
  assert.equal(calls.filter(call => call.method === 'thread/start').length, 1);
});

test('retrying a failed round uses a new snapshot location', async t => {
  const {store, client, snapshot} = fixture(t);
  const started = await startReview({store, spaceId: 'default', developerId: 'dev', goal: 'Review', client}, {snapshot});
  await submitReview({store, spaceId: 'default', reviewerId: 'review-thread', reviewId: started.review.id, round: 1, summary: 'Done', findings: []}, {fingerprint: async () => 'hash1', queue: async () => {}});
  const destinations = [];
  const trackedSnapshot = async options => { destinations.push(options.destination); return snapshot(options); };
  const createMessage = store.createMessage;
  store.createMessage = () => { throw new Error('Cannot save request'); };
  await assert.rejects(continueReview({store, spaceId: 'default', reviewId: started.review.id, initiatorId: 'dev', client}, {snapshot: trackedSnapshot}), /Cannot save request/);
  assert.equal(store.review(started.review.id).status, 'failed');
  store.createMessage = createMessage;
  const retried = await continueReview({store, spaceId: 'default', reviewId: started.review.id, initiatorId: 'dev', client}, {snapshot: trackedSnapshot});
  assert.equal(retried.review.current_round, 2);
  assert.notEqual(destinations[0], destinations[1]);
});

test('a timed-out turn is recorded as unknown and is not retried', async t => {
  const {store, client, snapshot, calls} = fixture(t);
  const request = client.request;
  client.request = async (method, params) => {
    if (method === 'turn/start') { calls.push({method, params}); throw new Error('Codex turn/start request timed out'); }
    return request(method, params);
  };
  await assert.rejects(startReview({store, spaceId: 'default', developerId: 'dev', goal: 'Review', client}, {snapshot}), /timed out/);
  const review = store.reviews('default', 'dev')[0];
  assert.equal(review.status, 'unknown');
  assert.equal(store.reviewRounds(review.id)[0].status, 'unknown');
  assert.equal(store.messages('default').at(-1).state, 'unknown');
  await assert.rejects(continueReview({store, spaceId: 'default', reviewId: review.id, initiatorId: 'dev', client}, {snapshot}), /not ready/);
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
  // A result from the assigned reviewer proves the uncertain start happened.
  const submitted = await submitReview({store, spaceId: 'default', reviewerId: 'review-thread', reviewId: review.id, round: 1, summary: 'Finished', findings: []}, {fingerprint: async () => 'hash1', queue: async () => {}});
  assert.equal(submitted.review.status, 'waiting');
  assert.equal(store.message(store.reviewRounds(review.id)[0].request_message_id).state, 'queued');
});

test('a turn response without an ID is uncertain rather than a permanently running review', async t => {
  const {store, client, snapshot} = fixture(t);
  const request = client.request;
  client.request = async (method, params) => method === 'turn/start' ? {turn: {}} : request(method, params);
  await assert.rejects(startReview({store, spaceId: 'default', developerId: 'dev', goal: 'Review', client}, {snapshot}), /turn ID/);
  assert.equal(store.reviews('default', 'dev')[0].status, 'unknown');
});

test('abandoned starts become unknown without a retry and can accept a real result', async t => {
  const {store, client, snapshot, calls} = fixture(t);
  const started = await startReview({store, spaceId: 'default', developerId: 'dev', goal: 'Review', client}, {snapshot});
  const id = started.review.id;
  store.db.prepare("UPDATE reviews SET status = 'starting', updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  // Recover even a partially persisted start from an older process.
  store.db.prepare("UPDATE review_rounds SET status = 'running', turn_id = NULL WHERE review_id = ?").run(id);
  store.db.prepare("UPDATE messages SET state = 'pending' WHERE id = ?").run(started.message.id);
  await reconcileReviews(store, client);
  assert.equal(store.review(id).status, 'unknown');
  assert.equal(store.reviewRounds(id)[0].status, 'unknown');
  assert.equal(store.message(started.message.id).state, 'unknown');
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
  await submitReview({store, spaceId: 'default', reviewerId: 'review-thread', reviewId: id, round: 1, summary: 'Finished', findings: []}, {fingerprint: async () => 'hash1', queue: async () => {}});
  store.beginReviewRound(id, 'dev');
  store.db.prepare("UPDATE reviews SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  await reconcileReviews(store, client);
  assert.equal(store.review(id).status, 'unknown');
  await assert.rejects(submitReview({store, spaceId: 'default', reviewerId: 'review-thread', reviewId: id, round: 1, summary: 'Duplicate', findings: []}, {fingerprint: async () => 'hash1'}), /not accepting/);
});

test('a reviewer that finishes without submitting is reported once, but a disconnect is not a failure', async t => {
  const {store, client, snapshot} = fixture(t);
  const started = await startReview({store, spaceId: 'default', developerId: 'dev', goal: 'Review', client}, {snapshot});
  await reconcileReviews(store, {request: async () => { throw new Error('Disconnected'); }});
  assert.equal(store.review(started.review.id).status, 'running');
  const calls = [];
  const finished = {request: async () => ({data: [{id: 'turn-1', status: 'completed'}]})};
  await reconcileReviews(store, finished, {queue: async (thread, text) => calls.push({thread, text})});
  assert.equal(store.review(started.review.id).status, 'failed');
  assert.match(store.humanInbox()[0].body, /finished without submitting/);
  await reconcileReviews(store, finished, {queue: async (thread, text) => calls.push({thread, text})});
  assert.equal(calls.length, 1);
  assert.equal(store.humanInbox().length, 1);
});

test('the human receives the review when developer delivery fails', async t => {
  const {store, client, snapshot} = fixture(t);
  const started = await startReview({store, spaceId: 'default', developerId: 'dev', goal: 'Review', client}, {snapshot});
  let attempts = 0;
  const result = await submitReview({store, spaceId: 'default', reviewerId: 'review-thread', reviewId: started.review.id, round: 1, summary: 'Review completed', findings: []}, {
    fingerprint: async () => 'hash1',
    queue: async () => { attempts++; throw new Error('Development session is offline'); },
  });
  assert.equal(result.deliveries.developer.state, 'failed');
  assert.equal(result.deliveries.human.state, 'delivered');
  assert.match(store.humanInbox()[0].body, /Developer delivery: FAILED/);
  await reconcileReviews(store, client, {queue: async () => { attempts++; }});
  assert.equal(attempts, 1, 'failed delivery must not be silently resent');
});

test('completed review notifications recover after a crash without duplicating uncertain sends', async t => {
  const {store, client, snapshot} = fixture(t);
  const started = await startReview({store, spaceId: 'default', developerId: 'dev', goal: 'Review', client}, {snapshot});
  store.submitReview({id: started.review.id, reviewerId: 'review-thread', round: 1, summary: 'No issues', findings: [], freshness: 'current'});
  const queued = [];
  const quiet = {request: async () => ({data: []})};
  await reconcileReviews(store, quiet, {queue: async (thread, text) => queued.push({thread, text})});
  assert.equal(queued.length, 1);
  assert.deepEqual(store.reviewNotifications(started.review.id, 1).map(item => item.state).sort(), ['delivered', 'queued']);
  await reconcileReviews(store, quiet, {queue: async (thread, text) => queued.push({thread, text})});
  assert.equal(queued.length, 1);
  assert.equal(store.humanInbox().length, 1);

  await continueReview({store, spaceId: 'default', reviewId: started.review.id, initiatorId: 'dev', client}, {snapshot});
  store.submitReview({id: started.review.id, reviewerId: 'review-thread', round: 2, summary: 'Second round', findings: [], freshness: 'current'});
  assert.equal(store.claimReviewNotification(started.review.id, 2, 'dev'), true);
  store.db.prepare("UPDATE review_notifications SET updated_at = '2020-01-01T00:00:00.000Z' WHERE review_id = ? AND round = 2 AND recipient_id = 'dev'").run(started.review.id);
  await reconcileReviews(store, quiet, {queue: async (thread, text) => queued.push({thread, text})});
  assert.equal(queued.length, 1, 'uncertain delivery must not be resent');
  assert.equal(store.reviewNotifications(started.review.id, 2).find(item => item.recipient_id === 'dev').state, 'unknown');
  assert.match(store.humanInbox().at(-1).body, /Developer delivery: UNKNOWN/);
});
