import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'anle-review-store-'));
  const store = new Store(dir);
  store.addMember('default', {threadId: 'developer', name: 'backend', cwd: '/repo/backend'});
  store.addMember('default', {threadId: 'reviewer', name: 'reviewer', cwd: '/repo/backend'});
  store.addMember('default', {threadId: 'other', name: 'other'});
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  return store;
}

test('review rounds retain findings and require explicit resolution of prior issues', t => {
  const store = fixture(t);
  const review = store.createReview({spaceId: 'default', developerId: 'developer', goal: 'Review login', repoRoot: '/repo/backend'});
  store.setReviewReviewer(review.id, 'reviewer');
  const snapshot = {snapshotPath: '/snapshot/1', fingerprint: 'hash1', headOid: 'head1', baseOid: 'base1', root: '/repo/backend', changedPaths: ['auth.js'], untracked: []};
  store.saveReviewRound(review.id, snapshot, 'request1');
  store.markReviewTurn(review.id, 1, 'turn1');
  assert.throws(() => store.submitReview({id: review.id, reviewerId: 'other', round: 1, summary: 'No issues', findings: [], freshness: 'current'}), /assigned reviewer/);
  const first = store.submitReview({id: review.id, reviewerId: 'reviewer', round: 1, summary: 'One issue', freshness: 'current', checked: ['auth.js'], unverified: ['integration'], findings: [
    {severity: 'P1', title: 'Token is never checked', path: 'auth.js', line: 3, detail: 'An unauthenticated request reaches the handler.'},
  ]});
  assert.equal(first.findings[0].id, 'F1');
  assert.equal(store.review(review.id).status, 'waiting');
  store.beginReviewRound(review.id, 'developer');
  store.saveReviewRound(review.id, {...snapshot, snapshotPath: '/snapshot/2', fingerprint: 'hash2'}, 'request2');
  store.markReviewTurn(review.id, 2, 'turn2');
  assert.throws(() => store.submitReview({id: review.id, reviewerId: 'reviewer', round: 2, summary: 'Done', findings: [], freshness: 'current'}), /previous open findings: F1/);
  assert.equal(store.review(review.id).status, 'running');
  assert.throws(() => store.submitReview({id: review.id, reviewerId: 'reviewer', round: 2, summary: 'Done', findings: [{id: 'F1', status: 'resolved'}], freshness: 'current'}), /Explain why/);
  const second = store.submitReview({id: review.id, reviewerId: 'reviewer', round: 2, summary: 'Fixed', freshness: 'stale', findings: [{id: 'F1', status: 'resolved', reason: 'The handler now rejects missing tokens.'}]});
  assert.equal(second.findings[0].status, 'resolved');
  assert.equal(second.freshness, 'stale');
  assert.deepEqual(store.reviewRounds(review.id).map(item => item.status), ['completed', 'completed']);
  assert.equal(JSON.parse(store.reviewRounds(review.id)[0].result_json).findings[0].status, 'open');
  assert.throws(() => store.submitReview({id: review.id, reviewerId: 'reviewer', round: 2, summary: 'Duplicate', findings: [], freshness: 'current'}), /not accepting/);
});

test('only the originating developer can start the next round', t => {
  const store = fixture(t);
  const review = store.createReview({spaceId: 'default', developerId: 'developer', goal: 'Review API', repoRoot: '/repo/backend'});
  store.setReviewReviewer(review.id, 'reviewer');
  store.saveReviewRound(review.id, {snapshotPath: '/snapshot', fingerprint: 'hash', headOid: 'head', baseOid: 'base', root: '/repo/backend', changedPaths: ['a'], untracked: []}, 'request');
  store.markReviewTurn(review.id, 1, 'turn');
  assert.throws(() => store.beginReviewRound(review.id, 'developer'), /not ready/);
  store.submitReview({id: review.id, reviewerId: 'reviewer', round: 1, summary: 'No findings', findings: [], freshness: 'unknown'});
  assert.throws(() => store.beginReviewRound(review.id, 'other'), /not ready/);
  assert.equal(store.beginReviewRound(review.id, 'developer').status, 'preparing');
  assert.throws(() => store.beginReviewRound(review.id, 'developer'), /not ready/);
});

test('removing a reviewer closes its review without deleting messages or the original session', t => {
  const store = fixture(t);
  const review = store.createReview({spaceId: 'default', developerId: 'developer', goal: 'Review API', repoRoot: '/repo/backend'});
  store.setReviewReviewer(review.id, 'reviewer');
  store.saveReviewRound(review.id, {snapshotPath: '/snapshot', fingerprint: 'hash', headOid: 'head', baseOid: 'base', root: '/repo/backend', changedPaths: ['a'], untracked: []}, 'request');
  store.markReviewTurn(review.id, 1, 'turn');
  store.removeMember('default', 'reviewer');
  assert.equal(store.review(review.id).status, 'closed');
  assert.equal(store.member('default', 'developer').name, 'backend');
  assert.equal(store.reviewRounds(review.id).length, 1);
  assert.throws(() => store.submitReview({id: review.id, reviewerId: 'reviewer', round: 1, summary: 'Done', findings: [], freshness: 'current'}), /assigned reviewer/);
});

test('review rules are scoped to their workspace and can be cleared', t => {
  const store = fixture(t);
  const second = store.createSpace('Other workspace');
  store.setReviewSettings('default', 'Check shared utilities');
  assert.equal(store.reviewSettings('default').instructions, 'Check shared utilities');
  assert.equal(store.reviewSettings(second.id).instructions, '');
  store.setReviewSettings('default', '');
  assert.equal(store.reviewSettings('default').instructions, '');
  assert.throws(() => store.setReviewSettings('missing', 'test'), /Workspace not found/);
});
