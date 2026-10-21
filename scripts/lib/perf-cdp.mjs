// A small, dependency-light Chrome DevTools Protocol client for the perf
// profiler (scripts/perf-profile.mjs).
//
// This is deliberately NOT the chrome-devtools MCP server: profiling needs
// raw protocol domains (Performance, HeapProfiler, Tracing, Network) that no
// page-driving wrapper exposes, and it needs them on a page it can reload
// itself. Everything here talks to one page target over its own WebSocket.
//
// The one behaviour worth knowing: `evaluate()` has a real deadline. A
// transcript that blocks the main thread (a long chat mid-paint, say) would
// otherwise hang the profiler instead of reporting the block — a timeout here
// IS a measurement ("this step took longer than the budget"), so it throws a
// PerfTimeout with the elapsed time rather than a bare error.
import WebSocket from 'ws';

export class PerfTimeout extends Error {
  constructor(method, ms) {
    super(method + ' exceeded ' + ms + 'ms');
    this.name = 'PerfTimeout';
    this.elapsedMs = ms;
  }
}

export async function connectPage(wsUrl, { defaultTimeoutMs = 60000 } = {}) {
  const socket = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();

  socket.on('message', (raw) => {
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    if (event.id != null) {
      const waiting = pending.get(event.id);
      if (!waiting) return;
      pending.delete(event.id);
      clearTimeout(waiting.timer);
      if (event.error) waiting.reject(new Error(event.error.message + ' (' + event.error.code + ')'));
      else waiting.resolve(event.result);
      return;
    }
    const handlers = listeners.get(event.method);
    if (handlers) for (const fn of handlers) fn(event.params || {});
  });

  socket.on('close', () => {
    for (const [, waiting] of pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('CDP socket closed during ' + waiting.method));
    }
    pending.clear();
  });

  function send(method, params = {}, { timeoutMs = defaultTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new PerfTimeout(method, timeoutMs));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  function on(method, fn) {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(fn);
    return () => listeners.get(method).delete(fn);
  }

  // evaluate(expression, options) — run an expression in the page and return
  // its JSON value. `awaitPromise` is on so benchmarks can await their own
  // settles (fonts, two frames) instead of the caller guessing a sleep.
  async function evaluate(expression, { timeoutMs = defaultTimeoutMs } = {}) {
    const out = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      allowUnsafeEvalBlockedByCSP: false,
      userGesture: true
    }, { timeoutMs });
    if (out.exceptionDetails) {
      const d = out.exceptionDetails;
      const message = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'evaluate failed';
      throw new Error(String(message).split('\n')[0]);
    }
    return out.result ? out.result.value : undefined;
  }

  async function close() {
    try { socket.close(); } catch { /* already gone */ }
  }

  return { send, on, evaluate, close, socket };
}

// listPageTargets(port) — the debug browser's page targets, with their ids.
export async function listPageTargets(port = 9222) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/list');
  const all = await res.json();
  return all.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

// findAppPage(port, baseUrl) — the already-open tab pointing at the app, so a
// profile run reuses the session (cookie, service worker) instead of needing
// a fresh sign-in.
export async function findAppPage(port, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const pages = await listPageTargets(port);
  const mine = pages.filter((p) => p.url.startsWith(origin));
  // Prefer a tab with no synthetic `perf=` marker: the profiler appends one to
  // force a real document load, and a leftover from an interrupted run would
  // otherwise be mistaken for the app's own URL.
  return mine.find((p) => !/[?&]perf=/.test(p.url)) || mine[0] || null;
}
