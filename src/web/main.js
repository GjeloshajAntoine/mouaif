// mouaif web entry — virtual list demo.
// Wires the primitive in src/virtual-list.js to the demo scroller in index.html.

import { createVirtualList } from '/web/virtual-list.js';

const scroller = document.getElementById('scroller');
const stats = document.getElementById('stats');

// 10 000 rows, fixed height 44 px. The point is that DOM count stays tiny.
const TOTAL = 10_000;
const data = new Array(TOTAL);
for (let i = 0; i < TOTAL; i++) {
  data[i] = {
    id: i,
    label: 'Row ' + i.toString().padStart(5, '0') + '  —  Lorem ipsum dolor sit amet'
  };
}

let frameCount = 0;
let lastSecond = performance.now();
let fps = 0;

function render(item, node) {
  if (!node._built) {
    const idx = document.createElement('span');
    idx.className = 'row__index';
    const lbl = document.createElement('span');
    lbl.className = 'row__label';
    node.appendChild(idx);
    node.appendChild(lbl);
    node._built = true;
    node._idx = idx;
    node._lbl = lbl;
  }
  node._idx.textContent = '#' + item.id;
  node._lbl.textContent = item.label;
}

const list = createVirtualList({
  scroller,
  itemHeight: 44,
  overscan: 4,
  render,
  data
});

function tick(now) {
  frameCount++;
  if (now - lastSecond >= 1000) {
    fps = frameCount;
    frameCount = 0;
    lastSecond = now;
    const r = list._range();
    stats.textContent =
      'rows: ' + TOTAL.toLocaleString() +
      '  •  range: ' + (r ? r.start + '–' + r.end : '–') +
      '  •  fps: ' + fps;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Expose for ad-hoc poking from devtools.
window.mouaifList = list;

// ---- AI test panel -----------------------------------------------------
// Sends one chat completion through /api/ai/chat. Reads the SSE stream
// line by line and appends deltas to the output box. No libraries —
// EventSource would also work, but fetch+ReadableStream is enough and
// keeps the page dependency-free.

const $modelId = document.getElementById('modelId');
const $prompt = document.getElementById('prompt');
const $send = document.getElementById('send');
const $status = document.getElementById('chatStatus');
const $out = document.getElementById('chatOut');

$send.addEventListener('click', sendChat);
$prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendChat();
});

async function sendChat() {
  const modelId = ($modelId.value || '').trim();
  const prompt = ($prompt.value || '').trim();
  if (!modelId) { $status.textContent = 'modelId is required'; return; }
  if (!prompt) { $status.textContent = 'prompt is required'; return; }

  $send.disabled = true;
  $out.textContent = '';
  $status.textContent = 'streaming...';

  let resp;
  try {
    resp = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, messages: [{ role: 'user', content: prompt }] })
    });
  } catch (e) {
    $status.textContent = 'network error';
    $send.disabled = false;
    return;
  }

  if (!resp.ok) {
    const text = await resp.text();
    $status.textContent = 'HTTP ' + resp.status;
    $out.textContent = text;
    $send.disabled = false;
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let assembled = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseSSEFrame(frame);
      if (!ev) continue;
      let data; try { data = JSON.parse(ev.data); } catch { continue; }
      if (ev.eventName === 'message' && typeof data.delta === 'string') {
        assembled += data.delta;
        $out.textContent = assembled;
      } else if (ev.eventName === 'done') {
        const u = data.usage || {};
        $status.textContent = 'done — ' + (u.promptTokens || 0) + ' in, ' + (u.completionTokens || 0) + ' out';
      } else if (ev.eventName === 'error') {
        $status.textContent = 'error: ' + (data.code || 'EUPSTREAM') + ' ' + (data.message || '');
        $out.textContent = (assembled || '') + '\n[error] ' + (data.message || '');
      }
    }
  }

  $send.disabled = false;
  if ($status.textContent === 'streaming...') $status.textContent = 'done';
}

function parseSSEFrame(frame) {
  let eventName = 'message';
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (!line) continue;
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (!dataLines.length) return null;
  return { eventName, data: dataLines.join('\n') };
}

// ---- Auth panel --------------------------------------------------------
// Fetches the account index from the server and exposes the per-provider
// sign-in flow. Each provider gets its own button + the no-browser
// fallback (paste the `code` from the redirected URL) for headless
// environments.

const $authOut = document.getElementById('authOut');
async function refreshAuth() {
  try {
    const r = await fetch('/api/auth/accounts');
    if (!r.ok) { $authOut.textContent = 'HTTP ' + r.status; return; }
    const data = await r.json();
    const accounts = data.accounts || {};
    const lines = [];
    for (const p of Object.keys(accounts)) {
      const list = accounts[p];
      lines.push((list && list.length ? list.join(', ') : '(none)') + '  — ' + p);
    }
    $authOut.textContent = lines.length ? lines.join('\n') : 'no providers';
  } catch (e) {
    $authOut.textContent = 'network error';
  }
}
refreshAuth();
setInterval(refreshAuth, 5000);

// Sign in with Anthropic.
const $signInAnthropic = document.getElementById('signInAnthropic');
const $signInStatus = document.getElementById('signInStatus');
const $signInHelp = document.getElementById('signInHelp');
const $signInCallback = document.getElementById('signInCallback');
const $codeInput = document.getElementById('codeInput');
const $completeCode = document.getElementById('completeCode');

let pendingState = null;
let pendingRedirect = null;

$signInAnthropic.addEventListener('click', async () => {
  $signInAnthropic.disabled = true;
  $signInStatus.textContent = 'starting sign-in…';
  try {
    const r = await fetch('/api/auth/sign-in/anthropic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) {
      $signInStatus.textContent = 'HTTP ' + r.status;
      $signInAnthropic.disabled = false;
      return;
    }
    const data = await r.json();
    pendingState = data.state;
    pendingRedirect = data.authorizeUrl;
    // Open the authorize URL in a new tab; the user signs in there and
    // the browser comes back to /oauth/callback on the mouaif server,
    // which finishes the flow. Poll /api/auth/accounts for the new
    // account to appear.
    window.open(pendingRedirect, '_blank', 'noopener');
    $signInCallback.textContent = window.location.origin + '/oauth/callback';
    $signInHelp.hidden = false;
    $signInStatus.textContent = 'waiting for browser…';
    // Poll the account list; the loopback callback updates it.
    const before = new Set(((await (await fetch('/api/auth/accounts')).json()).accounts || {}).anthropic || []);
    const started = Date.now();
    while (Date.now() - started < 5 * 60 * 1000) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const accounts = ((await (await fetch('/api/auth/accounts')).json()).accounts || {}).anthropic || [];
        const fresh = accounts.filter(a => !before.has(a));
        if (fresh.length) {
          $signInStatus.textContent = 'signed in as ' + fresh[0];
          $signInAnthropic.disabled = false;
          return;
        }
      } catch {}
    }
    $signInStatus.textContent = 'timed out. Paste the code from the redirect URL below if your browser could not reach this host.';
    $signInAnthropic.disabled = false;
  } catch (e) {
    $signInStatus.textContent = 'network error';
    $signInAnthropic.disabled = false;
  }
});

// No-browser fallback: paste the `code` from the redirected URL.
$completeCode.addEventListener('click', async () => {
  const raw = ($codeInput.value || '').trim();
  if (!pendingState || !pendingRedirect) {
    $signInStatus.textContent = 'click "Sign in with Anthropic" first';
    return;
  }
  // Accept either a bare `code`, or the full redirect URL.
  let code = raw;
  try {
    const u = new URL(raw);
    const c = u.searchParams.get('code');
    if (c) code = c;
  } catch { /* not a URL, treat as a bare code */ }
  if (!code) {
    $signInStatus.textContent = 'paste the code from the redirect URL';
    return;
  }
  $completeCode.disabled = true;
  $signInStatus.textContent = 'exchanging…';
  try {
    const r = await fetch('/oauth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', state: pendingState, code })
    });
    const data = await r.json();
    if (r.ok && data.ok) {
      $signInStatus.textContent = 'signed in as ' + data.account;
    } else {
      $signInStatus.textContent = 'failed: ' + (data.error || ('HTTP ' + r.status));
    }
  } catch (e) {
    $signInStatus.textContent = 'network error';
  }
  $completeCode.disabled = false;
});

// ---- Settings panel ----------------------------------------------------
// Reads /api/settings, lets the user edit the app-level settings
// (prompt size, trace default) and the models list, and load a
// project's settings on demand. No state, no caching — every action
// hits the server, so the page is always truthful.

const $promptSize = document.getElementById('promptSize');
const $traceByDefault = document.getElementById('traceByDefault');
const $saveApp = document.getElementById('saveApp');
const $resetApp = document.getElementById('resetApp');
const $appStatus = document.getElementById('appStatus');
const $modelsList = document.getElementById('modelsList');
const $mId = document.getElementById('mId');
const $mProvider = document.getElementById('mProvider');
const $mLabel = document.getElementById('mLabel');
const $mBaseUrl = document.getElementById('mBaseUrl');
const $mApiKey = document.getElementById('mApiKey');
const $addModel = document.getElementById('addModel');
const $addModelStatus = document.getElementById('addModelStatus');
const $projectDir = document.getElementById('projectDir');
const $loadProject = document.getElementById('loadProject');
const $projectStatus = document.getElementById('projectStatus');
const $projectOut = document.getElementById('projectOut');

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body; try { body = JSON.parse(text || '{}'); } catch { body = text; }
  return { status: r.status, body };
}

function setStatus(node, msg) { if (node) node.textContent = msg; }

let currentApp = {};

async function loadSettings() {
  const r = await fetchJson('/api/settings');
  if (r.status !== 200) { setStatus($appStatus, 'HTTP ' + r.status); return; }
  currentApp = r.body.app || {};
  // Defaults: settings.DEFAULTS has promptSize='average' and traceByDefault=false.
  $promptSize.value = currentApp.promptSize || 'average';
  $traceByDefault.checked = !!currentApp.traceByDefault;
  renderModels(currentApp.models || []);
  setStatus($appStatus, '');
}

function renderModels(list) {
  $modelsList.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No models configured. Add one below.';
    empty.style.color = 'var(--muted)';
    $modelsList.appendChild(empty);
    return;
  }
  for (const m of list) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'models__row';
    const idSpan = document.createElement('span');
    idSpan.className = 'models__id';
    idSpan.textContent = m.id + '  (' + m.provider + ')';
    const del = document.createElement('button');
    del.className = 'models__delete';
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', () => deleteModel(m.id));
    row.appendChild(idSpan);
    row.appendChild(del);
    const meta = document.createElement('div');
    meta.className = 'models__meta';
    meta.textContent = [m.label, m.baseUrl, m.apiKey ? 'key: •••' : null, m.auth && m.auth !== 'apikey' ? 'auth: ' + m.auth : null].filter(Boolean).join('  ·  ');
    li.appendChild(row);
    li.appendChild(meta);
    $modelsList.appendChild(li);
  }
}

$saveApp.addEventListener('click', async () => {
  $saveApp.disabled = true;
  setStatus($appStatus, 'saving…');
  const r = await fetchJson('/api/settings/app', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promptSize: $promptSize.value, traceByDefault: !!$traceByDefault.checked })
  });
  $saveApp.disabled = false;
  if (r.status === 200) { currentApp = r.body.app || currentApp; setStatus($appStatus, 'saved.'); }
  else setStatus($appStatus, 'HTTP ' + r.status);
});

$resetApp.addEventListener('click', async () => {
  if (!confirm('Reset all app-level settings to defaults? Models and other keys will be cleared.')) return;
  $resetApp.disabled = true;
  setStatus($appStatus, 'resetting…');
  const r = await fetchJson('/api/settings/app/reset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: ['models', 'promptSize', 'traceByDefault', 'authAccounts', 'projects', 'flags'] })
  });
  $resetApp.disabled = false;
  if (r.status === 200) { currentApp = r.body.app || {}; await loadSettings(); setStatus($appStatus, 'reset.'); }
  else setStatus($appStatus, 'HTTP ' + r.status);
});

$addModel.addEventListener('click', async () => {
  const id = ($mId.value || '').trim();
  const provider = $mProvider.value;
  const label = ($mLabel.value || '').trim() || id;
  const baseUrl = ($mBaseUrl.value || '').trim();
  const apiKey = ($mApiKey.value || '').trim();
  if (!id) { setStatus($addModelStatus, 'id is required'); return; }
  $addModel.disabled = true;
  setStatus($addModelStatus, 'adding…');
  const body = { id, provider, label };
  if (baseUrl) body.baseUrl = baseUrl;
  if (apiKey) body.apiKey = apiKey;
  const r = await fetchJson('/api/settings/app/models', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  $addModel.disabled = false;
  if (r.status === 200) {
    currentApp.models = r.body.models;
    renderModels(r.body.models);
    setStatus($addModelStatus, 'added ' + id + '.');
    $mId.value = ''; $mLabel.value = ''; $mBaseUrl.value = ''; $mApiKey.value = '';
  } else {
    setStatus($addModelStatus, 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''));
  }
});

async function deleteModel(id) {
  if (!confirm('Delete model ' + id + '?')) return;
  const r = await fetchJson('/api/settings/app/models/' + encodeURIComponent(id), { method: 'DELETE' });
  if (r.status === 200) {
    currentApp.models = r.body.models;
    renderModels(r.body.models);
  } else {
    alert('delete failed: HTTP ' + r.status);
  }
}

$loadProject.addEventListener('click', async () => {
  const dir = ($projectDir.value || '').trim();
  if (!dir) { setStatus($projectStatus, 'projectDir is required'); return; }
  $loadProject.disabled = true;
  setStatus($projectStatus, 'loading…');
  const r = await fetchJson('/api/settings/project?projectDir=' + encodeURIComponent(dir));
  $loadProject.disabled = false;
  if (r.status === 200) {
    setStatus($projectStatus, 'path: ' + r.body.path);
    $projectOut.hidden = false;
    $projectOut.textContent = JSON.stringify(r.body.project, null, 2);
  } else {
    setStatus($projectStatus, 'HTTP ' + r.status);
    $projectOut.hidden = true;
  }
});

loadSettings();
setInterval(loadSettings, 30000);
