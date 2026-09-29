'use strict';
// Exercise production handlers and browser lifecycle code, not source presence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const stream = read('frontend/src/components/chat/stream.js');
const liveSource = read('frontend/src/components/chat/live.js');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function frames(res) {
  return res.chunks.join('').split('\n\n').filter((f) => f.startsWith('event: ')).map((f) => {
    const lines = f.split('\n');
    return { name: lines[0].slice(7), data: JSON.parse(lines[1].slice(6)) };
  });
}
function response() {
  const res = new EventEmitter();
  return Object.assign(res, { chunks: [], writeHead() {}, write(c) { this.chunks.push(c); return true; }, end() {}, setHeader() {}, getHeader() {} });
}

async function serverReplay() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-reentry-'));
  process.env.MOUAIF_HOME = path.join(tmp, 'home');
  const settings = require('../src/settings.js');
  const chats = require('../src/chats.js');
  const ai = require('../src/ai.js');
  const live = require('../src/live-chat.js');
  const shared = require('../src/server-shared.js');
  const original = ai.streamChat;
  try {
    const projectDir = path.join(tmp, 'project');
    fs.mkdirSync(projectDir);
    settings.setProject(projectDir, { models: [{ id: 'mock', provider: 'openai-compatible' }] });
    settings.setApp({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', apiKey: 'test' }] });
    const chat = chats.createChat(projectDir, { title: 'reentry' });
    const key = shared.runningKey(projectDir, chat.id);
    const follower = response();
    ai.streamChat = async ({ onEvent }) => {
      onEvent('message', { delta: 'before ' });
      onEvent('reasoning', { delta: 'thinking ' });
      live.addSubscriber(key, null, follower);
      onEvent('message', { delta: 'after' });
      onEvent('reasoning', { delta: 'more' });
      onEvent('assistant_turn_end', { hasToolCalls: true });
      onEvent('message', { delta: 'new segment' });
      const late = response();
      live.addSubscriber(key, null, late);
      assert.deepEqual(frames(late).find((f) => f.name === 'live_segment').data, { text: 'new segment', reasoning: '' });
      onEvent('done', { usage: { promptTokens: 1, completionTokens: 1 } });
      return { ok: true };
    };
    const body = JSON.stringify({ projectDir, modelId: 'mock', content: 'test' });
    const req = { on(event, cb) { if (event === 'data') process.nextTick(() => cb(Buffer.from(body))); if (event === 'end') process.nextTick(cb); } };
    const owner = response();
    const { handleChatStream, handleChats } = require('../src/server-handlers-chats.js');
    await handleChatStream(req, owner, chat.id, null);
    const events = frames(follower);
    assert.deepEqual(events.find((f) => f.name === 'live_segment').data, { text: 'before ', reasoning: 'thinking ' });
    assert.equal(events.filter((f) => f.name === 'message').map((f) => f.data.delta).join(''), 'afternew segment');
    assert.equal(events.find((f) => f.name === 'reasoning').data.delta, 'more');
    assert.equal(frames(owner).filter((f) => f.name === 'message').map((f) => f.data.delta).join(''), 'before afternew segment');

    // A new run starts at seq 0. An old cursor must not hide its replay.
    live.ensureLiveChat(key);
    const first = response();
    live.addSubscriber(key, null, first);
    const firstId = frames(first)[0].data.runId;
    live.pushLive(key, 'shell_output', { id: 'old', delta: 'old' });
    live.finishLiveChat(key);
    live.ensureLiveChat(key);
    live.pushLive(key, 'shell_output', { id: 'new', delta: 'new' });
    const returning = response();
    live.addSubscriber(key, null, returning, { runId: firstId, fromLiveSeq: 20 });
    const handshake = frames(returning)[0].data;
    assert.notEqual(handshake.runId, firstId);
    assert.equal(handshake.fromLiveSeq, 0);
    assert.equal(frames(returning)[1].data.delta, 'new');
    const sameRun = response();
    live.addSubscriber(key, null, sameRun, { runId: handshake.runId, fromLiveSeq: 1 });
    assert.equal(frames(sameRun).length, 1, 'same-run reconnect does not duplicate consumed output');
    // Exercise the HTTP route's optional runId plumbing as well.
    shared.runningChats.add(key);
    const routed = response();
    await handleChats({ method: 'GET' }, routed, {
    pathname: '/api/chats/' + chat.id + '/live',
    query: { projectDir, runId: firstId, fromLiveSeq: '20' }
    });
    assert.equal(frames(routed)[0].data.fromLiveSeq, 0);
    assert.equal(frames(routed)[1].data.delta, 'new');
    shared.runningChats.delete(key);
    live.finishLiveChat(key);
    const rejected = response();
    rejected.writeHead = (status) => { rejected.status = status; };
    rejected.end = (body) => { rejected.body = body; };
    await handleChats({ method: 'GET' }, rejected, { pathname: '/api/chats/' + chat.id + '/live', query: { projectDir } });
    assert.equal(rejected.status, 404, 'HTTP route rejects a held live stream for a completed run');
    console.log('PASS real chat handler broadcasts text/reasoning, restores initial segments, and scopes replay to runs');
  } finally {
    ai.streamChat = original;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function recovery() {
  const statuses = [];
  let running = true, pending = 1, failures = false, subscriptions = 0, drains = 0;
  const context = vm.createContext({
    fetchRunState: async () => failures ? null : { running, nextSeq: 1 },
    syncToNextSeq: async () => 'stable',
    loadPendingAuthorization: async () => pending,
    subscribeLive: () => { subscriptions++; }, closeLive() {}, clearLiveSegment() {}, removePendingAuthorizationCards() {},
    setChatStatus: (refs, text) => statuses.push(text)
  });
  vm.runInContext(stream.slice(stream.indexOf('async function recoverFromDisk(')).replace('export async function ', 'async function ') + ';this.recover=recoverFromDisk;this.reconcile=reconcileRunningChat;', context);
  const state = { props: { projectDir: '/test', chatId: 'a' }, messages: [{ role: 'user', seq: 0 }], streaming: true, reconnect: { active: true, stopped: false, attempts: 0 }, _setRunningVisible(value) { this.visible = value; }, _drainOlderMessages() { drains++; } };
  const refs = { sendBtn: { current: {} } };
  for (let i = 0; i < 12; i++) assert.equal(await context.recover(state, refs), true);
  assert.equal(state.streaming, true);
  assert.equal(state.reconnect.attempts, 0);
  assert.equal(state.pendingAuthCount, 1);
  assert.equal(statuses.at(-1), 'waiting for you…');
  assert.equal(subscriptions, 12);
  state.messages = [{ role: 'tool', phase: 'call' }];
  pending = 0;
  for (let i = 0; i < 12; i++) assert.equal(await context.recover(state, refs), true, 'slow tools never time out after successful sync');
  running = false;
  assert.equal(await context.recover(state, refs), false, 'server completion wins even with an unfinished call row');
  assert.equal(state.streaming, false);
  assert.equal(state.visible, false);
  assert.equal(drains, 1);
  running = true;
  state.runSettled = true;
  for (let i = 0; i < 4; i++) await context.reconcile(state, refs);
  assert.equal(state.watchingRun, true, 'stable transcript and old completion latch cannot settle a new run');
  assert.equal(state.visible, true);
  assert.equal(state.runSettled, false);
  state.reconnect.active = true;
  failures = true;
  for (let i = 0; i < 5; i++) assert.equal(await context.recover(state, refs), true);
  assert.equal(await context.recover(state, refs), false, 'consecutive failed requests remain bounded');
  console.log('PASS recovery restores prompts/replay and keeps slow running turns busy until authoritative completion');
}

async function foreground() {
  const source = read('frontend/src/components/chat/useChatState.js');
  const start = source.indexOf('    if (!chatId || !projectDir) return undefined;', source.indexOf('  }, [runningVisible, projectDir, chatId]);'));
  const end = source.indexOf('  }, [chatId, projectDir]);', start);
  const timers = new Map(), listeners = {}, state = { props: { projectDir: '/test', chatId: 'a' }, streaming: true, reconnect: { active: false } };
  let timerId = 0, reconciles = 0, clears = 0, closes = 0;
  const controller = new AbortController();
  controller.readerReady = true;
  state.streamAbort = controller;
  const context = vm.createContext({
    state, refs: {}, chatId: 'a', projectDir: '/test',
    reconnect: { get current() { return state.reconnect; } }, watchingRun: { get current() { return state.watchingRun; } }, streaming: { get current() { return state.streaming; } }, kickPoll: { current: null },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout(id) { timers.delete(id); },
    document: { visibilityState: 'visible', addEventListener(n, fn) { listeners[n] = fn; }, removeEventListener(n) { delete listeners[n]; } },
    window: { addEventListener(n, fn) { listeners[n] = fn; }, removeEventListener(n) { delete listeners[n]; } },
    closeLive() { closes++; }, clearLiveSegment() { clears++; },
    reconcileRunningChat: async () => { reconciles++; }
  });
  vm.runInContext(stream.slice(stream.indexOf('export function resumeRunningChat('), stream.indexOf('export async function send(')).replace('export function ', 'function ') + '\nfunction mount(){' + source.slice(start, end) + '}this.cleanup=mount();', context);
  for (const n of ['visibilitychange', 'pageshow', 'focus']) listeners[n]();
  assert.equal(timers.size, 1);
  const [id, timer] = [...timers][0]; timers.delete(id);
  assert.equal(timer.delay, 0);
  await timer.fn();
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.resumeFollowing, true);
  assert.equal(state.streaming, false);
  assert.equal(state.watchingRun, true);
  assert.equal(reconciles, 1);
  assert.equal(closes, 1);
  assert.equal(clears, 1);

  // Focus during send preparation must not abort or duplicate that request.
  const preparing = new AbortController();
  state.streaming = true;
  state.streamAbort = preparing;
  listeners.focus();
  const [id2, timer2] = [...timers][0]; timers.delete(id2); await timer2.fn();
  assert.equal(preparing.signal.aborted, false);
  assert.equal(reconciles, 1);

  // Foreground events while a sync is in flight queue one follow-up sync.
  state.streaming = false;
  let release;
  context.reconcileRunningChat = () => new Promise((resolve) => { reconciles++; release = resolve; });
  listeners.focus();
  const [id3, timer3] = [...timers][0]; timers.delete(id3); const inFlight = timer3.fn();
  listeners.pageshow();
  const [id4, timer4] = [...timers][0]; timers.delete(id4); await timer4.fn();
  assert.equal(reconciles, 2);
  release(); await inFlight;
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 0);
  context.cleanup();
  assert.equal(timers.size, 0);
  assert.equal(Object.keys(listeners).length, 0);
  console.log('PASS foreground events coalesce, hand off stalled readers, preserve send preparation, and serialize polling');
}

function clientReplay() {
  const received = [];
  const context = vm.createContext({
    appendDeltaToLive: (delta) => received.push(delta), handleShellOutputEvent: (data) => received.push(data.delta), clearLiveSegment() {},
    appendMessageToTranscript() {}, renderAssistantBody() {}, afterTranscriptAppend() {}
  });
  vm.runInContext(liveSource.slice(liveSource.indexOf('function isCurrentChat('), liveSource.indexOf('function handleLiveRunEnd(')) + ';this.dispatch=dispatchLiveEvent;', context);
  const state = { props: { projectDir: '/test', chatId: 'a' }, liveRunId: 'old', nextLiveSeq: 50, runSettled: true };
  const refs = { transcript: { current: {} } };
  const dispatch = (eventName, data) => context.dispatch({ eventName, data: JSON.stringify(data) }, refs, state, '/test::a');
  dispatch('live_subscribed', { runId: 'new' });
  assert.equal(state.nextLiveSeq, 0);
  assert.equal(state.runSettled, false);
  dispatch('shell_output', { liveSeq: 0, delta: 'once' });
  dispatch('live_subscribed', { runId: 'new' });
  dispatch('shell_output', { liveSeq: 0, delta: 'duplicate' });
  assert.deepEqual(received, ['once']);

  const transcript = read('frontend/src/components/chat/transcript.js');
  vm.runInContext(transcript.slice(transcript.indexOf('export function restoreLiveSegment('), transcript.indexOf('// finalizeLiveSegment(')).replace('export function ', 'function ') + ';this.restore=restoreLiveSegment;', context);
  const row = { _body: {}, _streaming: true, _content: 'partial' };
  context.restore({ text: 'partial plus missed tokens', reasoning: 'full reasoning' }, { transcript: { current: { querySelector: () => row } } }, state);
  assert.equal(row._content, 'partial plus missed tokens');
  assert.equal(row._reasoning, 'full reasoning');
  console.log('PASS client resets new-run cursors, deduplicates same-run replay, and replaces retained segment snapshots');
}

(async () => {
  await serverReplay();
  await recovery();
  await foreground();
  clientReplay();
  await flush();
})().catch((error) => { console.error(error); process.exitCode = 1; });
