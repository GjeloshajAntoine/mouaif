'use strict';

// Regression test: leaving a chat must stop that chat's local SSE reader.
//
// send() opened `fetch(...)` with no way to cancel it and looped on the
// response body with no check that the view still belonged to the chat it
// started in. Navigating to another chat (or unmounting) left the reader
// alive: it held the fetch and its connection open, kept appending to
// `state.messages`, and rendered the deltas into whichever transcript was
// mounted by then — so a turn left mid-stream could paint the previous
// chat's text and tool cards into the chat the user switched to. The
// server keeps running the turn either way (a backgrounded tab must not
// cancel it); only this client's reader has to stop.
//
// The production send() source is extracted and executed in a VM with
// stubbed network/UI dependencies, the same technique
// scripts/test-chat-send-preparation.js uses.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/stream.js'), 'utf8');
const chunk = source
  .slice(source.indexOf('export function abortStream('), source.indexOf('async function recoverFromDisk('))
  .replace('export async function send(', 'async function send(')
  .replace('export function abortStream(', 'function abortStream(');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// A reader whose chunks are fed by the test. read() rejects with an
// AbortError once the request's signal aborts, like a real fetch body.
function makeReader(signal) {
  const queue = [];
  let waiting = null;
  let ended = false;
  const settle = () => {
    if (!waiting) return;
    if (queue.length) { const next = waiting; waiting = null; next.resolve({ value: Buffer.from(queue.shift()), done: false }); return; }
    if (ended) { const next = waiting; waiting = null; next.resolve({ value: undefined, done: true }); }
  };
  signal.addEventListener('abort', () => {
    if (!waiting) return;
    const next = waiting;
    waiting = null;
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    next.reject(err);
  });
  return {
    push(text) { queue.push(text); settle(); },
    finish() { ended = true; settle(); },
    read() {
      if (signal.aborted) {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        return Promise.reject(err);
      }
      return new Promise((resolve, reject) => { waiting = { resolve, reject }; settle(); });
    },
    releaseLock() {}
  };
}

function makeContext(net) {
  const effects = { errorCards: [], recovery: 0, autoRetry: 0, status: [] };
  const base = {
    console,
    AbortController,
    JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, Promise, Error,
    TextDecoder, isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout,
    createCounter: () => ({ reset() {}, rate() { return null; } }),
    toPublicImageAttachments: (items) => items,
    parseAtInvocation: () => null,
    parseDirectRestartInvocation: () => null,
    fetch: net.fetch,
    appendErrorCard: (msg) => { effects.errorCards.push(msg); },
    setChatStatus: (refs, text, kind) => { refs.status.current.textContent = text; effects.status.push(kind); },
    startStreamRecovery: () => { effects.recovery++; },
    maybeAutoRetry: () => { effects.autoRetry++; },
    finalizeLiveMessage: () => {},
    updateUsageSummary: () => {},
    renderUsageMeta: () => {},
    fetchRunState: async () => null,
    syncToNextSeq: async () => 0,
    appendToolCallCard: () => {},
    appendToolResultCard: () => {},
    updateProgressCard: () => {},
    markToolUsed: () => {},
    updateSwitch: () => {},
    refreshSystemPrompt: () => {},
    syncThinkingSelect: () => {},
    updateMetaLine: () => {},
    mountOverlayCard: () => {},
    authorizationCard: () => {},
    askUserCard: () => {},
    updateSetupVisibility: () => {}
  };
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(chunk + '; this.send = send; this.abortStream = abortStream;', context);
  context.effects = effects;
  return context;
}

function makeState(overrides) {
  return Object.assign({
    props: { projectDir: '/project', chatId: 'chat-a' },
    chat: { modelId: 'model', providerId: 'provider' },
    providers: [{}],
    imageAttachments: [],
    messages: [],
    streaming: false
  }, overrides);
}

function makeRefs() {
  return {
    promptInput: { current: { value: 'hello' } },
    sendBtn: { current: { disabled: false } },
    status: { current: { textContent: '' } },
    // The tail of send() reads the live row back out of the transcript.
    transcript: { current: { querySelector: () => null } },
    imageInput: { current: { value: '' } },
    _autoresize() {}
  };
}

(async () => {
  // ---- abortStream in isolation ------------------------------------
  {
    const context = makeContext({ fetch: () => new Promise(() => {}) });
    check('abortStream is a no-op without a controller', context.abortStream({}) === false);
    check('abortStream is a no-op for an unknown state', context.abortStream(null) === false);

    const controller = new AbortController();
    const state = { streamAbort: controller };
    check('abortStream reports that it aborted', context.abortStream(state) === true);
    check('the signal it aborts is the turn signal', controller.signal.aborted === true);
    check('the controller is released from state', state.streamAbort === null);
    check('a second abort is a no-op', context.abortStream(state) === false);
  }

  // ---- aborting while the response is still pending ----------------
  {
    let aborted = 0;
    const context = makeContext({
      fetch: (url, opts) => new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          aborted++;
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      })
    });
    const state = makeState();
    const refs = makeRefs();
    const pending = context.send(state, refs, { clearComposerDraft: async () => true, setImageAttachments: () => {} });
    await new Promise((r) => setTimeout(r, 10));
    check('send() registers the abort controller on the state', !!state.streamAbort);
    context.abortStream(state);
    await pending;
    check('the pending fetch was aborted', aborted === 1, 'aborted=' + aborted);
    check('an aborted send shows no error card', context.effects.errorCards.length === 0,
      JSON.stringify(context.effects.errorCards));
    check('an aborted send does not auto-retry', context.effects.autoRetry === 0);
    check('an aborted send unlocks the composer', state.streaming === false && refs.sendBtn.current.disabled === false);
    check('an aborted send does not start the recovery poll', context.effects.recovery === 0);
  }

  // ---- aborting mid-stream (user switches chat) --------------------
  {
    let reader = null;
    const context = makeContext({
      fetch: async (url, opts) => {
        reader = makeReader(opts.signal);
        return { ok: true, body: { getReader: () => reader } };
      }
    });
    const state = makeState();
    const refs = makeRefs();
    const pending = context.send(state, refs, { clearComposerDraft: async () => true, setImageAttachments: () => {} });
    await new Promise((r) => setTimeout(r, 10));
    check('the reader is streaming', !!reader);

    // One delta lands while the chat is still current.
    reader.push('event: message\ndata: {"delta":"hi"}\n\n');
    await new Promise((r) => setTimeout(r, 10));
    const messagesBefore = state.messages.length;

    // The user navigates away: the view now belongs to another chat and
    // the cleanup aborts this turn.
    state.props = { projectDir: '/project', chatId: 'chat-b' };
    reader.push('event: message\ndata: {"delta":"late"}\n\n');
    await new Promise((r) => setTimeout(r, 10));
    context.abortStream(state);
    await pending;

    check('the aborted reader stops the send', state.streaming === false, 'streaming=' + state.streaming);
    check('no error card is shown for a deliberate abort', context.effects.errorCards.length === 0,
      JSON.stringify(context.effects.errorCards));
    check('no recovery poll is started for a deliberate abort', context.effects.recovery === 0);
    check('no auto-retry is scheduled for a deliberate abort', context.effects.autoRetry === 0);
    check('the controller is released', !state.streamAbort);
    check('the transcript is left as it was before the abort',
      state.messages.length === messagesBefore, 'messages=' + state.messages.length);
  }

  // ---- a chat switch is noticed even before the abort arrives ------
  {
    let reader = null;
    const context = makeContext({
      fetch: async (url, opts) => {
        reader = makeReader(opts.signal);
        return { ok: true, body: { getReader: () => reader } };
      }
    });
    const state = makeState();
    const refs = makeRefs();
    const pending = context.send(state, refs, { clearComposerDraft: async () => true, setImageAttachments: () => {} });
    await new Promise((r) => setTimeout(r, 10));

    // The chat changes without anyone calling abortStream (a remount that
    // skips the cleanup, a race): the loop must notice by itself.
    state.props = { projectDir: '/project', chatId: 'chat-c' };
    reader.finish();
    await pending;
    check('the read loop stops on a chat change without an explicit abort',
      state.streaming === false && !state.streamAbort);
    check('a chat change does not raise an interruption error card',
      context.effects.errorCards.length === 0, JSON.stringify(context.effects.errorCards));
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
