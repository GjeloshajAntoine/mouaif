'use strict';
// Regression test: auto-retry is ONE-SHOT.
//
// `maybeAutoRetry` guards on `payload.retry`, but the two pre-stream failure
// sites built their error-card payload WITHOUT the retry flag — `retry` only
// ever existed as a local of send()'s options. So every auto-retry that also
// failed re-entered with an unmarked payload, the guard never matched, and a
// server that was simply down looped until the browser died: the failing fetch
// resolved immediately, so the recursion stayed in microtasks and starved the
// event loop while stacking an error card per attempt.
//
// The production auto-retry helper and the send() failure path are extracted
// and executed in a VM with stubbed network/UI dependencies, the same
// technique scripts/test-chat-stream-abort.js uses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/chat/stream.js'), 'utf8');

// maybeAutoRetry, plus send()'s helper chunk that reaches the pre-stream
// failure sites (send() itself is exercised end to end below).
const helper = source.slice(
  source.indexOf('function maybeAutoRetry('),
  source.indexOf('// markToolUsed(state, refs, toolName)')
);
const sendChunk = source
  .slice(source.indexOf('export async function send('), source.indexOf('async function recoverFromDisk('))
  .replace('export async function send(', 'async function send(');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

function makeBase(extra) {
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
    appendErrorCard: () => {},
    setChatStatus: () => {},
    startStreamRecovery: () => {},
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
  return Object.assign(base, extra || {});
}

function makeContext(extra, exported) {
  const base = makeBase(extra);
  const context = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : () => undefined)
  }));
  vm.runInContext(helper + ';' + sendChunk + '; this.send = send; this.maybeAutoRetry = maybeAutoRetry;'
    + (exported || ''), context);
  return context;
}

function makeRefs() {
  return {
    promptInput: { current: { value: 'hello' } },
    sendBtn: { current: { disabled: false } },
    status: { current: { textContent: '', dataset: {} } },
    transcript: { current: { querySelector: () => null } },
    imageInput: { current: { value: '' } },
    _autoresize() {}
  };
}

(async () => {
  // ---- the guard itself --------------------------------------------
  {
    const sends = [];
    const context = makeContext({}, ' this.sends = [];');
    context.sends = sends;
    context.send = () => { sends.push(1); return Promise.resolve(); };
    const refs = makeRefs();
    const state = { autoRetry: true };

    check('a first failure auto-retries',
      context.maybeAutoRetry(state, refs, { content: 'hi' }) === true);
    check('the retry it fires is marked',
      sends.length === 1);

    check('a turn already marked as a retry does NOT retry again',
      context.maybeAutoRetry(state, refs, { content: 'hi', retry: true }) === false);
    check('no second send was fired', sends.length === 1);

    check('a user tap on Retry bypasses the guard',
      context.maybeAutoRetry(state, refs, { content: 'hi', retry: true, manualRetry: true }) === false);
    check('a manual retry does not stack an automatic one', sends.length === 1);

    check('auto-retry off means no retry',
      context.maybeAutoRetry({ autoRetry: false }, refs, { content: 'hi' }) === false);
  }

  // ---- the failure site threads the marker into the payload --------
  // A server that is down: every attempt rejects before the stream starts.
  // The count must stop at 2 (the turn + its single automatic retry).
  //
  // The bounded fetch is the point of the test. Pre-fix, each attempt
  // resolved immediately, so the recursion never yielded and the process
  // starved its own timer queue — the harness hung instead of reporting a
  // verdict. Two guards fix that:
  //   * every attempt stays parked until the test releases it, so the
  //     recursion runs inside the test's control rather than spinning; and
  //   * past the cap the fetch parks forever, which halts a looping chain
  //     outright. The event loop then recovers and the assertions below run,
  //     so a regression reports a decisive "attempts=9" failure instead of
  //     an unreadable timeout.
  const RETRY_CAP = 8;
  {
    const cards = [];
    let attempts = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const context = makeContext({
      fetch: () => {
        attempts++;
        if (attempts > RETRY_CAP) return new Promise(() => {}); // park a runaway
        return gate.then(() => { throw new Error('network down'); });
      },
      appendErrorCard: (msg) => { cards.push(msg); }
    });
    const state = {
      props: { projectDir: '/project', chatId: 'chat-a' },
      chat: { modelId: 'model', providerId: 'provider' },
      messages: [], imageAttachments: [], streaming: false,
      autoRetry: true, tools: { catalog: [] }, agents: [], customActions: []
    };
    const refs = makeRefs();

    const turn = context.send(state, refs, { content: 'hello', attachments: [] });
    await new Promise((r) => setTimeout(r, 20));
    check('the first attempt reaches the server', attempts === 1, 'attempts=' + attempts);

    // Let every pending attempt fail at once. A one-shot retry starts
    // exactly one more attempt; a loop starts more until the cap parks it.
    release();
    await Promise.race([turn, new Promise((r) => setTimeout(r, 100))]);
    await new Promise((r) => setTimeout(r, 60));

    check('a dead server stops after the turn plus one auto-retry',
      attempts === 2, 'attempts=' + attempts);
    check('the user sees an error card per attempt, not an unbounded stack',
      cards.length === 2, 'cards=' + cards.length);
    check('the composer is usable again', state.streaming === false && refs.sendBtn.current.disabled === false);
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
  assert.ok(passed > 0);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
