import {randomUUID} from 'node:crypto';
import {chmodSync, mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export const HUMAN = 'human';

export function defaultDataDir() {
  return process.env.SEREIN_HOME || join(homedir(), '.serein');
}

export class Store {
  constructor(dataDir = defaultDataDir()) {
    dataDir = resolve(dataDir);
    this.dataDir = dataDir;
    mkdirSync(dataDir, {recursive: true, mode: 0o700});
    const filename = join(dataDir, 'serein.sqlite');
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE,
        role TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL DEFAULT '',
        added_at TEXT NOT NULL,
        PRIMARY KEY (space_id, thread_id),
        UNIQUE (space_id, name)
      );
      CREATE TABLE IF NOT EXISTS member_presence (
        space_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        current_task TEXT NOT NULL DEFAULT '',
        task_status TEXT NOT NULL DEFAULT 'unknown',
        task_updated_at TEXT,
        PRIMARY KEY (space_id, thread_id),
        FOREIGN KEY (space_id, thread_id) REFERENCES members(space_id, thread_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        recipient_name TEXT NOT NULL,
        body TEXT NOT NULL,
        reply_to TEXT,
        reply_expected INTEGER,
        conversation_id TEXT,
        parent_message_id TEXT,
        state TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_space_time ON messages(space_id, created_at);
      CREATE INDEX IF NOT EXISTS messages_reply_to ON messages(reply_to);
      CREATE INDEX IF NOT EXISTS messages_pending_time ON messages(state, updated_at);
      CREATE TABLE IF NOT EXISTS human_message_reads (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        read_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS human_message_resolutions (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        resolved_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_observations (
        thread_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS console_navigation (
        console_id TEXT NOT NULL,
        space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS console_navigation_console ON console_navigation(console_id);
    `);
    // Upgrade older databases atomically, retaining their messages and roles.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.db.prepare('PRAGMA table_info(messages)').all();
      if (!columns.some(column => column.name === 'reply_expected')) {
        this.db.exec('ALTER TABLE messages ADD COLUMN reply_expected INTEGER');
        // Previously replies were explicitly delivered as requiring no automatic reply.
        this.db.exec('UPDATE messages SET reply_expected = 0 WHERE reply_to IS NOT NULL');
      }
      const hadConversation = columns.some(column => column.name === 'conversation_id');
      const hadParent = columns.some(column => column.name === 'parent_message_id');
      if (!hadConversation) this.db.exec('ALTER TABLE messages ADD COLUMN conversation_id TEXT');
      if (!hadParent) this.db.exec('ALTER TABLE messages ADD COLUMN parent_message_id TEXT');
      if (!hadConversation || !hadParent) {
        this.db.exec(`
          UPDATE messages AS m SET parent_message_id = reply_to
          WHERE parent_message_id IS NULL AND reply_to IS NOT NULL
            AND EXISTS (SELECT 1 FROM messages p WHERE p.id = m.reply_to AND p.space_id = m.space_id);
          WITH RECURSIVE lineage(id, root_id) AS (
            SELECT id, id FROM messages WHERE parent_message_id IS NULL
            UNION ALL
            SELECT child.id, lineage.root_id FROM messages child JOIN lineage ON child.parent_message_id = lineage.id
          )
          UPDATE messages SET conversation_id = COALESCE((SELECT root_id FROM lineage WHERE lineage.id = messages.id), id)
          WHERE conversation_id IS NULL;
        `);
      }
      const memberColumns = this.db.prepare('PRAGMA table_info(members)').all();
      if (['current_task', 'task_status', 'task_updated_at'].every(name => memberColumns.some(column => column.name === name))) {
        this.db.exec(`INSERT OR IGNORE INTO member_presence (space_id, thread_id, current_task, task_status, task_updated_at)
          SELECT space_id, thread_id, current_task, task_status, task_updated_at FROM members`);
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS messages_conversation ON messages(space_id, conversation_id)');
      // Older running processes do not know the new columns. Complete their
      // direct replies as they arrive so conversations remain connected.
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS messages_fill_conversation AFTER INSERT ON messages
        WHEN NEW.conversation_id IS NULL BEGIN
          UPDATE messages SET
            parent_message_id = COALESCE(NEW.parent_message_id, (SELECT p.id FROM messages p WHERE p.id = NEW.reply_to AND p.space_id = NEW.space_id)),
            conversation_id = COALESCE((SELECT COALESCE(p.conversation_id, p.id) FROM messages p
              WHERE p.id = COALESCE(NEW.parent_message_id, NEW.reply_to) AND p.space_id = NEW.space_id), NEW.id),
            reply_expected = CASE WHEN NEW.reply_to IS NOT NULL AND NEW.reply_expected IS NULL THEN 0 ELSE NEW.reply_expected END
          WHERE id = NEW.id;
        END`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (!this.db.prepare('SELECT id FROM spaces LIMIT 1').get()) {
      this.db.prepare('INSERT OR IGNORE INTO spaces VALUES (?, ?, ?)').run('default', 'My Workspace', now());
    }
    // Rename only the default name generated by earlier versions, preserving custom names.
    const previousDefaultName = '我的协作空间';
    const defaultSpace = this.db.prepare('SELECT name FROM spaces WHERE id = ?').get('default');
    if (defaultSpace?.name === previousDefaultName) {
      const exists = this.db.prepare('SELECT id FROM spaces WHERE name = ? COLLATE NOCASE AND id != ?');
      let name = 'My Workspace';
      for (let suffix = 2; exists.get(name, 'default'); suffix++) name = `My Workspace ${suffix}`;
      this.db.prepare('UPDATE OR IGNORE spaces SET name = ? WHERE id = ? AND name = ?').run(name, 'default', previousDefaultName);
    }
  }

  close() { this.db.close(); }

  spaces() {
    return this.db.prepare('SELECT * FROM spaces ORDER BY rowid').all();
  }

  desktopNotificationsEnabled() {
    return this.db.prepare('SELECT value FROM settings WHERE key = ?').get('desktop_notifications')?.value === '1';
  }

  setDesktopNotifications(enabled) {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run('desktop_notifications', enabled ? '1' : '0');
  }

  createSpace(name) {
    name = requiredText(name, 'Workspace name', 80);
    const id = randomUUID();
    this.db.prepare('INSERT INTO spaces VALUES (?, ?, ?)').run(id, name, now());
    return this.space(id);
  }

  deleteSpace(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const deleted = this.db.prepare('SELECT * FROM spaces WHERE id = ?').get(id);
      if (!deleted) throw new Error('Workspace not found');
      this.db.prepare('DELETE FROM spaces WHERE id = ?').run(id);
      let nextSpace = this.spaces()[0];
      const replacementCreated = !nextSpace;
      if (!nextSpace) {
        const name = deleted.name.toLowerCase() === 'my workspace' ? 'New Workspace' : 'My Workspace';
        nextSpace = this.createSpace(name);
      }
      this.db.exec('COMMIT');
      return {deleted, nextSpace, replacementCreated};
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  space(value) {
    if (!value) return undefined;
    return this.db.prepare('SELECT * FROM spaces WHERE id = ? OR name = ? COLLATE NOCASE').get(value, value);
  }

  members(spaceId) {
    return this.db.prepare(`SELECT ${memberFields} ${memberJoins} WHERE m.space_id = ? ORDER BY m.rowid`).all(spaceId);
  }

  member(spaceId, value) {
    return this.db.prepare(`SELECT ${memberFields} ${memberJoins} WHERE m.space_id = ? AND (m.thread_id = ? OR m.name = ? COLLATE NOCASE)`).get(spaceId, value, value);
  }

  memberships(threadId) {
    return this.db.prepare(`SELECT ${memberFields}, s.name AS space_name ${memberJoins} JOIN spaces s ON s.id = m.space_id WHERE m.thread_id = ? ORDER BY s.created_at`).all(threadId);
  }

  addMember(spaceId, {threadId, name, role = '', cwd = ''}) {
    if (!this.space(spaceId)) throw new Error('Workspace not found');
    threadId = requiredText(threadId, 'Session ID', 200);
    name = requiredText(name, 'Node name', 80);
    if (name.toLowerCase() === HUMAN) throw new Error('The name "human" is reserved');
    role = String(role).trim().slice(0, 500);
    cwd = String(cwd).slice(0, 4000);
    this.db.prepare('INSERT INTO members (space_id, thread_id, name, role, cwd, added_at) VALUES (?, ?, ?, ?, ?, ?)').run(spaceId, threadId, name, role, cwd, now());
    return this.member(spaceId, threadId);
  }

  updateMember(spaceId, threadId, {name, role}) {
    name = requiredText(name, 'Node name', 80);
    if (name.toLowerCase() === HUMAN) throw new Error('The name "human" is reserved');
    this.db.prepare('UPDATE members SET name = ?, role = ? WHERE space_id = ? AND thread_id = ?').run(name, String(role || '').trim().slice(0, 500), spaceId, threadId);
  }

  updatePresence(spaceId, threadId, {task, status}) {
    const member = this.member(spaceId, threadId);
    if (!member) throw new Error('The current session is not in this workspace');
    if (task === undefined && status === undefined) throw new Error('Provide task or status');
    if (task !== undefined && typeof task !== 'string') throw new Error('Task must be a string');
    if (status !== undefined && !['available', 'working', 'blocked', 'unknown'].includes(status)) throw new Error('Invalid task status');
    const nextTask = task === undefined ? member.current_task : optionalText(task, 500);
    const nextStatus = status === undefined ? member.task_status : status;
    this.db.prepare(`INSERT INTO member_presence (space_id, thread_id, current_task, task_status, task_updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(space_id, thread_id) DO UPDATE SET current_task = excluded.current_task, task_status = excluded.task_status, task_updated_at = excluded.task_updated_at`)
      .run(spaceId, member.thread_id, nextTask, nextStatus, now());
    return this.member(spaceId, member.thread_id);
  }

  recordSessionObservations(threads) {
    if (!threads.length) return;
    const timestamp = now();
    const update = this.db.prepare(`INSERT INTO session_observations (thread_id, status, observed_at)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM members WHERE thread_id = ?)
      ON CONFLICT(thread_id) DO UPDATE SET status = excluded.status, observed_at = excluded.observed_at`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const thread of threads) update.run(thread.id, String(thread.status?.type || 'unknown'), timestamp, thread.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  sessionObservations() {
    return this.db.prepare('SELECT * FROM session_observations').all();
  }

  removeMember(spaceId, threadId) {
    this.db.prepare('DELETE FROM members WHERE space_id = ? AND thread_id = ?').run(spaceId, threadId);
  }

  createMessage({spaceId, sender, recipient, body, replyTo = null, contextMessageId = null, replyExpected = replyTo ? false : null}) {
    body = requiredText(body, 'Message', 12000);
    if (replyExpected !== null && typeof replyExpected !== 'boolean') throw new Error('reply_expected must be a boolean');
    const id = randomUUID();
    const timestamp = now();
    if (replyTo && contextMessageId) throw new Error('A reply already has a message context');
    const parentId = replyTo || contextMessageId;
    const parent = parentId ? this.message(parentId) : null;
    if (parentId && (!parent || parent.space_id !== spaceId)) throw new Error('Message context not found in this workspace');
    const conversationId = parent?.conversation_id || parent?.id || id;
    this.db.prepare(`INSERT INTO messages
      (id, space_id, sender_id, sender_name, recipient_id, recipient_name, body, reply_to, reply_expected, conversation_id, parent_message_id, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, spaceId, sender.id, sender.name, recipient.id, recipient.name, body, replyTo, replyExpected === null ? null : Number(replyExpected), conversationId, parentId, recipient.id === HUMAN ? 'delivered' : 'pending', timestamp, timestamp);
    return this.message(id);
  }

  setMessageState(id, state, error = null) {
    this.db.prepare('UPDATE messages SET state = ?, error = ?, updated_at = ? WHERE id = ?').run(state, error, now(), id);
  }

  recoverStaleDeliveries() {
    const timestamp = now();
    const cutoff = new Date(Date.now() - 120000).toISOString();
    return this.db.prepare(`UPDATE messages SET state = 'unknown', error = ?, updated_at = ?
      WHERE state = 'pending' AND updated_at < ?`)
      .run('Delivery did not complete; check the recipient before resending.', timestamp, cutoff).changes;
  }

  message(id) {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  }

  messageDetails(id) {
    return this.db.prepare(`${messageDetailsQuery} WHERE m.id = ?`).get(id);
  }

  messages(spaceId, limit = 100) {
    const query = `SELECT * FROM (
      ${messageDetailsQuery} WHERE m.space_id = ? ORDER BY m.rowid DESC ${limit == null ? '' : 'LIMIT ?'}
    ) ORDER BY sequence`;
    return limit == null ? this.db.prepare(query).all(spaceId) : this.db.prepare(query).all(spaceId, limit);
  }

  humanInbox() {
    return this.db.prepare(`${messageDetailsQuery} WHERE m.recipient_id = ? ORDER BY m.rowid`).all(HUMAN);
  }

  conversation(spaceId, conversationId) {
    return this.db.prepare(`${messageDetailsQuery} WHERE m.space_id = ? AND m.conversation_id = ? ORDER BY m.rowid`).all(spaceId, conversationId);
  }

  requestNavigation(consoleId, spaceId, threadId) {
    consoleId = requiredText(consoleId, 'Console ID', 200);
    if (!this.space(spaceId) || (threadId !== HUMAN && !this.member(spaceId, threadId))) throw new Error('Participant is no longer in this workspace');
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    this.db.prepare('DELETE FROM console_navigation WHERE created_at < ?').run(cutoff);
    this.db.prepare('INSERT INTO console_navigation VALUES (?, ?, ?, ?)').run(consoleId, spaceId, threadId, now());
  }

  takeNavigation(consoleId) {
    const request = this.db.prepare('SELECT rowid AS sequence, * FROM console_navigation WHERE console_id = ? ORDER BY rowid DESC LIMIT 1').get(consoleId);
    if (request) this.db.prepare('DELETE FROM console_navigation WHERE console_id = ? AND rowid <= ?').run(consoleId, request.sequence);
    return request;
  }

  markHumanMessageRead(spaceId, messageId) {
    return this.db.prepare(`INSERT OR IGNORE INTO human_message_reads (message_id, read_at)
      SELECT id, ? FROM messages WHERE id = ? AND space_id = ? AND recipient_id = ?`)
      .run(now(), messageId, spaceId, HUMAN).changes > 0;
  }

  setHumanMessageResolved(spaceId, messageId, resolved) {
    if (resolved) {
      return this.db.prepare(`INSERT OR IGNORE INTO human_message_resolutions (message_id, resolved_at)
        SELECT id, ? FROM messages WHERE id = ? AND space_id = ? AND recipient_id = ?`)
        .run(now(), messageId, spaceId, HUMAN).changes > 0;
    }
    return this.db.prepare(`DELETE FROM human_message_resolutions WHERE message_id IN
      (SELECT id FROM messages WHERE id = ? AND space_id = ? AND recipient_id = ?)`)
      .run(messageId, spaceId, HUMAN).changes > 0;
  }
}

const memberFields = `m.space_id, m.thread_id, m.name, m.role, m.cwd, m.added_at,
  COALESCE(p.current_task, '') AS current_task, COALESCE(p.task_status, 'unknown') AS task_status, p.task_updated_at`;
const memberJoins = 'FROM members m LEFT JOIN member_presence p ON p.space_id = m.space_id AND p.thread_id = m.thread_id';

const messageDetailsQuery = `SELECT m.rowid AS sequence, m.*, s.name AS space_name,
  r.read_at AS human_read_at, d.resolved_at AS human_resolved_at,
  CASE
    WHEN EXISTS (SELECT 1 FROM messages x WHERE x.reply_to = m.id AND x.space_id = m.space_id AND x.sender_id = m.recipient_id AND x.recipient_id = m.sender_id AND x.state IN ('queued', 'delivered')) THEN 'replied'
    WHEN EXISTS (SELECT 1 FROM messages x WHERE x.reply_to = m.id AND x.space_id = m.space_id AND x.sender_id = m.recipient_id AND x.recipient_id = m.sender_id AND x.state = 'unknown') THEN 'unknown'
    WHEN EXISTS (SELECT 1 FROM messages x WHERE x.reply_to = m.id AND x.space_id = m.space_id AND x.sender_id = m.recipient_id AND x.recipient_id = m.sender_id AND x.state = 'pending') THEN 'pending'
    WHEN EXISTS (SELECT 1 FROM messages x WHERE x.reply_to = m.id AND x.space_id = m.space_id AND x.sender_id = m.recipient_id AND x.recipient_id = m.sender_id AND x.state = 'failed') THEN 'failed'
    ELSE NULL
  END AS reply_state
  FROM messages m JOIN spaces s ON s.id = m.space_id
  LEFT JOIN human_message_reads r ON r.message_id = m.id
  LEFT JOIN human_message_resolutions d ON d.message_id = m.id`;

function requiredText(value, label, max) {
  const text = String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  if (!text) throw new Error(`${label} cannot be empty`);
  if (text.length > max) throw new Error(`${label} cannot exceed ${max} characters`);
  return text;
}

function optionalText(value, max) {
  const text = String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  if (text.length > max) throw new Error(`Text cannot exceed ${max} characters`);
  return text;
}

function now() { return new Date().toISOString(); }
