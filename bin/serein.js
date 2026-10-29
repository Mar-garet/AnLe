#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import {Store} from '../src/store.js';
import {peerList, replyMessage, resolveAgentSpace, sendMessage} from '../src/messaging.js';

const [action, ...rest] = process.argv.slice(2);

try {
  if (!action || action === 'console') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('The console requires an interactive terminal. Run serein --help for commands.');
    }
    if (process.env.SEREIN_UI === 'classic') {
      const {startConsole} = await import('../src/ui.js');
      await startConsole();
    } else {
      const {startNativeConsole} = await import('../src/native.js');
      try { await startNativeConsole(); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        console.error('Serein: tmux is not installed; opening the classic view.');
        const {startConsole} = await import('../src/ui.js');
        await startConsole();
      }
    }
  } else if (action === '__native_sidebar') {
    const {startConsole} = await import('../src/ui.js');
    const {NativePaneManager} = await import('../src/native.js');
    const manager = new NativePaneManager({socketName: process.env.SEREIN_TMUX_SOCKET, session: process.env.SEREIN_TMUX_SESSION, welcomePane: process.env.SEREIN_TMUX_WELCOME, welcomeSpaceId: process.env.SEREIN_TMUX_SPACE});
    await startConsole({nativeManager: manager});
  } else if (action === '__native_inbox') {
    const {startConsole} = await import('../src/ui.js');
    await startConsole({inboxOnly: true, initialSpaceId: rest[0]});
  } else if (action === 'classic') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The console requires an interactive terminal.');
    const {startConsole} = await import('../src/ui.js');
    await startConsole();
  } else if (action === '--help' || action === '-h' || action === 'help') {
    console.log(`SEREIN — Codex session collaboration console

  serein                                Open the console
  serein classic                        Open the classic view without tmux
  serein setup                          Connect Serein MCP to Codex
  serein peers [--space WORKSPACE]       List nodes in the current workspace
  serein send --to NODE --message TEXT [--space WORKSPACE]
  serein reply --reply-to ID --message TEXT [--space WORKSPACE]

Run send, reply, and peers from a registered Codex session; CODEX_THREAD_ID identifies the sender.
If the session belongs to multiple workspaces, specify a workspace name or ID with --space.`);
  } else if (action === 'setup') {
    const {CodexClient} = await import('../src/codex.js');
    const {setupIntegration} = await import('../src/setup.js');
    const store = new Store();
    let client;
    try {
      client = await CodexClient.connect();
      await setupIntegration(client, store.dataDir);
      console.log('Serein MCP was added to the Codex configuration. Messaging tools are set to be allowed automatically. Existing shared sessions will load the tools after refresh.');
    } finally { client?.close(); store.close(); }
  } else if (['peers', 'send', 'reply'].includes(action)) {
    const options = parseOptions(rest);
    const store = new Store();
    try {
      const threadId = process.env.CODEX_THREAD_ID;
      const space = resolveAgentSpace(store, threadId, options.space);
      if (action === 'peers') {
        console.log(JSON.stringify({space: {id: space.id, name: space.name}, self: store.member(space.id, threadId).name, peers: peerList(store, space.id)}, null, 2));
      } else if (action === 'send') {
        const message = await sendMessage(store, {spaceId: space.id, senderId: threadId, to: need(options.to, '--to'), body: need(options.message, '--message')});
        console.log(JSON.stringify({id: message.id, to: message.recipient_name, state: message.state, body: message.body}));
      } else {
        const message = await replyMessage(store, {spaceId: space.id, senderId: threadId, replyTo: need(options['reply-to'], '--reply-to'), body: need(options.message, '--message')});
        console.log(JSON.stringify({id: message.id, to: message.recipient_name, state: message.state, body: message.body}));
      }
    } finally { store.close(); }
  } else {
    throw new Error(`Unknown command: ${action}. Run serein --help for usage.`);
  }
} catch (error) {
  console.error(`Serein: ${error.message || error}`);
  process.exitCode = 1;
}

function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--') || i + 1 >= args.length) throw new Error(`Invalid argument: ${args[i]}`);
    const name = args[i].slice(2);
    if (!['space', 'to', 'message', 'reply-to'].includes(name)) throw new Error(`Unknown option: ${args[i]}`);
    options[name] = args[++i];
  }
  return options;
}

function need(value, flag) {
  if (!value) throw new Error(`Missing ${flag}`);
  return value;
}
