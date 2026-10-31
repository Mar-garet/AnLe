import {HUMAN} from './store.js';

// Delivery and replies are separate: a queued reply is not proof that the
// recipient has read it, and an uncertain attempt is never silently retried.
export function deliveryLabel(message) {
  return {pending: 'SENDING', queued: 'QUEUED', delivered: 'DELIVERED', failed: 'FAILED', unknown: 'UNKNOWN'}[message.state] || 'UNKNOWN';
}

export function replyLabel(message) {
  const result = {replied: 'REPLIED', unknown: 'REPLY UNKNOWN', pending: 'REPLY SENDING', failed: 'REPLY FAILED'}[message.reply_state];
  if (result) return result;
  if (message.human_resolved_at) return 'DONE';
  if (!['queued', 'delivered'].includes(message.state)) return null;
  if (message.reply_expected === 1 || message.reply_expected === true) return message.recipient_id === HUMAN ? 'NEEDS REPLY' : 'WAITING';
  if (message.reply_expected == null && !message.reply_to) return 'UNREPLIED';
  return null;
}

export function humanNeedsAttention(message) {
  if (message.recipient_id !== HUMAN || message.reply_state === 'replied' || message.human_resolved_at) return false;
  if (['unknown', 'pending', 'failed'].includes(message.reply_state)) return true;
  return message.reply_expected !== 0 && message.reply_expected !== false;
}
