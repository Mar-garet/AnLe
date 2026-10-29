import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
const split = value => [...segmenter.segment(String(value || ''))].map(part => part.segment);

export function editDraft(draft = {text: '', cursor: 0}, action, input = '') {
  const chars = split(draft.text);
  let cursor = Math.max(0, Math.min(chars.length, draft.cursor ?? chars.length));
  if (action === 'insert') {
    const added = split(String(input).replaceAll('\r\n', '\n').replaceAll('\r', '\n'));
    return {text: chars.slice(0, cursor).join('') + added.join('') + chars.slice(cursor).join(''), cursor: cursor + added.length};
  } else if (action === 'backspace' && cursor > 0) {
    chars.splice(--cursor, 1);
  } else if (action === 'delete' && cursor < chars.length) {
    chars.splice(cursor, 1);
  } else if (action === 'left') cursor = Math.max(0, cursor - 1);
  else if (action === 'right') cursor = Math.min(chars.length, cursor + 1);
  else if (action === 'home') cursor = 0;
  else if (action === 'end') cursor = chars.length;
  return {text: chars.join(''), cursor};
}

export function draftViewport(draft, width) {
  const chars = split(draft?.text).map(char => char === '\n' ? '↵' : char === '\t' ? ' ' : char);
  const cursor = Math.max(0, Math.min(chars.length, draft?.cursor ?? chars.length));
  const size = Math.max(1, width);
  const leftBudget = Math.floor((size - 1) * 0.65);
  let start = cursor;
  let end = cursor;
  let used = 1;
  while (start > 0 && used - 1 + stringWidth(chars[start - 1]) <= leftBudget) used += stringWidth(chars[--start]);
  while (end < chars.length && used + stringWidth(chars[end]) <= size) used += stringWidth(chars[end++]);
  while (start > 0 && used + stringWidth(chars[start - 1]) <= size) used += stringWidth(chars[--start]);
  return `${chars.slice(start, cursor).join('')}▌${chars.slice(cursor, end).join('')}`;
}
