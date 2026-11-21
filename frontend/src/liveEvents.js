// mouaif web — the app event stream (docs/features/live-events.md)
//
// One EventSource per tab on `GET /events` (and one per shared project in use,
// through `/s/<share>/events`). The server sends small notices — "this chat's
// rows changed", "a run started", "an approval was parked", "this project's
// hooks changed" — never the data itself. A view subscribes with the project
// it shows and refetches what changed with the endpoints it already uses.
//
// Recovery has no timer of its own:
//  - every (re)connect calls each subscriber's `onResync`, so a notice missed
//    while the stream was down is picked up by one catch-up fetch;
//  - the stream is closed while the tab is hidden (a hidden tab must not hold
//    one of the browser's few connections per host) and reopened, with a
//    resync, when it is shown again;
//  - when the stream cannot be opened at all (a proxy that buffers or blocks
//    `text/event-stream`), `liveEventsDown` turns true and views fall back to
//    a slow poll while it stays down.
import { signal } from '@preact/signals';
import { shareIdFor, whenSharesReady } from './api.js';

export const LIVE_EVENTS = ['chat_rows', 'chat_cost', 'chat_run', 'auth_pending', 'project_changed', 'app_changed'];

// Errors in a row, without an open in between, before the page says live
// updates are unavailable.
const DOWN_AFTER = 3;
// Retry delay once the browser gave up on a stream (it stopped reconnecting
// by itself: an HTTP error, or the server refused the stream).
const RETRY_MS = [2000, 5000, 15000, 30000];

// True while the local event stream cannot be opened. Views use it to start
// their fallback poll and the chat shows "live updates unavailable".
export const liveEventsDown = signal(false);

const streams = new Map();

function streamUrl(projectDir) {
  const id = projectDir ? shareIdFor(projectDir) : '';
  return id ? '/s/' + id + '/events?projectDir=' + encodeURIComponent(projectDir) : '/events';
}

function pageHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function dispatch(stream, name, event) {
  let data;
  try { data = JSON.parse(event.data); } catch { return; }
  if (!data || typeof data !== 'object') return;
  for (const sub of Array.from(stream.subs)) {
    if (name !== 'app_changed' && sub.projectDir && data.projectDir !== sub.projectDir) continue;
    try { sub.onEvent(name, data); } catch (e) { console.error('[mouaif] live event handler failed', e); }
  }
}

function setDown(stream, down) {
  if (stream.down === down) return;
  stream.down = down;
  if (stream.url === '/events') liveEventsDown.value = down;
  for (const sub of Array.from(stream.subs)) {
    if (typeof sub.onDown === 'function') {
      try { sub.onDown(down); } catch (e) { console.error('[mouaif] live event handler failed', e); }
    }
  }
}

function connect(stream) {
  if (stream.source || stream.retry || pageHidden() || typeof EventSource === 'undefined') return;
  const source = new EventSource(stream.url);
  stream.source = source;
  source.addEventListener('open', () => {
    if (stream.source !== source) return;
    stream.errors = 0;
    setDown(stream, false);
    // Whatever changed while there was no stream is fetched once now.
    for (const sub of Array.from(stream.subs)) {
      if (typeof sub.onResync === 'function') {
        try { sub.onResync(); } catch (e) { console.error('[mouaif] live event resync failed', e); }
      }
    }
  });
  source.addEventListener('error', () => {
    if (stream.source !== source) return;
    stream.errors += 1;
    if (stream.errors >= DOWN_AFTER) setDown(stream, true);
    // CONNECTING: the browser retries by itself. CLOSED: it gave up, so retry
    // here with a growing delay.
    if (source.readyState === 2) {
      stream.source = null;
      const delay = RETRY_MS[Math.min(stream.errors - 1, RETRY_MS.length - 1)];
      stream.retry = setTimeout(() => { stream.retry = null; connect(stream); }, delay);
    }
  });
  for (const name of LIVE_EVENTS) source.addEventListener(name, (e) => { if (stream.source === source) dispatch(stream, name, e); });
}

function disconnect(stream) {
  if (stream.retry) { clearTimeout(stream.retry); stream.retry = null; }
  if (stream.source) {
    try { stream.source.close(); } catch { /* already closed */ }
    stream.source = null;
  }
}

let visibilityBound = false;
function bindVisibility() {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    for (const stream of streams.values()) {
      if (pageHidden()) disconnect(stream);
      else { stream.errors = 0; connect(stream); }
    }
  });
  // The network came back: a stream the browser gave up on is retried now
  // instead of after its backoff.
  window.addEventListener('online', () => {
    for (const stream of streams.values()) {
      if (stream.retry) { clearTimeout(stream.retry); stream.retry = null; }
      connect(stream);
    }
  });
}

// subscribeLiveEvents({ projectDir, onEvent, onResync, onDown }) -> unsubscribe
//
// `projectDir` scopes the notices (app_changed always passes); empty means
// every project's notices on this mouaif. `onEvent(name, data)` gets each
// notice, `onResync()` runs after every (re)connect, and `onDown(down)` when
// the stream becomes unavailable or comes back. Returns the cleanup for an
// effect.
export function subscribeLiveEvents(options) {
  // A shared project's stream goes through its share, which is only known
  // once the share list is in.
  let detach = null;
  let closed = false;
  whenSharesReady().then(() => { if (!closed) detach = attach(options || {}); });
  return () => {
    closed = true;
    if (detach) detach();
  };
}

function attach({ projectDir = '', onEvent, onResync, onDown }) {
  bindVisibility();
  const url = streamUrl(projectDir);
  let stream = streams.get(url);
  if (!stream) {
    stream = { url, subs: new Set(), source: null, retry: null, errors: 0, down: false };
    streams.set(url, stream);
  }
  const sub = { projectDir, onEvent: onEvent || (() => {}), onResync, onDown };
  stream.subs.add(sub);
  connect(stream);
  if (stream.down && typeof onDown === 'function') onDown(true);
  return () => {
    stream.subs.delete(sub);
    if (stream.subs.size) return;
    disconnect(stream);
    streams.delete(url);
    if (url === '/events') liveEventsDown.value = false;
  };
}

// isLiveEventsDown(projectDir) — whether the stream serving this project is
// currently unavailable.
export function isLiveEventsDown(projectDir) {
  const stream = streams.get(streamUrl(projectDir || ''));
  return !!(stream && stream.down);
}

// subscribeChanges({ projectDir, project, app, runEnd, chatId, onChange }) -> unsubscribe
//
// For views that just refetch when something they show may have changed.
// `onChange()` runs for:
//  - a `project_changed` notice whose `what` is in `project` (and, when
//    `chatId` is given and the notice names a chat, for that chat);
//  - an `app_changed` notice whose `what` is in `app`;
//  - with `runEnd`, a turn ending in the project (`chat_run` running:false):
//    the model may have edited the files the view reads;
//  - every (re)connect, including the tab being shown again.
export function subscribeChanges({ projectDir = '', project = [], app = [], runEnd = false, chatId = '', onChange }) {
  return subscribeLiveEvents({
    projectDir,
    onEvent(name, data) {
      if (name === 'project_changed') {
        if (!project.includes(data.what)) return;
        if (chatId && data.chatId && data.chatId !== chatId) return;
      } else if (name === 'app_changed') {
        if (!app.includes(data.what)) return;
      } else if (name === 'chat_run') {
        if (!runEnd || data.running) return;
      } else return;
      onChange(data);
    },
    onResync: () => onChange(null)
  });
}
