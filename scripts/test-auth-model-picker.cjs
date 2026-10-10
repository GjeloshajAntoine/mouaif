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
import { SubagentModelDefaults } from './frontend/src/components/SubagentModelDefaults.jsx';
import { SettingsAgentsView } from './frontend/src/components/SettingsAgents.jsx';
import { loadPinned } from './frontend/src/components/chat/modelPicker.js';
window.authPickerTest = { h, render, AuthModelPicker, SubagentModelDefaults, SettingsAgentsView, loadPinned };`,
resolveDir: root, sourcefile: 'auth-model-picker-test.js'
}, bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.css': 'empty' }
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
const pickProvider = async (provider) => {
await evaluate(`(() => {
const row = Array.from(document.querySelectorAll('.mp__row')).find(el => el.querySelector('.mp__row-meta')?.textContent === ${JSON.stringify(provider)});
if (!row) throw new Error('Missing provider row'); row.click();
})()`);
await wait();
};
const tap = async (selector) => {
await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing tap target'); el.click(); })()`);
await wait();
};
try {
await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
const css = ['base.css', 'chat-view.css', 'components/settings/agents.css'].map(f => fs.readFileSync(path.join(root, 'frontend/src', f), 'utf8')).join('\n');
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
if (url === '/api/settings/models/recent') {
recentFetch++;
return Promise.resolve(new Response(JSON.stringify({ recent: [{ provider: 'one', id: 'alpha', ts: Date.now() }] }), { status: 200 }));
}
return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
};
// The pin list is app-wide too: one key, no project namespace. A pin set while
// working in ANOTHER project still shows here, which is the point of sharing it.
localStorage.setItem('mouaif_models_pinned', JSON.stringify(['two\\u0000beta']));
window.models = [
{ id: 'alpha', provider: 'one', label: 'Alpha' },
{ id: 'beta', provider: 'two', label: 'Beta' }
];
const { h, render, AuthModelPicker } = authPickerTest;
window.selections = [];
render(h(AuthModelPicker, { models, projectDir: '/fixture/auth',
  initialValue: { providerId: 'one', modelId: 'alpha' }, chatValue: { providerId: 'two', modelId: 'beta' }, modelSource: 'agent',
  onChange: selection => selections.push(selection) }), document.getElementById('fixture'));`);
await check('effective default is discoverable and provider-qualified', `document.querySelector('.auth-model-picker').textContent.includes('Runs on one / alpha instead of two / beta (agent)')`);
await check('mounting never creates an override', 'selections.length === 0');
await evaluate(`document.querySelector('.auth-model-picker select').dispatchEvent(new Event('change', { bubbles: true }))`);
await wait();
await check('thinking-only edit does not override the default model', 'selections.at(-1).modelOverride === null');
await tap('.auth-model-picker .mp__trigger');
await wait();
await check('auth picker shows the Pinned section', `Array.from(document.querySelectorAll('.mp__section-title'), el => el.textContent).includes('Pinned')`);
await check('auth picker shows the Recent section', `Array.from(document.querySelectorAll('.mp__section-title'), el => el.textContent).includes('Recent')`);
// The card is mounted with projectDir '/fixture/auth', yet the pin seeded above
// was written under the shared key by "another project". It must still show.
await check('a pin set in another project is offered here', `(() => {
const sec = Array.from(document.querySelectorAll('.mp__section')).find(s => s.querySelector('.mp__section-title') && s.querySelector('.mp__section-title').textContent === 'Pinned');
return !!sec && sec.textContent.includes('beta');
})()`);
await check('recent fetch hit the shared app-wide endpoint', 'recentFetch >= 1');
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
await tap('.mp__clear');
await check('clearing keeps the default without an override', 'selections.at(-1).modelOverride === null');
await tap('.auth-model-picker .mp__trigger');
await pickProvider('two');
await check('explicit pick is a provider-qualified one-run override', `selections.at(-1).modelOverride.providerId === 'two' && selections.at(-1).modelOverride.modelId === 'beta'`);
await check('override summary updates', `document.querySelector('.auth-model-picker').textContent.includes('Runs on two / beta (this run only)')`);
await check('360px approval has no horizontal overflow', 'document.documentElement.scrollWidth <= 360');
await evaluate(`authPickerTest.render(null, document.getElementById('fixture'));
authPickerTest.render(authPickerTest.h(authPickerTest.AuthModelPicker, { models: [], initialValue: { providerId: 'gone', modelId: 'ghost' }, modelSource: 'agent' }), document.getElementById('fixture'));`);
await wait();
await check('empty catalog still displays the provider-qualified pin', `document.querySelector('.auth-model-picker').textContent.includes('Runs on gone / ghost')`);
await tap('.auth-model-picker .mp__trigger');
await tap('.mp__clear');
await evaluate(`authPickerTest.render(null, document.getElementById('fixture'));
authPickerTest.render(authPickerTest.h(authPickerTest.AuthModelPicker, { models: [], modelError: 'Unknown pinned model' }), document.getElementById('fixture'));`);
await wait();
await check('invalid default is explained before approval', `document.querySelector('.auth-model-picker').textContent.includes('Default unavailable: Unknown pinned model')`);
await evaluate(`authPickerTest.render(null, document.getElementById('fixture'));
window.writes = [];
window.catalogQueries = [];
window.failNext = false;
window.fetch = async (url, init = {}) => {
  if (init.method === 'PUT' || init.method === 'PATCH') {
    writes.push({ url, method: init.method, body: JSON.parse(init.body) });
    if (failNext) { failNext = false; return new Response('{}', { status: 500 }); }
    return new Response(JSON.stringify({ project: JSON.parse(init.body), chat: JSON.parse(init.body) }));
  }
  if (url.startsWith('/api/settings/resolved')) return new Response(JSON.stringify({ resolved: {} }));
  if (url.startsWith('/api/chats/')) return new Response(JSON.stringify({ chat: {} }));
  if (url === '/api/ai/models/providers') return new Response(JSON.stringify({ providers: [{ id: 'one' }, { id: 'two' }] }));
  if (url.startsWith('/api/ai/models/live')) { catalogQueries.push(url); return new Response(JSON.stringify({ models: [{ id: 'alpha' }] })); }
  return new Response(JSON.stringify({ models: [] }));
};
authPickerTest.render(authPickerTest.h(authPickerTest.SubagentModelDefaults, { projectDir: '/fixture/defaults', chatId: 'chat' }), document.getElementById('fixture'));`);
await wait();
await check('opening defaults never changes configuration', 'writes.length === 0');
await check('chat and project defaults have discoverable touch controls', `document.querySelectorAll('#fixture .mp__trigger').length === 2 && Array.from(document.querySelectorAll('#fixture .mp__trigger')).every(el => el.getBoundingClientRect().height >= 44 && el.getBoundingClientRect().width >= 44)`);
await check('catalog loads provider-qualified chat and image slices', `catalogQueries.length === 4 && catalogQueries.every(url => !url.includes('object'))`);
await tap('#fixture .mp__trigger');
await pickProvider('two');
await check('project choice uses the existing settings PUT', `writes.at(-1).method === 'PUT' && writes.at(-1).body.subagentProviderId === 'two' && writes.at(-1).body.subagentModelId === 'alpha' && !('patch' in writes.at(-1).body)`);
await evaluate(`document.querySelectorAll('#fixture .mp__trigger')[1].click()`);
await wait();
await pickProvider('one');
await check('chat choice uses the existing chat PATCH', `writes.at(-1).method === 'PATCH' && writes.at(-1).body.subagentProviderId === 'one'`);
await evaluate(`document.querySelectorAll('#fixture .mp__trigger')[1].click()`);
await wait();
await tap('.mp__clear');
await check('clearing chat follows project and clears both fields', `writes.at(-1).body.subagentModelId === '' && writes.at(-1).body.subagentProviderId === ''`);
await evaluate(`failNext = true; document.querySelectorAll('#fixture .mp__trigger')[1].click()`);
await wait();
await pickProvider('two');
await check('failed save stays unsaved and offers retry by picking again', `document.getElementById('fixture').textContent.includes('Not saved: HTTP 500') && document.querySelectorAll('#fixture .mp__trigger')[1].textContent.includes('Follow project default')`);
await check('360px defaults have no horizontal overflow', 'document.documentElement.scrollWidth <= 360');
if (process.env.TRACK_C_SCREENSHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(process.env.TRACK_C_SCREENSHOT, Buffer.from(shot.data, 'base64'));
}
await evaluate(`authPickerTest.render(null, document.getElementById('fixture'));
window.fetch = async url => new Response(JSON.stringify(url.startsWith('/api/agents/_default')
  ? { agent: { modelId: 'default-pin', providerId: 'two' } }
  : { agents: [{ name: 'Pinned', modelId: 'same-slug', providerId: 'one' }, { name: 'Unpinned' }] }));
authPickerTest.render(authPickerTest.h(authPickerTest.SettingsAgentsView, { projectDir: '/fixture/agents' }), document.getElementById('fixture'));`);
await wait();
await check('Agents list shows named and default provider-qualified pins', `document.getElementById('fixture').textContent.includes('Runs on: one / same-slug') && document.getElementById('fixture').textContent.includes('Runs on: two / default-pin')`);
await check('unpinned agent explicitly follows defaults, not defaultAgent pin', `document.getElementById('fixture').textContent.includes('Follows chat / project subagent defaults, then the chat model')`);
await check('360px Agents list has no horizontal overflow', 'document.documentElement.scrollWidth <= 360');
await check('unhandled errors', 'errors.length === 0');
console.log('\nAuth model picker browser regressions passed.');
} finally {
ws.close();
await fetch(endpoint + '/json/close/' + target.id);
}
}
main().catch(err => { console.error(err); process.exitCode = 1; });
