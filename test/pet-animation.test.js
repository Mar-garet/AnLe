import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {PET_COMPACT_WIDTH, PET_FRAME_COUNT, PET_SCENE_WIDTH, petFrame} from '../src/pet-animation.js';

test('the dogs meet, play-fight, and move apart before the scene repeats', () => {
  const apart = petFrame(0);
  const approaching = petFrame(6);
  const fighting = petFrame(8);
  const leaving = petFrame(20);
  const rested = petFrame(23);
  const gap = frame => frame.leX - frame.anX - 5;
  assert.equal(apart.phase, 'apart');
  assert.equal(approaching.phase, 'approaching');
  assert.equal(fighting.phase, 'fighting');
  assert.equal(leaving.phase, 'leaving');
  assert.ok(gap(approaching) < gap(apart));
  assert.ok(gap(fighting) < gap(approaching));
  assert.ok(gap(leaving) > gap(fighting));
  assert.equal(gap(rested), gap(apart));
  assert.ok(fighting.rows.flat().some(run => run.color === 'hit'));
  assert.deepEqual(petFrame(PET_FRAME_COUNT), apart);
});

test('all animation frames fit their terminal area, including the narrow layout', () => {
  for (const width of [PET_COMPACT_WIDTH, PET_SCENE_WIDTH]) {
    const pictures = new Set();
    for (let tick = 0; tick < PET_FRAME_COUNT; tick++) {
      const {rows} = petFrame(tick, width);
      assert.equal(rows.length, 3);
      assert.ok(rows.every(row => stringWidth(row.map(run => run.text).join('')) === width));
      assert.ok(rows.flat().some(run => run.color === 'an'));
      assert.ok(rows.flat().some(run => run.color === 'le'));
      pictures.add(rows.map(row => row.map(run => run.text).join('')).join('\n'));
    }
    assert.ok(pictures.size > 3, 'the pets should visibly move');
  }
});
