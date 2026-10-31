import {execFile, spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {Store} from './store.js';

const exec = promisify(execFile);
const binPath = fileURLToPath(new URL('../bin/serein.js', import.meta.url));

function tmuxEnvironment() {
  const env = {...process.env};
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

export class NativePaneManager {
  constructor({socketName, session, welcomePane, welcomeSpaceId}) {
    this.socketName = socketName;
    this.session = session;
    this.welcomePane = welcomePane;
    this.visiblePane = welcomePane;
    this.panes = new Map();
    this.inboxes = new Map(welcomeSpaceId ? [[welcomeSpaceId, welcomePane]] : []);
    this.activities = new Map();
    this.desired = null;
    this.worker = null;
    this.env = tmuxEnvironment();
  }

  async tmux(args) {
    const {stdout} = await exec('tmux', ['-L', this.socketName, ...args], {env: this.env, timeout: 10000});
    return stdout.trim();
  }

  show(member, serverSocket, spaceId) {
    return this.schedule(member ? {member, serverSocket} : {spaceId});
  }

  showActivity(spaceId) {
    return this.schedule({spaceId, activity: true});
  }

  schedule(desired) {
    this.desired = desired;
    if (!this.worker) {
      this.worker = this.update().finally(() => { this.worker = null; });
    }
    return this.worker;
  }

  async update() {
    while (true) {
      const desired = this.desired;
      try {
        const pane = desired.member ? await this.ensurePane(desired.member, desired.serverSocket) :
          desired.activity ? await this.ensureActivityPane(desired.spaceId) : await this.ensureInboxPane(desired.spaceId);
        if (this.desired !== desired) continue;
        if (pane !== this.visiblePane) {
          await this.tmux(['swap-pane', '-d', '-s', pane, '-t', this.visiblePane]);
          this.visiblePane = pane;
        }
      } catch (error) {
        if (this.desired !== desired) continue;
        throw error;
      }
      if (this.desired === desired) return;
    }
  }

  async ensurePane(member, serverSocket) {
    let pane = this.panes.get(member.thread_id);
    const command = ['codex', 'resume', member.thread_id, '--remote', `unix://${serverSocket}`];
    if (!pane) {
      const args = ['new-window', '-d', '-t', `${this.session}:`, '-P', '-F', '#{pane_id}'];
      if (member.cwd && existsSync(member.cwd)) args.push('-c', member.cwd);
      pane = await this.tmux([...args, ...command]);
      if (!/^%\d+$/.test(pane)) throw new Error('Could not open the native Codex pane.');
      this.panes.set(member.thread_id, pane);
    } else {
      const dead = await this.tmux(['display-message', '-p', '-t', pane, '#{pane_dead}']);
      if (dead === '1') await this.tmux(['respawn-pane', '-k', '-t', pane, ...command]);
    }
    return pane;
  }

  async ensureInboxPane(spaceId) {
    if (!spaceId) return this.welcomePane;
    let pane = this.inboxes.get(spaceId);
    const command = [process.execPath, '--disable-warning=ExperimentalWarning', binPath, '__native_inbox', spaceId];
    if (!pane) {
      pane = await this.tmux(['new-window', '-d', '-t', `${this.session}:`, '-P', '-F', '#{pane_id}', ...command]);
      if (!/^%\d+$/.test(pane)) throw new Error('Could not open the human inbox.');
      this.inboxes.set(spaceId, pane);
    } else {
      const dead = await this.tmux(['display-message', '-p', '-t', pane, '#{pane_dead}']);
      if (dead === '1') await this.tmux(['respawn-pane', '-k', '-t', pane, ...command]);
    }
    return pane;
  }

  async ensureActivityPane(spaceId) {
    let pane = this.activities.get(spaceId);
    const command = ['env', `ANLE_CONSOLE_ID=${this.socketName}`, process.execPath, '--disable-warning=ExperimentalWarning', binPath, '__native_activity', spaceId];
    if (!pane) {
      pane = await this.tmux(['new-window', '-d', '-t', `${this.session}:`, '-P', '-F', '#{pane_id}', ...command]);
      if (!/^%\d+$/.test(pane)) throw new Error('Could not open activity.');
      this.activities.set(spaceId, pane);
    } else {
      const dead = await this.tmux(['display-message', '-p', '-t', pane, '#{pane_dead}']);
      if (dead === '1') await this.tmux(['respawn-pane', '-k', '-t', pane, ...command]);
    }
    return pane;
  }

  async discardInbox(spaceId) {
    const pane = this.inboxes.get(spaceId);
    if (!pane || pane === this.visiblePane) return;
    await this.tmux(['kill-pane', '-t', pane]);
    this.inboxes.delete(spaceId);
  }

  async discardActivity(spaceId) {
    const pane = this.activities.get(spaceId);
    if (!pane || pane === this.visiblePane) return;
    await this.tmux(['kill-pane', '-t', pane]);
    this.activities.delete(spaceId);
  }

  async focusActivity(spaceId) {
    await this.showActivity(spaceId);
    const pane = this.activities.get(spaceId);
    if (!this.desired?.activity || this.desired?.spaceId !== spaceId || pane !== this.visiblePane) throw new Error('The selected workspace changed.');
    await this.tmux(['select-pane', '-t', pane]);
  }

  async focusInbox(spaceId, {selectNewest = false} = {}) {
    await this.show(null, undefined, spaceId);
    const pane = this.inboxes.get(spaceId);
    if (this.desired?.member || this.desired?.activity || this.desired?.spaceId !== spaceId || pane !== this.visiblePane) throw new Error('The selected workspace changed.');
    if (selectNewest) await this.tmux(['send-keys', '-t', pane, 'C-n']);
    if (this.desired?.member || this.desired?.activity || this.desired?.spaceId !== spaceId || pane !== this.visiblePane) throw new Error('The selected workspace changed.');
    await this.tmux(['select-pane', '-t', pane]);
  }

  async forwardInbox(spaceId, value, paste = false) {
    await this.show(null, undefined, spaceId);
    const pane = this.inboxes.get(spaceId);
    if (this.desired?.member || this.desired?.activity || this.desired?.spaceId !== spaceId || pane !== this.visiblePane) throw new Error('The selected workspace changed.');
    const text = paste ? `\x1b[200~${value}\x1b[201~` : value;
    await this.tmux(['send-keys', '-t', pane, '-l', '--', text]);
    if (this.desired?.member || this.desired?.activity || this.desired?.spaceId !== spaceId || pane !== this.visiblePane) throw new Error('The selected workspace changed; input remains in its inbox.');
    await this.tmux(['select-pane', '-t', pane]);
  }

  async focus(member, serverSocket) {
    await this.show(member, serverSocket);
    if (this.desired?.member?.thread_id !== member.thread_id) throw new Error('The selected session changed.');
    const pane = this.panes.get(member.thread_id);
    if (pane !== this.visiblePane) throw new Error('The selected session changed.');
    await this.tmux(['select-pane', '-t', pane]);
  }

  async forward(member, serverSocket, value, paste = false) {
    await this.show(member, serverSocket);
    if (this.desired?.member?.thread_id !== member.thread_id) throw new Error('The selected session changed.');
    const pane = this.panes.get(member.thread_id);
    if (pane !== this.visiblePane) throw new Error('The selected session changed.');
    const text = paste ? `\x1b[200~${value}\x1b[201~` : value;
    await this.tmux(['send-keys', '-t', pane, '-l', '--', text]);
    if (this.desired?.member?.thread_id !== member.thread_id || this.visiblePane !== pane) throw new Error('The selected session changed; input remains in its native pane.');
    await this.tmux(['select-pane', '-t', pane]);
  }

  async close() {
    await this.tmux(['kill-session', '-t', this.session]);
  }
}

export async function startNativeConsole() {
  const store = new Store();
  const initialSpaceId = store.spaces()[0].id;
  store.close();
  const socketName = `serein-${process.pid}-${randomBytes(3).toString('hex')}`;
  const session = 'workspace';
  const env = tmuxEnvironment();
  const tmux = async args => (await exec('tmux', ['-L', socketName, ...args], {env, timeout: 10000})).stdout.trim();
  const columns = Math.max(64, process.stdout.columns || 100);
  const rows = Math.max(18, process.stdout.rows || 30);
  const sidebar = 32;
  const nativeWidth = Math.max(30, columns - sidebar - 1);
  let created = false;
  try {
    const left = await tmux(['new-session', '-d', '-s', session, '-x', String(columns), '-y', String(rows), '-P', '-F', '#{pane_id}', process.execPath, '-e', 'setInterval(() => {}, 3600000)']);
    created = true;
    const right = await tmux(['split-window', '-h', '-l', String(nativeWidth), '-t', left, '-d', '-P', '-F', '#{pane_id}', process.execPath, '--disable-warning=ExperimentalWarning', binPath, '__native_inbox', initialSpaceId]);
    await tmux(['set-option', '-g', 'status', 'off']);
    await tmux(['set-option', '-g', 'mouse', 'on']);
    await tmux(['set-window-option', '-g', 'remain-on-exit', 'on']);
    // Let tmux mark the actual active pane, including mouse and keyboard focus
    // changes, without changing the native Codex interface inside the pane.
    await tmux(['set-window-option', '-t', left, 'pane-border-status', 'bottom']);
    await tmux(['set-window-option', '-t', left, 'pane-active-border-style', 'fg=colour166']);
    await tmux(['set-window-option', '-t', left, 'pane-border-style', 'fg=colour244']);
    await tmux(['set-window-option', '-t', left, 'pane-border-format', '#{?pane_active,#[fg=colour16]#[bg=colour214]#[bold]  ● FOCUSED  #[default],#[fg=colour244]  ○ INACTIVE  #[default]}']);
    // Older tmux versions may not support arrows; the focus labels still work.
    await tmux(['set-window-option', '-t', left, 'pane-border-indicators', 'arrows']).catch(() => {});
    // tmux normally distributes a terminal resize across both panes. Keep the
    // workspace usable when a large terminal is subsequently made smaller.
    await tmux(['set-hook', '-w', '-t', left, 'window-resized', `resize-pane -t ${left} -x ${sidebar}`]);
    await tmux(['bind-key', '-n', 'F6', 'select-pane', '-t', left]);
    await tmux(['bind-key', '-n', 'F7', 'select-pane', '-R']);
    await tmux(['respawn-pane', '-k', '-t', left, 'env', `SEREIN_TMUX_SOCKET=${socketName}`, `SEREIN_TMUX_SESSION=${session}`, `SEREIN_TMUX_WELCOME=${right}`, `SEREIN_TMUX_SPACE=${initialSpaceId}`, process.execPath, '--disable-warning=ExperimentalWarning', binPath, '__native_sidebar']);
    await tmux(['select-pane', '-t', left]);
    await new Promise((resolve, reject) => {
      const child = spawn('tmux', ['-L', socketName, 'attach-session', '-t', session], {env, stdio: 'inherit'});
      child.once('error', reject);
      child.once('exit', resolve);
    });
  } finally {
    if (created) await tmux(['kill-session', '-t', session]).catch(() => {});
  }
}
