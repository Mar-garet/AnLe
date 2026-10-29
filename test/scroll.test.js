import test from 'node:test';
import assert from 'node:assert/strict';
import {MouseSequenceParser, positionForScrollbarRow, scrollbarGeometry} from '../src/scroll.js';

test('scrollbar thumb follows the visible position and maps clicks to content', () => {
  const top = scrollbarGeometry(100, 10, 0, 10);
  const middle = scrollbarGeometry(100, 10, 45, 10);
  const bottom = scrollbarGeometry(100, 10, 90, 10);
  assert.equal(top.thumbStart, 0);
  assert.equal(bottom.thumbStart, 9);
  assert.ok(middle.thumbStart > top.thumbStart && middle.thumbStart < bottom.thumbStart);
  assert.equal(positionForScrollbarRow(top, 0), 0);
  assert.equal(positionForScrollbarRow(top, 9), 90);
  assert.equal(scrollbarGeometry(3, 10, 0, 10).maxPosition, 0);
});

test('mouse parser handles split scroll and drag reports without treating paste as mouse input', () => {
  const parser = new MouseSequenceParser();
  assert.deepEqual(parser.push('abc\x1b[<64;5'), []);
  assert.deepEqual(parser.push('0;12M'), [{button: 64, x: 50, y: 12, release: false}]);
  assert.deepEqual(parser.push('\x1b[<0;90;10M\x1b[<32;90;15M\x1b[<0;90;15m'), [
    {button: 0, x: 90, y: 10, release: false},
    {button: 32, x: 90, y: 15, release: false},
    {button: 0, x: 90, y: 15, release: true},
  ]);
  assert.deepEqual(parser.push('\x1b[200~not a mouse \x1b[<64;1;1M\x1b[20'), []);
  assert.deepEqual(parser.push('1~\x1b[<65;8;9M'), [{button: 65, x: 8, y: 9, release: false}]);
});
