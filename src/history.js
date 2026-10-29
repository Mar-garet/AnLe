import {stripVTControlCharacters} from 'node:util';

// Read from the existing thread without resuming it or starting a turn.
export async function readSessionHistory(client, threadId, {onPage, isCancelled = () => false} = {}) {
  const pages = [];
  const cursors = new Set();
  let cursor = null;
  let first = true;
  do {
    if (isCancelled()) throw new Error('Session history request cancelled');
    let page;
    try {
      page = await client.request('thread/items/list', {threadId, cursor, limit: 100, sortDirection: 'desc'});
    } catch (error) {
      if (!first || !isUnsupported(error)) throw error;
      return readTurnHistory(client, threadId, {onPage, isCancelled});
    }
    if (isCancelled()) throw new Error('Session history request cancelled');
    if (!Array.isArray(page.data)) throw new Error('Codex returned an invalid session history page');
    pages.unshift([...page.data].reverse());
    onPage?.(pages.flat());
    cursor = page.nextCursor || null;
    if (cursor && cursors.has(cursor)) throw new Error('Codex returned a duplicate session history cursor');
    if (cursor) cursors.add(cursor);
    first = false;
  } while (cursor);
  return pages.flat();
}

async function readTurnHistory(client, threadId, {onPage, isCancelled}) {
  const pages = [];
  const cursors = new Set();
  let cursor = null;
  let first = true;
  do {
    if (isCancelled()) throw new Error('Session history request cancelled');
    let page;
    try {
      page = await client.request('thread/turns/list', {threadId, cursor, limit: 100, sortDirection: 'desc', itemsView: 'full'});
    } catch (error) {
      if (!first || !isUnsupported(error)) throw error;
      try {
        const result = await client.request('thread/read', {threadId, includeTurns: true});
        return turnEntries(result.thread?.turns || []);
      } catch (fallbackError) {
        if (isUnsupported(fallbackError)) throw new Error('Codex cannot provide this session history yet. Check the original session or try again later.');
        throw fallbackError;
      }
    }
    if (isCancelled()) throw new Error('Session history request cancelled');
    if (!Array.isArray(page.data)) throw new Error('Codex returned an invalid session history page');
    pages.unshift(turnEntries([...page.data].reverse()));
    onPage?.(pages.flat());
    cursor = page.nextCursor || null;
    if (cursor && cursors.has(cursor)) throw new Error('Codex returned a duplicate session history cursor');
    if (cursor) cursors.add(cursor);
    first = false;
  } while (cursor);
  return pages.flat();
}

function turnEntries(turns) {
  return turns.flatMap(turn => (turn.items || []).map(item => ({turnId: turn.id, item})));
}

function isUnsupported(error) {
  return /method not found|unknown method|unsupported|not supported/i.test(error.message);
}

export function displaySessionItem(entry) {
  const item = entry.item || {};
  if (item.type !== 'userMessage' && item.type !== 'agentMessage') return null;
  let title;
  let body;
  switch (item.type) {
    case 'userMessage': {
      const text = (item.content || []).map(part => part.type === 'text' ? part.text : `[${part.type || 'attachment'}] ${part.path || part.fileId || ''}`).join('\n');
      if (/^\[SEREIN · Joined workspace /.test(text)) return null;
      if (text.startsWith('[SEREIN · ')) {
        const header = text.split('\n', 1)[0];
        const firstBody = text.indexOf('\n\n');
        const lastBody = text.indexOf('\n\n---\nThis is a Serein collaboration message.', firstBody + 2);
        const sender = header.match(/ · From (.+?) \(/)?.[1];
        const isHuman = header.includes('(human participant)');
        return {title: isHuman ? 'YOU' : sender ? `SEREIN · ${safeTerminalText(sender)}` : 'SEREIN', body: safeTerminalText(firstBody < 0 ? text : text.slice(firstBody + 2, lastBody < 0 ? undefined : lastBody)), kind: isHuman ? 'userMessage' : 'serein'};
      }
      title = 'YOU'; body = text; break;
    }
    case 'agentMessage':
      title = 'CODEX';
      body = [item.text || '', ...(item.questions || []).map(question => [question.title, ...(question.options || []).map(option => `- ${option}`)].filter(Boolean).join('\n'))].filter(Boolean).join('\n');
      break;
  }
  if (!String(body || '').trim()) return null;
  return {title: safeTerminalText(title), body: safeTerminalText(body), kind: item.type};
}

export function safeTerminalText(value) {
  return stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
