// Messages are grouped only by an explicit context or a direct reply. Similar
// text or matching participants alone do not imply a shared conversation.
export function groupConversations(messages) {
  const groups = new Map();
  for (const message of messages) {
    const id = message.conversation_id || message.id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(message);
  }
  return [...groups.entries()].map(([id, entries]) => {
    const root = entries.find(message => message.id === id) || entries[0];
    const participants = new Map();
    for (const entry of entries) {
      if (!participants.has(entry.sender_id)) participants.set(entry.sender_id, entry.sender_name);
      if (!participants.has(entry.recipient_id)) participants.set(entry.recipient_id, entry.recipient_name);
    }
    const last = entries.at(-1);
    const open = entries.filter(entry => entry.reply_expected === 1 && !entry.human_resolved_at && entry.reply_state !== 'replied' && ['queued', 'delivered'].includes(entry.state)).length;
    const issues = entries.filter(entry => ['failed', 'unknown'].includes(entry.state) || ['failed', 'unknown'].includes(entry.reply_state)).length;
    return {...root, conversation_id: id, conversation_size: entries.length,
      participants: [...participants].map(([participantId, name]) => ({id: participantId, name})),
      open_count: open, issue_count: issues, latest_at: last.created_at, latest_sequence: last.sequence || 0};
  }).sort((a, b) => a.latest_sequence - b.latest_sequence);
}
