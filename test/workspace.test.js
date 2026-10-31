import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'serein-workspaces-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, {recursive: true, force: true}); });
  return store;
}

test('deleting a workspace removes its data without affecting another workspace', t => {
  const store = fixture(t);
  const other = store.createSpace('Other');
  const repository = join(store.dataDir, 'repository');
  mkdirSync(repository);
  writeFileSync(join(repository, 'file.txt'), 'keep the repository');
  store.addMember('default', {threadId: 'same-thread', name: 'front', cwd: repository});
  store.addMember(other.id, {threadId: 'same-thread', name: 'front', cwd: repository});
  store.updatePresence('default', 'same-thread', {task: 'Deleted workspace task', status: 'working'});
  store.updatePresence(other.id, 'same-thread', {task: 'Retained workspace task', status: 'blocked'});
  const message = store.createMessage({spaceId:'default', sender:{id:'same-thread', name:'front'}, recipient:{id:'human', name:'human'}, body:'Question'});
  store.markHumanMessageRead('default', message.id);
  const retained = store.createMessage({spaceId:other.id, sender:{id:'same-thread', name:'front'}, recipient:{id:'human', name:'human'}, body:'Keep me'});
  const result = store.deleteSpace('default');
  assert.equal(result.nextSpace.id, other.id);
  assert.equal(result.replacementCreated, false);
  assert.equal(store.space('default'), undefined);
  assert.equal(store.message(message.id), undefined);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM human_message_reads').get().count, 0);
  assert.equal(store.member(other.id, 'same-thread').cwd, repository);
  assert.equal(store.member(other.id, 'same-thread').current_task, 'Retained workspace task');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM member_presence').get().count, 1);
  assert.equal(store.message(retained.id).body, 'Keep me');
  assert.equal(readFileSync(join(repository, 'file.txt'), 'utf8'), 'keep the repository');
});

test('deleting the last workspace creates a new empty workspace atomically', t => {
  const store = fixture(t);
  store.addMember('default', {threadId: 'thread', name: 'agent'});
  store.createMessage({spaceId:'default', sender:{id:'thread', name:'agent'}, recipient:{id:'human', name:'human'}, body:'Question'});
  const result = store.deleteSpace('default');
  assert.equal(result.replacementCreated, true);
  assert.notEqual(result.nextSpace.id, 'default');
  assert.notEqual(result.nextSpace.name, 'My Workspace');
  assert.equal(store.spaces().length, 1);
  assert.deepEqual(store.members(result.nextSpace.id), []);
  assert.deepEqual(store.messages(result.nextSpace.id, null), []);
});

test('deleting a missing workspace leaves existing data intact', t => {
  const store = fixture(t);
  assert.throws(() => store.deleteSpace('missing'), /Workspace not found/);
  assert.equal(store.spaces().length, 1);
  assert.equal(store.spaces()[0].id, 'default');
});
