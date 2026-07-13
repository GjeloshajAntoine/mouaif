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
