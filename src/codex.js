import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import WebSocket from 'ws';

const exec = promisify(execFile);

// The CLI's shared daemon speaks WebSocket over a local Unix socket.
export class CodexClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.nextId = 0;
    this.pending = new Map();
  }

  static async connect() {
    let socket = process.env.SEREIN_CODEX_SOCKET;
    if (!socket) {
      const {stdout} = await exec('codex', ['app-server', 'daemon', 'version'], {timeout: 5000});
      const info = JSON.parse(stdout);
      if (info.status !== 'running' || !info.socketPath) {
        throw new Error('The shared Codex server is not running. Start a Codex CLI session first.');
      }
      socket = info.socketPath;
    }
    const client = new CodexClient(socket);
    await client.open();
    return client;
  }

  async open() {
    this.ws = new WebSocket(`ws+unix:${this.socketPath}:/`);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to the Codex server')), 5000);
      this.ws.once('open', () => { clearTimeout(timeout); resolve(); });
      this.ws.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    this.ws.on('message', raw => this.onMessage(raw));
    this.ws.on('close', () => this.failPending(new Error('Disconnected from the Codex server')));
    this.ws.on('error', error => this.failPending(error));
    await this.request('initialize', {clientInfo: {name: 'anle_console', title: 'AnLe Console', version: '0.1.0'}});
    this.notify('initialized', {});
  }

  onMessage(raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.id == null || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || 'Codex request failed'));
    else pending.resolve(message.result);
  }

  failPending(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }

  request(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected to the Codex server'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} request timed out`)); }, 12000);
      this.pending.set(id, {resolve, reject, timer});
      this.ws.send(JSON.stringify({id, method, params}), error => {
        if (error && this.pending.has(id)) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }

  notify(method, params = {}) { this.ws.send(JSON.stringify({method, params})); }

  async listThreads() {
    const threads = new Map();
    let cursor;
    const cursors = new Set();
    do {
      const result = await this.request('thread/list', {
        limit: 100,
        cursor: cursor || null,
        sortKey: 'updated_at',
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer']
      });
      for (const thread of result.data) threads.set(thread.id, thread);
      cursor = result.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Codex returned a duplicate session pagination cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    // Fresh sessions can be loaded in the daemon before they appear in the
    // persisted thread listing. Read their metadata without loading history.
    const loadedIds = (await this.request('thread/loaded/list')).data;
    const loadedSet = new Set(loadedIds);
    const missing = loadedIds.filter(id => !threads.has(id) || threads.get(id).status?.type === 'notLoaded');
    for (let i = 0; i < missing.length; i += 16) {
      const batch = await Promise.all(missing.slice(i, i + 16).map(async threadId => {
        try {
          return (await this.request('thread/read', {threadId})).thread;
        } catch (error) {
          // A session can close between listing it and reading its metadata.
          if (/not found|not loaded/i.test(error.message)) return null;
          throw error;
        }
      }));
      for (const thread of batch) if (thread) threads.set(thread.id, thread);
    }
    return [...threads.values()].sort((a, b) =>
      Number(loadedSet.has(b.id)) - Number(loadedSet.has(a.id)) ||
      Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  close() { this.ws?.close(); }
}

export async function queueToThread(threadId, text) {
  const client = await CodexClient.connect();
  try {
    const loaded = await client.request('thread/loaded/list');
    if (!loaded.data.includes(threadId)) {
      throw new Error('The target session is not connected to the shared Codex server. Open it with codex resume first.');
    }
  } finally { client.close(); }
  // A queued message uses the target thread's settings. Newer Codex versions
  // reject approval, sandbox and working-directory overrides on `queue`.
  const args = ['queue', '--thread', threadId, '--message', text];
  if (process.env.SEREIN_CODEX_SOCKET) args.push('--remote', `unix://${process.env.SEREIN_CODEX_SOCKET}`);
  const {stdout, stderr} = await exec('codex', args, {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  return (stdout || stderr).trim();
}
