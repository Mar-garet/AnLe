import {replyMessage, sendMessage} from './messaging.js';

function requestIds(turn) {
  const ids = [];
  for (const item of turn.items || []) {
    if (item.type !== 'userMessage') continue;
    for (const part of item.content || []) {
      if (part.type !== 'text') continue;
      const match = String(part.text || '').match(/^\[(?:AnLe|SEREIN) · [^\n]+\]\nMessage ID: ([^\s·]+)/);
      if (match) ids.push(match[1]);
    }
  }
  return ids;
}

function fallbackBody(turn) {
  if (turn.status !== 'completed') {
    const detail = String(turn.error?.message || 'No further details').slice(0, 1000);
    return `[AnLe · CR review incomplete]\nThe CR ${turn.status} before it reported an outcome: ${detail}\nDo not treat this as a clean review.`;
  }
  const final = (turn.items || []).filter(item => item.type === 'agentMessage' &&
    (!item.phase || ['final_answer', 'finalAnswer'].includes(item.phase))).at(-1)?.text?.trim();
  if (!final) return '[AnLe · CR review incomplete]\nThe CR finished without reporting its findings. No clean result can be assumed; inspect the CR session or request another review.';
  return `[AnLe · CR review report]\nThe CR finished without sending its result. Its final response follows:\n\n${final.slice(0, 11000)}${final.length > 11000 ? '\n\n[Truncated; see the CR session.]' : ''}`;
}

// If a CR finishes a requested review without using reply_message, relay its
// final response (or an explicit incomplete status) to its paired developer.
// Claims are stored before sending, so concurrent monitors cannot duplicate it.
export async function reconcileCRReports(store, client, {queue, participantIds = null} = {}) {
  store.recoverCRFallbacks();
  const pending = store.pendingCRReports(participantIds);
  const byReviewer = new Map();
  for (const request of pending) {
    if (store.crReplyState(request)) continue;
    if (!byReviewer.has(request.recipient_id)) byReviewer.set(request.recipient_id, new Map());
    byReviewer.get(request.recipient_id).set(request.id, request);
  }
  for (const [reviewerId, requests] of byReviewer) {
    let cursor;
    const seen = new Set();
    try {
      for (let pageNo = 0; pageNo < 10 && requests.size; pageNo++) {
        const page = await client.request('thread/turns/list', {threadId: reviewerId, limit: 50, sortDirection: 'desc', itemsView: 'full', ...(cursor ? {cursor} : {})});
        if (!Array.isArray(page.data)) break;
        for (const turn of page.data) {
          for (const id of requestIds(turn)) {
            const request = requests.get(id);
            if (!request) continue;
            requests.delete(id);
            if (!['completed', 'failed', 'interrupted'].includes(turn.status) || !turn.id) continue;
            if (!store.claimCRFallback(request, turn.id)) continue;
            try {
              const message = request.sender_id === request.report_recipient
                ? await replyMessage(store, {spaceId: request.space_id, senderId: reviewerId, replyTo: id, body: fallbackBody(turn), replyExpected: false}, queue)
                : await sendMessage(store, {spaceId: request.space_id, senderId: reviewerId, to: request.report_recipient, contextMessageId: id, body: fallbackBody(turn), replyExpected: false}, queue);
              store.finishCRFallback(id, 'reported', {fallbackMessageId: message.id});
            } catch (error) {
              store.finishCRFallback(id, error.deliveryState === 'unknown' ? 'unknown' : 'failed', {fallbackMessageId: error.messageId, error: error.message || error});
            }
          }
        }
        cursor = page.nextCursor;
        if (!cursor || seen.has(cursor)) break;
        seen.add(cursor);
      }
    } catch {
      // An unavailable server or unreadable history does not imply completion.
    }
  }
}
