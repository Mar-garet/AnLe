#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import {Store} from '../src/store.js';
import {conversationForAgent, peerList, replyMessage, resolveAgentSpace, sendMessage} from '../src/messaging.js';

const [action, ...rest] = process.argv.slice(2);

try {
  if (!action || action === 'console') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('The console requires an interactive terminal. Run anle --help for commands.');
    }
    if (process.env.SEREIN_UI === 'classic') {
      const {startConsole} = await import('../src/ui.js');
      await startConsole();
    } else {
      const {startNativeConsole} = await import('../src/native.js');
      try { await startNativeConsole(); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        console.error('AnLe: tmux is not installed; opening the classic view.');
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
  } else if (action === '__native_activity') {
    const {startConsole} = await import('../src/ui.js');
    await startConsole({activityOnly: true, initialSpaceId: rest[0]});
  } else if (action === 'classic') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The console requires an interactive terminal.');
    const {startConsole} = await import('../src/ui.js');
    await startConsole();
  } else if (action === '--help' || action === '-h' || action === 'help') {
    console.log(`AnLe — Codex session collaboration console

  anle                                  Open the console
  anle classic                          Open the classic view without tmux
  anle setup                            Connect AnLe MCP to Codex
  anle peers [--space WORKSPACE]         List nodes in the current workspace
  anle presence [--task TEXT] [--status working|blocked|available|unknown] [--space WORKSPACE]
  anle send --to NODE --message TEXT [--context-message ID] [--reply-expected true|false] [--space WORKSPACE]
  anle reply --reply-to ID --message TEXT [--reply-expected true|false] [--space WORKSPACE]
  anle conversation --message-id ID [--space WORKSPACE]

Run these commands from a registered Codex session; CODEX_THREAD_ID identifies the sender.
If the session belongs to multiple workspaces, specify a workspace name or ID with --space.`);
  } else if (action === 'setup') {
    const {CodexClient} = await import('../src/codex.js');
    const {setupIntegration} = await import('../src/setup.js');
    const store = new Store();
    let client;
    try {
      client = await CodexClient.connect();
      await setupIntegration(client, store.dataDir);
      console.log('AnLe MCP was added to the Codex configuration. Messaging tools are set to be allowed automatically. Existing shared sessions will load the tools after refresh.');
    } finally { client?.close(); store.close(); }
  } else if (['peers', 'presence', 'send', 'reply', 'conversation'].includes(action)) {
    const options = parseOptions(rest);
    const store = new Store();
    try {
      const threadId = process.env.CODEX_THREAD_ID;
      const space = resolveAgentSpace(store, threadId, options.space);
      if (action === 'peers') {
        console.log(JSON.stringify({space: {id: space.id, name: space.name}, self: store.member(space.id, threadId).name, peers: peerList(store, space.id)}, null, 2));
      } else if (action === 'presence') {
        const member = store.updatePresence(space.id, threadId, {task: options.task, status: options.status});
        console.log(JSON.stringify({current_task: member.current_task || null, task_status: member.task_status, task_updated_at: member.task_updated_at}));
      } else if (action === 'conversation') {
        console.log(JSON.stringify(conversationForAgent(store, space.id, threadId, need(options['message-id'], '--message-id')), null, 2));
      } else if (action === 'send') {
        const message = await sendMessage(store, {spaceId: space.id, senderId: threadId, to: need(options.to, '--to'), body: need(options.message, '--message'), contextMessageId: options['context-message'], replyExpected: optionalBoolean(options['reply-expected'])});
        console.log(JSON.stringify({id: message.id, conversation_id: message.conversation_id, to: message.recipient_name, state: message.state, body: message.body}));
      } else {
        const message = await replyMessage(store, {spaceId: space.id, senderId: threadId, replyTo: need(options['reply-to'], '--reply-to'), body: need(options.message, '--message'), replyExpected: optionalBoolean(options['reply-expected'])});
        console.log(JSON.stringify({id: message.id, conversation_id: message.conversation_id, to: message.recipient_name, state: message.state, body: message.body}));
      }
    } finally { store.close(); }
  } else {
    throw new Error(`Unknown command: ${action}. Run anle --help for usage.`);
  }
} catch (error) {
  console.error(`AnLe: ${error.message || error}`);
  process.exitCode = 1;
}

function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--') || i + 1 >= args.length) throw new Error(`Invalid argument: ${args[i]}`);
    const name = args[i].slice(2);
    if (!['space', 'to', 'message', 'reply-to', 'context-message', 'reply-expected', 'message-id', 'task', 'status'].includes(name)) throw new Error(`Unknown option: ${args[i]}`);
    options[name] = args[++i];
  }
  return options;
}

function need(value, flag) {
  if (!value) throw new Error(`Missing ${flag}`);
  return value;
}

function optionalBoolean(value) {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('--reply-expected must be true or false');
}
