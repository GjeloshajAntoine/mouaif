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
//   4. the run's cost reaches the chat's status line — a transcription is not a
//      chat turn, so no chat or project total covers it, and the status line is
//      the only place the user sees what dictating cost;
//   5. an unpriced run (`whisper-1` bills per minute and reports no tokens)
//      says nothing about cost rather than `$0.00`, and the button never claims
//      a price it was not given.
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
    runs: 0, cost: 'priced'
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

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'https://fixture.invalid');
    const method = (init.method || input.method || 'GET').toUpperCase();
    test.requests.push({ url: url.pathname + url.search, method });
    if (url.origin !== 'https://fixture.invalid') {
      test.unexpected.push(method + ' ' + url.href);
      throw new Error('Unstubbed origin: ' + url.href);
    }
    if (method === 'POST' && url.pathname === '/api/ai/transcribe') {
      test.transcribeBodies.push(JSON.parse(init.body || '{}'));
      test.runs += 1;
      const priced = test.cost === 'priced';
      return reply({
        text: priced ? 'This is a dictated sentence about mouaif.' : 'Second dictated sentence.',
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
            // Remembered on the dictation page, honoured here.
            dictation: { modelId: 'gemini-2.5-flash', providerId: 'gemini' }
          }
        },
        '/api/ai/models': { models: [{ provider: 'gemini', id: 'gemini-2.5-flash' }] },
        '/api/ai/models/providers': { providers },
        // The chat head refreshes the live catalog for its own model list; the
        // mic does not need it, but ChatView asks on open.
        '/api/ai/models/live': { models: [{ id: 'gemini-2.5-flash' }], cached: false },
        '/api/ai/provider-credit': { supported: false },
        '/api/settings/models/recent': { recent: [] },
        '/api/ai/transcribe/models': dictationCatalog,
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
    start() { this.state = 'recording'; if (this.onstart) this.onstart(); }
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
      status: status ? status.textContent : null,
      statusState: status ? status.getAttribute('data-state') : null,
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
    const waitFor = async (expression, label) => {
    for (let attempt = 0; attempt < 100; attempt++) {
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
    check('and the composer got the second transcript too',
      unpriced.composer === 'This is a dictated sentence about mouaif. Second dictated sentence.');
    check('the button does not claim a price either',
      unpriced.title === 'Added to the composer — review it, then send.');
    check('two runs, two upstream calls', await evaluate('dictationTest.runs === 2'));
  });
  console.log('\nDictation composer regressions passed (' + checks + ' checks). No production files or live app data touched.');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
