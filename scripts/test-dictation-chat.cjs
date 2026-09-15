// Dictation from the chat composer: real App -> ChatView -> MicButton.
//
// Run: node scripts/test-dictation-chat.cjs
// Requires debug Chrome at CDP_URL (default http://127.0.0.1:9222).
//
// The dictation helpers have two surfaces, and the page's own tests cover only
// one of them. This is the other: the microphone button inside the *real* chat
// view, with the real composer markup and the real CSS, driven the way a user
// drives it (tap to record, tap to stop). It pins the four things that can
// break and that nothing else would notice:
//
//   1. the button resolves the model from the app-level `dictation` key, so the
//      composer and the dictation page cannot disagree about which model a tap
//      uses;
//   2. the transcript lands in the composer draft (and is persisted), not in
//      the transcript or nowhere;
//   3. the draft is persisted, not shown only;
//   4. the run's cost reaches the chat's status line *and* the header Total —
//      a transcription writes no message row, so the server attributes the
//      priced run to the chat (this file pins that the request carries the
//      `chatId` the server needs) and the status line keeps reporting the same
//      figure at the moment it happened;
//   5. an unpriced run (`whisper-1` bills per minute and reports no tokens)
//      says nothing about cost rather than `$0.00`, and the button never claims
//      a price it was not given;
//   6. a live take settles with the *sum* of its chunks' prices, since a chunk
//      is a real billed request and no single chunk is the take;
//   7. a tap with nothing configured reports *why* in the chat's status row and
//      never opens the microphone — the button's own report is a `title`, which
//      no phone displays, so this state used to look like a dead button;
//   8. a tap that is resolving the model says so while it waits — but only in
//      the chat's status line (`Preparing dictation…`), *after* the resolve has
//      outlasted `MIC_WAIT_DELAY_MS`, and never for a tap that answers inside
//      it: the resolve is two local reads, so reporting it unconditionally wrote
//      a sentence for one frame on every tap. The button's own loading state
//      (spinner, `aria-busy`, `Working…`) is a transcription request in flight
//      and nothing else — a spinner on the resolve would be the loading state of
//      a transcription the user has not asked for, before any audio exists. The
//      fixture holds the settings read for that check, and holds it for nothing
//      for the counter-check.
//   9. the decision is watched on both sides of the delay: `scripts/test-dictation.js`
//      pins `micWaitPhase` and `micResolveNote` as pure functions, and this file
//      pins the button with the reads held slow (a sentence, no loading state)
//      and fast (neither);
//  10. a live take's *settle* is one of those transcription requests: on stop,
//      while the last segment (or a segment still in flight) is being
//      transcribed, the button holds the spinner, `Working…` and `aria-busy`
//      and the chat's line says `Transcribing…` — before this the take went
//      idle-looking with its stale word count exactly while the user waited on
//      it — and both are gone once the take settles.
//  11. the composer microphone can be hidden app-wide (Settings → Chat
//      defaults → Dictation microphone in the composer, `dictationButton`),
//      and hiding it is not disabling it. The second page at the end of this
//      file renders the same ChatView with both optional composer tools turned
//      off and asserts the row is otherwise intact: no mic, no image button,
//      and still a text area, a send button, a status line and — because a
//      pasted image travels through it — the image file input. Source-level
//      contracts for all of it live in scripts/test-composer-tools.mjs.
//
// All bundles stay in memory; only a fresh about:blank target is touched. Fetch
// is fully stubbed (unknown requests fail), with CDP blocking real network as a
// second guard, so no server, provider or application data is involved.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { WebSocket } = require('ws');

const root = path.resolve(__dirname, '..');
const endpoint = (process.env.CDP_URL || 'http://127.0.0.1:9222').replace(/\/$/, '');
const PROJECT_DIR = '/fixture/dictation-chat';
const CHAT_ID = 'dictation-regression';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Two canned runs. The priced one is what a token-reporting model looks like
// (Gemini counts the audio in the prompt); the unpriced one is `whisper-1`,
// which bills per minute and reports no tokens at all.
const PRICED_COST = { input: 0.0003, output: 0.00025, total: 0.00055, currency: 'USD', known: true };
const UNPRICED_COST = { input: 0, output: 0, total: 0, currency: 'USD', known: false };

async function bundle() {
  const [js, css] = await Promise.all([
    build({
      stdin: {
        contents: `import { h, render } from 'preact';
import { App } from './frontend/src/components/App.jsx';
import { route } from './frontend/src/api.js';
route.value = { name: 'chat', chatId: ${JSON.stringify(CHAT_ID)}, projectDir: ${JSON.stringify(PROJECT_DIR)} };
render(h(App), document.getElementById('app'));`,
        resolveDir: root, sourcefile: 'dictation-chat-fixture.js'
      },
      bundle: true, write: false, minify: false, format: 'iife', platform: 'browser',
      define: { 'import.meta.env': '{"PROD":true}' },
      // Lazy editor/inspector CSS is not used by the chat route. The real
      // stylesheet entry is bundled separately below, in its @import order.
      loader: { '.css': 'empty' }
    }),
    // style.css is the app's real entry, so its @import order comes with it.
    build({ entryPoints: [path.join(root, 'frontend/src/style.css')], bundle: true, write: false, minify: false })
  ]);
  return { js: js.outputFiles[0].text, css: css.outputFiles[0].text };
}

// Runs inside the blank page, BEFORE any application code is imported. Every
// request the chat view makes on open is answered from here; anything else is
// recorded and thrown so a new dependency shows up as a failure rather than a
// silently missing feature.
//
// The fixture data arrives as an argument because this function is stringified
// into the page: a closure over the constants below would not survive it.
function installFixture(data) {
  const test = window.dictationTest = {
    requests: [], unexpected: [], errors: [], transcribeBodies: [], draftPatches: [],
    // Every `start(...)` argument any take asked for. A live take rotates
    // complete recordings, so this must never carry a timeslice (see
    // createSegmentRecorder) — that is what the check near the end asserts.
    timeslices: [],
    // When set, a request is answered with the entry that follows the requests
    // already made (`segmentAnswerBase`), rather than with the one canned
    // sentence: that is how a take made of several segments is read back as one
    // stitched transcript.
    segmentAnswers: null,
    segmentAnswerBase: 0,
    runs: 0, cost: 'priced',
    // A hold on the *settings* read, so the mic's "resolving the model" step can
    // be watched: on a healthy connection it is two local reads answered inside a
    // frame, which is exactly why the chat line only *names* it after
    // MIC_WAIT_DELAY_MS (and why it never becomes the button's loading state).
    // Holding **only** `/api/settings` (not every response) is what makes the two
    // checks below meaningful: the same delay is either watched (settings read
    // held) or absent (held for nothing), where a global hold would keep the
    // resolve slow either way.
    holdMs: 0,
    // A hold on the *transcription* request, so the live take's settle can be
    // watched: the user stops, the last segment is still in flight, and the
    // button must say so (spinner, `Working…`, `aria-busy`) rather than going
    // idle-looking with a stale word count.
    transcribeHoldMs: 0
  };
  addEventListener('error', (event) => test.errors.push(event.message));
  addEventListener('unhandledrejection', (event) => test.errors.push(String(event.reason)));

  const providers = [{ id: 'gemini' }];
  const chat = {
    id: 'dictation-regression', title: 'Dictation regression',
    providerId: 'gemini', modelId: 'gemini-2.5-flash', running: false, draft: ''
  };
  const messages = [
    { seq: 0, role: 'user', ts: 1700000000000, content: 'Earlier turn, so the transcript has something above it.' },
    { seq: 1, role: 'assistant', ts: 1700000001000, content: 'Fixture reply.' }
  ];
  const reply = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
  });
  const dictationCatalog = {
    // The app-level `dictation` key names this row, which is the whole point of
    // check 1: the mic must use the remembered model, not the chat's.
    models: [{ id: 'gemini-2.5-flash', provider: 'gemini', label: 'Gemini 2.5 Flash', kind: 'gemini', source: 'live', connected: true }],
    kinds: [
      { id: 'openai-compatible', label: 'OpenAI-compatible (multipart /audio/transcriptions)' },
      { id: 'gemini', label: 'Gemini (inline audio)' }
    ],
    total: 0, providers: ['gemini'], liveFailures: []
  };
  // Both halves of "what a tap can use" are switchable, so a later check can
  // put the app in the state a fresh install is in (nothing remembered, nothing
  // offered) without a second page load.
  test.dictationChoice = { modelId: 'gemini-2.5-flash', providerId: 'gemini' };
  test.catalogModels = dictationCatalog.models;
  // The two optional composer tool buttons. Both default to shown, which is the
  // state every check above runs in; the composer-tools page at the end of this
  // file turns both off to watch what the row does without them.
  test.composerTools = { dictationButton: true, imageButton: true };
  // Puts the two halves back where they started, for a check that runs after
  // the "nothing configured" state has been installed.
  test.restoreDictation = () => {
    test.dictationChoice = { modelId: 'gemini-2.5-flash', providerId: 'gemini' };
    test.catalogModels = dictationCatalog.models;
  };

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'https://fixture.invalid');
    const method = (init.method || input.method || 'GET').toUpperCase();
    test.requests.push({ url: url.pathname + url.search, method });
    if (test.holdMs && url.pathname === '/api/settings') await new Promise((resolve) => setTimeout(resolve, test.holdMs));
    if (url.origin !== 'https://fixture.invalid') {
      test.unexpected.push(method + ' ' + url.href);
      throw new Error('Unstubbed origin: ' + url.href);
    }
    if (method === 'POST' && url.pathname === '/api/ai/transcribe') {
    test.transcribeBodies.push(JSON.parse(init.body || '{}'));
    test.runs += 1;
    // Held before anything else is answered, so the take that is *closing*
    // waits on this request while the fixture watches the button.
    if (test.transcribeHoldMs) await new Promise((resolve) => setTimeout(resolve, test.transcribeHoldMs));
      const priced = test.cost === 'priced';
      const answers = test.segmentAnswers;
      // A live take is one request per segment, answered in speaking order:
      // the fixture mirrors that so a stitched transcript can be read back.
      const nth = test.transcribeBodies.length - 1 - (test.segmentAnswerBase || 0);
      const text = answers && answers.length
        ? answers[Math.max(0, Math.min(nth, answers.length - 1))]
        : (priced ? 'This is a dictated sentence about mouaif.' : 'Second dictated sentence.');
      return reply({
        text,
        model: { id: 'gemini-2.5-flash', provider: 'gemini' },
        kind: 'gemini',
        bytes: 4096,
        durationMs: 812,
        usage: priced ? { promptTokens: 1000, completionTokens: 100 } : null,
        cost: priced ? data.pricedCost : data.unpricedCost
        });
    }
    if (method === 'PATCH' && url.pathname === '/api/chats/' + chat.id) {
      const patch = JSON.parse(init.body || '{}');
      test.draftPatches.push(patch);
      return reply({ chat: Object.assign({}, chat, patch) });
    }
    if (method === 'POST' && url.pathname === '/api/git') {
      const body = JSON.parse(init.body || '{}');
      if (['--numstat', '--numstat --cached'].includes(body.args)) return reply({ ok: true, stdout: '' });
    }
    if (method === 'GET') {
      const bodies = {
        '/api/settings': {
        app: {
        providers,
        enterForNewline: true,
        // Remembered on the dictation page, honoured here. Switchable, so the
        // "nothing configured" state can be reached without a reload.
        dictation: test.dictationChoice,
        // Which optional composer tools the row draws. `false` hides one;
        // see docs/features/composer-tool-buttons.md.
        dictationButton: test.composerTools.dictationButton,
        imageButton: test.composerTools.imageButton
        }
        },
        '/api/ai/models': { models: [{ provider: 'gemini', id: 'gemini-2.5-flash' }] },
        '/api/ai/models/providers': { providers },
        // The chat head refreshes the live catalog for its own model list; the
        // mic does not need it, but ChatView asks on open.
        '/api/ai/models/live': { models: [{ id: 'gemini-2.5-flash' }], cached: false },
        '/api/ai/provider-credit': { supported: false },
        '/api/settings/models/recent': { recent: [] },
        '/api/ai/transcribe/models': Object.assign({}, dictationCatalog, { models: test.catalogModels }),
        '/api/chats': { chats: [chat], total: 1 },
        ['/api/chats/' + chat.id]: { chat },
        ['/api/chats/' + chat.id + '/messages']: { messages, nextSeq: messages.length },
        ['/api/chats/' + chat.id + '/revision']: { running: false, nextSeq: messages.length },
        ['/api/chats/' + chat.id + '/system-prompt']: { text: '', agentFilesAvailable: [], skills: [], projectAgentFiles: false },
        '/api/prompts': { prompts: [] },
        '/api/mcp/servers': { servers: [] },
        '/api/agents': { agents: [] },
        '/api/actions': { actions: [] },
        '/api/tools/list': { tools: [] },
        '/api/tools/authorization': { tools: {}, mcp: {} },
        '/api/projects/registered': { projects: [] }
      };
      if (Object.hasOwn(bodies, url.pathname)) return reply(bodies[url.pathname]);
    }
    test.unexpected.push(method + ' ' + url.pathname);
    throw new Error('Unstubbed fetch: ' + method + ' ' + url.pathname);
  };

  // ---- Fake microphone -------------------------------------------------
  // Installed before the app is imported because the recorder is probed when
  // the user taps, and `isTypeSupported` is what the probe calls.
  class FakeMediaRecorder {
    constructor(stream, options = {}) {
      this.stream = stream;
      this.mimeType = options.mimeType || 'audio/webm';
      this.state = 'inactive';
    }
    static isTypeSupported(type) { return type.indexOf('mp4') < 0; }
    start(timeslice) {
      this.state = 'recording';
      test.timeslices.push(timeslice);
      if (this.onstart) this.onstart();
    }
    // `stop()` is what makes a segment: the fake hands over a non-empty
    // recording the way the browser flushes what it captured, then reports the
    // stop. One recorder per segment, exactly as the rotation drives it.
    stop() {
      this.state = 'inactive';
      if (this.ondataavailable) this.ondataavailable({ data: new Blob([new Uint8Array(2048)], { type: this.mimeType }) });
      if (this.onstop) this.onstop();
    }
  }
  window.MediaRecorder = FakeMediaRecorder;
  const stream = { getTracks: () => [{ stop() { test.streamStopped = (test.streamStopped || 0) + 1; } }] };
  if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {} });
  navigator.mediaDevices.getUserMedia = async () => stream;

  // Every write to the chat's status line, recorded as it happens. The line is
  // written imperatively (Preact does not own its text), so a later re-render
  // can wipe it — recording the mutations is what makes the check about "the
  // chat was told" rather than about whatever survived the last paint.
  test.statusWrites = [];
  test.watchStatus = () => {
    if (!document.querySelector('.chat-view__status')) return false;
    // Observed on document.body, not on the status element: if Preact ever
    // replaces the element the ref points at, an observer attached to the old
    // node would miss every later write and blame the feature.
    new MutationObserver(() => {
      const el = document.querySelector('.chat-view__status');
      test.statusWrites.push({ text: el ? el.textContent : null, state: el ? el.getAttribute('data-state') : null });
    }).observe(document.body, { childList: true, characterData: true, subtree: true });
    return true;
  };

  test.snapshot = () => {
    const mic = document.querySelector('.chat-view__mic-btn');    const status = document.querySelector('.chat-view__status');
    const composer = document.querySelector('#chatComposer');
    return {
      hasMic: !!mic,
      label: mic ? mic.getAttribute('aria-label') : null,
      recording: mic ? mic.getAttribute('aria-pressed') : null,
      title: mic ? mic.getAttribute('title') : null,
      // The loading affordances: `aria-busy` and the spinner are a
      // transcription *request* in flight, and nothing else — the model resolve
      // before the microphone opens must leave both untouched while it is named
      // in the chat line instead.
      busy: mic ? mic.getAttribute('aria-busy') : null,
      spinner: mic ? !!mic.querySelector('.dictation__spinner') : false,
      // A live take that is closing: `is-busy` is the class the spinner's
      // styling hangs off, so it is read alongside the ring itself.
      busyClass: mic ? mic.classList.contains('is-busy') : false,
      status: status ? status.textContent : null,
      statusState: status ? status.getAttribute('data-state') : null,
      // The header Total pill: where an attributed dictation run must land, not
      // only the status line under the composer.
      total: (() => {
      const value = document.querySelector('.chat-view__usage-summary-value');
      const pills = document.querySelectorAll('.chat-view__usage-summary-label');
      for (let i = 0; i < pills.length; i++) {
      if (pills[i].textContent === 'Total') {
        const el = pills[i].parentElement.querySelector('.chat-view__usage-summary-value');
        return el ? el.textContent : null;
      }
      }
      return value ? value.textContent : null;
      })(),
      composer: composer ? composer.value : null
    };
  };
}

async function withPage(bundleText, width, run) {
  let target, ws;
  const pending = new Map();
  const network = [];
  let id = 0;
  try {
    const response = await fetch(endpoint + '/json/new?about:blank', { method: 'PUT', signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok, 'CDP can create an isolated blank target');
    target = await response.json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (message.method === 'Network.requestWillBeSent') network.push(message.params.request.url);
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 5000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(method + ' timed out')); }, 15000);
      pending.set(key, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: key, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    // `budget` is in 50 ms polls. The default is generous for a render or a
    // fetch; a check that has to watch a live take rotate needs more, because
    // the button rotates on its own schedule (LIVE_CHUNK_MS).
    const waitFor = async (expression, label, budget = 100) => {
    for (let attempt = 0; attempt < budget; attempt++) {
      if (await evaluate(expression)) return;
      await sleep(50);
    }
    // A timeout is almost always "the app never rendered" or "a fixture route
    // is missing", so the failure carries the page's own diagnostics.
    const state = await evaluate(`({
      hasMic: !!document.querySelector('.chat-view__mic-btn'),
      hasComposer: !!document.querySelector('#chatComposer'),
      status: (document.querySelector('.chat-view__status') || {}).textContent,
      requests: dictationTest.requests.map(r => r.method + ' ' + r.url),
      errors: dictationTest.errors,
      unexpected: dictationTest.unexpected,
      body: document.body.innerHTML.slice(0, 200)
    })`).catch((err) => ({ evaluateFailed: String(err) }));
    throw new Error('Timed out: ' + label + ' :: ' + JSON.stringify(state));
    };
    const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const tap = async (selector) => {
      const point = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Missing tap target: ' + ${JSON.stringify(selector)});
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        if (!r.width || !r.height) throw new Error('Tap target has no box: ' + ${JSON.stringify(selector)});
        return { x, y };
      })()`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await settle();
    };
    try {
      await send('Network.enable');
      await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] });
      await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 480 });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await evaluate(`document.open(); document.write('<!doctype html><html><head></head><body></body></html>'); document.close();
        document.head.innerHTML = '<meta name="viewport" content="width=device-width,initial-scale=1">';
        document.body.innerHTML = '<main id="app"></main>';
        const style = document.createElement('style'); style.textContent = ${JSON.stringify(bundleText.css)};
        document.head.append(style); (${installFixture.toString()})(${JSON.stringify({
        projectDir: PROJECT_DIR, chatId: CHAT_ID, pricedCost: PRICED_COST, unpricedCost: UNPRICED_COST
        })});`);
      await evaluate(bundleText.js);
      await waitFor(`document.querySelector('.chat-view__mic-btn') && document.querySelector('#chatComposer')`,
      'real ChatView rendered with the composer mic');
      assert.ok(await evaluate('dictationTest.watchStatus()'), 'the chat status line exists to watch');
      await settle();
      await run({ evaluate, waitFor, settle, tap });
      assert.deepEqual(await evaluate('dictationTest.unexpected'), [], 'all fetches matched explicit fixture routes');
      assert.deepEqual(await evaluate('dictationTest.errors'), [], 'no uncaught browser errors');
      assert.deepEqual(network, [], 'no real network requests from the isolated app');
    } finally {
      ws.close();
      await fetch(endpoint + '/json/close/' + target.id).catch(() => {});
    }
  } catch (error) {
    if (ws) ws.close();
    if (target) await fetch(endpoint + '/json/close/' + target.id).catch(() => {});
    throw error;
  }
}

async function main() {
  const bundleText = await bundle();
  const width = Number(process.env.WIDTH || 390);
  let checks = 0;
  const check = (name, value) => {
    assert.ok(value, name);
    checks += 1;
    console.log('  ok - ' + name);
  };

  console.log('Dictation in the chat composer (real ChatView, ' + width + 'px)');
  await withPage(bundleText, width, async ({ evaluate, waitFor, tap }) => {
    const read = () => evaluate('dictationTest.snapshot()');

    // ---- The button, on a cold chat --------------------------------
    const idle = await read();
    check('the composer renders the microphone button', idle.hasMic);
    check('and labels it as an un-pressed recorder', idle.label === 'Dictate' && idle.recording === 'false');

    // ---- Record ------------------------------------------------------
    await tap('.chat-view__mic-btn');
    await waitFor(`document.querySelector('.chat-view__mic-btn').getAttribute('aria-pressed') === 'true'`, 'recording starts');
    const recording = await read();
    check('a tap starts recording and says so', /^Stop dictation \(/.test(recording.label));

    // ---- Stop: the transcript goes to the composer, the cost to the status
    await tap('.chat-view__mic-btn');
    await waitFor(`document.querySelector('.chat-view__status').textContent.indexOf('dictation added') === 0`, 'transcription lands');
    const done = await read();
    check('the chat status line reports what the run cost', done.status === 'dictation added · $0.00055');
    check('the chat was told as it happened, not only in the DOM now',
    await evaluate(`dictationTest.statusWrites.some(w => w.text === 'dictation added · $0.00055' && w.state === 'success')`));
    check('the transcript is appended to the composer draft',
      done.composer === 'This is a dictated sentence about mouaif.');
    check('the draft is persisted, not only shown',
      await evaluate(`dictationTest.draftPatches.some(p => String(p.draft).indexOf('dictated sentence') >= 0)`));
    check('the model came from the app-level dictation choice, not the chat',
      await evaluate(`dictationTest.transcribeBodies[0].modelId === 'gemini-2.5-flash' && dictationTest.transcribeBodies[0].providerId === 'gemini'`));
    check('and the button keeps the same figure for its tooltip',
    done.title === 'Added to the composer ($0.00055) — review it, then send.');
    check('and the cost reaches the chat header Total, not only the status line',
    done.total === '$0.00055',
    'Total pill reads ' + JSON.stringify(done.total));
    check('the run was attributed to this chat, so the server can persist it',
    await evaluate(`dictationTest.transcribeBodies[0].chatId === ${JSON.stringify(CHAT_ID)}`));
    check('the microphone was released after the run', await evaluate('dictationTest.streamStopped === 1'));

    // ---- An unpriced run says nothing rather than $0.00 --------------
    //
    // The realistic case: `whisper-1` bills per minute of audio and answers
    // with the transcript alone, so the server sends `cost.known: false`.
    await evaluate(`dictationTest.cost = 'unpriced'`);
    await tap('.chat-view__mic-btn');
    await waitFor(`document.querySelector('.chat-view__mic-btn').getAttribute('aria-pressed') === 'true'`, 'second recording starts');
    await tap('.chat-view__mic-btn');
    await waitFor(`dictationTest.runs === 2 && document.querySelector('.chat-view__mic-btn').getAttribute('aria-pressed') === 'false'`, 'second transcription lands');
    const unpriced = await read();
    check('an unpriced run adds no figure to the status line', unpriced.status === 'dictation added');
    check('and leaves the header Total where the priced run left it',
    unpriced.total === '$0.00055',
    'Total pill reads ' + JSON.stringify(unpriced.total));
    check('and the composer got the second transcript too',
      unpriced.composer === 'This is a dictated sentence about mouaif. Second dictated sentence.');
    check('the button does not claim a price either',
      unpriced.title === 'Added to the composer — review it, then send.');
    check('two runs, two upstream calls', await evaluate('dictationTest.runs === 2'));

    // ---- A live take that rotates: several complete recordings -------------
    //
    // The regression this pins: a live take used to be cut with
    // MediaRecorder's *timeslice*, whose later slices carry no container
    // header (the EBML header is in the first slice alone), so the provider
    // was handed fragments and only the take's first ~3 s were ever
    // transcribed. A live take now rotates whole recordings: one request per
    // rotation, in speaking order, settled with the sum of their prices — and
    // the last, partial segment is still sent rather than dropped.
    await evaluate(`dictationTest.cost = 'priced';
      dictationTest.segmentAnswerBase = dictationTest.transcribeBodies.length;
      dictationTest.segmentAnswers = ['The build is red.', 'And the note is saved.', 'So the release waits.'];`);
    const runsBefore = await evaluate('dictationTest.runs');
    const draftBefore = (await read()).composer;
    await tap('.chat-view__mic-btn');
    await waitFor(`document.querySelector('.chat-view__mic-btn').getAttribute('aria-pressed') === 'true'`, 'the rotating take starts');
    // Two rotations happen while the take runs, so this check does not have to
    // know how long a segment is: LIVE_CHUNK_MS is the button's business.
    await waitFor(`dictationTest.runs >= ${runsBefore + 2}`, 'the take rotates while the user is still speaking', 300);
    const midTake = await read();
    check('a live take posts a completed recording while the user is still speaking',
    (await evaluate('dictationTest.runs')) >= runsBefore + 2);
    check('and the chat says how many words have landed so far',
    / words so far — tap the mic to stop\.$/.test(String(midTake.status)), 'status: ' + midTake.status);
    check('and the first segment is already in the draft at the caret',
    String(midTake.composer).indexOf('The build is red.') > 0 &&
    String(midTake.composer).indexOf(draftBefore) === 0, 'composer: ' + midTake.composer);
    // ---- The take's own settle is a transcription request too ----------
    //
    // The regression this pins: on a live take the loading state is not only
    // the request *while* the user speaks. When they tap to stop, the last
    // segment (or a segment still in flight) is still being transcribed, and
    // the button has to say so — before this it went back to a plain
    // microphone and its "N words so far — tap the mic to stop." line while it
    // was in fact transcribing, so the loading state was missing exactly when
    // the user was waiting on it. The transcription is held so that the closing
    // wait is long enough to read; the assertions compare the button with
    // itself one segment-request later, so how long a segment is, and how many
    // are still in flight, do not matter.
    await evaluate('dictationTest.transcribeHoldMs = 1500;');
    const runsAtStop = await evaluate('dictationTest.runs');
    await tap('.chat-view__mic-btn');
    await waitFor(`dictationTest.runs > ${runsAtStop}`, 'the last segment is being transcribed');
    await waitFor(`document.querySelector('.chat-view__mic-btn').getAttribute('aria-label') === 'Working…'`,
    'the closing take is reported as working');
    const closing = await read();
    check('a live take that is still transcribing its last segment shows the loading state',
    closing.spinner === true && closing.busy === 'true' && closing.busyClass === true,
    'spinner: ' + closing.spinner + ', aria-busy: ' + closing.busy + ', is-busy: ' + closing.busyClass);
    check('and says it is transcribing rather than leaving the countdown standing',
    closing.status === 'Transcribing…' && closing.statusState === 'busy', 'status: ' + closing.status);
    check('and the running clock is replaced by the working label',
    closing.label === 'Working…' && closing.recording === 'false');
    // The spinner is a *request* being processed: it must end when the take
    // settles, or the button would claim work that is over.
    await evaluate('dictationTest.transcribeHoldMs = 0;');
    await waitFor(`document.querySelector('.chat-view__status').textContent.indexOf('dictation added') === 0`,
    'the rotating take settles');
    const rotated = await read();
    check('the spinner ends when the take settles, so nothing claims work that is over',
    rotated.spinner === false && rotated.busy === null && rotated.busyClass === false,
    'spinner: ' + rotated.spinner + ', aria-busy: ' + rotated.busy);
    const segmentCount = (await evaluate('dictationTest.transcribeBodies.length')) - runsBefore;
    check('a live take sends one request per rotation, and the last (partial) segment too',
      segmentCount >= 3, segmentCount + ' segment request(s)');
    check('every segment carried the dictation model and this chat',
      await evaluate(`dictationTest.transcribeBodies.slice(${runsBefore}).every(b => b.modelId === 'gemini-2.5-flash' && b.providerId === 'gemini' && b.chatId === ${JSON.stringify(CHAT_ID)})`));
    check('the segments are stitched into the draft in speaking order',
      rotated.composer === draftBefore + ' The build is red. And the note is saved. So the release waits.',
      'composer: ' + JSON.stringify(rotated.composer));
    check('and the take settles with the sum of its segments\' prices',
      rotated.status === 'dictation added · $' + new Intl.NumberFormat('en-US', {
        useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 5
      }).format(0.00055 * segmentCount), 'status: ' + rotated.status);

    // ---- A tap with nothing configured must say so, and must not record ----
    //
    // The state a fresh install is in: nothing remembered under the app-level
    // `dictation` key, and a catalog that offers nothing the selection rules
    // would adopt. The mic used to record, stop, fail to match a row, and write
    // the reason to its own `title` — which no phone shows, so the tap looked
    // like nothing happened at all. The check is that the chat's own status row
    // carries the reason, and that the microphone is never opened for a take
    // that cannot be sent.
    const streamsBefore = await evaluate('dictationTest.streamStopped');
    const runsBeforeNoModel = await evaluate('dictationTest.runs');
    const composerBeforeNoModel = (await read()).composer;
    await evaluate('dictationTest.dictationChoice = null; dictationTest.catalogModels = [];');
    await tap('.chat-view__mic-btn');
    await waitFor(`document.querySelector('.chat-view__status').textContent.indexOf('No dictation model yet') === 0`,
      'the missing model is reported in the chat');
    const noModel = await read();
    check('a tap with no dictation model says so in the chat status line',
      noModel.status === 'No dictation model yet — Open Settings → App defaults → Dictation to pick a dictation model.');
    check('and marks the line as an error', noModel.statusState === 'error');
    check('the recorder never started', noModel.recording === 'false');
    check('the microphone was never opened', await evaluate('dictationTest.streamStopped') === streamsBefore);
    check('and no transcription was attempted', await evaluate(`dictationTest.runs === ${runsBeforeNoModel}`));
    check('the draft the user already had is untouched', noModel.composer === composerBeforeNoModel);

    // ---- No take slices the recorder -------------------------------------
    //
    // The one-line guard for the bug above: a take that asks for a timeslice
    // gets slices, and only the first of them is a file the provider can read.
    check('no take ever asked the recorder for a timeslice',
      (await evaluate('dictationTest.timeslices')).every((arg) => !arg));

    // ---- A tap that resolves the model says so, and never claims a transcription ----
    //
    // Two facts are pinned here, and they are the two halves of one rule:
    //
    //   * the model resolve is two reads (`/api/settings`, then the catalog)
    //     *before* the microphone opens — no audio exists and nothing has been
    //     asked for yet — so it is never the button's loading state: no spinner,
    //     no `aria-busy`, no `Working…`, however long it runs. A spinner there is
    //     the loading state of an operation the user has not started. What the
    //     wait gets is a sentence in the chat's status row (`Preparing
    //     dictation…`, decided by `micResolveNote`), because a tap must not look
    //     dead either;
    //   * that sentence is delayed by `MIC_WAIT_DELAY_MS`: on a healthy
    //     connection both reads answer inside a frame, so the same tap with the
    //     settings read held for nothing must never write it at all.
    //
    // The state is restored first because the case above emptied the catalog on
    // purpose.
    await evaluate('dictationTest.restoreDictation(); dictationTest.holdMs = 1200;');
    await tap('.chat-view__mic-btn');
    await waitFor(`document.querySelector('.chat-view__status').textContent === 'Preparing dictation…'`,
    'the slow resolve is named in the chat line');
    const waiting = await read();
    check('a slow resolve names the step in the chat line', waiting.status === 'Preparing dictation…');
    check('and marks that line as a wait', waiting.statusState === 'busy');
    check('but the button takes none of the loading affordances',
    waiting.busy === null && waiting.spinner === false);
    check('so it keeps its microphone glyph and its own label', waiting.label === 'Dictate');
    check('and nothing is recorded during it', waiting.recording === 'false');
    await waitFor(`document.querySelector('.chat-view__mic-btn').getAttribute('aria-pressed') === 'true'`,
    'recording starts once the model resolves');
    const resumed = await read();
    check('the sentence gives way to the recorder when the wait is over',
    resumed.spinner === false && resumed.busy === null && /^Stop dictation/.test(resumed.label));
    // Close the take and let the page settle, so nothing is left running.
    await tap('.chat-view__mic-btn');
    await waitFor(`document.querySelector('.chat-view__mic-btn').getAttribute('aria-pressed') === 'false'`,
    'the take is closed again');
    await waitFor(`document.querySelector('.chat-view__mic-btn').getAttribute('aria-busy') !== 'true' ||
    document.querySelector('.chat-view__mic-btn').getAttribute('aria-busy') === null`, 'nothing is left busy');
    // ---- A fast resolve never says anything --------------------------------
    //
    // The half that makes the delayed sentence worth having: with the reads held
    // for nothing, the same tap must not write `Preparing dictation…` at all, and
    // must not render a working state either. The watchdog samples on every
    // animation frame, so a state that lasted one frame would still be caught.
    await evaluate('dictationTest.holdMs = 0;');
    await evaluate(`window.__micBusySeen = 0; window.__micStatusFrom = dictationTest.statusWrites.length;
    window.__micWatch = setInterval(() => {
    const mic = document.querySelector('.chat-view__mic-btn');
    if (mic && mic.getAttribute('aria-busy') === 'true') window.__micBusySeen += 1;
    }, 16);`);
    await tap('.chat-view__mic-btn');
    await waitFor(`document.querySelector('.chat-view__mic-btn').getAttribute('aria-pressed') === 'true'`,
    'a fast tap still starts recording');
    await evaluate('clearInterval(window.__micWatch);');
    check('a resolve inside the delay never shows a working state at all',
    (await evaluate('window.__micBusySeen')) === 0, 'busy frames seen: ' + (await evaluate('window.__micBusySeen')));
    check('and never claims to be preparing dictation',
    (await evaluate('dictationTest.statusWrites.slice(window.__micStatusFrom)'
    + '.filter((w) => w.text === "Preparing dictation…").length')) === 0);
    const fast = await read();
    check('and it goes straight to recording', /^Stop dictation/.test(fast.label) && fast.busy === null);
    await tap('.chat-view__mic-btn');
    await waitFor(`document.querySelector('.chat-view__mic-btn').getAttribute('aria-pressed') === 'false'`,
    'the fast take is closed');
    await evaluate('dictationTest.holdMs = 0;');
    });

  // ---- The composer with both optional tools hidden ----------------------
  //
  // Settings → Chat defaults can hide the dictation microphone and the image
  // button (`dictationButton` / `imageButton`, docs/features/composer-tool-buttons.md).
  // Hiding is not disabling, and it is not "the row minus two controls": the
  // text area, the send button and the status line have to be untouched, and
  // the image *file input* has to still be mounted, because a pasted image
  // travels through it. The other page in this file runs with both shown, so
  // the pair of pages is the whole check — an unconditional `<input>` or a
  // button that is merely styled away would pass one and fail the other.
  console.log('Composer with the optional buttons hidden (real ChatView, ' + width + 'px)');
  await withPage(bundleText, width, async ({ evaluate, waitFor }) => {
    await waitFor('dictationTest.composerTools.dictationButton === true && dictationTest.composerTools.imageButton === true',
      'the fixture starts with both optional tools shown');
    const shown = await evaluate(`({
      mic: !!document.querySelector('.chat-view__mic-btn'),
      imageButton: !!document.querySelector('.chat-view__image-btn'),
      imageInput: !!document.querySelector('.chat-view__image-input')
    })`);
    check('both optional tools are drawn before the user hides them',
      shown.mic && shown.imageButton);

    // Flip both preferences and reload the route, which is what the next visit
    // to a chat does (ChatView seeds them from /api/settings when its data
    // loads).
    await evaluate(`dictationTest.composerTools.dictationButton = false;
      dictationTest.composerTools.imageButton = false;
      location.hash = '#/projects';`);
    await waitFor(`!document.querySelector('.chat-view__mic-btn') || !document.querySelector('#chatComposer')`,
      'the chat view is left for the project list');
    await evaluate(`location.hash = '#/chat/${CHAT_ID}?projectDir=' + encodeURIComponent(${JSON.stringify(PROJECT_DIR)});`);
    await waitFor(`document.querySelector('#chatComposer') && dictationTest.requests.filter(r => r.url === '/api/settings').length >= 2`,
      'the chat is opened again and re-reads the app settings');
    const hidden = await evaluate(`({
      mic: !!document.querySelector('.chat-view__mic-btn'),
      imageButton: !!document.querySelector('.chat-view__image-btn'),
      imageInput: !!document.querySelector('.chat-view__image-input'),
      imageInputType: (document.querySelector('.chat-view__image-input') || {}).type,
      composer: !!document.querySelector('#chatComposer'),
      send: !!document.querySelector('.chat-view__send'),
      status: !!document.querySelector('.chat-view__status'),
      row: !!document.querySelector('.chat-view__composer'),
      dictationPage: location.hash
    })`);
    check('a hidden dictation button leaves no microphone in the composer', hidden.mic === false);
    check('and a hidden image button leaves no image button', hidden.imageButton === false);
    check('the message box survives both', hidden.composer);
    check('so does the send button', hidden.send);
    check('and the status line', hidden.status);
    check('the composer row itself is still there', hidden.row);
    check('the image file input stays mounted, so a pasted image still attaches',
      hidden.imageInput && hidden.imageInputType === 'file');
    // Nothing is disabled — the routes are not gated on a display preference.
    check('hiding a button disables nothing: the transcription endpoint is still live',
      await evaluate(`(async () => (await fetch('/api/ai/transcribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'gemini-2.5-flash', providerId: 'gemini', data: 'AA==' })
      })).status)()`) === 200);
  });

  console.log('\nDictation composer regressions passed (' + checks + ' checks). No production files or live app data touched.');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
