import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReviewSnapshot, currentReviewFingerprint} from '../src/review-snapshot.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'anle-review-snapshot-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8'}).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.test');
  writeFileSync(join(repo, 'tracked.txt'), 'original\n');
  writeFileSync(join(repo, 'literal[1].txt'), 'initial\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return {dir, repo, git};
}

test('captures staged, unstaged, untracked and symlink changes without modifying the source', async t => {
  const {dir, repo, git} = fixture(t);
  writeFileSync(join(repo, 'tracked.txt'), 'staged\n');
  git('add', 'tracked.txt');
  writeFileSync(join(repo, 'tracked.txt'), 'staged and unstaged\n');
  writeFileSync(join(repo, 'new file.txt'), 'new file\n');
  writeFileSync(join(repo, 'ignored.txt'), 'ignored secret\n');
  symlinkSync('tracked.txt', join(repo, 'new-link'));
  const before = git('status', '--porcelain=v1');
  const snapshot = await createReviewSnapshot({cwd: repo, destination: join(dir, 'snapshots', 'round-1')});
  assert.equal(git('status', '--porcelain=v1'), before);
  assert.equal(readFileSync(join(snapshot.snapshotPath, 'tracked.txt'), 'utf8'), 'staged and unstaged\n');
  assert.equal(readFileSync(join(snapshot.snapshotPath, 'new file.txt'), 'utf8'), 'new file\n');
  assert.equal(readlinkSync(join(snapshot.snapshotPath, 'new-link')), 'tracked.txt');
  assert.throws(() => lstatSync(join(snapshot.snapshotPath, 'ignored.txt')), {code: 'ENOENT'});
  assert.match(execFileSync('git', ['-C', snapshot.snapshotPath, 'diff', '--cached'], {encoding: 'utf8'}), /\+staged/);
  assert.match(execFileSync('git', ['-C', snapshot.snapshotPath, 'diff'], {encoding: 'utf8'}), /\+staged and unstaged/);
  assert.ok(snapshot.changedPaths.includes('tracked.txt'));
  assert.ok(snapshot.untracked.includes('new file.txt'));
  assert.equal(await currentReviewFingerprint(repo), snapshot.fingerprint);
  writeFileSync(join(repo, 'tracked.txt'), 'changed after snapshot\n');
  assert.notEqual(await currentReviewFingerprint(repo), snapshot.fingerprint);
  assert.equal(readFileSync(join(snapshot.snapshotPath, 'tracked.txt'), 'utf8'), 'staged and unstaged\n');
});

test('captures only literal selected paths and never deletes an existing destination', async t => {
  const {dir, repo} = fixture(t);
  writeFileSync(join(repo, 'tracked.txt'), 'other change\n');
  writeFileSync(join(repo, 'literal[1].txt'), 'selected change\n');
  const snapshot = await createReviewSnapshot({cwd: repo, destination: join(dir, 'snapshots', 'selected'), paths: ['literal[1].txt']});
  assert.deepEqual(snapshot.changedPaths, ['literal[1].txt']);
  assert.equal(readFileSync(join(snapshot.snapshotPath, 'tracked.txt'), 'utf8'), 'original\n');
  assert.equal(readFileSync(join(snapshot.snapshotPath, 'literal[1].txt'), 'utf8'), 'selected change\n');
  const existing = join(dir, 'existing');
  mkdirSync(existing);
  writeFileSync(join(existing, 'keep'), 'keep');
  await assert.rejects(createReviewSnapshot({cwd: repo, destination: existing}), {code: 'EEXIST'});
  assert.equal(readFileSync(join(existing, 'keep'), 'utf8'), 'keep');
  await assert.rejects(createReviewSnapshot({cwd: repo, destination: join(repo, 'inside')}), /outside the source repository/);
  await assert.rejects(createReviewSnapshot({cwd: repo, destination: join(dir, 'unsafe'), paths: ['../other']}), /repository-relative/);
});

test('supports committed changes against an explicit base', async t => {
  const {dir, repo, git} = fixture(t);
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'tracked.txt'), 'second commit\n');
  git('add', 'tracked.txt');
  git('commit', '-qm', 'second');
  const snapshot = await createReviewSnapshot({cwd: repo, destination: join(dir, 'committed'), base});
  assert.equal(snapshot.baseOid, base);
  assert.deepEqual(snapshot.changedPaths, ['tracked.txt']);
  assert.equal(readFileSync(join(snapshot.snapshotPath, 'tracked.txt'), 'utf8'), 'second commit\n');
});

test('includes intent-to-add files in the snapshot and changed paths', async t => {
  const {dir, repo, git} = fixture(t);
  writeFileSync(join(repo, 'planned.txt'), 'new content\n');
  git('add', '-N', 'planned.txt');
  const before = git('status', '--porcelain=v1');
  const snapshot = await createReviewSnapshot({cwd: repo, destination: join(dir, 'intent-to-add')});
  assert.equal(readFileSync(join(snapshot.snapshotPath, 'planned.txt'), 'utf8'), 'new content\n');
  assert.deepEqual(snapshot.changedPaths, ['planned.txt']);
  assert.deepEqual(snapshot.untracked, ['planned.txt']);
  assert.equal(git('status', '--porcelain=v1'), before);
});

test('keeps renamed, deleted and Unicode paths in the fixed snapshot', async t => {
  const {dir, repo, git} = fixture(t);
  git('mv', 'tracked.txt', 'renamed 代码.txt');
  writeFileSync(join(repo, 'renamed 代码.txt'), 'edited after rename\n');
  rmSync(join(repo, 'literal[1].txt'));
  writeFileSync(join(repo, '新文件.txt'), 'new\n');
  const before = git('status', '--porcelain=v1');
  const snapshot = await createReviewSnapshot({cwd: repo, destination: join(dir, 'renamed')});
  assert.equal(readFileSync(join(snapshot.snapshotPath, 'renamed 代码.txt'), 'utf8'), 'edited after rename\n');
  assert.equal(readFileSync(join(snapshot.snapshotPath, '新文件.txt'), 'utf8'), 'new\n');
  assert.throws(() => lstatSync(join(snapshot.snapshotPath, 'tracked.txt')), {code: 'ENOENT'});
  assert.throws(() => lstatSync(join(snapshot.snapshotPath, 'literal[1].txt')), {code: 'ENOENT'});
  assert.equal(git('status', '--porcelain=v1'), before);
});
