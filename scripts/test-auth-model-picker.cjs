// Browser regression for the subagent authorization card's model picker.
// Requires debug Chrome at CDP_URL (default http://127.0.0.1:9222).
//
// Regression: the auth card's ModelPickerField never received `pinned`/
// `recent`, so the Pinned and Recent sections rendered nothing on the card
// even when the chat top bar picker showed them. This fixture mounts the real
// AuthModelPicker on an isolated about:blank tab with an in-memory
// localStorage shim, seeds a pinned + a recently used model, opens the sheet,
// and asserts both the Pinned and Recent sections render.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { WebSocket } = require('ws');
const root = path.resolve(__dirname, '..');
const endpoint = process.env.CDP_URL || 'http://127.0.0.1:9222';
async function main() {
const bundle = await build({
stdin: {
contents: `import { h, render } from 'preact';
import { AuthModelPicker } from './frontend/src/components/AuthModelPicker.jsx';
import { loadPinned } from './frontend/src/components/chat/modelPicker.js';
window.authPickerTest = { h, render, AuthModelPicker, loadPinned };`,
resolveDir: root, sourcefile: 'auth-model-picker-test.js'
}, bundle: true, write: false, format: 'iife', platform: 'browser'
});
const target = await (await fetch(endpoint + '/json/new?about:blank', { method: 'PUT', signal: AbortSignal.timeout(5000) })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
ws.on('message', (raw) => {
const message = JSON.parse(raw);
const waiter = pending.get(message.id);
if (!waiter) return;
pending.delete(message.id);
clearTimeout(waiter.timer);
if (message.error) waiter.reject(new Error(message.error.message));
else waiter.resolve(message.result);
});
ws.on('close', () => {
for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('CDP socket closed')); }
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
const evaluate = async (expression) => {
const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
return result.result.value;
};
const check = async (name, expression) => {
assert.equal(await evaluate(expression), true, name);
console.log('  ok - ' + name);
};
const wait = () => evaluate('new Promise(resolve => setTimeout(resolve, 120))');
const tap = async (selector) => {
await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing tap target'); el.click(); })()`);
await wait();
};
try {
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
const css = ['base.css', 'chat-view.css'].map(f => fs.readFileSync(path.join(root, 'frontend/src', f), 'utf8')).join('\n');
await evaluate(`document.open(); document.write('<!doctype html><html><head></head><body></body></html>'); document.close();
document.head.innerHTML = '<meta name="viewport" content="width=device-width,initial-scale=1">';
document.body.innerHTML = '<div id="fixture"></div>';
const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.head.append(style);`);
await evaluate(bundle.outputFiles[0].text);
await evaluate(`window.errors = [];
addEventListener('unhandledrejection', ev => errors.push(String(ev.reason)));
// about:blank denies real localStorage; use an in-memory shim that
// modelPicker.js reads through the global localStorage reference.
const store = new Map();
Object.defineProperty(window, 'localStorage', { configurable: true, value: {
getItem: k => store.has(k) ? store.get(k) : null,
setItem: (k, v) => store.set(k, String(v)),
removeItem: k => store.delete(k),
clear: () => store.clear(),
key: i => Array.from(store.keys())[i] || null,
get length() { return store.size; }
} });
window.recentFetch = 0;
window.fetch = (url) => {
if (url === '/api/settings/models/recent?projectDir=' + encodeURIComponent('/fixture/auth')) {
recentFetch++;
return Promise.resolve(new Response(JSON.stringify({ recent: [{ provider: 'one', id: 'alpha', ts: Date.now() }] }), { status: 200 }));
}
return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
};
const key = 'mouaif_models__fixture_auth_pinned';
localStorage.setItem(key, JSON.stringify(['two\\u0000beta']));
window.models = [
{ id: 'alpha', provider: 'one', label: 'Alpha' },
{ id: 'beta', provider: 'two', label: 'Beta' }
];
const { h, render, AuthModelPicker } = authPickerTest;
render(h(AuthModelPicker, { models, projectDir: '/fixture/auth', initialValue: { providerId: 'one', modelId: 'alpha' } }), document.getElementById('fixture'));`);
await tap('.auth-model-picker .mp__trigger');
await wait();
await check('auth picker shows the Pinned section', `Array.from(document.querySelectorAll('.mp__section-title'), el => el.textContent).includes('Pinned')`);
await check('auth picker shows the Recent section', `Array.from(document.querySelectorAll('.mp__section-title'), el => el.textContent).includes('Recent')`);
await check('recent fetch hit the server-backed endpoint', 'recentFetch >= 1');
const pinnedRow = await evaluate(`(() => {
const sec = Array.from(document.querySelectorAll('.mp__section')).find(s => s.querySelector('.mp__section-title') && s.querySelector('.mp__section-title').textContent === 'Pinned');
return sec ? sec.textContent : '';
})()`);
assert.ok(pinnedRow.includes('beta'), 'Pinned section lists the pinned model');
console.log('  ok - Pinned section lists the pinned model');
const recentRow = await evaluate(`(() => {
const sec = Array.from(document.querySelectorAll('.mp__section')).find(s => s.querySelector('.mp__section-title') && s.querySelector('.mp__section-title').textContent === 'Recent');
return sec ? sec.textContent : '';
})()`);
assert.ok(recentRow.includes('alpha'), 'Recent section lists the used model');
console.log('  ok - Recent section lists the used model');
await check('unhandled errors', 'errors.length === 0');
console.log('\nAuth model picker browser regressions passed.');
} finally {
ws.close();
await fetch(endpoint + '/json/close/' + target.id);
}
}
main().catch(err => { console.error(err); process.exitCode = 1; });
