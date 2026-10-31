import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text, render, useApp, useInput, usePaste, useStdin, useStdout} from 'ink';
import {basename} from 'node:path';
import stringWidth from 'string-width';
import {ANLE_WORDMARK, ANLE_WORDMARK_WIDTH, COMPACT_INBOX_PETS, COMPACT_INBOX_PETS_WIDTH, EMPTY_INBOX_PETS, EMPTY_INBOX_PETS_WIDTH, MINI_INBOX_PETS, MINI_INBOX_PETS_WIDTH} from './brand.js';
import {CodexClient} from './codex.js';
import {groupConversations} from './conversations.js';
import {draftViewport, editDraft} from './editor.js';
import {displaySessionItem, readSessionHistory, safeTerminalText} from './history.js';
import {deliveryLabel, humanNeedsAttention, replyLabel} from './message-status.js';
import {notifyHumanMessages} from './notifications.js';
import {HUMAN, Store} from './store.js';
import {introduce, replyMessage, sendMessage} from './messaging.js';
import {MouseSequenceParser, positionForScrollbarRow, scrollbarGeometry} from './scroll.js';
import {COMPACT_CONTENT_TOP, COMPACT_PICKER_TOP, compactContentRows, compactNodeAt, sidebarNodeWindow} from './sidebar.js';
import {integrationStatus, setupIntegration} from './setup.js';

const h = React.createElement;
const graphemes = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
// Keep normal text on the terminal's own foreground and use accents that
// remain visible on both light and dark backgrounds, including 256 colors.
const C = {purple: '#7f4ce5', cyan: '#197f7f', yellow: '#b24c19', an: '#a56a0b', path: '#267f97', pathActive: '#c1561e', foreground: undefined, muted: '#767676', red: '#b24c4c', green: '#197f4c'};
const T = (value, color = C.foreground, props = {}) => h(Text, {color, ...props}, value);

function inboxPetLayout(width, height, composeHeight) {
  // Leave enough horizontal space for message metadata and a readable reply.
  const innerWidth = width - 5;
  const innerHeight = height - 2 - composeHeight;
  if (height >= 18 && innerWidth >= EMPTY_INBOX_PETS_WIDTH + 31 && innerHeight >= EMPTY_INBOX_PETS.length + 2) {
    return {kind: 'full', art: EMPTY_INBOX_PETS, sideWidth: EMPTY_INBOX_PETS_WIDTH + 1};
  }
  if (innerWidth >= COMPACT_INBOX_PETS_WIDTH + 31 && innerHeight >= COMPACT_INBOX_PETS.length + 2) {
    return {kind: 'compact', art: COMPACT_INBOX_PETS, sideWidth: COMPACT_INBOX_PETS_WIDTH + 1};
  }
  return {kind: 'mini', art: MINI_INBOX_PETS, sideWidth: 0};
}

export async function startConsole({nativeManager = null, inboxOnly = false, activityOnly = false, initialSpaceId = null} = {}) {
  const store = new Store();
  const instance = render(h(Console, {store, nativeManager, inboxOnly, activityOnly, initialSpaceId}), {alternateScreen: true, exitOnCtrlC: !nativeManager && !inboxOnly && !activityOnly});
  await instance.waitUntilExit();
  store.close();
}

function Console({store, nativeManager, inboxOnly, activityOnly, initialSpaceId}) {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const {stdin} = useStdin();
  const mouseHandler = useRef(() => {});
  const mouseDrag = useRef(null);
  const initializedInbox = useRef(false);
  const knownHumanMessages = useRef(null);
  const lastDeliveryRecovery = useRef(0);
  const [size, setSize] = useState({columns: stdout.columns || 100, rows: stdout.rows || 30});
  const [spaces, setSpaces] = useState(() => store.spaces());
  const [spaceId, setSpaceId] = useState(() => initialSpaceId || store.spaces()[0].id);
  const [members, setMembers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [humanMessages, setHumanMessages] = useState([]);
  const [inboxPendingOnly, setInboxPendingOnly] = useState(false);
  const [storeReady, setStoreReady] = useState(false);
  const [desktopNotifications, setDesktopNotifications] = useState(() => store.desktopNotificationsEnabled());
  const [threads, setThreads] = useState([]);
  const [pickerThreads, setPickerThreads] = useState([]);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerLoading, setPickerLoading] = useState(false);
  const [client, setClient] = useState(null);
  const [connection, setConnection] = useState('CONNECTING');
  const [integration, setIntegration] = useState('checking');
  const [selection, setSelection] = useState(0);
  const [sidebarScroll, setSidebarScroll] = useState(0);
  const [focus, setFocus] = useState(inboxOnly || activityOnly ? 'messages' : 'nodes');
  const [view, setView] = useState(activityOnly ? 'activity' : 'node');
  const [conversationMode, setConversationMode] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [messageSelection, setMessageSelection] = useState(0);
  const [profileOffset, setProfileOffset] = useState(0);
  const [detailOffset, setDetailOffset] = useState(0);
  const [detailMessageId, setDetailMessageId] = useState(null);
  const [sessionOffset, setSessionOffset] = useState(0);
  const [sessionHistory, setSessionHistory] = useState({threadId: null, entries: [], loading: false, error: ''});
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [inlineDrafts, setInlineDrafts] = useState({});
  const [sendingDrafts, setSendingDrafts] = useState({});
  const [pickerSelection, setPickerSelection] = useState(0);
  const [pickerScroll, setPickerScroll] = useState(0);
  const [mode, setMode] = useState('normal');
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState(null);
  const [notice, setNotice] = useState(inboxOnly ? 'Select a message and type your reply · Enter sends' : activityOnly ? 'Select a message · Enter opens details' : 'Select a session and type below · Ctrl+N opens your inbox');

  const space = spaces.find(item => item.id === spaceId) || spaces[0];
  const selected = selection === 0 ? {thread_id: HUMAN, name: 'human', role: 'Your node'} : members[selection - 1];
  const inbox = useMemo(() => inboxPendingOnly ? humanMessages.filter(humanNeedsAttention) : humanMessages, [humanMessages, inboxPendingOnly]);
  const unreadCount = humanMessages.filter(message => !message.human_read_at).length;
  const attentionCount = humanMessages.filter(humanNeedsAttention).length;
  const conversations = useMemo(() => groupConversations(messages), [messages]);
  const conversationList = view === 'activity' && conversationMode && !conversationId;
  const activityMessages = conversationId ? messages.filter(message => (message.conversation_id || message.id) === conversationId) : conversationList ? conversations : messages;
  const contentMessages = view === 'activity' ? activityMessages : selection === 0 ? inbox : [];
  const detailMessage = messages.find(message => message.id === detailMessageId) || humanMessages.find(message => message.id === detailMessageId);
  const sessionThreadId = view === 'node' && selection > 0 ? selected?.thread_id : null;
  const membersByThread = useMemo(() => new Map(members.map(member => [member.thread_id, member])), [members]);
  const sidebarMembers = useMemo(() => {
    const threadPaths = new Map(threads.map(thread => [thread.id, thread.cwd]));
    return members.map(member => member.cwd ? member : {...member, cwd: threadPaths.get(member.thread_id) || ''});
  }, [members, threads]);
  const selectedMessage = conversationList ? null : mode === 'detail' ? detailMessage : focus !== 'nodes' && !sessionThreadId ? contentMessages[messageSelection] : null;
  const replyMember = selectedMessage?.recipient_id === HUMAN ?
    (selectedMessage.space_id === space.id ? membersByThread.get(selectedMessage.sender_id) : store.member(selectedMessage.space_id, selectedMessage.sender_id)) : null;
  const composeTarget = mode === 'normal' && sessionThreadId ? {member: selected, replyTo: null, spaceId: space.id, spaceName: space.name} :
    (mode === 'normal' || mode === 'detail') && replyMember ? {member: replyMember, replyTo: selectedMessage.id, spaceId: selectedMessage.space_id, spaceName: selectedMessage.space_name} : null;
  const composeKey = composeTarget ? `${composeTarget.spaceId}:${composeTarget.member.thread_id}:${composeTarget.replyTo || 'new'}` : null;
  const inlineDraft = inlineDrafts[composeKey] || {text: '', cursor: 0};
  const composeHeight = composeTarget ? 3 : 0;
  const panelHeight = Math.max(10, size.rows - (inboxOnly || activityOnly ? 2 : 10));
  const sidebarWidth = Math.max(25, Math.min(34, Math.floor(size.columns * 0.32)));
  const feedWidth = inboxOnly || activityOnly ? size.columns : Math.max(30, size.columns - sidebarWidth - 2);
  const petLayout = !nativeManager && view === 'node' && selected?.thread_id === HUMAN && (mode === 'normal' || mode === 'detail') ?
    inboxPetLayout(feedWidth, panelHeight, composeHeight) : null;
  const waitingMessages = useMemo(() => {
    if (!sessionThreadId) return [];
    const seen = new Set();
    for (const entry of sessionHistory.entries) {
      if (entry.item?.type !== 'userMessage') continue;
      for (const part of entry.item.content || []) {
        const id = part.text?.match(/^Message ID: ([^\s·]+)/m)?.[1];
        if (id) seen.add(id);
      }
    }
    return messages.filter(message => message.recipient_id === sessionThreadId && !seen.has(message.id));
  }, [messages, sessionHistory.entries, sessionThreadId]);
  const sessionRows = useMemo(() => sessionDisplayRows(sessionHistory.entries, feedWidth - 1, waitingMessages), [sessionHistory.entries, feedWidth, waitingMessages]);
  const sessionRoom = Math.max(1, panelHeight - 5 - composeHeight);
  const sessionMaxOffset = Math.max(0, sessionRows.length - sessionRoom);
  const detailWidth = Math.max(10, feedWidth - 7 - (petLayout?.sideWidth || 0));
  const detailLines = useMemo(() => {
    const error = detailMessage?.error ? `${deliveryLabel(detailMessage)}: ${safeTerminalText(detailMessage.error)}\n\n` : '';
    return wrapBody(`${error}${safeTerminalText(detailMessage?.body || '')}`, detailWidth);
  }, [detailMessage?.body, detailMessage?.error, detailMessage?.state, detailWidth]);
  const detailRoom = Math.max(1, panelHeight - 6 - composeHeight);
  const messageRoom = Math.max(1, Math.floor((panelHeight - 6 - composeHeight) / 2));
  const messageStart = focus !== 'nodes' ? Math.max(0, Math.min(messageSelection - messageRoom + 1, contentMessages.length - messageRoom)) : Math.max(0, contentMessages.length - messageRoom);
  let scrollInfo = null;
  if (!nativeManager && mode === 'normal' && sessionThreadId) {
    scrollInfo = {kind: 'session', total: sessionHistory.threadId === sessionThreadId ? sessionRows.length : 0, visible: sessionRoom, position: sessionMaxOffset - Math.min(sessionOffset, sessionMaxOffset), trackLength: sessionRoom};
  } else if (!nativeManager && mode === 'detail') {
    scrollInfo = {kind: 'detail', total: detailLines.length, visible: detailRoom, position: detailOffset, trackLength: Math.max(1, panelHeight - 5 - composeHeight)};
  } else if (!nativeManager && mode === 'normal') {
    scrollInfo = {kind: 'messages', total: contentMessages.length, visible: messageRoom, position: messageStart, trackLength: Math.max(1, panelHeight - 5 - composeHeight)};
  }
  const candidates = useMemo(() => {
    const query = pickerQuery.trim().toLocaleLowerCase();
    return pickerThreads.filter(thread => {
      const member = membersByThread.get(thread.id);
      return !query || [thread.name, thread.preview, thread.cwd, thread.id, member?.name, member?.cwd].some(part => String(part || '').toLocaleLowerCase().includes(query));
    });
  }, [pickerThreads, membersByThread, pickerQuery]);
  const pickerNodes = useMemo(() => candidates.map(thread => {
    const member = membersByThread.get(thread.id);
    return {
      thread_id: thread.id,
      cwd: thread.cwd || member?.cwd || '',
      name: safeTerminalText(member?.name || thread.name || thread.preview || 'Untitled session').replace(/[\r\n\t]/g, ' '),
      added: !!member,
      status: statusLabel(thread.status?.type),
    };
  }), [candidates, membersByThread]);

  const refreshStore = useCallback(() => {
    if (!inboxOnly && !activityOnly && Date.now() - lastDeliveryRecovery.current >= 30000) {
      store.recoverStaleDeliveries();
      lastDeliveryRecovery.current = Date.now();
    }
    setSpaces(store.spaces());
    setMembers(store.members(spaceId));
    setMessages(store.messages(spaceId, null));
    setHumanMessages(store.humanInbox());
    setDesktopNotifications(store.desktopNotificationsEnabled());
    setStoreReady(true);
  }, [store, spaceId, inboxOnly, activityOnly]);

  const refreshThreads = useCallback(async () => {
    if (!client) return;
    try {
      const latest = await client.listThreads();
      setThreads(latest); setConnection('CONNECTED');
      if (!inboxOnly && !activityOnly) store.recordSessionObservations(latest);
    }
    catch (error) { setConnection('DISCONNECTED'); setNotice(error.message); }
  }, [client, store, inboxOnly, activityOnly]);

  const refreshIntegration = useCallback(async () => {
    if (!client) return;
    try {
      const state = await integrationStatus(client, store.dataDir);
      setIntegration(state);
      if (state === 'missing' || state === 'needs-update') setNotice('Press Ctrl+S to connect AnLe MCP and allow node messaging');
      if (state === 'conflict') setNotice('An MCP server named serein already exists. Check your Codex configuration.');
    } catch (error) { setIntegration('error'); setNotice(error.message); }
  }, [client, store.dataDir]);

  useEffect(() => {
    const resize = () => setSize({columns: stdout.columns || 100, rows: stdout.rows || 30});
    stdout.on('resize', resize);
    return () => stdout.off('resize', resize);
  }, [stdout]);

  useEffect(() => {
    let cancelled = false;
    let connected;
    CodexClient.connect().then(value => {
      connected = value;
      if (cancelled) value.close();
      else { setClient(value); setConnection('CONNECTED'); }
    }).catch(error => { if (!cancelled) { setConnection('DISCONNECTED'); setNotice(error.message); } });
    return () => { cancelled = true; connected?.close(); };
  }, []);

  useEffect(() => {
    refreshStore();
    const timer = setInterval(refreshStore, 1000);
    return () => clearInterval(timer);
  }, [refreshStore]);

  useEffect(() => {
    if (inboxOnly || activityOnly || !storeReady) return;
    const currentIds = new Set(humanMessages.map(message => message.id));
    const previousIds = knownHumanMessages.current;
    knownHumanMessages.current = currentIds;
    if (!previousIds || !desktopNotifications) return;
    const arrivals = humanMessages.filter(message => !previousIds.has(message.id) && !message.human_read_at);
    if (!arrivals.length) return;
    let cancelled = false;
    notifyHumanMessages(arrivals).catch(error => {
      if (!cancelled) setNotice(`Desktop alert unavailable: ${error.message || String(error)}`);
    });
    return () => { cancelled = true; };
  }, [humanMessages, desktopNotifications, storeReady, inboxOnly, activityOnly]);

  useEffect(() => {
    refreshThreads();
    refreshIntegration();
    const timer = setInterval(refreshThreads, 5000);
    return () => clearInterval(timer);
  }, [refreshThreads, refreshIntegration]);

  useEffect(() => { if (selection > members.length) setSelection(members.length); }, [selection, members.length]);
  useEffect(() => { setSidebarScroll(0); }, [selection, spaceId, size.columns, size.rows]);
  useEffect(() => { setPickerScroll(0); }, [pickerSelection, pickerQuery, mode, size.columns, size.rows]);
  useEffect(() => { if (messageSelection >= contentMessages.length) setMessageSelection(Math.max(0, contentMessages.length - 1)); }, [messageSelection, contentMessages.length]);
  useEffect(() => {
    if (conversationId && !conversations.some(group => group.conversation_id === conversationId)) setConversationId(null);
  }, [conversationId, conversations]);
  useEffect(() => {
    if (!inboxOnly || initializedInbox.current || !inbox.length) return;
    initializedInbox.current = true;
    const newestUnread = inbox.findLastIndex(message => !message.human_read_at);
    setMessageSelection(newestUnread >= 0 ? newestUnread : inbox.length - 1);
  }, [inboxOnly, inbox]);
  useEffect(() => {
    if (!activityOnly || initializedInbox.current || !messages.length) return;
    initializedInbox.current = true;
    setMessageSelection(messages.length - 1);
  }, [activityOnly, messages]);
  useEffect(() => { setSessionOffset(value => Math.min(value, sessionMaxOffset)); }, [sessionMaxOffset]);
  useEffect(() => () => client?.close(), [client]);

  useEffect(() => {
    if (nativeManager || !sessionThreadId || !client) return;
    let cancelled = false;
    let timer;
    let first = true;
    let lastSnapshot;
    setSessionOffset(0);
    setSessionHistory({threadId: sessionThreadId, entries: [], loading: true, error: ''});
    const refresh = async () => {
      try {
        const entries = await readSessionHistory(client, sessionThreadId, {
          isCancelled: () => cancelled,
          onPage: first ? page => {
            if (!cancelled) setSessionHistory({threadId: sessionThreadId, entries: page, loading: true, error: ''});
          } : undefined,
        });
        if (!cancelled) {
          const snapshot = JSON.stringify(entries);
          if (snapshot !== lastSnapshot) {
            lastSnapshot = snapshot;
            setSessionHistory({threadId: sessionThreadId, entries, loading: false, error: ''});
          }
        }
      } catch (error) {
        if (!cancelled) {
          lastSnapshot = undefined;
          setSessionHistory(current => ({threadId: sessionThreadId, entries: current.threadId === sessionThreadId ? current.entries : [], loading: false, error: error.message || String(error)}));
        }
      }
      first = false;
      if (!cancelled) timer = setTimeout(refresh, 5000);
    };
    refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, nativeManager, sessionThreadId, historyRefresh]);

  useEffect(() => {
    if (!nativeManager || (view !== 'activity' && !client && selected?.thread_id !== HUMAN)) return;
    let cancelled = false;
    const member = selected?.thread_id === HUMAN ? null : selected;
    const display = view === 'activity' ? nativeManager.showActivity(space.id) : nativeManager.show(member, client?.socketPath, space.id);
    display.catch(error => {
      if (!cancelled) setNotice(`Could not open Codex: ${error.message || String(error)}`);
    });
    return () => { cancelled = true; };
  }, [nativeManager, client, selected?.thread_id, selected?.cwd, space.id, view]);

  useEffect(() => {
    if (!nativeManager) return;
    let cancelled = false;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const request = store.takeNavigation(nativeManager.socketName);
        if (!request) return;
        const targetSpace = store.space(request.space_id);
        const targetMembers = store.members(request.space_id);
        const index = request.thread_id === HUMAN ? -1 : targetMembers.findIndex(member => member.thread_id === request.thread_id);
        if (!targetSpace || (request.thread_id !== HUMAN && index < 0)) throw new Error('Participant is no longer in this workspace');
        setSpaces(store.spaces()); setMembers(targetMembers); setSpaceId(request.space_id); setSelection(index + 1);
        setView('node'); setMode('normal'); setFocus('nodes');
        if (request.thread_id === HUMAN) await nativeManager.focusInbox(request.space_id);
        else {
          if (!client) throw new Error('Connect to Codex before opening the session');
          await nativeManager.focus(targetMembers[index], client.socketPath);
        }
      } catch (error) {
        if (!cancelled) setNotice(error.message || String(error));
      } finally { busy = false; }
    };
    const timer = setInterval(poll, 300);
    void poll();
    return () => { cancelled = true; clearInterval(timer); };
  }, [store, nativeManager, client]);

  function prompt(nextMode, value = '') { setInput(value); setMode(nextMode); }
  function finish() { setMode('normal'); setInput(''); setDraft(null); refreshStore(); }
  function run(task) { Promise.resolve().then(task).catch(error => setNotice(error.message || String(error))).finally(refreshStore); }
  function updateInlineDraft(action, value = '') {
    if (!composeKey) return;
    setInlineDrafts(current => ({...current, [composeKey]: editDraft(current[composeKey], action, value)}));
  }

  function selectNewestInbox() {
    const unread = humanMessages.findLastIndex(message => !message.human_read_at);
    const open = humanMessages.findLastIndex(humanNeedsAttention);
    setInboxPendingOnly(false);
    setMessageSelection(unread >= 0 ? unread : open >= 0 ? open : Math.max(0, humanMessages.length - 1));
    setMode('normal'); setDetailMessageId(null); setFocus('messages');
  }

  function toggleInboxFilter() {
    const pendingOnly = !inboxPendingOnly;
    const next = pendingOnly ? humanMessages.filter(humanNeedsAttention) : humanMessages;
    const unread = next.findLastIndex(message => !message.human_read_at);
    setInboxPendingOnly(pendingOnly);
    setMessageSelection(unread >= 0 ? unread : Math.max(0, next.length - 1));
    setMode('normal'); setDetailMessageId(null); setFocus('messages');
  }

  function toggleConversations() {
    const next = !conversationMode;
    setConversationMode(next); setConversationId(null); setMode('normal'); setDetailMessageId(null);
    setMessageSelection(Math.max(0, (next ? conversations.length : messages.length) - 1));
    setFocus('messages');
  }

  function openConversation(group) {
    if (!group) return;
    const id = group.conversation_id || group.id;
    const count = messages.filter(message => (message.conversation_id || message.id) === id).length;
    setConversationId(id); setMessageSelection(Math.max(0, count - 1)); setMode('normal'); setFocus('messages');
  }

  function closeConversation() {
    const index = conversations.findIndex(group => group.conversation_id === conversationId);
    setConversationId(null); setMessageSelection(Math.max(0, index)); setMode('normal'); setDetailMessageId(null); setFocus('messages');
  }

  function openParticipant(which) {
    const message = mode === 'detail' ? detailMessage : contentMessages[messageSelection];
    if (!message) return;
    const threadId = which === 'sender' ? message.sender_id : message.recipient_id;
    try {
      if (activityOnly) {
        if (!process.env.ANLE_CONSOLE_ID) throw new Error('The console navigation is unavailable');
        store.requestNavigation(process.env.ANLE_CONSOLE_ID, message.space_id, threadId);
        setNotice(`Opening ${which === 'sender' ? message.sender_name : message.recipient_name}…`);
        return;
      }
      const targetMembers = store.members(message.space_id);
      const index = threadId === HUMAN ? -1 : targetMembers.findIndex(member => member.thread_id === threadId);
      if (threadId !== HUMAN && index < 0) throw new Error('Participant is no longer in this workspace');
      setSpaces(store.spaces()); setMembers(targetMembers); setSpaceId(message.space_id);
      setSelection(index + 1); setView('node'); setMode('normal'); setFocus(threadId === HUMAN ? 'messages' : 'nodes');
    } catch (error) { setNotice(error.message || String(error)); }
  }

  function scrollProfile(amount) {
    const width = nativeManager ? Math.max(8, size.columns - 4) : Math.max(8, feedWidth - 4);
    const room = nativeManager ? Math.max(1, compactContentRows(size.rows) - 2) : Math.max(1, panelHeight - 4);
    const runtime = connection === 'CONNECTED' ? threads.find(thread => thread.id === selected?.thread_id)?.status?.type : undefined;
    const limit = Math.max(0, profileLines(selected, runtime, width).length - room);
    setProfileOffset(value => Math.max(0, Math.min(limit, value + amount)));
  }

  function toggleHumanDone() {
    const message = mode === 'detail' ? detailMessage : contentMessages[messageSelection];
    if (!message || message.recipient_id !== HUMAN) return;
    if (message.reply_state === 'replied') { setNotice('This message has already been replied to.'); return; }
    const resolved = !message.human_resolved_at;
    store.markHumanMessageRead(message.space_id, message.id);
    store.setHumanMessageResolved(message.space_id, message.id, resolved);
    setNotice(resolved ? (inboxPendingOnly && mode === 'normal' ? 'Marked done · Ctrl+T shows it to undo' : 'Marked done · Ctrl+D can undo') : 'Marked open');
    refreshStore();
  }

  async function sendInline() {
    if (!composeTarget || !composeKey) return;
    const value = inlineDraft.text.trim();
    if (!value) return;
    if (sendingDrafts[composeKey]) { setNotice('Still sending the previous message.'); return; }
    const target = composeTarget;
    const key = composeKey;
    const originalDraft = inlineDraft;
    setInlineDrafts(current => ({...current, [key]: {text: '', cursor: 0}}));
    setSendingDrafts(current => ({...current, [key]: true}));
    setFocus('input');
    setNotice(`Sending to ${target.member.name}…`);
    try {
      if (target.replyTo) store.markHumanMessageRead(target.spaceId, target.replyTo);
      const operation = target.replyTo
        ? replyMessage(store, {spaceId: target.spaceId, senderId: HUMAN, replyTo: target.replyTo, body: value})
        : sendMessage(store, {spaceId: target.spaceId, senderId: HUMAN, to: target.member.thread_id, body: value});
      refreshStore();
      await operation;
      setNotice(`Message queued in ${target.member.name}'s original session.`);
    } catch (error) {
      setInlineDrafts(current => current[key]?.text ? current : {...current, [key]: originalDraft});
      setNotice(error.deliveryState === 'unknown' ? 'Delivery UNKNOWN · check Activity before resending; draft kept' : error.message || String(error));
    } finally {
      setSendingDrafts(current => ({...current, [key]: false}));
      refreshStore();
    }
  }

  async function submit() {
    const value = input.trim();
    try {
      if (mode === 'new-space') {
        const created = store.createSpace(value);
        setSpaceId(created.id); setSelection(0); setNotice(`Created workspace: ${created.name}`); finish();
      } else if (mode === 'picker-search') {
        setPickerQuery(value); setPickerSelection(0); setMode('picker'); setInput('');
      } else if (mode === 'join-name') {
        if (!value) throw new Error('Node name cannot be empty');
        setDraft({...draft, name: value}); prompt('join-role');
      } else if (mode === 'join-role') {
        const member = store.addMember(space.id, {threadId: draft.thread.id, name: draft.name, role: value, cwd: draft.thread.cwd || ''});
        finish(); setSelection(members.length + 1); setNotice(`Sending an introduction to ${member.name}…`);
        run(async () => { await introduce(space, member); setNotice(`${member.name} joined. Introduction queued in the original session.`); });
      } else if (mode === 'edit-name') {
        if (!value) throw new Error('Node name cannot be empty');
        setDraft({...draft, name: value}); prompt('edit-role', draft.member.role);
      } else if (mode === 'edit-role') {
        store.updateMember(space.id, draft.member.thread_id, {name: draft.name, role: value});
        const updated = store.member(space.id, draft.member.thread_id);
        finish(); setNotice('Node updated. Sending an introduction…');
        run(async () => { await introduce(space, updated); setNotice(`Introduction queued in ${updated.name}'s original session.`); });
      }
    } catch (error) { setNotice(error.message || String(error)); }
  }

  usePaste(text => {
    if (['new-space', 'picker-search', 'join-name', 'join-role', 'edit-name', 'edit-role'].includes(mode)) setInput(old => old + text.replaceAll('\n', ' '));
    else if (nativeManager && mode === 'normal' && view === 'node' && selected?.thread_id === HUMAN && focus === 'nodes') {
      nativeManager.forwardInbox(space.id, text, true).catch(error => setNotice(error.message || String(error)));
    }
    else if (nativeManager && mode === 'normal' && sessionThreadId && selected) {
      if (!client) setNotice('Connecting to Codex…');
      else nativeManager.forward(selected, client.socketPath, text, true).catch(error => setNotice(error.message || String(error)));
    }
    else if (composeTarget) { updateInlineDraft('insert', text); setFocus('input'); }
  });

  useInput((keyInput, key) => {
    if (inboxOnly || activityOnly) {
      if (inboxOnly && key.ctrl && keyInput.toLowerCase() === 'n') { selectNewestInbox(); return; }
      if (inboxOnly && key.ctrl && keyInput.toLowerCase() === 't') { toggleInboxFilter(); return; }
      if (activityOnly && key.ctrl && keyInput.toLowerCase() === 't') { toggleConversations(); return; }
      if (activityOnly && key.ctrl && ['o', 'p'].includes(keyInput.toLowerCase())) { openParticipant(keyInput.toLowerCase() === 'o' ? 'sender' : 'recipient'); return; }
      if (key.ctrl && keyInput.toLowerCase() === 'd') { toggleHumanDone(); return; }
      if (key.escape) {
        if (mode === 'detail') setMode('normal');
        else if (activityOnly && conversationId) closeConversation();
        setFocus('messages'); return;
      }
      if (mode === 'detail' && (key.upArrow || key.downArrow || key.pageUp || key.pageDown)) {
        const amount = key.pageUp || key.pageDown ? 8 : 1;
        setDetailOffset(value => Math.max(0, value + (key.upArrow || key.pageUp ? -amount : amount)));
        return;
      }
      if (mode === 'normal' && (key.upArrow || key.downArrow || key.pageUp || key.pageDown)) {
        const amount = key.pageUp || key.pageDown ? 8 : 1;
        setFocus('messages');
        setMessageSelection(value => Math.max(0, Math.min(contentMessages.length - 1, value + (key.upArrow || key.pageUp ? -amount : amount))));
        return;
      }
      if (key.return) {
        if (activityOnly && conversationList) openConversation(contentMessages[messageSelection]);
        else if (composeTarget && (key.shift || key.meta)) updateInlineDraft('insert', '\n');
        else if (composeTarget && inlineDraft.text.trim()) void sendInline();
        else if (mode === 'normal' && contentMessages[messageSelection]) openMessage(contentMessages[messageSelection]);
        return;
      }
      if (composeTarget) {
        if (key.backspace) updateInlineDraft('backspace');
        else if (key.delete) updateInlineDraft('delete');
        else if (key.leftArrow) updateInlineDraft('left');
        else if (key.rightArrow) updateInlineDraft('right');
        else if (key.home) updateInlineDraft('home');
        else if (key.end) updateInlineDraft('end');
        else if (!key.ctrl && !key.meta && keyInput) { updateInlineDraft('insert', keyInput); setFocus('input'); }
      }
      return;
    }
    if (nativeManager && key.ctrl && keyInput === 'c') {
      nativeManager.close().catch(error => setNotice(error.message || String(error)));
      return;
    }
    if (mode === 'picker') {
      if (key.escape || keyInput === 'q') { setMode('normal'); return; }
      if (key.upArrow) setPickerSelection(value => Math.max(0, value - 1));
      if (key.downArrow && candidates.length) setPickerSelection(value => Math.min(candidates.length - 1, value + 1));
      if (key.pageUp || key.pageDown) {
        const rowCapacity = nativeManager ? Math.max(1, compactContentRows(size.rows) - 2) : Math.max(1, panelHeight - 4);
        const innerWidth = nativeManager ? Math.max(8, Math.max(20, size.columns) - 4) : Math.max(1, feedWidth - 4);
        setPickerScroll(value => {
          const window = sidebarNodeWindow({nodes: pickerNodes, selection: pickerSelection, innerWidth, rowCapacity, scrollShift: value});
          const next = Math.max(0, Math.min(window.scrollLimit, window.start + (key.pageDown ? rowCapacity - 1 : 1 - rowCapacity)));
          return value + next - window.start;
        });
      }
      if (keyInput === '/') { prompt('picker-search', pickerQuery); return; }
      if (key.return && candidates[pickerSelection]) {
        const thread = candidates[pickerSelection];
        const member = membersByThread.get(thread.id);
        if (member) {
          setNotice(`${member.name} is already in this workspace.`);
          return;
        }
        if (thread.status?.type === 'notLoaded') {
          setNotice(`Run codex resume ${thread.id}, then press r.`);
          return;
        }
        setDraft({thread}); prompt('join-name', suggestedName(thread, members));
      }
      return;
    }
    if (mode === 'help') { setMode('normal'); return; }
    if (mode === 'confirm-remove') {
      if (keyInput.toLowerCase() === 'y' && selected && selection > 0) {
        store.removeMember(space.id, selected.thread_id); setNotice(`${selected.name} removed from the workspace.`); setSelection(0); refreshStore();
      }
      setMode('normal'); return;
    }
    if (mode === 'confirm-delete-space') {
      if (key.escape || keyInput.toLowerCase() === 'n') { setMode('normal'); setDraft(null); return; }
      if (keyInput.toLowerCase() === 'y') {
        try {
          const {deleted, nextSpace, replacementCreated} = store.deleteSpace(draft.spaceId);
          setSpaces(store.spaces()); setSpaceId(nextSpace.id); setSelection(0); setView('node'); setFocus('nodes');
          setMessageSelection(0); setDetailMessageId(null);
          setInlineDrafts(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${deleted.id}:`))));
          setNotice(replacementCreated ? 'Workspace deleted. An empty workspace was created.' : `Workspace deleted: ${deleted.name}`);
          if (nativeManager) nativeManager.show(null, undefined, nextSpace.id).then(() => Promise.all([nativeManager.discardInbox(deleted.id), nativeManager.discardActivity(deleted.id)])).catch(error => setNotice(error.message || String(error)));
        } catch (error) { setNotice(error.message || String(error)); }
        setMode('normal'); setDraft(null);
      }
      return;
    }
    if (mode === 'profile') {
      if (key.escape || keyInput === 'q') setMode('normal');
      else if (key.ctrl && keyInput.toLowerCase() === 'e' && selected) { setDraft({member: selected}); prompt('edit-name', selected.name); }
      else if (key.upArrow || key.pageUp) scrollProfile(key.pageUp ? -8 : -1);
      else if (key.downArrow || key.pageDown) scrollProfile(key.pageDown ? 8 : 1);
      return;
    }
    if (mode !== 'normal' && mode !== 'detail') {
      if (key.escape) { if (mode === 'picker-search') { setMode('picker'); setInput(''); } else finish(); return; }
      if (key.return) { submit(); return; }
      if (key.backspace || key.delete) { setInput(old => Array.from(old).slice(0, -1).join('')); return; }
      if (!key.ctrl && !key.meta && keyInput) setInput(old => old + keyInput);
      return;
    }
    const command = letter => keyInput.toLowerCase() === letter && (key.ctrl || (!nativeManager && !composeTarget && mode === 'normal' && !key.meta));
    if (command('q')) {
      if (nativeManager) nativeManager.close().catch(error => setNotice(error.message || String(error)));
      else exit();
      return;
    }
    if (key.ctrl && keyInput.toLowerCase() === 'u') {
      if (!['darwin', 'linux'].includes(process.platform)) { setNotice('Desktop alerts are unavailable on this platform.'); return; }
      const enabled = !desktopNotifications;
      store.setDesktopNotifications(enabled);
      setDesktopNotifications(enabled);
      setNotice(`Desktop alerts ${enabled ? 'ON' : 'OFF'} · Ctrl+U toggles`);
      return;
    }
    if (command('n')) {
      setMode('normal');
      setSelection(0); setView('node'); setFocus(nativeManager ? 'nodes' : 'messages');
      if (!nativeManager) selectNewestInbox();
      if (nativeManager) nativeManager.focusInbox(space.id, {selectNewest: true}).catch(error => setNotice(error.message || String(error)));
      return;
    }
    if (!nativeManager && selection === 0 && view === 'node' && key.ctrl && keyInput.toLowerCase() === 't') { toggleInboxFilter(); return; }
    if (!nativeManager && selection === 0 && view === 'node' && focus !== 'nodes' && key.ctrl && keyInput.toLowerCase() === 'd') { toggleHumanDone(); return; }
    if (!nativeManager && view === 'activity' && key.ctrl && keyInput.toLowerCase() === 't') { toggleConversations(); return; }
    if (!nativeManager && view === 'activity' && key.ctrl && ['o', 'p'].includes(keyInput.toLowerCase())) { openParticipant(keyInput.toLowerCase() === 'o' ? 'sender' : 'recipient'); return; }
    if (command('v')) {
      setMode('normal');
      const nextView = view === 'activity' ? 'node' : 'activity';
      setView(nextView);
      const nextMessages = nextView === 'activity' ? messages : selection === 0 ? inbox : [];
      setMessageSelection(Math.max(0, nextMessages.length - 1));
      if (nativeManager) setFocus('nodes');
      else if (focus === 'input') setFocus('messages');
      return;
    }
    if ((key.ctrl && keyInput === 'p') || (!nativeManager && !composeTarget && mode === 'normal' && keyInput === '?')) { setMode('help'); return; }
    if (command('a')) {
      if (integration !== 'ready') { setNotice('Press Ctrl+S to connect AnLe MCP before adding sessions.'); return; }
      if (!client || client.ws?.readyState !== 1) { setNotice('Press Ctrl+R to reconnect to Codex.'); return; }
      setPickerThreads([]); setPickerQuery(''); setPickerSelection(0); setPickerLoading(true); setMode('picker');
      run(async () => {
        try {
          const freshThreads = await client.listThreads();
          setThreads(freshThreads);
          setPickerThreads(freshThreads);
        } finally { setPickerLoading(false); }
      });
      return;
    }
    if (command('s')) {
      if (!client) { setNotice('Connect to the shared Codex server first.'); return; }
      setNotice('Connecting AnLe MCP…');
      run(async () => { await setupIntegration(client, store.dataDir); setIntegration('ready'); setNotice('AnLe MCP connected. Node messaging tools are set to allow automatically.'); });
      return;
    }
    if ((key.ctrl && keyInput === 'w') || (!nativeManager && !composeTarget && mode === 'normal' && keyInput === 'G')) { prompt('new-space'); return; }
    if (command('g')) {
      const index = spaces.findIndex(item => item.id === spaceId);
      setSpaceId(spaces[(index + 1) % spaces.length].id); setSelection(0); setView('node'); setFocus('nodes'); setMode('normal');
      return;
    }
    if (command('e') && selection > 0 && selected) { setDraft({member: selected}); prompt('edit-name', selected.name); return; }
    if (key.ctrl && keyInput.toLowerCase() === 'o' && selection > 0 && selected && view === 'node') { setProfileOffset(0); setMode('profile'); return; }
    if (command('x') && selection > 0) { setMode('confirm-remove'); return; }
    if (key.ctrl && keyInput === 'd') {
      setDraft({spaceId: space.id, spaceName: space.name, memberCount: store.members(space.id).length, messageCount: store.messages(space.id, null).length, replacement: store.spaces().length === 1});
      setMode('confirm-delete-space');
      return;
    }
    if (((key.ctrl && keyInput === 'l') || (!nativeManager && !composeTarget && mode === 'normal' && keyInput === 'i')) && selection > 0 && selected) { run(async () => { await introduce(space, selected); setNotice(`Introduction queued in ${selected.name}'s original session.`); }); return; }
    if (command('r')) {
      refreshStore();
      if (sessionThreadId) setHistoryRefresh(value => value + 1);
      if (!client || client.ws?.readyState !== 1) run(async () => { const next = await CodexClient.connect(); setClient(next); setConnection('CONNECTED'); setNotice('Reconnected to Codex.'); });
      else { refreshThreads(); refreshIntegration(); setNotice('Refreshed.'); }
      return;
    }
    if (nativeManager && mode === 'normal' && view === 'activity' && (key.return || key.tab)) {
      nativeManager.focusActivity(space.id).catch(error => setNotice(error.message || String(error)));
      return;
    }
    if (nativeManager && mode === 'normal' && view === 'node' && selection === 0 && focus === 'nodes') {
      if (key.return || key.tab) { nativeManager.focusInbox(space.id).catch(error => setNotice(error.message || String(error))); return; }
      if (!key.ctrl && !key.meta && keyInput) { nativeManager.forwardInbox(space.id, keyInput).catch(error => setNotice(error.message || String(error))); return; }
    }
    if (nativeManager && mode === 'normal' && sessionThreadId && selected && focus === 'nodes') {
      if (key.return || key.tab || (!key.ctrl && !key.meta && keyInput)) {
        if (!client) setNotice('Connecting to Codex…');
        else if (key.return || key.tab) nativeManager.focus(selected, client.socketPath).catch(error => setNotice(error.message || String(error)));
        else nativeManager.forward(selected, client.socketPath, keyInput).catch(error => setNotice(error.message || String(error)));
        return;
      }
    }
    if (key.escape) {
      if (mode === 'detail') { setMode('normal'); setFocus('messages'); }
      else if (!nativeManager && view === 'activity' && conversationId) closeConversation();
      else if (focus === 'input' || (nativeManager && focus !== 'nodes')) { setFocus('nodes'); setView('node'); }
      return;
    }
    if (key.tab || (!composeTarget && mode === 'normal' && keyInput === 'f')) {
      if (mode === 'detail') setFocus(value => value === 'input' ? 'messages' : 'input');
      else setFocus(value => value === 'nodes' ? 'messages' : value === 'messages' && composeTarget ? 'input' : 'nodes');
      if (focus === 'nodes' && !sessionThreadId) setMessageSelection(Math.max(0, contentMessages.length - 1));
      return;
    }
    if (!nativeManager && conversationList && focus !== 'nodes' && key.return) { openConversation(contentMessages[messageSelection]); return; }
    if (composeTarget && key.return) {
      if (key.shift || key.meta) { updateInlineDraft('insert', '\n'); setFocus('input'); return; }
      if (inlineDraft.text.trim()) void sendInline();
      else if (mode === 'normal' && !sessionThreadId && focus === 'messages' && contentMessages[messageSelection]) openMessage(contentMessages[messageSelection]);
      else setFocus('input');
      return;
    }
    if (composeTarget && focus === 'input') {
      if (key.backspace) { updateInlineDraft('backspace'); return; }
      if (key.delete) { updateInlineDraft('delete'); return; }
      if (key.leftArrow) { updateInlineDraft('left'); return; }
      if (key.rightArrow) { updateInlineDraft('right'); return; }
      if (key.home) { updateInlineDraft('home'); return; }
      if (key.end) { updateInlineDraft('end'); return; }
    }
    if (composeTarget && !key.ctrl && !key.meta && keyInput) {
      updateInlineDraft('insert', keyInput); setFocus('input'); return;
    }
    if (mode === 'detail') {
      if (key.upArrow || key.pageUp) setDetailOffset(value => Math.max(0, value - (key.pageUp ? 8 : 1)));
      if (key.downArrow || key.pageDown) setDetailOffset(value => value + (key.pageDown ? 8 : 1));
      return;
    }
    if (focus === 'messages' || focus === 'input') {
      if (sessionThreadId) {
        if (key.upArrow || key.pageUp) setSessionOffset(value => Math.min(sessionMaxOffset, value + (key.pageUp ? sessionRoom : 1)));
        if (key.downArrow || key.pageDown) setSessionOffset(value => Math.max(0, value - (key.pageDown ? sessionRoom : 1)));
        if (key.home) setSessionOffset(sessionMaxOffset);
        if (key.end) setSessionOffset(0);
      } else {
        if (key.upArrow || key.pageUp) setMessageSelection(value => Math.max(0, value - (key.pageUp ? 8 : 1)));
        if (key.downArrow || key.pageDown) setMessageSelection(value => Math.min(Math.max(0, contentMessages.length - 1), value + (key.pageDown ? 8 : 1)));
        if (key.return && contentMessages[messageSelection]) openMessage(contentMessages[messageSelection]);
      }
    } else {
      if (key.upArrow) { setView('node'); setSelection(value => Math.max(0, value - 1)); }
      if (key.downArrow) { setView('node'); setSelection(value => Math.min(members.length, value + 1)); }
      if (key.pageUp || key.pageDown) {
        const nodes = [{name: 'human', thread_id: HUMAN}, ...sidebarMembers];
        const rowCapacity = nativeManager ? compactContentRows(size.rows) : Math.max(1, panelHeight - 5);
        const innerWidth = nativeManager ? Math.max(8, size.columns - 4) : sidebarWidth - 4;
        const indent = nativeManager ? 2 : 4;
        setView('node');
        setSidebarScroll(value => {
          const window = sidebarNodeWindow({nodes, selection, innerWidth, rowCapacity, indent, scrollShift: value});
          const next = Math.max(0, Math.min(window.scrollLimit, window.start + (key.pageDown ? rowCapacity - 1 : 1 - rowCapacity)));
          return value + next - window.start;
        });
      }
    }
  });

  mouseHandler.current = event => {
    if (inboxOnly || activityOnly) {
      if (event.release) { mouseDrag.current = null; return; }
      const geometry = scrollInfo && scrollbarGeometry(scrollInfo.total, scrollInfo.visible, scrollInfo.position, scrollInfo.trackLength);
      const scrollTo = position => {
        const next = Math.max(0, Math.min(geometry.maxPosition, position));
        if (mode === 'detail') setDetailOffset(next);
        else { setFocus('messages'); setMessageSelection(Math.min(contentMessages.length - 1, next + messageRoom - 1)); }
      };
      if (event.button & 64) {
        const direction = event.button & 3;
        if (direction > 1) return;
        if (mode === 'detail') setDetailOffset(value => Math.max(0, value + (direction ? 3 : -3)));
        else { setFocus('messages'); setMessageSelection(value => Math.max(0, Math.min(contentMessages.length - 1, value + (direction ? 1 : -1)))); }
      } else if (event.button & 32) {
        if (geometry?.maxPosition && mouseDrag.current) scrollTo(positionForScrollbarRow(geometry, event.y - 5, mouseDrag.current.grab));
      } else if ((event.button & 3) === 0 && geometry?.maxPosition && event.x >= size.columns - 2 && event.y >= 5 && event.y < 5 + geometry.trackLength) {
        const row = event.y - 5;
        const grab = row >= geometry.thumbStart && row < geometry.thumbStart + geometry.thumbLength ? row - geometry.thumbStart : Math.floor(geometry.thumbLength / 2);
        mouseDrag.current = {grab};
        scrollTo(positionForScrollbarRow(geometry, row, grab));
      } else if ((event.button & 3) === 0 && petLayout?.sideWidth && event.x >= size.columns - petLayout.sideWidth - 2 && event.x < size.columns - 2) {
        return;
      } else if ((event.button & 3) === 0 && mode === 'normal' && event.y >= 5) {
        const row = Math.floor((event.y - 5) / 2);
        if (row < messageRoom && messageStart + row < contentMessages.length) { setFocus('messages'); setMessageSelection(messageStart + row); }
        else if (composeTarget) setFocus('input');
      }
      return;
    }
    if (nativeManager) {
      if (event.release || (event.button & 32)) return;
      const wheel = event.button & 64 ? event.button & 3 : null;
      if (wheel !== null && wheel > 1) return;
      const direction = wheel === 0 ? -1 : 1;
      const click = wheel === null && (event.button & 3) === 0;
      const room = Math.max(1, compactContentRows(size.rows) - (composeTarget && (mode === 'detail' || selected?.thread_id === HUMAN || view === 'activity') ? 2 : 0));
      if (mode === 'picker') {
        if (wheel !== null) setPickerSelection(value => Math.max(0, Math.min(candidates.length - 1, value + direction)));
        else if (click && event.x >= 2 && event.x < size.columns && event.y >= COMPACT_PICKER_TOP) {
          const innerWidth = Math.max(8, Math.max(20, size.columns) - 4);
          const {rows} = sidebarNodeWindow({nodes: pickerNodes, selection: pickerSelection, innerWidth, rowCapacity: Math.max(1, room - 2), scrollShift: pickerScroll});
          const index = rows[event.y - COMPACT_PICKER_TOP]?.index;
          if (index !== undefined) setPickerSelection(index);
        }
        return;
      }
      if (mode === 'detail') {
        if (wheel !== null) setDetailOffset(value => Math.max(0, value + direction * 3));
        return;
      }
      if (mode === 'profile') {
        if (wheel !== null) scrollProfile(direction * 3);
        return;
      }
      if (mode !== 'normal') return;
      const showingNodes = view === 'activity' || (view === 'node' && (selection > 0 || focus === 'nodes'));
      if (showingNodes) {
        if (wheel !== null) {
          setFocus('nodes'); setView('node');
          setSelection(value => Math.max(0, Math.min(members.length, value + direction)));
        } else if (click) {
          setFocus('nodes'); setView('node');
          const nodes = [{name: 'human / inbox', thread_id: HUMAN}, ...sidebarMembers];
          const index = compactNodeAt({x: event.x, y: event.y, width: size.columns, height: size.rows, selection, nodes, scrollShift: sidebarScroll});
          if (index !== null) setSelection(index);
        }
      } else if (click && event.y < COMPACT_CONTENT_TOP) {
        setView('node'); setFocus('nodes');
      } else if (wheel !== null) {
        setFocus('messages');
        setMessageSelection(value => Math.max(0, Math.min(contentMessages.length - 1, value + direction)));
      } else if (click && event.y >= COMPACT_CONTENT_TOP + 1) {
        const count = Math.max(1, Math.floor((room - 1) / 2));
        const start = focus === 'nodes' ? Math.max(0, contentMessages.length - count) : Math.max(0, Math.min(messageSelection - count + 1, contentMessages.length - count));
        const row = Math.floor((event.y - COMPACT_CONTENT_TOP - 1) / 2);
        if (row < count && start + row < contentMessages.length) { setFocus('messages'); setMessageSelection(start + row); }
      }
      return;
    }
    if (mode === 'profile' && (event.button & 64) && size.columns >= 64 && size.rows >= 18 && event.x > sidebarWidth + 1) {
      const direction = event.button & 3;
      if (direction <= 1) scrollProfile(direction === 0 ? -3 : 3);
      return;
    }
    if (mode === 'picker' && size.columns >= 64 && size.rows >= 18) {
      if (event.release || (event.button & 32)) return;
      const inPanel = event.x > sidebarWidth + 1 && event.x < sidebarWidth + feedWidth && event.y >= 8 && event.y < 5 + panelHeight;
      if (!inPanel) return;
      if (event.button & 64) {
        const direction = event.button & 3;
        if (direction <= 1) setPickerSelection(value => Math.max(0, Math.min(candidates.length - 1, value + (direction ? 1 : -1))));
      } else if ((event.button & 3) === 0) {
        const {rows} = sidebarNodeWindow({nodes: pickerNodes, selection: pickerSelection, innerWidth: Math.max(1, feedWidth - 4), rowCapacity: Math.max(1, panelHeight - 4), scrollShift: pickerScroll});
        const index = rows[event.y - 8]?.index;
        if (index !== undefined) setPickerSelection(index);
      }
      return;
    }
    if (event.release) { mouseDrag.current = null; return; }
    if (!scrollInfo || size.columns < 64 || size.rows < 18) return;
    const geometry = scrollbarGeometry(scrollInfo.total, scrollInfo.visible, scrollInfo.position, scrollInfo.trackLength);
    if (!geometry.maxPosition) return;
    const panelLeft = sidebarWidth + 1;
    const panelRight = sidebarWidth + feedWidth;
    const trackX = panelRight - 2;
    const trackTop = 9;
    const overPanel = event.x >= panelLeft && event.x <= panelRight && event.y >= 5 && event.y < 5 + panelHeight;
    const scrollTo = position => {
      const next = Math.max(0, Math.min(geometry.maxPosition, position));
      if (scrollInfo.kind === 'session') setSessionOffset(geometry.maxPosition - next);
      else if (scrollInfo.kind === 'detail') setDetailOffset(next);
      else { setFocus('messages'); setMessageSelection(Math.min(contentMessages.length - 1, next + messageRoom - 1)); }
    };
    if ((event.button & 64) && overPanel) {
      const direction = event.button & 3;
      if (direction !== 0 && direction !== 1) return;
      const amount = direction === 0 ? -3 : 3;
      if (scrollInfo.kind === 'messages') {
        const current = focus === 'nodes' ? contentMessages.length - 1 : messageSelection;
        setFocus('messages');
        setMessageSelection(Math.max(0, Math.min(contentMessages.length - 1, current + amount)));
      } else scrollTo(geometry.maxPosition ? Math.max(0, Math.min(geometry.maxPosition, scrollInfo.position + amount)) : 0);
      return;
    }
    if (event.button & 32) {
      if (mouseDrag.current?.kind === scrollInfo.kind) scrollTo(positionForScrollbarRow(geometry, event.y - trackTop, mouseDrag.current.grab));
      return;
    }
    if ((event.button & 3) !== 0 || event.x < trackX || event.x > panelRight || event.y < trackTop || event.y >= trackTop + geometry.trackLength) return;
    const row = event.y - trackTop;
    const onThumb = row >= geometry.thumbStart && row < geometry.thumbStart + geometry.thumbLength;
    const grab = onThumb ? row - geometry.thumbStart : Math.floor(geometry.thumbLength / 2);
    mouseDrag.current = {kind: scrollInfo.kind, grab};
    scrollTo(positionForScrollbarRow(geometry, row, grab));
  };

  useEffect(() => {
    if (!stdin.isTTY || !stdout.isTTY || process.env.TERM === 'dumb') return;
    const parser = new MouseSequenceParser();
    const onData = chunk => { for (const event of parser.push(chunk.toString())) mouseHandler.current(event); };
    stdin.on('data', onData);
    stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
    return () => {
      stdin.off('data', onData);
      stdout.write('\x1b[?1002l\x1b[?1000l\x1b[?1006l');
    };
  }, [nativeManager, stdin, stdout]);

  function openMessage(message) {
    if (message.recipient_id === HUMAN && !message.human_read_at) {
      store.markHumanMessageRead(message.space_id, message.id);
      refreshStore();
    }
    setDetailMessageId(message.id); setDetailOffset(0); setMode('detail');
  }

  const statusMap = Object.fromEntries(threads.map(thread => [thread.id, thread.status?.type]));
  if (inboxOnly || activityOnly) {
    return h(Box, {flexDirection: 'column'},
      h(MainPanel, {mode, space, selected, view, connection, contentMessages, conversationList, conversationId, detailMessage, detailLines, detailRoom, messageRoom, messageStart, scrollInfo, messageSelection, focus, detailOffset, unreadCount, attentionCount, inboxPendingOnly, sessionHistory, sessionRows, sessionOffset, composeTarget, inlineDraft, composeHeight, petLayout, sending: !!sendingDrafts[composeKey], pickerNodes, pickerSelection, pickerScroll, pickerLoading, input, draft, profileOffset, statusMap, width: feedWidth, height: panelHeight}),
      T(` ${safeTerminalText(notice).replaceAll('\n', ' ')} · F6 sessions`, C.muted, {wrap: 'truncate-end'}));
  }
  if (nativeManager) {
    return h(CompactSidebar, {size, selected, members: sidebarMembers, selection, sidebarScroll, statusMap, connection, unreadCount, attentionCount, desktopNotifications, mode, view, focus, notice, contentMessages, messageSelection, detailMessage, detailOffset, pickerNodes, pickerSelection, pickerScroll, pickerLoading, input, draft, profileOffset, composeTarget, inlineDraft, sending: !!sendingDrafts[composeKey]});
  }
  if (size.columns < 64 || size.rows < 18) {
    return h(Box, {padding: 1, flexDirection: 'column'}, h(Text, {bold: true}, T('An', C.an), T('Le', C.foreground)), T('Resize the terminal to at least 64 × 18. Press Ctrl+Q to quit.', C.muted));
  }

  return h(Box, {flexDirection: 'column', width: Math.max(55, size.columns)},
    h(Header, {connection, spaceCount: spaces.length, unreadCount}),
    h(Box, {flexDirection: 'row'},
      h(Sidebar, {space, members: sidebarMembers, selectedIndex: selection, sidebarScroll, statusMap, unreadCount, attentionCount, width: sidebarWidth, height: panelHeight}),
      h(MainPanel, {mode, space, selected, view, connection, contentMessages, conversationList, conversationId, detailMessage, detailLines, detailRoom, messageRoom, messageStart, scrollInfo, messageSelection, focus, detailOffset, unreadCount, attentionCount, inboxPendingOnly, sessionHistory, sessionRows, sessionOffset, composeTarget, inlineDraft, composeHeight, petLayout, sending: !!sendingDrafts[composeKey], pickerNodes, pickerSelection, pickerScroll, pickerLoading, input, draft, profileOffset, statusMap, width: feedWidth, height: panelHeight}),
    ),
    h(Box, {paddingX: 1}, T('◆ ', C.yellow), T(notice, C.muted, {wrap: 'truncate-end'})),
    h(Box, {paddingX: 1, overflow: 'hidden'}, T('Tab', C.cyan), T(' focus  ', C.muted), T('^A', C.cyan), T(' add  ', C.muted), T('^N', C.cyan), T(' inbox  ', C.muted), T('^V', C.cyan), T(view === 'activity' ? ' node  ' : ' feed  ', C.muted), T('^P', C.cyan), T(' help  ', C.muted), T('^Q', C.cyan), T(' quit', C.muted)),
  );
}

function renderPickerRows(rows, selection, {idLength, showStatus, innerWidth}) {
  return rows.map(({node, index, type, text, part}) => {
    const active = index === selection;
    if (type === 'path') return T(`  ${text}`, node.cwd ? active ? C.pathActive : C.path : C.muted, {key: `${node.thread_id}:path:${part}`, bold: active && !!node.cwd, wrap: 'truncate-end'});
    const badge = node.added ? '[ADDED]' : node.status === 'OFFLINE' ? 'OFFLINE' : '';
    let tags = [node.added ? '[ADDED]' : '', node.thread_id.slice(-idLength), showStatus || (!node.added && node.status === 'OFFLINE') ? node.status : ''].filter(Boolean).join(' · ');
    const tagLimit = Math.max(4, innerWidth - 9);
    if (stringWidth(tags) > tagLimit) tags = [badge, node.thread_id.slice(-4)].filter(Boolean).join(' ');
    if (stringWidth(tags) > tagLimit) tags = badge || node.thread_id.slice(-4);
    return h(Box, {key: `${node.thread_id}:name`}, h(Box, {width: 2, flexShrink: 0}, T(active ? '▸ ' : '  ', C.yellow)),
      h(Box, {flexGrow: 1, flexShrink: 1, overflow: 'hidden'}, T(node.name, active ? C.pathActive : C.foreground, {bold: active, wrap: 'truncate-end'})),
      h(Box, {marginLeft: 1, flexShrink: 0}, T(tags, active ? C.yellow : C.muted, {wrap: 'truncate-end'})));
  });
}

function AnLeBrand({width, separator = false}) {
  const lines = width >= ANLE_WORDMARK_WIDTH ? ANLE_WORDMARK.map(([an, le], index) => h(Text, {key: index}, T(an, C.an), T(le, C.foreground))) :
    [h(Text, {key: 'name', bold: true}, T('An', C.an), T('Le', C.foreground)), T(' ', C.foreground, {key: 'blank-1'}), T(' ', C.foreground, {key: 'blank-2'})];
  return h(Box, {width, height: 4, flexDirection: 'column', overflow: 'hidden'},
    ...lines,
    separator ? T('─'.repeat(Math.max(1, width)), C.muted) : T(' '));
}

function profileLines(member, runtime, width) {
  if (!member) return [{text: 'Session unavailable', color: C.muted}];
  const rows = [];
  const add = (label, value) => {
    rows.push({text: label, color: C.cyan, bold: true});
    for (const line of wrapBody(safeTerminalText(value || 'Not set'), Math.max(4, width - 2))) rows.push({text: `  ${line}`, color: C.foreground});
  };
  rows.push({text: `CODEX · ${statusLabel(runtime)}`, color: C.muted});
  rows.push({text: `REPORTED · ${member.task_updated_at ? String(member.task_status || 'unknown').toUpperCase() : 'NOT SET'}`, color: C.muted});
  rows.push({text: member.task_updated_at ? `Updated ${formatDate(member.task_updated_at)}` : 'Task status not reported yet', color: C.muted});
  add('ROLE / RESPONSIBILITY', member.role);
  add('CURRENT TASK', member.current_task);
  add('DIRECTORY', member.cwd);
  return rows;
}

function CompactSidebar({size, selected, members, selection, sidebarScroll, statusMap, connection, unreadCount, attentionCount, desktopNotifications, mode, view, focus, notice, contentMessages, messageSelection, detailMessage, detailOffset, pickerNodes, pickerSelection, pickerScroll, pickerLoading, input, draft, profileOffset, composeTarget, inlineDraft, sending}) {
  const width = Math.max(20, size.columns);
  const height = Math.max(10, size.rows);
  const innerWidth = Math.max(8, width - 4);
  const showEditor = composeTarget && (mode === 'detail' || selected?.thread_id === HUMAN || view === 'activity');
  const room = Math.max(1, compactContentRows(height) - (showEditor ? 2 : 0));
  let body;
  let nodeOverflow = false;
  if (mode === 'picker') {
    const rowCapacity = Math.max(1, room - 2);
    const {rows, total} = sidebarNodeWindow({nodes: pickerNodes, selection: pickerSelection, innerWidth, rowCapacity, scrollShift: pickerScroll});
    nodeOverflow = total > rowCapacity;
    body = [T('SELECT SESSION', C.cyan, {bold: true, key: 'title'}), T('↑↓ · / search · Enter', C.muted, {key: 'hint', wrap: 'truncate-end'}),
      ...renderPickerRows(rows, pickerSelection, {idLength: 4, showStatus: false, innerWidth}),
      pickerNodes.length === 0 ? T(pickerLoading ? 'Loading…' : 'No matching sessions', C.muted, {key: 'empty'}) : null];
  } else if (mode === 'help') {
    body = [T('SHORTCUTS', C.cyan, {bold: true, key: 'title'}),
      ...['↑↓ select · Enter open', 'F6 list · F7 Codex', 'Ctrl+O agent profile', 'Ctrl+N inbox · Ctrl+V activity', 'Ctrl+U desktop alerts', 'Ctrl+A add · Ctrl+X remove', 'Ctrl+E edit · Ctrl+L intro', 'Ctrl+G switch · Ctrl+W new', 'Ctrl+D delete workspace', 'Ctrl+R refresh · Ctrl+S connect', 'Ctrl+Q quit · Any key back'].map(line => T(line, C.muted, {key: line, wrap: 'truncate-end'}))];
  } else if (mode === 'profile') {
    const rows = profileLines(selected, connection === 'CONNECTED' ? statusMap[selected?.thread_id] : undefined, innerWidth);
    const capacity = Math.max(1, room - 2);
    const offset = Math.min(profileOffset, Math.max(0, rows.length - capacity));
    body = [T(`PROFILE · ${selected?.name || ''}`, C.cyan, {bold: true, key: 'title', wrap: 'truncate-end'}),
      ...rows.slice(offset, offset + capacity).map((row, index) => T(row.text, row.color, {key: index, bold: row.bold, wrap: 'truncate-end'})),
      T('↑↓ scroll · ^E edit · Esc', C.muted, {key: 'hint', wrap: 'truncate-end'})];
  } else if (mode === 'detail') {
    const lines = wrapBody(safeTerminalText(detailMessage?.body || ''), Math.max(8, innerWidth));
    const count = Math.max(1, room - 2);
    const offset = Math.min(detailOffset, Math.max(0, lines.length - count));
    body = [T('MESSAGE', C.cyan, {bold: true, key: 'title'}), T(`${detailMessage?.sender_name || ''} ▸ human`, C.muted, {key: 'who', wrap: 'truncate-end'}),
      ...lines.slice(offset, offset + count).map((line, index) => T(line || ' ', C.foreground, {key: index, wrap: 'truncate-end'}))];
  } else if (mode === 'confirm-remove') {
    body = [T('REMOVE SESSION', C.cyan, {bold: true, key: 'title'}), T(selected?.name || '', C.foreground, {key: 'name', wrap: 'truncate-end'}), T('From this workspace only', C.muted, {key: 'scope'}), T('Codex session is kept', C.muted, {key: 'kept'}), T('Y remove · Esc cancel', C.yellow, {key: 'hint', wrap: 'truncate-end'})];
  } else if (mode === 'confirm-delete-space') {
    const memberCount = draft?.memberCount ?? 0;
    const messageCount = draft?.messageCount ?? 0;
    const memberLabel = `${memberCount} node${memberCount === 1 ? '' : 's'}`;
    const messageLabel = `${messageCount} AnLe message${messageCount === 1 ? '' : 's'}`;
    const counts = room < (draft?.replacement ? 7 : 6) ?
      [T(`${memberLabel} · ${messageLabel}`, C.muted, {key: 'counts', wrap: 'truncate-end'})] :
      [T(`Removes ${memberLabel}`, C.muted, {key: 'members'}), T(`and ${messageLabel}`, C.muted, {key: 'messages', wrap: 'truncate-end'})];
    body = [T('DELETE WORKSPACE', C.cyan, {bold: true, key: 'title'}), T(draft?.spaceName || '', C.foreground, {key: 'name', wrap: 'truncate-end'}),
      ...counts,
      T('Codex sessions/repos stay', C.muted, {key: 'kept'}), draft?.replacement ? T('Creates an empty workspace', C.muted, {key: 'replacement', wrap: 'truncate-end'}) : null,
      T('Y delete · Esc cancel', C.yellow, {key: 'hint', wrap: 'truncate-end'})];
  } else if (mode !== 'normal') {
    const labels = {'new-space': 'WORKSPACE NAME', 'picker-search': 'SEARCH SESSIONS', 'join-name': 'NAME THIS SESSION', 'join-role': 'ROLE / DESCRIPTION', 'edit-name': 'NODE NAME', 'edit-role': 'ROLE / DESCRIPTION'};
    body = [T(labels[mode] || '', C.cyan, {bold: true, key: 'title', wrap: 'truncate-end'}), T('Enter confirm · Esc cancel', C.muted, {key: 'hint', wrap: 'truncate-end'}), T(`› ${input}▌`, C.foreground, {key: 'input', wrap: 'wrap'})];
  } else if (view !== 'activity' && selection === 0 && focus !== 'nodes') {
    const isInbox = view !== 'activity';
    const count = Math.max(1, Math.floor((room - 1) / 2));
    const start = focus === 'nodes' ? Math.max(0, contentMessages.length - count) : Math.max(0, Math.min(messageSelection - count + 1, contentMessages.length - count));
    body = [T(isInbox ? `INBOX${unreadCount ? ` · ${unreadCount} NEW` : ''}` : 'ACTIVITY', C.cyan, {bold: true, key: 'title', wrap: 'truncate-end'}),
      ...contentMessages.slice(start, start + count).map((message, index) => h(Box, {key: message.id, flexDirection: 'column'},
        T(`${focus !== 'nodes' && start + index === messageSelection ? '▸' : ' '} ${message.sender_name} ▸ ${message.recipient_name}${message.recipient_id === HUMAN && !message.human_read_at ? ' · NEW' : ''}`, C.purple, {wrap: 'truncate-end'}),
        T(`  ${safeTerminalText(message.body).replaceAll('\n', ' ')}`, C.foreground, {wrap: 'truncate-end'}))),
      contentMessages.length === 0 ? T('No messages yet.', C.muted, {key: 'empty'}) : null];
  } else {
    const nodes = [{name: 'human / inbox', thread_id: HUMAN}, ...members];
    const {rows, total} = sidebarNodeWindow({nodes, selection, innerWidth, rowCapacity: room, scrollShift: sidebarScroll});
    nodeOverflow = total > room;
    body = rows.map(({node, index, type, text, part}) => {
      const active = index === selection;
      if (type === 'path') return T(`  ${text}`, node.cwd ? active ? C.pathActive : C.path : C.muted, {key: `${node.thread_id}:path:${part}`, bold: active && !!node.cwd, wrap: 'truncate-end'});
      const state = node.thread_id === HUMAN ? (unreadCount ? `${unreadCount} NEW` : attentionCount ? `${attentionCount} OPEN` : 'YOU') : statusLabel(statusMap[node.thread_id]);
      return h(Box, {key: `${node.thread_id}:name`}, h(Box, {width: 2, flexShrink: 0}, T(active ? '▸ ' : '  ', C.yellow)),
        h(Box, {flexGrow: 1, flexShrink: 1, overflow: 'hidden'}, T(node.name, active ? C.pathActive : C.foreground, {bold: active, wrap: 'truncate-end'})),
        h(Box, {marginLeft: 1, flexShrink: 0}, T(state, active ? C.yellow : C.muted)));
    });
  }
  const editor = showEditor ? h(Box, {height: 2, flexDirection: 'column', key: 'editor'},
    T(inlineDraft.text ? `› ${safeTerminalText(draftViewport(inlineDraft, Math.max(1, innerWidth - 2)))}` : '› Type reply… ▌', C.foreground, {wrap: 'truncate-end'}),
    T(`Reply to ${composeTarget.member.name}${sending ? ' · SENDING' : ' · Enter send'}`, C.muted, {wrap: 'truncate-end'})) : null;
  const visibleBody = body.filter(Boolean);
  if (visibleBody.length > room) visibleBody.splice(Math.max(0, room - 1), visibleBody.length - room);
  return h(Box, {width, height, borderStyle: 'single', borderColor: C.purple, flexDirection: 'column', paddingX: 1, overflow: 'hidden'},
    h(AnLeBrand, {width: innerWidth, separator: true}),
    h(Box, {flexGrow: 1, flexShrink: 1, flexDirection: 'column', overflow: 'hidden'}, ...visibleBody), editor,
    T(view === 'activity' ? 'Activity · ^V return · Enter' : safeTerminalText(notice).replaceAll('\n', ' '), C.muted, {wrap: 'truncate-end'}),
    T(nodeOverflow ? '↑↓ select · Pg scroll' : '↑↓ select · Enter', C.muted, {wrap: 'truncate-end'}),
    T('^A add · ^X rm · ^O profile', C.muted, {wrap: 'truncate-end'}),
    T(`^N inbox · ^D del · ^U ${desktopNotifications ? 'ON' : 'OFF'}`, C.muted, {wrap: 'truncate-end'}),
    T('F6 list · ^P help · ^Q quit', C.muted, {wrap: 'truncate-end'}));
}

function Header({connection, spaceCount, unreadCount}) {
  return h(Box, {height: 4, paddingX: 1, justifyContent: 'space-between'},
    h(AnLeBrand, {width: 22}),
    h(Box, {flexDirection: 'column', alignItems: 'flex-end'},
      T('✦  SIGNAL', C.yellow, {bold: true}),
      T(`${connection === 'CONNECTED' ? '●' : '○'} ${connection}`, connection === 'CONNECTED' ? C.green : C.red),
      T(`${spaceCount} ${spaceCount === 1 ? 'WORKSPACE' : 'WORKSPACES'}`, C.muted),
      T(unreadCount ? `◆ ${unreadCount} NEW · ^N INBOX` : '^N INBOX', unreadCount ? C.yellow : C.muted, {bold: unreadCount > 0}),
    ));
}

function Sidebar({space, members, selectedIndex, sidebarScroll, statusMap, unreadCount, attentionCount, width, height}) {
  const nodes = [{name: 'human', thread_id: HUMAN, role: 'You'}, ...members];
  const {rows} = sidebarNodeWindow({nodes, selection: selectedIndex, innerWidth: width - 4, rowCapacity: height - 5, indent: 4, scrollShift: sidebarScroll});
  return h(Box, {width, height, borderStyle: 'single', borderColor: C.purple, flexDirection: 'column', paddingX: 1, overflow: 'hidden'},
    T('▣  WORKSPACE', C.purple, {bold: true}),
    T(space?.name || '', C.foreground, {wrap: 'truncate-end'}),
    T('─'.repeat(Math.max(4, width - 4)), C.muted),
    ...rows.map(({node, index, type, text, part}) => {
      const selected = index === selectedIndex;
      if (type === 'path') return T(`    ${text}`, node.cwd ? selected ? C.pathActive : C.path : C.muted, {key: `${node.thread_id}:path:${part}`, bold: selected && !!node.cwd, wrap: 'truncate-end'});
      const state = node.thread_id === HUMAN ? (unreadCount ? `${unreadCount} NEW` : attentionCount ? `${attentionCount} OPEN` : 'YOU') : statusLabel(statusMap[node.thread_id]);
      return h(Box, {key: `${node.thread_id}:name`},
        h(Box, {width: 4, flexShrink: 0},
          T(selected ? '▸' : ' ', C.yellow),
          T(` ${node.thread_id === HUMAN ? '▧' : '▣'} `, C.foreground, {bold: selected})),
        h(Box, {flexGrow: 1, flexShrink: 1, overflow: 'hidden'},
          T(node.name, selected ? C.pathActive : C.foreground, {bold: selected, wrap: 'truncate-end'})),
        h(Box, {marginLeft: 1, flexShrink: 0}, T(state, selected ? C.yellow : C.muted)));
    }),
    members.length === 0 ? T('  Ctrl+A: add session', C.muted, {wrap: 'truncate-end'}) : null,
  );
}

function petRows(art, withNames = false) {
  const artWidth = art[0]?.reduce((width, run) => width + stringWidth(run.text), 0) || 0;
  const indent = art === EMPTY_INBOX_PETS ? 2 : 1;
  const gap = art === EMPTY_INBOX_PETS ? 3 : 1;
  const dogWidth = Math.floor((artWidth - indent - gap) / 2);
  return [
    ...art.map((runs, index) => h(Text, {key: `pet-${index}`},
      ...runs.map((run, i) => T(run.text, run.color, {key: i, backgroundColor: run.backgroundColor})))),
    withNames ? h(Text, {key: 'pet-names', bold: true},
      T(' '.repeat(indent + Math.floor((dogWidth - 2) / 2))), T('An', C.an),
      T(' '.repeat(dogWidth + gap - 2)), T('Le', C.foreground)) : null,
  ];
}

function MainPanel({mode, space, selected, view, connection, contentMessages, conversationList, conversationId, detailMessage, detailLines, detailRoom, messageRoom, messageStart, scrollInfo, messageSelection, focus, detailOffset, unreadCount, attentionCount, inboxPendingOnly, sessionHistory, sessionRows, sessionOffset, composeTarget, inlineDraft, composeHeight, petLayout, sending, pickerNodes, pickerSelection, pickerScroll, pickerLoading, input, draft, profileOffset, statusMap, width, height}) {
  let body;
  const contentWidth = width - (scrollInfo ? 1 : 0) - (petLayout?.sideWidth || 0);
  const showMiniPets = petLayout?.kind === 'mini' && (mode === 'detail' || contentMessages.length > 0 || contentWidth - 4 < COMPACT_INBOX_PETS_WIDTH);
  const headingRows = (first, second, third) => showMiniPets ? [h(Box, {key: 'pet-heading', height: 3, flexDirection: 'row', overflow: 'hidden'},
    h(Box, {flexGrow: 1, flexShrink: 1, flexDirection: 'column', overflow: 'hidden'}, first, second, third),
    h(Box, {width: MINI_INBOX_PETS_WIDTH, marginLeft: 1, flexShrink: 0, flexDirection: 'column'}, ...petRows(MINI_INBOX_PETS)))] : [first, second, third];
  if (mode === 'picker') {
    const {rows} = sidebarNodeWindow({nodes: pickerNodes, selection: pickerSelection, innerWidth: Math.max(1, width - 4), rowCapacity: Math.max(1, height - 4), scrollShift: pickerScroll});
    body = [T('▣  SELECT A SESSION', C.cyan, {bold: true, key: 'title'}),
      T('↑↓ select  ·  / search  ·  Enter  ·  Esc back', C.muted, {key: 'hint', wrap: 'truncate-end'}),
      ...renderPickerRows(rows, pickerSelection, {idLength: 8, showStatus: true, innerWidth: Math.max(1, width - 4)}),
      pickerNodes.length === 0 ? T(pickerLoading ? 'Loading sessions…' : 'No matching sessions. Press / to search.', C.muted, {key: 'empty', wrap: 'truncate-end'}) : null];
  } else if (mode === 'help') {
    body = [T('▣  KEYBOARD SHORTCUTS', C.cyan, {bold: true, key: 'title'}),
      ...['Type to message · Enter send', 'Tab focus · ↑↓ select/scroll', 'Ctrl+O agent profile', 'Ctrl+N inbox · Ctrl+V activity', 'Ctrl+U desktop alerts', 'Ctrl+A add · Ctrl+E edit', 'Ctrl+X remove · Ctrl+L intro', 'Ctrl+R refresh · Ctrl+G switch', 'Ctrl+W new · Ctrl+D delete workspace', 'Ctrl+S connect · Ctrl+Q quit', 'Press any key to return'].map(line => T(line, C.muted, {key: line, wrap: 'truncate-end'}))];
  } else if (mode === 'profile') {
    const rows = profileLines(selected, connection === 'CONNECTED' ? statusMap[selected?.thread_id] : undefined, Math.max(8, width - 4));
    const capacity = Math.max(1, height - 4);
    const offset = Math.min(profileOffset, Math.max(0, rows.length - capacity));
    body = [T(`▣  PROFILE · ${selected?.name || ''}`, C.cyan, {bold: true, key: 'title', wrap: 'truncate-end'}),
      T('↑↓ scroll · Ctrl+E edit role · Esc back', C.muted, {key: 'hint', wrap: 'truncate-end'}),
      ...rows.slice(offset, offset + capacity).map((row, index) => T(row.text, row.color, {key: index, bold: row.bold, wrap: 'truncate-end'}))];
  } else if (mode === 'detail') {
    const message = detailMessage;
    const lines = detailLines;
    const room = detailRoom;
    const offset = Math.min(detailOffset, Math.max(0, lines.length - room));
    body = [...headingRows(T('▣  MESSAGE DETAILS', C.cyan, {bold: true, key: 'title', wrap: 'truncate-end'}),
      T(`${message?.space_name || ''} · ${message?.sender_name || ''} ▸ ${message?.recipient_name || ''} · ${message ? deliveryLabel(message) : ''}${message && replyLabel(message) ? ` · ${replyLabel(message)}` : ''}   ${formatDate(message?.created_at)}`, C.muted, {key: 'who', wrap: 'truncate-end'}),
      T(composeTarget ? 'Type below to reply · Enter send · Esc back' : '↑↓ scroll · Esc back', C.muted, {key: 'hint', wrap: 'truncate-end'})),
      ...lines.slice(offset, offset + room).map((line, index) => T(line || ' ', C.foreground, {key: index, wrap: 'truncate-end'}))];
  } else if (mode === 'confirm-remove') {
    body = [T('▣  REMOVE NODE', C.cyan, {bold: true, key: 'title'}), T(`Remove ${selected?.name} from ${space.name}?`, C.foreground, {key: 'body', wrap: 'truncate-end'}), T('Y confirm · any other key cancels', C.yellow, {key: 'hint', wrap: 'truncate-end'}), T('The original session will be kept.', C.muted, {key: 'detail', wrap: 'truncate-end'})];
  } else if (mode === 'confirm-delete-space') {
    body = [T('▣  DELETE WORKSPACE', C.cyan, {bold: true, key: 'title'}), T(draft?.spaceName || '', C.foreground, {key: 'name', wrap: 'truncate-end'}),
      T(`Removes ${draft?.memberCount ?? 0} node${draft?.memberCount === 1 ? '' : 's'} and ${draft?.messageCount ?? 0} AnLe message${draft?.messageCount === 1 ? '' : 's'}.`, C.muted, {key: 'scope', wrap: 'truncate-end'}),
      T('Original Codex sessions and repositories are kept.', C.muted, {key: 'kept', wrap: 'truncate-end'}),
      draft?.replacement ? T('An empty workspace will be created.', C.muted, {key: 'replacement', wrap: 'truncate-end'}) : null,
      T('Y delete · Esc cancel', C.yellow, {key: 'hint'})];
  } else if (mode !== 'normal') {
    const labels = {'new-space': 'WORKSPACE NAME', 'picker-search': 'SEARCH BY NAME, DIRECTORY OR ID', 'join-name': 'NAME THIS SESSION', 'join-role': 'ROLE / DESCRIPTION (OPTIONAL)', 'edit-name': 'NODE NAME', 'edit-role': 'ROLE / DESCRIPTION'};
    body = [T(`▣  ${labels[mode]}`, C.cyan, {bold: true, key: 'title'}),
      T(mode === 'join-name' ? 'Name used in AnLe · Enter confirm · Esc cancel' : mode === 'join-role' ? 'An introduction is queued after joining.' : 'Enter confirm  ·  Esc cancel', C.muted, {key: 'hint', wrap: 'truncate-end'}),
      h(Box, {key: 'input', marginTop: 1, borderStyle: 'single', borderColor: C.yellow, paddingX: 1}, T(`› ${input}▌`, C.foreground, {wrap: 'wrap'}))];
  } else if (view === 'node' && selected?.thread_id !== HUMAN) {
    const matches = sessionHistory.threadId === selected?.thread_id;
    const rows = matches ? sessionRows : [];
    const room = Math.max(1, height - 5 - composeHeight);
    const offset = Math.min(sessionOffset, Math.max(0, rows.length - room));
    const end = rows.length - offset;
    const start = Math.max(0, end - room);
    const loading = !matches || sessionHistory.loading;
    const error = connection === 'DISCONNECTED' ? 'Codex is disconnected. Press Ctrl+R to reconnect.' : matches ? sessionHistory.error : '';
    body = [h(Box, {key: 'title', justifyContent: 'space-between'},
      T(`▣  SESSION · ${selected?.name || ''}`, C.cyan, {bold: true, wrap: 'truncate-end'}),
      T(loading ? 'LOADING' : 'CHAT', C.muted)),
      T(error ? `Could not load history: ${error}` : 'PgUp/PgDn scroll · Ctrl+V activity', error ? C.red : C.muted, {key: 'hint', wrap: 'truncate-end'}),
      T('─'.repeat(Math.max(4, contentWidth - 4)), C.muted, {key: 'line'}),
      ...rows.slice(start, end).map((row, index) => T(row.text || ' ', row.heading ? row.kind === 'userMessage' ? C.yellow : row.kind === 'serein' ? C.cyan : row.kind === 'error' ? C.red : row.kind === 'agentMessage' ? C.purple : C.muted : C.foreground, {key: start + index, bold: !!row.heading, wrap: 'truncate-end'})),
      !rows.length && !error ? T(loading ? 'Loading session history…' : 'No saved session activity yet.', C.muted, {key: 'empty'}) : null];
  } else {
    const isInbox = view === 'node';
    const available = messageRoom;
    const start = messageStart;
    const artWidth = contentWidth - 4;
    const petArt = height >= 18 && artWidth >= EMPTY_INBOX_PETS_WIDTH ? EMPTY_INBOX_PETS :
      artWidth >= COMPACT_INBOX_PETS_WIDTH ? COMPACT_INBOX_PETS : [];
    const showPetNames = petArt.length > 0 && (petArt === EMPTY_INBOX_PETS || height >= 11);
    const inboxTitle = `▣  YOUR INBOX${inboxPendingOnly ? ' · OPEN' : ''}`;
    const inboxSummary = [unreadCount ? `${unreadCount} NEW` : '', attentionCount ? `${attentionCount} OPEN` : ''].filter(Boolean).join(' · ');
    const activityTitle = conversationList ? '▣  CONVERSATIONS' : conversationId ? '▣  CONVERSATION' : '▣  ACTIVITY';
    const title = showMiniPets ? T(inboxTitle, C.cyan, {bold: true, key: 'title', wrap: 'truncate-end'}) :
      h(Box, {key: 'title', justifyContent: 'space-between'}, T(isInbox ? inboxTitle : activityTitle, C.cyan, {bold: true, wrap: 'truncate-end'}), T(isInbox && inboxSummary ? inboxSummary : `${contentMessages.length} ${conversationList ? 'THREADS' : contentMessages.length === 1 ? 'MESSAGE' : 'MESSAGES'}`, isInbox && inboxSummary ? C.yellow : C.muted));
    const missingSender = isInbox && focus !== 'nodes' && contentMessages[messageSelection] && !composeTarget;
    const hint = missingSender ? 'Session removed · ^D done' : showMiniPets ? (isInbox ? '↑↓ · ^T open · ^D done' : '↑↓ · Enter') :
      focus !== 'nodes' ? (isInbox ? '↑↓ select · type to reply · ^T open · ^D done' : conversationList ? '↑↓ select · Enter open · ^T messages' : conversationId ? '↑↓ select · Enter details · ^O sender · ^P recipient · Esc back' : '↑↓ select · Enter details · ^T threads · ^O sender · ^P recipient') : isInbox ? 'Ctrl+N inbox · Tab select messages' : `Selected: ${selected?.name || 'human'} · Tab select messages`;
    body = [...headingRows(title, T(hint, C.muted, {wrap: 'truncate-end', key: 'selected'}),
      T('─'.repeat(Math.max(1, contentWidth - 4 - (showMiniPets ? MINI_INBOX_PETS_WIDTH + 1 : 0))), C.muted, {key: 'line'})),
      ...contentMessages.slice(start, start + available).map((message, index) => {
        const isUnread = message.recipient_id === HUMAN && !message.human_read_at;
        const response = replyLabel(message);
        const short = contentWidth < 55;
        const shortResponse = { 'NEEDS REPLY': 'REPLY', 'REPLY UNKNOWN': 'UNKNOWN', 'REPLY FAILED': 'FAILED', 'REPLY SENDING': 'SENDING', 'UNREPLIED': 'OPEN' }[response] || response;
        const state = conversationList ? (short ? `${message.conversation_size} MSG${message.issue_count ? ' !' : message.open_count ? ' *' : ''}` : [`${message.conversation_size} MSG`, message.open_count ? `${message.open_count} WAIT` : '', message.issue_count ? `${message.issue_count} ISSUE` : ''].filter(Boolean).join(' · ')) :
          isInbox ? [isUnread ? 'NEW' : '', short ? shortResponse : response].filter(Boolean).join(short ? '/' : ' · ') || 'READ' :
            short && response ? ({WAITING: 'WAIT', 'REPLY UNKNOWN': 'UNKNOWN', 'REPLY FAILED': 'FAILED', 'REPLY SENDING': 'SENDING'}[response] || response) : [deliveryLabel(message), response].filter(Boolean).join(' · ');
        const stateColor = message.issue_count || message.state === 'failed' || message.state === 'unknown' || ['failed', 'unknown'].includes(message.reply_state) ? C.red : isUnread || humanNeedsAttention(message) ? C.yellow : C.muted;
        return h(Box, {key: message.id, flexDirection: 'column'},
          h(Box, {height: 1, overflow: 'hidden'},
            h(Box, {flexShrink: 0}, T(focus !== 'nodes' && start + index === messageSelection ? '▸' : ' ', C.yellow), T(formatTime(message.latest_at || message.created_at), C.muted)),
            h(Box, {flexGrow: 1, flexShrink: 1, marginLeft: 2, overflow: 'hidden'},
              T(conversationList ? message.participants.map(participant => participant.name).join(' ▸ ') : message.sender_name, C.purple, {wrap: 'truncate-end'}),
              conversationList ? null : isInbox ? (!short ? T(` · ${message.space_name}`, C.path, {wrap: 'truncate-end'}) : null) : T(` ▸ ${message.recipient_name}`, C.cyan, {wrap: 'truncate-end'})),
            h(Box, {flexShrink: 0, marginLeft: 1}, T(state, stateColor))),
          T(`  ${!isInbox && !conversationList && short && response ? `${deliveryLabel(message)} · ` : ''}${safeTerminalText(message.body).replaceAll('\n', ' ')}`, C.foreground, {wrap: 'truncate-end'}));
      }),
      contentMessages.length === 0 ? h(Box, {key: 'empty', flexDirection: 'column', marginTop: !petLayout?.sideWidth && petArt === EMPTY_INBOX_PETS ? 1 : 0},
        ...(!petLayout?.sideWidth && !showMiniPets ? petRows(petArt, showPetNames) : []),
        T(isInbox ? inboxPendingOnly ? '  No open messages.' : '  No messages for you yet.' : conversationList ? '  No conversations yet.' : '  No collaboration messages yet.', C.muted, {wrap: 'truncate-end'})) : null];
  }
  const editor = composeTarget ? h(Box, {height: composeHeight, flexShrink: 0, flexDirection: 'column', key: 'composer'},
    T('─'.repeat(Math.max(4, width - 4)), C.muted),
    h(Box, null, T('› ', C.yellow), inlineDraft.text ? T(safeTerminalText(draftViewport(inlineDraft, Math.max(1, width - 6))), C.foreground, {wrap: 'truncate-end'}) : T('Type a message… ▌', C.muted, {wrap: 'truncate-end'})),
    T(`${composeTarget.replyTo ? 'Reply to' : 'To'} ${composeTarget.member.name}${composeTarget.spaceName ? ` · ${composeTarget.spaceName}` : ''} · Enter send${sending ? ' · SENDING' : ''}`, C.muted, {wrap: 'truncate-end'})) : null;
  const geometry = scrollInfo && scrollbarGeometry(scrollInfo.total, scrollInfo.visible, scrollInfo.position, scrollInfo.trackLength);
  const bar = geometry ? h(Box, {width: 1, flexShrink: 0, flexDirection: 'column', key: 'scrollbar'},
    ...Array.from({length: 3}, (_, index) => T(' ', C.muted, {key: `head-${index}`})),
    ...Array.from({length: geometry.trackLength}, (_, index) => {
      const thumb = geometry.maxPosition > 0 && index >= geometry.thumbStart && index < geometry.thumbStart + geometry.thumbLength;
      return T(thumb ? '█' : '│', thumb ? C.cyan : C.muted, {key: `track-${index}`});
    })) : null;
  const pets = petLayout?.sideWidth ? h(Box, {width: petLayout.sideWidth, paddingLeft: 1, marginTop: 1, flexShrink: 0, flexDirection: 'column', overflow: 'hidden'},
    ...petRows(petLayout.art, true)) : null;
  return h(Box, {width, height, borderStyle: 'single', borderColor: C.cyan, flexDirection: 'column', paddingX: 1, overflow: 'hidden'},
    h(Box, {flexGrow: 1, flexShrink: 1, flexDirection: 'row', overflow: 'hidden'},
      h(Box, {flexGrow: 1, flexShrink: 1, flexDirection: 'column', overflow: 'hidden'}, ...body), pets, bar), editor);
}

function sessionDisplayRows(entries, width, waitingMessages) {
  const rows = [];
  const pending = [...waitingMessages].sort((a, b) => a.sequence - b.sequence);
  let pendingIndex = 0;
  function appendWaiting(message) {
    const label = message.sender_id === HUMAN ? 'YOU' : `AnLe · ${message.sender_name}`;
    const state = {queued: 'QUEUED', pending: 'SENDING', failed: 'FAILED', unknown: 'UNKNOWN'}[message.state] || message.state.toUpperCase();
    rows.push({text: `▸ ${label} · ${state}`, heading: true, kind: message.state === 'failed' || message.state === 'unknown' ? 'error' : 'userMessage'});
    for (const line of wrapBody(safeTerminalText(message.body), Math.max(8, width - 6))) rows.push({text: `  ${line}`});
    rows.push({text: ' '});
  }
  for (const entry of entries) {
    const time = entry.startedAtMs ?? entry.completedAtMs;
    if (Number.isFinite(time)) {
      while (pendingIndex < pending.length && Date.parse(pending[pendingIndex].created_at) <= time) appendWaiting(pending[pendingIndex++]);
    }
    const item = displaySessionItem(entry);
    if (!item) continue;
    rows.push({text: `▸ ${item.title}`, heading: true, kind: item.kind});
    for (const line of wrapBody(item.body, Math.max(8, width - 6))) rows.push({text: `  ${line}`});
    rows.push({text: ' '});
  }
  while (pendingIndex < pending.length) appendWaiting(pending[pendingIndex++]);
  if (rows.at(-1)?.text === ' ') rows.pop();
  return rows;
}

function statusLabel(value) {
  return {active: 'BUSY', idle: 'IDLE', notLoaded: 'OFFLINE', systemError: 'ERROR'}[value] || 'UNKNOWN';
}

function suggestedName(thread, members) {
  let name = (thread.name || basename(thread.cwd || '') || 'agent').trim().replace(/[\r\n]/g, ' ').slice(0, 50);
  if (!name || name.toLowerCase() === 'human') name = 'agent';
  const names = new Set(members.map(member => member.name.toLowerCase()));
  if (!names.has(name.toLowerCase())) return name;
  for (let n = 2; n < 10000; n++) if (!names.has(`${name}-${n}`.toLowerCase())) return `${name}-${n}`;
  return `${name}-${thread.id.slice(0, 6)}`;
}

function wrapBody(text, width) {
  const rows = [];
  for (const line of text.replaceAll('\t', '  ').split('\n')) {
    if (/^[\x20-\x7e]*$/.test(line)) {
      if (!line) rows.push('');
      else for (let i = 0; i < line.length; i += width) rows.push(line.slice(i, i + width));
      continue;
    }
    let current = '';
    let used = 0;
    for (const {segment: char} of graphemes.segment(line)) {
      const charWidth = char.length === 1 && char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126 ? 1 : stringWidth(char);
      if (current && used + charWidth > width) { rows.push(current); current = ''; used = 0; }
      current += char;
      used += charWidth;
    }
    rows.push(current);
  }
  return rows;
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
}

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('en-GB', {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
}
