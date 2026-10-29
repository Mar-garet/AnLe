import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {draftViewport, editDraft} from '../src/editor.js';

test('edits Chinese and emoji at the cursor without splitting graphemes', () => {
  let draft = editDraft(undefined, 'insert', '你好👩‍💻');
  draft = editDraft(draft, 'left');
  draft = editDraft(draft, 'insert', '，');
  assert.equal(draft.text, '你好，👩‍💻');
  draft = editDraft(draft, 'delete');
  assert.equal(draft.text, '你好，');
  draft = editDraft(draft, 'backspace');
  assert.equal(draft.text, '你好');
  draft = editDraft(draft, 'home');
  draft = editDraft(draft, 'insert', 'Hi ');
  assert.equal(draft.text, 'Hi 你好');
  assert.ok(stringWidth(draftViewport(draft, 6)) <= 6);
  assert.match(draftViewport(draft, 6), /▌/);
});

test('keeps pasted multiline input and places the cursor at the end', () => {
  const draft = editDraft(undefined, 'insert', '第一行\r\nsecond line');
  assert.equal(draft.text, '第一行\nsecond line');
  const atEnd = editDraft(draft, 'end');
  assert.ok(draftViewport(atEnd, 8).endsWith('▌'));
});
