// Real App -> ChatView -> useChatState -> refreshAllProviders regression.
// Run: node scripts/test-model-picker-chat.cjs
// Requires debug Chrome at CDP_URL (default http://127.0.0.1:9222).
// All bundles stay in memory; only a fresh about:blank target is touched.
// Fetch is fully stubbed (unknown requests fail), with CDP blocking network
// as a second guard. No server, provider, application data, or build is used.
//
// Optional negative control: --refresh-from-head bundles ONLY modelPicker.js
// and useChatState.js from git HEAD, leaving the current modal/CSS in place.
// This isolates the pre-patch composer-status regression without checking out
// or modifying production files. It should FAIL while HEAD has the old writes.
// Native Escape/gestures/mock visualViewport coverage belongs to the separate
// test-model-picker.cjs; here we use real layout, native dialog and focus.
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { build } = require('esbuild');
const { WebSocket } = require('ws');

const root = path.resolve(__dirname, '..');
const endpoint = (process.env.CDP_URL || 'http://127.0.0.1:9222').replace(/\/$/, '');
const fromHead = process.argv.includes('--refresh-from-head');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function bundleFixture() {
  const sources = new Map();
  if (fromHead) {
    for (const file of ['modelPicker.js', 'useChatState.js']) {
      const relative = 'frontend/src/components/chat/' + file;
      sources.set(path.join(root, relative), execFileSync('git', ['show', 'HEAD:' + relative], {
        cwd: root, encoding: 'utf8'
      }));
    }
  }
  const [js, css] = await Promise.all([
    build({
      stdin: {
        contents: `import { h, render } from 'preact';
import { App } from './frontend/src/components/App.jsx';
import { route } from './frontend/src/api.js';
route.value = { name: 'chat', chatId: 'picker-regression', projectDir: '/fixture/model-picker' };
render(h(App), document.getElementById('app'));`,
        resolveDir: root, sourcefile: 'model-picker-chat-fixture.js'
      },
      bundle: true, write: false, format: 'iife', platform: 'browser',
      define: { 'import.meta.env': '{"PROD":true}' },
      // Lazy editor/inspector CSS is not used by the chat route. Load the real
      // stylesheet entry separately, preserving its complete @import order.
      loader: { '.css': 'empty' },
      plugins: sources.size ? [{
        name: 'read-only-refresh-from-head',
        setup(api) {
          api.onLoad({ filter: /[/\\](modelPicker|useChatState)\.js$/ }, args => {
            if (sources.has(args.path)) return { contents: sources.get(args.path), loader: 'js' };
          });
        }
      }] : []
    }),
    build({
      entryPoints: [path.join(root, 'frontend/src/style.css')],
      bundle: true, write: false, minify: false
    })
  ]);
  return { js: js.outputFiles[0].text, css: css.outputFiles[0].text };
}

// Runs inside the blank page, BEFORE importing any application code.
function installFixture() {
  const test = window.chatPickerTest = {
    requests: [], unexpected: [], errors: [], pending: [], statusMutations: [], round: 0,
    providerError: 'Fixture upstream is unavailable. Check the local service and retry; ' +
      'this deliberately long provider diagnostic must wrap inside the model picker, ' +
      'not grow the composer status row or resize and re-pin the transcript behind it. '.repeat(20)
  };
  addEventListener('error', event => test.errors.push(event.message));
  addEventListener('unhandledrejection', event => test.errors.push(String(event.reason)));
  const providers = [{ id: 'ollama' }, { id: 'openai-compatible' }];
  const chat = {
    id: 'picker-regression', title: 'Model picker integration',
    providerId: 'ollama', modelId: 'fixture-seed', running: false, draft: ''
  };
  const models = providers.map(p => ({ provider: p.id, id: 'fixture-seed' }));
  const messages = Array.from({ length: 36 }, (_, seq) => ({
    seq, role: seq % 2 ? 'assistant' : 'user', ts: 1700000000000 + seq * 1000,
    content: `Fixture message ${seq}: stable transcript content. ` +
      'A real rendered conversation long enough to overflow the phone and desktop transcript.'
  }));
  const reply = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
  });
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'https://fixture.invalid');
    const method = init.method || input.method || 'GET';
    test.requests.push({ url: url.pathname + url.search, method });
    if (method === 'POST' && url.origin === 'https://fixture.invalid' && url.pathname === '/api/git') {
      const body = JSON.parse(init.body);
      if (body.projectDir === '/fixture/model-picker' && body.action === 'diff' &&
          ['--numstat', '--numstat --cached'].includes(body.args)) return reply({ ok: true, stdout: '' });
    }
    if (method === 'GET' && url.origin === 'https://fixture.invalid') {
      const pathname = url.pathname;
      if (pathname === '/api/ai/models/live') {
        const provider = url.searchParams.get('provider');
        if (!providers.some(p => p.id === provider)) throw new Error('Unknown fixture provider: ' + provider);
        // Hold ALL live requests once a refresh round starts, even if a buggy
        // caller forgets _bust. The Node assertions check that flag explicitly.
        if (test.round) return new Promise(resolve => test.pending.push({ provider, resolve }));
        return reply({ models: [{ id: 'fixture-seed' }], cached: true });
      }
      const bodies = {
        '/api/settings': { app: { providers, enterForNewline: true } },
        '/api/ai/models': { models },
        '/api/ai/models/providers': { providers },
        '/api/ai/provider-credit': { supported: false },
        '/api/settings/models/recent': { recent: [] },
        '/api/chats': { chats: [chat], total: 1 },
        '/api/chats/picker-regression': { chat },
        '/api/chats/picker-regression/messages': { messages, nextSeq: messages.length },
        '/api/chats/picker-regression/revision': { running: false, nextSeq: messages.length },
        '/api/chats/picker-regression/system-prompt': {
          text: '', agentFilesAvailable: [], skills: [], projectAgentFiles: false
        },
        '/api/prompts': { prompts: [] },
        '/api/mcp/servers': { servers: [] },
        '/api/agents': { agents: [] },
        '/api/actions': { actions: [] },
        '/api/tools/list': { tools: [] },
        '/api/tools/authorization': { tools: {}, mcp: {} },
        '/api/projects/registered': { projects: [] }
      };
      if (Object.hasOwn(bodies, pathname)) return reply(bodies[pathname]);
    }
    test.unexpected.push(method + ' ' + url.href);
    throw new Error('Unstubbed fetch: ' + method + ' ' + url.href);
  };
  test.settle = fail => {
    if (test.pending.length !== providers.length) throw new Error('Expected one request per provider');
    for (const { provider, resolve } of test.pending.splice(0)) {
      resolve(fail && provider === 'ollama'
        ? reply({ code: 'EUNREACHABLE', error: test.providerError }, 503)
        : reply({ models: [{ id: 'fixture-seed' }, { id: 'fixture-refreshed-' + test.round }], cached: false }));
    }
  };
  test.query = value => {
    const input = document.querySelector('.mp__search');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  test.snapshot = () => {
    const rect = el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const boxes = {};
    for (const selector of ['#app', '.app__shell', '.app__main', '.chat-view',
      '.chat-view__head', '.chat-view__composer-row', '.chat-view__composer',
      '.chat-view__status-row', '.chat-view__status', '.chat-view__transcript']) {
      const el = document.querySelector(selector);
      if (!el) throw new Error('Missing geometry target: ' + selector);
      boxes[selector] = { ...rect(el), scrollTop: el.scrollTop, scrollLeft: el.scrollLeft,
        scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    }
    const transcript = document.querySelector('.chat-view__transcript');
    const status = document.querySelector('.chat-view__status');
    return {
      boxes, status: status.textContent, statusState: status.getAttribute('data-state'),
      transcript: transcript.textContent, messages: transcript.querySelectorAll('.chat-msg').length,
      lastMessage: rect(transcript.querySelector('.chat-msg:last-child')),
      composer: document.querySelector('#chatComposer').value,
      scrollX, scrollY, documentTop: document.scrollingElement.scrollTop
    };
  };
}

async function withPage(bundle, width, run) {
  let target, ws;
  const pending = new Map();
  const network = [];
  let id = 0;
  try {
    const response = await fetch(endpoint + '/json/new?about:blank', { method: 'PUT', signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok, 'CDP can create an isolated blank target');
    target = await response.json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.method === 'Network.requestWillBeSent') network.push(message.params.request.url);
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    ws.on('close', () => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('CDP socket closed'));
      }
      pending.clear();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 5000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', err => { clearTimeout(timer); reject(err); });
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(method + ' timed out')); }, 15000);
      pending.set(key, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: key, method, params }));
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async (expression, label) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate(expression)) return;
        await sleep(50);
      }
      throw new Error('Timed out: ' + label);
    };
    // Let Preact effects, layout/ResizeObserver and transcript rAF pinning run.
    const settleLayout = () => evaluate(`new Promise(resolve => setTimeout(() =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)), 100))`);
    const click = async selector => {
      const point = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Missing click target: ' + ${JSON.stringify(selector)});
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        if (!r.width || !r.height || !el.contains(document.elementFromPoint(x, y)))
          throw new Error('Click target is clipped/covered: ' + ${JSON.stringify(selector)});
        return { x, y };
      })()`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
      await settleLayout();
    };
    try {
      await send('Network.enable');
      await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] });
      await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 480 });
      await send('Emulation.setFocusEmulationEnabled', { enabled: true });
      // about:blank starts in quirks mode; use the production standards-mode
      // doctype so scrollingElement and flex/viewport layout match the app.
      await evaluate(`document.open(); document.write('<!doctype html><html><head></head><body></body></html>'); document.close();
        document.head.innerHTML = '<meta name="viewport" content="width=device-width,initial-scale=1">';
        document.body.innerHTML = '<main id="app"></main>';
        const style = document.createElement('style'); style.textContent = ${JSON.stringify(bundle.css)};
        document.head.append(style); (${installFixture.toString()})();`);
      assert.equal(await evaluate('location.href'), 'about:blank');
      await evaluate(bundle.js);
      await waitFor(`document.querySelectorAll('.chat-view__transcript .chat-msg').length === 36 &&
        document.querySelector('.mp__id')?.textContent === 'fixture-seed' &&
        chatPickerTest.requests.some(r => r.url === '/api/tools/list?projectDir=%2Ffixture%2Fmodel-picker') &&
        chatPickerTest.requests.some(r => r.url.startsWith('/api/ai/models/live?'))`, 'real ChatView fully loaded');
      await settleLayout();
      await run({ evaluate, waitFor, settleLayout, click, send });
      assert.deepEqual(await evaluate('chatPickerTest.unexpected'), [], 'all fetches matched explicit fixture routes');
      assert.deepEqual(await evaluate('chatPickerTest.errors'), [], 'no uncaught browser errors');
      assert.deepEqual(network, [], 'no real network requests from the isolated app');
    } catch (error) {
      try {
        console.error('Browser diagnostic:', JSON.stringify(await evaluate(`({
          status: document.querySelector('.chat-view__status')?.textContent,
          unexpected: chatPickerTest.unexpected, errors: chatPickerTest.errors,
          pending: chatPickerTest.pending.map(p => p.provider), requests: chatPickerTest.requests.slice(-12)
        })`), null, 2));
      } catch { /* preserve the original error if the target disconnected */ }
      throw error;
    }
  } finally {
    for (const waiter of pending.values()) clearTimeout(waiter.timer);
    pending.clear();
    if (ws) ws.terminate();
    if (target) await fetch(endpoint + '/json/close/' + target.id, { signal: AbortSignal.timeout(5000) });
  }
}

async function exerciseChat({ evaluate, waitFor, settleLayout, click, send }, width) {
  const check = async (name, expression) => {
    assert.equal(await evaluate(expression), true, name);
    console.log('  ok - ' + name);
  };
  // Keep the REAL shell/layout rules; add only adversarial containing-block
  // and clipping properties to its ancestor. On phones the modal extends
  // beyond this inset clip, and on desktop beyond the shell's 30rem width.
  await evaluate(`Object.assign(document.querySelector('#app').style, {
    transform: 'translate(7px, 5px)', overflow: 'hidden', clipPath: 'inset(0 16px 24px 0)'
  });
  const status = document.querySelector('.chat-view__status');
  new MutationObserver(records => chatPickerTest.statusMutations.push(...records.map(r => r.type)))
    .observe(status, { subtree: true, childList: true, characterData: true, attributes: true });`);
  await settleLayout();
  await check('real shell, full CSS and overflowing transcript at ' + width, `(() => {
    const t = document.querySelector('.chat-view__transcript');
    return !!document.querySelector('#app > .app__shell > .app__main--chat > .chat-view') &&
      getComputedStyle(document.querySelector('.app__shell')).display === 'flex' &&
      getComputedStyle(t).overflowY === 'auto' && t.clientHeight > 200 &&
      t.scrollHeight > t.clientHeight * 2 && getComputedStyle(document.querySelector('#app')).transform !== 'none';
  })()`);

  for (const pinned of [true, false]) {
    const mode = pinned ? 'pinned' : 'scrolled up';
    await evaluate(`(() => { document.querySelector('#chatComposer').focus({ preventScroll: true });
      const t = document.querySelector('.chat-view__transcript');
      t.scrollTop = ${pinned ? 't.scrollHeight' : 'Math.floor((t.scrollHeight - t.clientHeight) / 2)'};
      t.dispatchEvent(new Event('scroll')); })()`);
    await settleLayout();
    const baseline = await evaluate('chatPickerTest.snapshot()');
    assert.equal(baseline.status, '', 'composer starts without refresh feedback');
    const t = baseline.boxes['.chat-view__transcript'];
    assert.ok(t.scrollTop > 0, 'non-zero transcript scroll exercises scroll preservation');
    assert.ok(pinned ? t.scrollHeight - t.clientHeight - t.scrollTop <= 1
      : t.scrollHeight - t.clientHeight - t.scrollTop > 200, 'fixture is ' + mode);
    const stable = async phase => {
      const current = await evaluate('chatPickerTest.snapshot()');
      const { transcript: beforeText, ...beforeGeometry } = baseline;
      const { transcript: afterText, ...afterGeometry } = current;
      assert.equal(afterText, beforeText, 'refresh must not replace/change transcript content');
      assert.deepEqual(afterGeometry, beforeGeometry, `${width}px ${mode}: ${phase} must preserve composer status, transcript geometry and every scroll offset`);
      assert.deepEqual(await evaluate('chatPickerTest.statusMutations'), [], 'refresh must never write to composer status (even transiently)');
    };
    await click('.mp__trigger');
    await waitFor(`document.querySelector('.mp__pop')?.matches(':modal')`, 'native modal open');
    await stable('opening');
    await check('native dialog escapes transformed/clipped app (' + width + ', ' + mode + ')', `(() => {
      const d = document.querySelector('.mp__pop');
      const r = d.getBoundingClientRect();
      const ancestor = document.querySelector(${JSON.stringify(width < 480 ? '#app' : '.app__shell')}).getBoundingClientRect();
      const x = r.right - 4, y = ${width < 480 ? 'r.bottom - 4' : 'r.top + 20'};
      return d instanceof HTMLDialogElement && d.open && d.matches(':modal') &&
        document.activeElement.matches('.mp__search') &&
        r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 &&
        ${width < 480 ? 'y > ancestor.bottom - 24' : 'x > ancestor.right'} &&
        d.contains(document.elementFromPoint(x, y));
    })()`);
    await check('background composer cannot take focus while modal is open', `(() => {
      const input = document.querySelector('.mp__search');
      document.querySelector('#chatComposer').focus({ preventScroll: true });
      return document.activeElement === input;
    })()`);
    // CDP keyboard events exercise the browser's native tab order, not a
    // synthetic event or merely an aria-modal attribute.
    for (let i = 0; i < 12; i++) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      assert.equal(await evaluate(`document.querySelector('.mp__pop').contains(document.activeElement) ||
        document.activeElement === document.body`), true, 'Tab must not focus any background app control');
    }
    await evaluate(`document.querySelector('.mp__search').focus({ preventScroll: true });
      chatPickerTest.searchNode = document.querySelector('.mp__search');
      Array.from(document.querySelectorAll('.mp__chip')).find(el => el.querySelector('.mp__chip-label').textContent === 'ollama').click();
      chatPickerTest.query('no-such-fixture-model');`);
    await settleLayout();
    await stable('native focus/tab navigation');
    const modalBox = await evaluate(`JSON.stringify(document.querySelector('.mp__pop').getBoundingClientRect().toJSON())`);

    for (const [name, selector, fail] of [
      ['empty-state refresh success', '.mp__empty-action:not(.mp__empty-action--clear)', false],
      ['header refresh provider error', '.mp__refresh', true],
      ['header refresh recovery', '.mp__refresh', false]
    ]) {
      const start = await evaluate(`chatPickerTest.round++; chatPickerTest.requests.length`);
      await click(selector);
      await waitFor('chatPickerTest.pending.length === 2', name + ' calls every configured provider');
      const requests = await evaluate(`chatPickerTest.requests.slice(${start}).filter(r => r.url.startsWith('/api/ai/models/live?'))`);
      assert.deepEqual(requests.map(r => {
        const url = new URL(r.url, 'https://fixture.invalid');
        assert.equal(r.method, 'GET');
        assert.equal(url.searchParams.get('_bust'), '1', 'explicit refresh must bypass provider cache');
        return url.searchParams.get('provider');
      }).sort(), ['ollama', 'openai-compatible'], 'one forced live request per provider');
      await stable(name + ' pending');
      await check(name + ' is busy, preserving search/filter/focus', `
        document.querySelector('.mp__refresh').disabled &&
        document.querySelector('.mp__empty-action:not(.mp__empty-action--clear)').disabled &&
        document.querySelector('.mp__search') === chatPickerTest.searchNode &&
        document.activeElement === chatPickerTest.searchNode &&
        chatPickerTest.searchNode.value === 'no-such-fixture-model' &&
        document.querySelector('.mp__chip.is-active .mp__chip-label').textContent === 'ollama'`);
      await evaluate(`chatPickerTest.settle(${fail})`);
      await waitFor(`!document.querySelector('.mp__refresh').disabled`, name + ' finishes');
      await settleLayout();
      await stable(name + ' settled');
      assert.equal(await evaluate(`JSON.stringify(document.querySelector('.mp__pop').getBoundingClientRect().toJSON())`), modalBox,
        'refresh does not move/resize the modal');
      await check(name + ' retains mounted/focused search and no-match state', `
        document.querySelector('.mp__search') === chatPickerTest.searchNode &&
        document.activeElement === chatPickerTest.searchNode &&
        chatPickerTest.searchNode.value === 'no-such-fixture-model' &&
        document.querySelector('.mp__chip.is-active .mp__chip-label').textContent === 'ollama' &&
        document.querySelector('.mp__empty-title').textContent === 'No matches'`);
      if (fail) {
        await check('provider diagnostic is visible INSIDE native modal, not composer', `(() => {
          const d = document.querySelector('.mp__pop');
          const a = d.querySelector('[role="alert"]');
          if (!a || !a.textContent.includes(chatPickerTest.providerError) || !a.textContent.includes('ollama not running')) return false;
          const r = a.getBoundingClientRect(), p = d.getBoundingClientRect();
          return r.height > 0 && r.top >= p.top && r.bottom <= p.bottom &&
            d.querySelector('.mp__list').clientHeight >= 100 &&
            a.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        })()`);
      } else {
        await check(name + ' clears modal errors and updates production catalog', `
          !document.querySelector('.mp__pop [role="alert"]') &&
          document.querySelector('.mp__chip.is-active .mp__chip-count').textContent === '2'`);
      }
      console.log(`  ok - ${width}px ${mode}: ${name} leaves status/geometry/scroll unchanged`);
    }
    await click('.mp__empty-action--clear');
    await check('refreshed model reaches real ChatView picker via hook', `
      Array.from(document.querySelectorAll('.mp__row-id')).some(el => el.textContent === 'fixture-refreshed-' + chatPickerTest.round)`);
    await click('.mp__close');
    await check('closing restores real trigger focus and background interactivity', `
      !document.querySelector('.mp__pop') && document.activeElement.matches('.mp__trigger') &&
      (document.querySelector('#chatComposer').focus({ preventScroll: true }), document.activeElement.id === 'chatComposer')`);
    await settleLayout();
    await stable('closing');
  }
}

async function main() {
  assert.ok(process.argv.slice(2).every(arg => arg === '--refresh-from-head'), 'Unknown argument');
  console.log('ChatView model-picker integration' + (fromHead ? ' (negative control: refresh modules from HEAD)' : ' (working tree)'));
  const bundle = await bundleFixture();
  for (const width of [390, 1280]) {
    await withPage(bundle, width, page => exerciseChat(page, width));
  }
  console.log('\nChatView model-picker integration passed. No production files or live app data touched.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
