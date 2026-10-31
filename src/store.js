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
      CREATE TABLE IF NOT EXISTS reviewer_pairs (
        space_id TEXT NOT NULL,
        developer_id TEXT NOT NULL,
        reviewer_id TEXT,
        status TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        intro_state TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (space_id, developer_id),
        UNIQUE (space_id, reviewer_id),
        FOREIGN KEY (space_id, developer_id) REFERENCES members(space_id, thread_id) ON DELETE CASCADE
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
      CREATE TABLE IF NOT EXISTS cr_report_requests (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'waiting',
        turn_id TEXT,
        fallback_message_id TEXT,
        error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cr_report_requests_state ON cr_report_requests(state, updated_at);
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
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        developer_id TEXT NOT NULL,
        reviewer_id TEXT,
        goal TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        base_oid TEXT,
        paths_json TEXT NOT NULL,
        status TEXT NOT NULL,
        current_round INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reviews_developer ON reviews(space_id, developer_id, created_at);
      CREATE TABLE IF NOT EXISTS review_settings (
        space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
        instructions TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS review_rounds (
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        round INTEGER NOT NULL,
        snapshot_path TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        head_oid TEXT NOT NULL,
        changed_paths_json TEXT NOT NULL,
        untracked_json TEXT NOT NULL,
        request_message_id TEXT,
        turn_id TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(review_id, round)
      );
      CREATE TABLE IF NOT EXISTS review_findings (
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        detail TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_round INTEGER NOT NULL,
        updated_round INTEGER NOT NULL,
        PRIMARY KEY(review_id, id)
      );
      CREATE TABLE IF NOT EXISTS review_notifications (
        review_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        recipient_id TEXT NOT NULL,
        state TEXT NOT NULL,
        message_id TEXT,
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(review_id, round, recipient_id),
        FOREIGN KEY(review_id, round) REFERENCES review_rounds(review_id, round) ON DELETE CASCADE
      );
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
    try { this.db.prepare('INSERT INTO spaces VALUES (?, ?, ?)').run(id, name, now()); }
    catch (error) {
      if (/UNIQUE constraint failed: spaces\.name/i.test(error.message || '')) throw new Error('Workspace name already exists');
      throw error;
    }
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

  allMembers() {
    return this.db.prepare(`SELECT ${memberFields} ${memberJoins} ORDER BY m.rowid`).all();
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE members SET name = ?, role = ? WHERE space_id = ? AND thread_id = ?').run(name, String(role || '').trim().slice(0, 500), spaceId, threadId);
      const pair = this.reviewerPair(spaceId, threadId);
      if (pair?.reviewer_id && this.member(spaceId, pair.reviewer_id)) {
        this.db.prepare('UPDATE members SET name = ? WHERE space_id = ? AND thread_id = ?')
          .run(this.availableReviewerName(spaceId, name, pair.reviewer_id), spaceId, pair.reviewer_id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  reviewerPairs(spaceId) { return this.db.prepare('SELECT * FROM reviewer_pairs WHERE space_id = ? ORDER BY rowid').all(spaceId); }
  reviewerPair(spaceId, developerId) { return this.db.prepare('SELECT * FROM reviewer_pairs WHERE space_id = ? AND developer_id = ?').get(spaceId, developerId); }
  pairForReviewer(spaceId, reviewerId) { return this.db.prepare('SELECT * FROM reviewer_pairs WHERE space_id = ? AND reviewer_id = ?').get(spaceId, reviewerId); }
  reviewerThreadIds() { return this.db.prepare('SELECT reviewer_id FROM reviewer_pairs WHERE reviewer_id IS NOT NULL UNION SELECT reviewer_id FROM reviews WHERE reviewer_id IS NOT NULL').all().map(item => item.reviewer_id); }
  isReviewerThread(threadId) {
    return !!this.db.prepare('SELECT 1 FROM reviewer_pairs WHERE reviewer_id = ? UNION ALL SELECT 1 FROM reviews WHERE reviewer_id = ? LIMIT 1').get(threadId, threadId);
  }

  availableReviewerName(spaceId, developerName, exceptId = '') {
    for (let n = 1; n < 10000; n++) {
      const suffix = n === 1 ? ' CR' : ` CR ${n}`;
      const name = `${developerName.slice(0, 80 - suffix.length)}${suffix}`;
      const existing = this.member(spaceId, name);
      if (!existing || existing.thread_id === exceptId) return name;
    }
    throw new Error('Could not choose a unique CR name');
  }

  claimReviewerPair(spaceId, developerId, retry = false) {
    const developer = this.member(spaceId, developerId);
    if (!developer || this.isReviewerThread(developer.thread_id)) throw new Error('A coding session is required for a CR pair');
    const attempt = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT OR IGNORE INTO reviewer_pairs (space_id, developer_id, status, attempt_id, created_at, updated_at)
      VALUES (?, ?, 'creating', ?, ?, ?)`).run(spaceId, developer.thread_id, attempt, timestamp, timestamp);
    if (retry) this.db.prepare(`UPDATE reviewer_pairs SET status = 'creating', attempt_id = ?, intro_state = 'pending', error = NULL, updated_at = ?
      WHERE space_id = ? AND developer_id = ? AND status IN ('failed', 'disabled')`).run(attempt, timestamp, spaceId, developer.thread_id);
    const pair = this.reviewerPair(spaceId, developer.thread_id);
    return {pair, claimed: pair.attempt_id === attempt && pair.status === 'creating'};
  }

  finishReviewerPair(spaceId, developerId, attemptId, reviewerId, cwd, role) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pair = this.reviewerPair(spaceId, developerId);
      const developer = this.member(spaceId, developerId);
      if (!pair || pair.status !== 'creating' || pair.attempt_id !== attemptId || !developer) throw new Error('The CR pairing request is no longer active');
      const name = this.availableReviewerName(spaceId, developer.name);
      this.db.prepare('INSERT INTO members (space_id, thread_id, name, role, cwd, added_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(spaceId, reviewerId, name, role.slice(0, 500), cwd.slice(0, 4000), now());
      this.db.prepare("UPDATE reviewer_pairs SET reviewer_id = ?, status = 'ready', error = NULL, updated_at = ? WHERE space_id = ? AND developer_id = ?")
        .run(reviewerId, now(), spaceId, developerId);
      this.db.exec('COMMIT');
      return {pair: this.reviewerPair(spaceId, developerId), reviewer: this.member(spaceId, reviewerId)};
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  failReviewerPair(spaceId, developerId, attemptId, status, error) {
    if (!['failed', 'unknown'].includes(status)) throw new Error('Invalid CR pairing status');
    this.db.prepare("UPDATE reviewer_pairs SET status = ?, error = ?, updated_at = ? WHERE space_id = ? AND developer_id = ? AND status = 'creating' AND attempt_id = ?")
      .run(status, String(error).slice(0, 2000), now(), spaceId, developerId, attemptId);
  }

  claimPairIntroduction(spaceId, developerId) {
    return this.db.prepare("UPDATE reviewer_pairs SET intro_state = 'sending', updated_at = ? WHERE space_id = ? AND developer_id = ? AND status = 'ready' AND intro_state = 'pending'")
      .run(now(), spaceId, developerId).changes > 0;
  }

  finishPairIntroduction(spaceId, developerId, state, error = null) {
    if (!['queued', 'failed', 'unknown'].includes(state)) throw new Error('Invalid CR introduction state');
    this.db.prepare("UPDATE reviewer_pairs SET intro_state = ?, error = ?, updated_at = ? WHERE space_id = ? AND developer_id = ? AND intro_state = 'sending'")
      .run(state, error ? String(error).slice(0, 2000) : null, now(), spaceId, developerId);
  }

  recoverReviewerPairs() {
    const cutoff = new Date(Date.now() - 120000).toISOString();
    this.db.prepare("UPDATE reviewer_pairs SET status = 'unknown', error = 'CR creation was interrupted; inspect existing sessions before retrying.', updated_at = ? WHERE status = 'creating' AND updated_at < ?")
      .run(now(), cutoff);
    this.db.prepare("UPDATE reviewer_pairs SET intro_state = 'unknown', error = 'Introduction delivery is uncertain; inspect the coding session before resending.', updated_at = ? WHERE intro_state = 'sending' AND updated_at < ?")
      .run(now(), cutoff);
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ownPair = this.reviewerPair(spaceId, threadId);
      const paired = this.pairForReviewer(spaceId, threadId);
      this.db.prepare(`UPDATE reviews SET status = 'closed', error = 'A review participant was removed from the workspace.', updated_at = ?
        WHERE space_id = ? AND (developer_id = ? OR reviewer_id = ? OR reviewer_id = ?) AND status != 'closed'`).run(now(), spaceId, threadId, threadId, ownPair?.reviewer_id || '');
      if (paired) this.db.prepare("UPDATE reviewer_pairs SET reviewer_id = NULL, status = 'disabled', intro_state = 'disabled', updated_at = ? WHERE space_id = ? AND developer_id = ?")
        .run(now(), spaceId, paired.developer_id);
      if (ownPair?.reviewer_id) this.db.prepare('DELETE FROM members WHERE space_id = ? AND thread_id = ?').run(spaceId, ownPair.reviewer_id);
      this.db.prepare('DELETE FROM members WHERE space_id = ? AND thread_id = ?').run(spaceId, threadId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  createReview({spaceId, developerId, goal, repoRoot, paths = []}) {
    const developer = this.member(spaceId, developerId);
    if (!developer) throw new Error('The development session is not in this workspace');
    goal = requiredText(goal, 'Review goal', 4000);
    repoRoot = requiredText(repoRoot, 'Repository directory', 4000);
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO reviews (id, space_id, developer_id, goal, repo_root, paths_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?, ?)`)
      .run(id, spaceId, developer.thread_id, goal, repoRoot, JSON.stringify(paths), timestamp, timestamp);
    return this.review(id);
  }

  reviewSettings(spaceId) {
    if (!this.space(spaceId)) throw new Error('Workspace not found');
    return this.db.prepare('SELECT instructions FROM review_settings WHERE space_id = ?').get(spaceId) || {instructions: ''};
  }

  setReviewSettings(spaceId, instructions) {
    if (!this.space(spaceId)) throw new Error('Workspace not found');
    instructions = optionalText(instructions, 3000);
    this.db.prepare(`INSERT INTO review_settings (space_id, instructions) VALUES (?, ?)
      ON CONFLICT(space_id) DO UPDATE SET instructions = excluded.instructions`).run(spaceId, instructions);
    return this.reviewSettings(spaceId);
  }

  review(id) { return this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id); }

  reviews(spaceId, threadId = null) {
    if (threadId) return this.db.prepare('SELECT * FROM reviews WHERE space_id = ? AND (developer_id = ? OR reviewer_id = ?) ORDER BY rowid DESC').all(spaceId, threadId, threadId);
    return this.db.prepare('SELECT * FROM reviews WHERE space_id = ? ORDER BY rowid DESC').all(spaceId);
  }

  reviewRounds(id) { return this.db.prepare('SELECT * FROM review_rounds WHERE review_id = ? ORDER BY round').all(id); }
  reviewFindings(id) { return this.db.prepare('SELECT * FROM review_findings WHERE review_id = ? ORDER BY created_round, rowid').all(id); }
  reviewNotifications(id, round) { return this.db.prepare('SELECT * FROM review_notifications WHERE review_id = ? AND round = ?').all(id, round); }
  pendingReviewNotifications() { return this.db.prepare("SELECT DISTINCT review_id, round FROM review_notifications WHERE state = 'pending' ORDER BY updated_at").all(); }

  claimReviewNotification(id, round, recipientId) {
    return this.db.prepare(`UPDATE review_notifications SET state = 'sending', updated_at = ?
      WHERE review_id = ? AND round = ? AND recipient_id = ? AND state = 'pending'`).run(now(), id, round, recipientId).changes > 0;
  }

  finishReviewNotification(id, round, recipientId, {state, messageId = null, error = null}) {
    if (!['queued', 'delivered', 'failed', 'unknown'].includes(state)) throw new Error('Invalid review notification state');
    this.db.prepare(`UPDATE review_notifications SET state = ?, message_id = ?, error = ?, updated_at = ?
      WHERE review_id = ? AND round = ? AND recipient_id = ? AND state = 'sending'`)
      .run(state, messageId, error ? String(error).slice(0, 2000) : null, now(), id, round, recipientId);
  }

  recoverReviewNotifications() {
    const cutoff = new Date(Date.now() - 120000).toISOString();
    return this.db.prepare(`UPDATE review_notifications SET state = 'unknown', error = ?, updated_at = ?
      WHERE state = 'sending' AND updated_at < ?`)
      .run('Delivery did not complete; check Activity before resending.', now(), cutoff).changes;
  }

  cancelPendingReviewNotification(id, round, recipientId) {
    return this.db.prepare("UPDATE review_notifications SET state = 'cancelled', updated_at = ? WHERE review_id = ? AND round = ? AND recipient_id = ? AND state = 'pending'")
      .run(now(), id, round, recipientId).changes > 0;
  }

  recoverAbandonedReviews() {
    // The process may have exited while a snapshot or turn was being started.
    // Never retry automatically: the request might have reached Codex.
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const timestamp = now();
    const error = 'Review start did not finish; inspect the reviewer session before starting another review.';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stale = this.db.prepare("SELECT id, current_round, status FROM reviews WHERE status IN ('preparing', 'starting') AND updated_at < ?").all(cutoff);
      for (const review of stale) {
        this.db.prepare("UPDATE reviews SET status = 'unknown', error = ?, updated_at = ? WHERE id = ?").run(error, timestamp, review.id);
        if (review.status === 'starting') {
          const round = this.db.prepare('SELECT request_message_id FROM review_rounds WHERE review_id = ? AND round = ?').get(review.id, review.current_round);
          this.db.prepare("UPDATE review_rounds SET status = 'unknown', updated_at = ? WHERE review_id = ? AND round = ? AND status IN ('starting', 'running')")
            .run(timestamp, review.id, review.current_round);
          if (round?.request_message_id) this.db.prepare("UPDATE messages SET state = 'unknown', error = ?, updated_at = ? WHERE id = ? AND state = 'pending'")
            .run(error, timestamp, round.request_message_id);
        }
      }
      this.db.exec('COMMIT');
      return stale.length;
    } catch (failure) { this.db.exec('ROLLBACK'); throw failure; }
  }

  setReviewReviewer(id, reviewerId) {
    const review = this.review(id);
    if (!review || !this.member(review.space_id, reviewerId)) throw new Error('The reviewer is not in this workspace');
    this.db.prepare('UPDATE reviews SET reviewer_id = ?, updated_at = ? WHERE id = ?').run(reviewerId, now(), id);
  }

  beginReviewRound(id, developerId) {
    const result = this.db.prepare(`UPDATE reviews SET status = 'preparing', error = NULL, updated_at = ?
      WHERE id = ? AND developer_id = ? AND status IN ('waiting', 'failed') AND reviewer_id IS NOT NULL`).run(now(), id, developerId);
    if (!result.changes) throw new Error('This review is not ready for another round');
    return this.review(id);
  }

  saveReviewRound(id, snapshot, requestMessageId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const review = this.review(id);
      if (!review || review.status !== 'preparing' || !review.reviewer_id) throw new Error('Review is not ready to start');
      const round = review.current_round + 1;
      const timestamp = now();
      this.db.prepare(`INSERT INTO review_rounds (review_id, round, snapshot_path, fingerprint, head_oid, changed_paths_json, untracked_json, request_message_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?)`)
        .run(id, round, snapshot.snapshotPath, snapshot.fingerprint, snapshot.headOid, JSON.stringify(snapshot.changedPaths), JSON.stringify(snapshot.untracked), requestMessageId, timestamp, timestamp);
      this.db.prepare(`UPDATE reviews SET base_oid = COALESCE(base_oid, ?), repo_root = ?, current_round = ?, status = 'starting', error = NULL, updated_at = ? WHERE id = ?`)
        .run(snapshot.baseOid, snapshot.root, round, timestamp, id);
      this.db.exec('COMMIT');
      return this.review(id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  markReviewTurn(id, round, turnId) {
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE review_rounds SET turn_id = ?, status = CASE WHEN status IN ('starting', 'unknown') THEN 'running' ELSE status END, updated_at = ? WHERE review_id = ? AND round = ?")
        .run(turnId, timestamp, id, round);
      this.db.prepare("UPDATE reviews SET status = 'running', error = NULL, updated_at = ? WHERE id = ? AND current_round = ? AND status IN ('starting', 'unknown')")
        .run(timestamp, id, round);
      this.db.exec('COMMIT');
    } catch (failure) { this.db.exec('ROLLBACK'); throw failure; }
  }

  failReview(id, status, error) {
    if (!['failed', 'unknown'].includes(status)) throw new Error('Invalid review failure status');
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`UPDATE reviews SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status IN ('preparing', 'starting', 'running')`)
        .run(status, optionalText(error || '', 2000), timestamp, id);
      if (result.changes) this.db.prepare(`UPDATE review_rounds SET status = ?, updated_at = ? WHERE review_id = ? AND round = (SELECT current_round FROM reviews WHERE id = ?) AND status IN ('starting', 'running')`)
        .run(status, timestamp, id, id);
      this.db.exec('COMMIT');
      return result.changes > 0;
    } catch (failure) { this.db.exec('ROLLBACK'); throw failure; }
  }

  submitReview({id, reviewerId, round, summary, findings, checked = [], unverified = [], freshness, humanQuestion = ''}) {
    summary = requiredText(summary, 'Review summary', 4000);
    if (typeof humanQuestion !== 'string') throw new Error('Human question must be text');
    humanQuestion = optionalText(humanQuestion, 2000);
    if (!Array.isArray(findings) || findings.length > 80) throw new Error('Provide at most 80 findings');
    if (!Array.isArray(checked) || !Array.isArray(unverified) || checked.length > 30 || unverified.length > 30) throw new Error('Invalid review verification list');
    checked = checked.map(value => requiredText(value, 'Verification', 500));
    unverified = unverified.map(value => requiredText(value, 'Unverified item', 500));
    if (!['current', 'stale', 'unknown'].includes(freshness)) throw new Error('Invalid snapshot freshness');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const review = this.review(id);
      if (!review || review.reviewer_id !== reviewerId || !this.member(review.space_id, reviewerId)) throw new Error('Only the assigned reviewer can submit this review');
      const currentRound = this.db.prepare('SELECT status, request_message_id FROM review_rounds WHERE review_id = ? AND round = ?').get(id, round);
      if (review.current_round !== round || !currentRound || !['starting', 'running', 'unknown'].includes(review.status) ||
          (review.status === 'unknown' && currentRound.status !== 'unknown')) throw new Error('This review round is not accepting results');
      const previous = this.reviewFindings(id);
      const byId = new Map(previous.map(item => [item.id, item]));
      const seen = new Set();
      let nextId = previous.length + 1;
      const upsert = this.db.prepare(`INSERT INTO review_findings (review_id, id, severity, title, path, line, detail, status, reason, created_round, updated_round)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(review_id, id) DO UPDATE SET severity = excluded.severity, title = excluded.title, path = excluded.path, line = excluded.line, detail = excluded.detail, status = excluded.status, reason = excluded.reason, updated_round = excluded.updated_round`);
      for (const finding of findings) {
        if (!finding || typeof finding !== 'object') throw new Error('Invalid finding');
        const old = finding.id ? byId.get(finding.id) : null;
        if (finding.id && !old) throw new Error(`Unknown previous finding: ${finding.id}`);
        const findingId = old?.id || `F${nextId++}`;
        if (seen.has(findingId)) throw new Error(`Finding repeated: ${findingId}`);
        seen.add(findingId);
        const status = finding.status || 'open';
        if (!['open', 'resolved', 'dismissed'].includes(status) || (!old && status !== 'open')) throw new Error('New findings must be open; previous findings may be open, resolved, or dismissed');
        const severity = finding.severity || old?.severity;
        if (!['P0', 'P1', 'P2', 'P3'].includes(severity)) throw new Error('Finding severity must be P0, P1, P2, or P3');
        const title = requiredText(finding.title || old?.title, 'Finding title', 300);
        const path = requiredText(finding.path || old?.path, 'Finding path', 2000);
        if (path.startsWith('/') || path.split('/').includes('..')) throw new Error('Finding paths must be relative to the repository');
        const line = finding.line ?? old?.line;
        if (!Number.isInteger(line) || line < 1) throw new Error('Finding line must be a positive integer');
        const detail = requiredText(finding.detail || old?.detail, 'Finding detail', 3000);
        const reason = optionalText(finding.reason || '', 2000);
        if (status !== 'open' && !reason) throw new Error(`Explain why ${findingId} is ${status}`);
        upsert.run(id, findingId, severity, title, path, line, detail, status, reason, old?.created_round || round, round);
      }
      const missing = previous.filter(item => item.status === 'open' && !seen.has(item.id));
      if (missing.length) throw new Error(`Report the status of previous open findings: ${missing.map(item => item.id).join(', ')}`);
      const result = {summary, checked, unverified, freshness, findings: this.reviewFindings(id), ...(humanQuestion ? {human_question: humanQuestion} : {})};
      const timestamp = now();
      this.db.prepare(`UPDATE review_rounds SET status = 'completed', result_json = ?, updated_at = ? WHERE review_id = ? AND round = ?`)
        .run(JSON.stringify(result), timestamp, id, round);
      this.db.prepare(`UPDATE reviews SET status = 'waiting', error = NULL, updated_at = ? WHERE id = ?`)
        .run(timestamp, id);
      // A result proves that a previously uncertain start actually reached Codex.
      if (currentRound.request_message_id) this.db.prepare("UPDATE messages SET state = 'queued', error = NULL, updated_at = ? WHERE id = ? AND state IN ('pending', 'unknown')")
        .run(timestamp, currentRound.request_message_id);
      const notify = this.db.prepare(`INSERT INTO review_notifications (review_id, round, recipient_id, state, updated_at) VALUES (?, ?, ?, 'pending', ?)`);
      notify.run(id, round, review.developer_id, timestamp);
      if (humanQuestion) notify.run(id, round, HUMAN, timestamp);
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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

  trackCRRequest(messageId) {
    this.db.prepare("INSERT OR IGNORE INTO cr_report_requests (message_id, state, updated_at) VALUES (?, 'waiting', ?)").run(messageId, now());
  }

  pendingCRReports(participantIds = null) {
    const requests = this.db.prepare(`SELECT m.*, p.developer_id AS report_recipient FROM cr_report_requests c
      JOIN messages m ON m.id = c.message_id
      JOIN reviewer_pairs p ON p.space_id = m.space_id AND p.reviewer_id = m.recipient_id AND p.status = 'ready'
        AND (p.developer_id = m.sender_id OR (m.sender_id = 'human' AND m.reply_to IS NOT NULL))
      WHERE c.state = 'waiting' AND m.state IN ('queued', 'unknown') ORDER BY m.rowid`).all();
    return participantIds ? requests.filter(item => participantIds.has(item.sender_id) || participantIds.has(item.recipient_id) || participantIds.has(item.report_recipient)) : requests;
  }

  crReplyState(request) {
    const reply = this.db.prepare(`SELECT state FROM messages WHERE space_id = ? AND sender_id = ? AND recipient_id = ?
      AND (reply_to = ? OR parent_message_id = ?) AND state IN ('queued', 'delivered', 'pending', 'unknown')
      ORDER BY CASE WHEN state IN ('queued', 'delivered') THEN 0 ELSE 1 END, rowid DESC LIMIT 1`)
      .get(request.space_id, request.recipient_id, request.report_recipient || request.sender_id, request.id, request.id);
    if (reply && ['queued', 'delivered'].includes(reply.state)) this.db.prepare("UPDATE cr_report_requests SET state = 'reported', updated_at = ? WHERE message_id = ? AND state = 'waiting'").run(now(), request.id);
    return reply?.state || null;
  }

  claimCRFallback(request, turnId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pair = this.pairForReviewer(request.space_id, request.recipient_id);
      if (!pair || pair.status !== 'ready' || (pair.developer_id !== request.sender_id && request.sender_id !== HUMAN) || this.crReplyState(request)) {
        this.db.exec('COMMIT');
        return false;
      }
      const result = this.db.prepare("UPDATE cr_report_requests SET state = 'sending', turn_id = ?, updated_at = ? WHERE message_id = ? AND state = 'waiting'")
        .run(turnId, now(), request.id);
      this.db.exec('COMMIT');
      return result.changes > 0;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  finishCRFallback(messageId, state, {fallbackMessageId = null, error = null} = {}) {
    if (!['reported', 'failed', 'unknown'].includes(state)) throw new Error('Invalid CR report state');
    this.db.prepare("UPDATE cr_report_requests SET state = ?, fallback_message_id = ?, error = ?, updated_at = ? WHERE message_id = ? AND state = 'sending'")
      .run(state, fallbackMessageId, error ? String(error).slice(0, 2000) : null, now(), messageId);
  }

  recoverCRFallbacks() {
    const cutoff = new Date(Date.now() - 120000).toISOString();
    return this.db.prepare("UPDATE cr_report_requests SET state = 'unknown', error = ?, updated_at = ? WHERE state = 'sending' AND updated_at < ?")
      .run('Report delivery is uncertain; check Activity before resending.', now(), cutoff).changes;
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
