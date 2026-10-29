import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {compactNodeAt, directoryLines, sidebarNodeWindow} from '../src/sidebar.js';

const nodes = [
  {thread_id: 'human', name: 'human'},
  {thread_id: 'a', name: 'frontend', cwd: '/Users/example/very-long-project/前端'},
  {thread_id: 'b', name: 'backend', cwd: '/Users/example/backend'},
  {thread_id: 'c', name: 'another backend', cwd: '/Users/example/backend'},
];

test('directories retain their full absolute path across terminal-width wrapping', () => {
  const path = '/Users/example/中文项目/👩‍💻/frontend';
  const lines = directoryLines(path, 12);
  assert.equal(lines.join(''), path);
  assert.ok(lines.every(line => stringWidth(line) <= 12));
  assert.deepEqual(directoryLines('', 30), ['Directory unavailable']);
});

test('clicking a name or any wrapped path line selects the correct session', () => {
  const options = {width: 20, height: 21, selection: 0, nodes};
  const visible = sidebarNodeWindow({nodes, selection: 0, innerWidth: 16, rowCapacity: 10});
  const frontendRows = visible.rows.map((row, index) => ({row, y: index + 6})).filter(item => item.row.index === 1);
  assert.ok(frontendRows.length > 2);
  for (const {y} of frontendRows) assert.equal(compactNodeAt({...options, x: 5, y}), 1);
  const backendRow = visible.rows.findIndex(row => row.index === 2);
  assert.equal(compactNodeAt({...options, x: 5, y: backendRow + 6}), 2);
  assert.equal(compactNodeAt({...options, x: 1, y: 6}), null);
  assert.equal(compactNodeAt({...options, x: 5, y: 5}), null);
});

test('scrolling keeps the selected session and its directory together', () => {
  const options = {width: 24, height: 16, selection: 3, nodes};
  const visible = sidebarNodeWindow({nodes, selection: 3, innerWidth: 20, rowCapacity: 5});
  assert.equal(visible.rows[0].type, 'path');
  assert.equal(visible.rows[0].part, 0);
  const selected = visible.rows.filter(row => row.index === 3);
  assert.equal(selected[0].type, 'path');
  assert.equal(selected.at(-1).type, 'name');
  assert.equal(selected.filter(row => row.type === 'path').map(row => row.text).join(''), nodes[3].cwd);
  for (const row of selected) {
    const y = visible.rows.indexOf(row) + 6;
    assert.equal(compactNodeAt({...options, x: 5, y}), 3);
  }
  assert.equal(compactNodeAt({...options, x: 5, y: 11}), null);
});

test('paging exposes the end of a path longer than the viewport', () => {
  const longPath = `/tmp/${'long-directory/'.repeat(12)}last-segment`;
  const entries = [{thread_id: 'human'}, {thread_id: 'long', cwd: longPath}];
  const options = {nodes: entries, selection: 1, innerWidth: 16, rowCapacity: 5};
  const first = sidebarNodeWindow(options);
  const last = sidebarNodeWindow({...options, scrollShift: 100});
  assert.equal(first.rows[0].type, 'path');
  assert.ok(last.start > first.start);
  assert.ok(last.rows.map(row => row.text || '').join('').endsWith('last-segment'));
  assert.equal(last.rows.at(-1).type, 'name');
  assert.equal(compactNodeAt({x: 5, y: 6, width: 20, height: 16, nodes: entries, selection: 1, scrollShift: 100}), 1);
});
