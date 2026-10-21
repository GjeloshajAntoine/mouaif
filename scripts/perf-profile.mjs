// scripts/perf-profile.mjs
//
// A complete performance + memory profile of the mouaif web app, recorded
// against the running app in the debug Chrome (docs/features/performance-memory-profile.md).
//
// What it measures, in one run:
//
//   1. App shell        — cold load (FCP/DCL/LCP, transfer, JS heap after load),
//                         then the Chats tab and the Inspector tab.
//   2. Long chats       — for each transcript in the ladder (seeded synthetic
//                         chats of 30 / 500 / 2,000 / 10,000 rows, plus this
//                         project's own longest real chats): open cost
//                         (navigation → first row → last row), the render burst,
//                         the DOM node count and heap it leaves behind,
//                         long tasks, scrolling through the whole transcript,
//                         and a V8 heap snapshot with the biggest retained
//                         classes.
//   3. Stored history   — the project's real chat list and the paginated
//                         history of its longest chat.
//
// Every step is also recorded as a CDP trace and read back, so the report
// carries real Long Task / layout / script durations instead of only the
// timings this script took around them.
//
// Usage:
//
//   node scripts/perf-profile.mjs                      # full run against :8080
//   node scripts/perf-profile.mjs --base http://127.0.0.1:8080
//   node scripts/perf-profile.mjs --profiles medium,long
//   node scripts/perf-profile.mjs --real 2 --no-synthetic
//   node scripts/perf-profile.mjs --keep               # keep seeded chats after the run
//   node scripts/perf-profile.mjs --report <path.json> # replace an existing report
//   node scripts/perf-profile.mjs --cleanup-only <manifest.json>
//
// Exit codes: 0 ok, 1 the run failed, 2 usage error. The seeded chats are
// removed again in a finally block (getChat → deleteChat) unless --keep is
// given, so a crashed run is cleaned up by the next one (see removeStrays).
//
// This script never restarts, stops or starts the app: it attaches to the tab
// that is already signed in, and it only writes through the app's own chat
// store (seeded fixture chats, removed afterwards).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPage, findAppPage, listPageTargets, PerfTimeout } from './lib/perf-cdp.mjs';
import { withSession } from './lib/perf-session.mjs';
import {
  PROFILES, FIXTURE_TITLE_PREFIX, seedChats, removeSeeded, removeStrays,
  longestRealChats, projectStoreSize
} from './lib/perf-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPORT = path.join(ROOT, 'perf', 'latest.json');
const WIDTH = 430;
const HEIGHT = 932;

// ---- args -----------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    base: 'http://127.0.0.1:8080',
    port: 9222,
    projectDir: ROOT,
    profiles: ['tiny', 'medium', 'long', 'huge'],
    real: 3,
    synthetic: true,
    keep: false,
    report: DEFAULT_REPORT,
    cleanupOnly: '',
    timeout: 180000,
    scrollSteps: 6,
    snapshotLimit: 3,
    fullHistory: true,
    maxPages: 200,
    drainDeadlineMs: 90000
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null) throw new Error(arg + ' needs a value');
      return v;
    };
    if (arg === '--base') out.base = next().replace(/\/$/, '');
    else if (arg === '--port') out.port = Number(next());
    else if (arg === '--project') out.projectDir = path.resolve(next());
    else if (arg === '--profiles') out.profiles = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--real') out.real = Number(next());
    else if (arg === '--no-synthetic') out.synthetic = false;
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--report') out.report = path.resolve(next());
    else if (arg === '--cleanup-only') out.cleanupOnly = path.resolve(next());
    else if (arg === '--timeout') out.timeout = Number(next());
    else if (arg === '--scroll-steps') out.scrollSteps = Math.max(2, Number(next()));
    else if (arg === '--snapshots') out.snapshotLimit = Math.max(0, Number(next()));
    else if (arg === '--no-full-history') out.fullHistory = false;
    else if (arg === '--max-pages') out.maxPages = Math.max(1, Number(next()));
    else if (arg === '--drain-deadline') out.drainDeadlineMs = Math.max(10000, Number(next()));
    else if (arg === '--quick') { out.profiles = ['medium', 'long']; out.real = 1; out.snapshotLimit = 1; }
    else if (arg === '--help' || arg === '-h') { out.help = true; }
    else throw new Error('unknown argument: ' + arg);
  }
  for (const p of out.profiles) {
    if (!PROFILES[p]) throw new Error('unknown profile "' + p + '" (have: ' + Object.keys(PROFILES).join(', ') + ')');
  }
  return out;
}

const HELP = `Record a performance and memory profile of the running mouaif app.

  node scripts/perf-profile.mjs [options]

  --base <url>        app URL (default http://127.0.0.1:8080)
  --port <n>          Chrome debug port (default 9222)
  --project <dir>     project to profile (default: this repository)
  --profiles <list>   synthetic transcript sizes (default tiny,medium,long,huge)
  --real <n>          also profile the n longest real chats (default 3)
  --no-synthetic      skip the seeded fixture chats
  --scroll-steps <n>  scroll samples per transcript (default 6)
  --snapshots <n>     V8 heap snapshots to take, largest chats first (default 3)
  --no-full-history   skip draining pagination to measure the whole transcript
  --max-pages <n>     page-prepend cap for the full-history pass (default 200)
  --drain-deadline <ms> time budget for that pass (default 90000)
  --quick             medium+long synthetic chats, one real chat, one snapshot
  --timeout <ms>      per-step deadline (default 180000)
  --report <path>     where to write the JSON report (default perf/latest.json)
  --keep              keep the seeded chats afterwards
  --cleanup-only <m>  delete the chats a previous manifest lists, then exit
`;

// ---- helpers --------------------------------------------------------------

const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  process.stdout.write(msg + '\n');
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round(sorted[i]);
}

function round(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function summarize(numbers) {
  const list = (numbers || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!list.length) return { count: 0, min: null, median: null, p90: null, p99: null, max: null, total: null };
  return {
    count: list.length,
    min: round(list[0]),
    median: round(list[Math.floor(list.length / 2)]),
    p90: pct(list, 90),
    p99: pct(list, 99),
    max: round(list[list.length - 1]),
    total: round(list.reduce((a, b) => a + b, 0))
  };
}

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return round(n / 1024, 1) + ' KB';
  return round(n / (1024 * 1024), 2) + ' MB';
}

function fmtMs(n) {
  if (n == null) return '—';
  if (n < 1000) return round(n, 0) + ' ms';
  return round(n / 1000, 2) + ' s';
}

// ---- in-page instrumentation ---------------------------------------------
//
// Installed after every navigation, before the app's first script runs
// (Page.addScriptToEvaluateOnNewDocument). It answers one question the
// profiler cannot answer from outside: how long after navigation the
// transcript became usable (first row), was complete (last row), and when the
// main thread stopped being blocked.
const PAGE_INSTRUMENT = `(() => {
  if (window.__perf) return;
  const perf = {
    navStart: performance.now(),
    firstRowAt: null,
    lastRowAt: null,
    rowsSeen: 0,
    longTasks: [],
    marks: []
  };
  window.__perf = perf;
  const countRows = () => {
    const t = document.querySelector('.chat-view__transcript');
    return t ? t.querySelectorAll('.chat-msg, .tool-card').length : 0;
  };
  const finish = () => {
    if (perf.lastRowAt != null) return;
    const rows = countRows();
    perf.rowsSeen = Math.max(perf.rowsSeen, rows);
    const t = document.querySelector('.chat-view__transcript');
    // Complete = the backfill has retired and the DOM has stopped growing for
    // a settle window. The backfill inserts rows above its anchor in 40-row
    // chunks, so a snapshot taken too early under-counts badly.
    if (perf._last === rows && rows > 0) {
      perf._stable = (perf._stable || 0) + 1;
      if (perf._stable >= 3) perf.lastRowAt = performance.now();
    } else {
      perf._stable = 0;
      perf._last = rows;
    }
    if (perf.lastRowAt == null) setTimeout(finish, 40);
  };
  const observe = () => {
    if (!document.querySelector('.chat-view__transcript')) { setTimeout(observe, 25); return; }
    if (perf.firstRowAt == null) {
      const rows = countRows();
      if (rows > 0) perf.firstRowAt = performance.now();
      else { setTimeout(observe, 25); return; }
    }
    finish();
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) perf.longTasks.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { /* not supported */ }
  setTimeout(observe, 0);
})();`;

// heapMeasure() — synchronous heap + DOM census, evaluated in the page.
const HEAP_MEASURE = `(() => {
  const m = performance.memory;
  const t = document.querySelector('.chat-view__transcript');
  const all = document.querySelectorAll('*');
  const transcriptNodes = t ? t.querySelectorAll('*') : [];
  const rows = t ? t.querySelectorAll('.chat-msg') : [];
  const cards = t ? t.querySelectorAll('.tool-card') : [];
  return {
    jsHeapUsed: m ? m.usedJSHeapSize : null,
    jsHeapTotal: m ? m.totalJSHeapSize : null,
    jsHeapLimit: m ? m.jsHeapSizeLimit : null,
    domNodes: all.length,
    transcriptNodes: transcriptNodes.length,
    rows: rows.length,
    toolCards: cards.length,
    scrollHeight: t ? t.scrollHeight : null,
    detached: null,
    tasks: null,
    url: location.hash
  };
})()`;

// settleFrames() — wait for two animation frames plus the transcript to stop
// growing, so a measurement lands after the paint it describes.
// Frames are awaited through a fallback timer as well as rAF: the debug Chrome
// may hold the app tab in the background (this script runs headless against a
// tab it did not open), and a background tab never fires rAF — waiting on it
// alone hangs the whole run. Page.bringToFront is attempted too, but the
// fallback is what keeps the profile correct either way.
const FRAME = `(() => new Promise((resolve) => {
  let done = false;
  const finish = (how) => { if (!done) { done = true; resolve(how); } };
  requestAnimationFrame(() => finish('raf'));
  setTimeout(() => finish('timer'), 32);
}))()`;

const SETTLE = `(() => new Promise((resolve) => {
  const t0 = performance.now();
  let stable = 0, last = -1;
  const step = () => {
    const t = document.querySelector('.chat-view__transcript');
    const n = t ? t.querySelectorAll('.chat-msg, .tool-card').length : 0;
    if (n === last && n > 0) stable++; else { stable = 0; last = n; }
    if (stable >= 2 || performance.now() - t0 > 20000) resolve({ rows: n, ms: performance.now() - t0 });
    else {
      let stepped = false;
      const again = () => { if (!stepped) { stepped = true; step(); } };
      requestAnimationFrame(again);
      setTimeout(again, 32);
    }
  };
  step();
}))()`;

// scrollHarness() — scroll the transcript in `steps` jumps and sample the
// per-step main-thread cost. Each sample is taken from a rAF callback, so it
// measures what the user feels: frame-to-frame time while scrolling.
const SCROLL = `((steps) => new Promise((resolve) => {
  const t = document.querySelector('.chat-view__transcript');
  if (!t) { resolve({ error: 'no transcript' }); return; }
  const max = Math.max(0, t.scrollHeight - t.clientHeight);
  const targets = [];
  for (let i = steps; i >= 0; i--) targets.push(Math.round((max * i) / steps));
  const samples = [];
  let i = 0;
  let last = performance.now();
  const step = () => {
    const start = last;
    t.scrollTop = targets[i];
    // Force the layout the scroll caused, inside the measurement: scrollHeight
    // is the point where the browser has to lay the new window out.
    const h = t.scrollHeight;
    const frameMs = performance.now() - start;
    const to = targets[i];
    let next = false;
    const advance = () => {
      if (next) return;
      next = true;
      samples.push({ to, ms: performance.now() - start, frameMs, height: h });
      last = performance.now();
      i++;
      if (i < targets.length) step(); else resolve({ samples, max });
    };
    requestAnimationFrame(advance);
    setTimeout(advance, 32);
  };
  step();
}))`;

// SCROLL_ALL — drag the transcript back to its top repeatedly until the
// backward pagination drains (PAGE_SIZE 100 rows per page, NEAR_TOP_PX 48),
// sampling the cost of every page-prepend.
//
// This is the long-chat case the product is built around: a chat opens with
// only its newest page, so the interesting question is not "how big is the DOM
// after the first page" but "what does holding the whole history cost". Each
// iteration scrolls to the top in two jumps (the second one after the loader
// had a frame to fire) and waits for the row count to stop growing.
const SCROLL_ALL = `(({ maxPages, deadlineMs }) => new Promise((resolve) => {
  const t = document.querySelector('.chat-view__transcript');
  if (!t) { resolve({ error: 'no transcript' }); return; }
  const count = () => t.querySelectorAll('.chat-msg, .tool-card').length;
  const samples = [];
  const t0 = performance.now();
  let pages = 0;
  let lastRows = count();
  const idle = () => new Promise((r) => {
    const go = () => r();
    requestAnimationFrame(go);
    setTimeout(go, 32);
  });
  const step = async () => {
    if (pages >= maxPages || performance.now() - t0 > deadlineMs) {
      resolve({ samples, pages, rows: count(), deadlineHit: performance.now() - t0 > deadlineMs, ms: performance.now() - t0 });
      return;
    }
    const before = count();
    const start = performance.now();
    t.scrollTop = 0;
    await idle();
    t.scrollTop = 0;
    await idle();
    // Wait for the prepend: rows only arrive after the page fetch resolves, so
    // the wait is "until the row count moves, or nothing moves for 12 s".
    // One page-prepend takes roughly 0.3-1.7 s on this machine, so a fixed
    // short poll would declare "history exhausted" mid-transcript and
    // under-report both the rows and the heap holding them costs.
    let waited = 0;
    while (waited < 12000) {
      if (count() !== before) {
        // Rows arrived; give the chunked insert a moment to finish this page.
        const seen = count();
        for (let i = 0; i < 20 && count() === seen; i++) await idle();
        break;
      }
      await idle();
      waited += 32;
    }
    const rows = count();
    samples.push({
      page: pages + 1,
      ms: performance.now() - start,
      rowsBefore: before,
      rowsAfter: rows,
      added: rows - before,
      heap: performance.memory ? performance.memory.usedJSHeapSize : null,
      nodes: document.querySelectorAll('*').length,
      scrollHeight: t.scrollHeight,
      // A page that adds nothing is the end of history.
      drained: rows === before
    });
    pages++;
    if (rows === before) {
      resolve({ samples, pages, rows, exhausted: true, ms: performance.now() - t0 });
      return;
    }
    lastRows = rows;
    step();
  };
  step();
}))`;

// ---- trace / metric readers ----------------------------------------------

function readTrace(buffer) {
  // Trace events arrive as a JSON array or as a sequence of objects wrapped in
  // brackets (complete events with a trailing comma). Accept both.
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  let events = [];
  try {
    events = JSON.parse(text);
  } catch {
    const start = text.indexOf('[') + 1;
    const end = text.lastIndexOf(']');
    if (start <= 0 || end <= start) return { events: [] };
    try { events = JSON.parse('[' + text.slice(start, end).replace(/,\s*$/, '') + ']'); }
    catch { return { events: [] }; }
  }
  return { events: Array.isArray(events) ? events : [] };
}

// traceInsights(events) — the few trace numbers worth putting in a report:
// long tasks (over 50 ms), layout / script / paint time, and the busiest
// long tasks so a regression has something to point at.
function traceInsights(events) {
  const complete = events.filter((e) => e && e.ph === 'X' && typeof e.dur === 'number');
  const longTasks = complete.filter((e) => (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') && e.dur / 1000 >= 50)
    .map((e) => ({ ms: round(e.dur / 1000), startMs: round((e.ts || 0) / 1000) }))
    .sort((a, b) => b.ms - a.ms);
  const byName = new Map();
  for (const e of complete) {
    if (!/Layout$|UpdateLayoutTree$|Paint$|^EvaluateScript$|^FunctionCall$|^ParseHTML$|^CompileScript$/.test(e.name || '')) continue;
    const key = e.name;
    byName.set(key, (byName.get(key) || 0) + e.dur / 1000);
  }
  const costs = [...byName.entries()]
    .map(([name, ms]) => ({ name, ms: round(ms) }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 8);
  return {
    longTaskCount: longTasks.length,
    longTaskTotalMs: round(longTasks.reduce((n, t) => n + t.ms, 0)),
    longestTasks: longTasks.slice(0, 5),
    byCost: costs
  };
}

function metricsByName(list) {
  const out = {};
  for (const m of list || []) {
    const prev = out[m.name];
    if (prev == null || m.value > prev) out[m.name] = m.value;
  }
  return out;
}

// coreVitals(metrics) — the paint/load numbers, read from the document itself.
//
// Performance.getMetrics only carries FCP/LCP when the page emitted the
// corresponding trace events, and it reports DomContentLoaded/loadEventEnd as
// milliseconds SINCE NAVIGATION START while the paint times are absolute
// monotonic clocks — mixing them in one object invites a nonsense comparison.
// So the paints come from the PageLoad/PaintTiming entries (`startTime` is
// already relative to navigation) and the total document load from
// PerformanceNavigationTiming, which is measured the same way.
function coreVitals(metrics, navTiming, paints) {
  const pick = (name) => (metrics[name] == null ? null : round(metrics[name]));
  return {
    fcpMs: paints && paints.firstContentfulPaint != null ? round(paints.firstContentfulPaint) : null,
    lcpMs: paints && paints.largestContentfulPaint != null ? round(paints.largestContentfulPaint) : null,
    domContentLoadedMs: navTiming && navTiming.domContentLoaded != null ? round(navTiming.domContentLoaded) : null,
    loadMs: navTiming && navTiming.loadEventEnd != null ? round(navTiming.loadEventEnd) : null,
    ttfbMs: navTiming && navTiming.responseStart != null ? round(navTiming.responseStart) : null,
    transferBytes: navTiming && navTiming.transferSize != null ? navTiming.transferSize : null,
    jsHeapUsedAtLoad: pick('JSHeapUsedSize'),
    jsHeapTotalAtLoad: pick('JSHeapTotalSize'),
    domNodesAtLoad: pick('Nodes'),
    listenersAtLoad: pick('JSEventListeners')
  };
}

// readVitals(cdp) — one round trip for both halves of the load story.
const READ_VITALS = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const paint = performance.getEntriesByType('paint') || [];
  const lcp = (performance.getEntriesByType('largest-contentful-paint') || []).pop();
  return {
    nav: nav ? {
      domContentLoaded: nav.domContentLoadedEventEnd,
      loadEventEnd: nav.loadEventEnd,
      responseStart: nav.responseStart,
      transferSize: nav.transferSize,
      encodedBodySize: nav.encodedBodySize,
      duration: nav.duration
    } : null,
    paints: {
      firstContentfulPaint: (paint.find((p) => p.name === 'first-contentful-paint') || {}).startTime != null
        ? paint.find((p) => p.name === 'first-contentful-paint').startTime : null,
      largestContentfulPaint: lcp ? lcp.startTime : null
    }
  };
})()`;

async function readVitals(cdp) {
  return cdp.evaluate(READ_VITALS, { timeoutMs: 15000 }).catch(() => ({ nav: null, paints: null }));
}

// ---- the profiler ---------------------------------------------------------

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { log('error: ' + e.message + '\n\n' + HELP); process.exit(2); }
  if (args.help) { log(HELP); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = path.dirname(args.report);
  fs.mkdirSync(reportDir, { recursive: true });
  const snapDir = path.join(reportDir, 'snapshots', stamp);
  fs.mkdirSync(snapDir, { recursive: true });

  // --cleanup-only: delete what a manifest lists and stop.
  if (args.cleanupOnly) {
    const manifest = JSON.parse(fs.readFileSync(args.cleanupOnly, 'utf8'));
    const res = removeSeeded(manifest, process.env.MOUAIF_HOME);
    log('cleanup: removed ' + res.removed + ' chat(s)' + (res.missing.length ? ', missing ' + res.missing.join(', ') : ''));
    return;
  }

  const page = await findAppPage(args.port, args.base);
  if (!page) {
    const pages = await listPageTargets(args.port);
    throw new Error('no tab pointing at ' + args.base + ' in Chrome on port ' + args.port
      + ' (open tabs: ' + (pages.map((p) => p.url).join(', ') || 'none') + ')');
  }
  log('app tab      : ' + page.url);

  const cdp = await connectPage(page.webSocketDebuggerUrl, { defaultTimeoutMs: args.timeout });
  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    stamp,
    environment: {},
    app: {},
    chatsTab: {},
    inspectorTab: {},
    transcripts: [],
    storedHistory: {},
    seeded: null,
    notes: []
  };

  let manifest = null;
  const cleanup = async () => {
    if (manifest && !args.keep) {
      try {
        const res = removeSeeded(manifest, process.env.MOUAIF_HOME);
        log('cleanup      : removed ' + res.removed + ' seeded chat(s)'
          + (res.missing.length ? ' (missing: ' + res.missing.join(', ') + ')' : ''));
        manifest.removed = res;
      } catch (e) {
        log('cleanup      : FAILED — ' + e.message + ' (run --cleanup-only perf/latest.json)');
      }
    }
  };

  // --- sign in the profiling tab -------------------------------------------
  //
  // A profile of the sign-in screen measures nothing, and an expired session is
  // easy to miss: the DOM looks fine until a call 401s. Mint a temporary
  // session for the configured account, prove the tab is accepted with it, and
  // revoke it when the whole measurement block returns (withSession's finally).
  // The session only has to outlive the run; it is never the user's own.
  try {
    await cdp.send('Page.enable');
    const run = await withSession(args.base, async ({ cookie, expiresAt }) => {
      if (cookie) {
      // Set the session cookie from the page's own origin rather than with
      // Network.setCookie: the value has to apply to the document that is
      // about to be created, and document.cookie on the current origin is
      // the form every browser treats identically.
      await cdp.evaluate(`document.cookie = ${JSON.stringify(cookie + '; path=/; SameSite=Lax')}`, { timeoutMs: 15000 });
      }
      const signedIn = await cdp.evaluate(
        "fetch('/api/access/status').then((r) => r.json()).then((b) => b.authenticated === true)",
        { timeoutMs: 20000 }
      );
      if (!signedIn) throw new Error('the profiling tab is not signed in to ' + args.base + ' after setting a session cookie');
      return runProfile(cdp, args, report, {
        expiresAt: expiresAt || null,
        authMode: cookie ? 'session' : 'none',
        stamp,
        snapDir,
        // Seeding happens inside the signed-in block; hand the manifest back so
        // cleanup() can delete exactly those chats even if a later step throws.
        onManifest: (m) => { manifest = m; }
      });
    });
    if (run.result && run.result.manifest) manifest = run.result.manifest;
    log('auth         : ' + (run.mode === 'none' ? 'not required' : 'temporary session (revoked at exit)'));
    report.environment.auth = run.mode;
  } catch (e) {
    report.error = { message: e.message, step: e.name === 'PerfTimeout' ? 'timeout' : 'run' };
    log('\nFAILED: ' + e.message);
    await cleanup();
    writeReport(args.report, report);
    await cdp.close();
    process.exit(1);
  }

  await cleanup();
  // Leave the tab where a human expects it.
  await navigate(cdp, args.base + '/#/projects', args.timeout).catch(() => {});
  await cdp.close();
  writeReport(args.report, report);
  printSummary(report, args.report);
}

async function runProfile(cdp, args, report, ctx) {
  // --- environment -------------------------------------------------------
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable', { maxTotalBufferSize: 200 * 1024 * 1024, maxResourceBufferSize: 32 * 1024 * 1024 });
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable', {});
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_INSTRUMENT });

  const version = await cdp.send('Browser.getVersion').catch(() => null);
  const metrics = metricsByName((await cdp.send('Performance.getMetrics')).metrics);
  const ua = await cdp.evaluate('navigator.userAgent');
  const visibility = await cdp.evaluate('document.visibilityState').catch(() => 'unknown');
  report.environment = {
    generatedAt: report.generatedAt,
    visibility,
    auth: ctx.authMode || null,
    base: args.base,
    projectDir: args.projectDir,
    chromePort: args.port,
    browser: version ? version.product : null,
    userAgent: ua,
    viewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true },
    platform: process.platform,
    nodeVersion: process.version,
    host: os.hostname(),
    cpus: os.cpus().length,
    totalMemBytes: os.totalmem(),
    loadAverage: os.loadavg().map((n) => round(n, 2)),
    store: projectStoreSize(process.env.MOUAIF_HOME),
    serverMetricSample: { note: 'Chrome-side metrics from the already-open tab', ...metrics }
  };
  log('viewport     : ' + WIDTH + 'x' + HEIGHT + ' @2x (mobile)');
  log('browser      : ' + (report.environment.browser || 'unknown'));
  if (visibility === 'hidden') {
  report.notes.push('The app tab stayed hidden during the run, so frame timings are timer-bounded '
    + '(Chrome suspends rAF and throttles timers in a background tab). Scroll and open numbers '
    + 'are still comparable between transcripts in the same run, but not with a foreground run.');
  log('warning      : app tab is hidden — frame timings are timer-bounded');
  }

  // --- server process (read-only, for the memory half of the profile) ----
  report.server = readServerProcess(args.base);

  // --- 1. app shell ------------------------------------------------------
  log('\n[1/4] app shell …');
  report.app = await measureShell(cdp, args);

  // --- fixtures ----------------------------------------------------------
  const fixtureInfo = { profiles: [], real: [] };
  let manifest = null;
  if (args.synthetic) {
    // Clean any strays from an interrupted run first: they would show up in
    // the chat list and skew the list measurement.
    const strays = removeStrays(process.env.MOUAIF_HOME, args.projectDir);
    if (strays) log('strays       : removed ' + strays + ' leftover fixture chat(s)');
    log('seeding      : ' + args.profiles.join(', ') + ' …');
    manifest = seedChats({
      home: process.env.MOUAIF_HOME,
      projectDir: args.projectDir,
      profiles: args.profiles,
      stamp: ctx.stamp
    });
    // Written before the first measurement: if the run dies mid-way, the
    // manifest is what --cleanup-only uses to delete exactly these chats.
    fs.writeFileSync(args.report.replace(/\.json$/, '') + '.manifest.json', JSON.stringify(manifest, null, 2));
    if (ctx.onManifest) ctx.onManifest(manifest);
    fixtureInfo.profiles = manifest.chats;
    for (const c of manifest.chats) log('  ' + c.profile.padEnd(7) + c.rows + ' rows, ' + fmtBytes(c.bytes) + '  id ' + c.id);
    report.seeded = manifest;
  }

  // --- 2. long transcripts ----------------------------------------------
  const targets = [];
  for (const c of fixtureInfo.profiles) {
    targets.push({ kind: 'synthetic', id: c.id, label: 'synthetic ' + c.profile, rows: c.rows, bytes: c.bytes });
  }
  if (args.real > 0) {
    const real = longestRealChats(process.env.MOUAIF_HOME, args.projectDir, args.real);
    fixtureInfo.real = real;
    for (const r of real) {
      targets.push({ kind: 'real', id: r.id, label: 'real «' + String(r.title || '').slice(0, 40) + '»', rows: r.rows, bytes: r.bytes });
    }
  }
  // Largest first is the wrong order for a profile: the biggest transcript
  // leaves the largest heap behind and colours every later measurement, so
  // run small→large and snapshot separately.
  targets.sort((a, b) => a.rows - b.rows);
  log('\n[2/4] ' + targets.length + ' transcript(s): ' + targets.map((t) => t.rows).join(', ') + ' rows');

  const snapshotsLeft = { n: args.snapshotLimit };
  for (const target of targets) {
    log('  ' + target.label + ' (' + target.rows + ' rows, ' + fmtBytes(target.bytes) + ') …');
    const entry = await measureTranscript(cdp, args, target, {
    snapDir: ctx.snapDir,
      takeSnapshot: snapshotsLeft.n > 0 && target.rows >= 500
    });
    if (entry.snapshot) snapshotsLeft.n -= 1;
    report.transcripts.push(entry);
    log('    first row ' + fmtMs(entry.open.firstRowMs)
      + ' · complete ' + fmtMs(entry.open.completeMs)
      + ' · ' + entry.heap.domNodes + ' nodes'
      + ' · heap ' + fmtBytes(entry.heap.jsHeapUsed)
      + ' · long tasks ' + entry.trace.longTaskCount);
  }

  // --- 3. chat list + stored history ------------------------------------
  log('\n[3/4] chats tab and stored history …');
  report.chatsTab = await measureChatsTab(cdp, args);
  report.storedHistory = await measureStoredHistory(cdp, args);
  report.inspectorTab = await measureInspectorTab(cdp, args);

  // --- 4. summary -------------------------------------------------------
  log('\n[4/4] writing report …');
  report.summary = summarizeReport(report);
  report.notes = buildNotes(report);
  return { auth: { mode: ctx.authMode || null }, manifest };
}

// readServerProcess(base) — RSS/CPU of the process serving the app.
//
// The web profile covers the browser; a "complete" profile of this app also
// has to state what the Node server holds, because the server keeps the
// project's chat metadata in memory. Read from /proc (Linux) by matching the
// listener on the app's port — no server call, no restart.
function readServerProcess(base) {
  const port = Number(new URL(base).port || (new URL(base).protocol === 'https:' ? 443 : 80));
  try {
    const inodes = new Set();
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of text.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 10) continue;
        const local = cols[1];
        const listenPort = parseInt(local.split(':')[1], 16);
        if (listenPort === port && cols[3] === '0A') inodes.add(cols[9]);
      }
    }
    for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      const fdDir = '/proc/' + pid + '/fd';
      let fds;
      try { fds = fs.readdirSync(fdDir); } catch { continue; }
      let hit = false;
      for (const fd of fds) {
        let link;
        try { link = fs.readlinkSync(fdDir + '/' + fd); } catch { continue; }
        const m = /^socket:\[(\d+)\]$/.exec(link);
        if (m && inodes.has(m[1])) { hit = true; break; }
      }
      if (!hit) continue;
      const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
      const read = (key) => {
        const m = new RegExp('^' + key + ':\\s+(.*)$', 'm').exec(status);
        return m ? m[1] : null;
      };
      const rss = read('VmRSS') || '';
      const vm = read('VmSize') || '';
      const threads = read('Threads');
      let cmd = '';
      try { cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ').trim(); } catch { /* gone */ }
      return {
        pid: Number(pid),
        port,
        rssBytes: parseInt(rss, 10) * 1024 || null,
        vmBytes: parseInt(vm, 10) * 1024 || null,
        threads: threads ? Number(threads) : null,
        cmd: cmd.slice(0, 300)
      };
    }
  } catch { /* not Linux, or the process is not reachable */ }
  return { pid: null, port, note: 'server process not resolved (non-Linux host or different owner)' };
}

// navigate(cdp, url) — go to a hash route and make the tab the foreground tab.
//
// The foreground matters for measurement, not for politeness: Chrome throttles
// timers and stops rAF in a background tab, and this script attaches to a tab
// the user already has open. `Page.bringToFront` is best-effort (a headless
// browser may refuse); the in-page waits all carry a timer fallback so a run
// still completes if it does.
async function navigate(cdp, url, timeout) {
  // A hash-only change does NOT reload the document — the app's router just
  // updates a signal. That matters here twice: the probe's timings would be
  // overwritten by the previous page, and app state (a signed-out shell, a
  // rendered transcript) would survive into the next measurement. So every
  // measured navigation is a real document load: assign the hash, then reload.
  //
  // `performance.now()` is measured from the document's own navigation start,
  // so a reload is exactly what makes the open timings mean "time since the
  // user opened this chat".
  const hash = new URL(url).hash;
  await cdp.send('Page.navigate', { url: url.replace(/#.*$/, '') + '?perf=' + hash.slice(1).replace(/[^a-z0-9]/gi, '.').slice(0, 80) }, { timeoutMs: timeout });
  await cdp.send('Page.bringToFront').catch(() => {});
  // The `?perf=…` load has no hash, so it lands on the app's default view. Set
  // the route and reload once more: the final document is then the route being
  // measured, loaded from scratch, with the probe installed from its first
  // script.
  await cdp.send('Runtime.evaluate', { expression: 'location.hash = ' + JSON.stringify(hash), timeoutMs: 15000 }).catch(() => {});
  await cdp.send('Page.reload', { ignoreCache: false }, { timeoutMs: timeout });
  await waitForReady(cdp, timeout);
}

// waitForReady(cdp) — the document's own load is complete before measuring.
async function waitForReady(cdp, timeout) {
  const t0 = nowMs();
  while (nowMs() - t0 < timeout) {
    const ready = await cdp.evaluate('document.readyState', { timeoutMs: 15000 }).catch(() => null);
    if (ready === 'complete') return true;
    await sleep(50);
  }
  return false;
}

// waitFor(fn, {timeout, poll}) — poll an in-page predicate.
async function waitFor(cdp, expression, { timeout = 30000, poll = 50 } = {}) {
  const t0 = nowMs();
  while (nowMs() - t0 < timeout) {
    const value = await cdp.evaluate(expression, { timeoutMs: 10000 }).catch(() => null);
    if (value) return { value, ms: round(nowMs() - t0) };
    await sleep(poll);
  }
  return { value: null, ms: round(nowMs() - t0), timedOut: true };
}

// traceWhile(cdp, fn) — record a CDP trace for the duration of fn, then return
// both fn's result and the trace insights.
async function traceWhile(cdp, fn) {
  const chunks = [];
  const off = cdp.on('Tracing.dataCollected', (params) => {
    if (params && params.value) chunks.push(...params.value);
  });
  let ended = null;
  const done = new Promise((resolve) => { ended = resolve; });
  const offEnd = cdp.on('Tracing.tracingComplete', () => ended());
  await cdp.send('Tracing.start', {
    categories: [
      'devtools.timeline', 'disabled-by-default-devtools.timeline',
      'blink.user_timing', 'loading', 'v8.execute', 'disabled-by-default-v8.compile'
    ].join(','),
    transferMode: 'ReportEvents'
  });
  let result;
  try {
    result = await fn();
  } finally {
    await cdp.send('Tracing.end').catch(() => {});
    await Promise.race([done, sleep(20000)]);
    off();
    offEnd();
  }
  return { result, trace: traceInsights(chunks) };
}

async function metricsNow(cdp) {
  return metricsByName((await cdp.send('Performance.getMetrics')).metrics);
}

// --- 1. shell --------------------------------------------------------------

async function measureShell(cdp, args) {
  await cdp.evaluate('window.__perf && (window.__perf = null)').catch(() => {});
  const start = nowMs();
  const { trace } = await traceWhile(cdp, async () => {
    await navigate(cdp, args.base + '/#/projects', args.timeout);
    // The shell is ready when the tab bar exists and the chat list has settled.
    await waitFor(cdp, 'document.querySelectorAll(".app__tab, .app__tabbar").length > 0 && document.readyState === "complete"', { timeout: Math.min(args.timeout, 60000) });
    await cdp.evaluate('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true');
    await cdp.evaluate(SETTLE);
  });
  const shellMs = round(nowMs() - start);
  const metrics = await metricsNow(cdp);
  const vitals = await readVitals(cdp);
  const heap = await cdp.evaluate(HEAP_MEASURE);
  return {
    shellMs,
    vitals: coreVitals(metrics, vitals.nav, vitals.paints),
    heapAfterLoad: {
      jsHeapUsed: heap.jsHeapUsed,
      jsHeapTotal: heap.jsHeapTotal,
      jsHeapLimit: heap.jsHeapLimit,
      domNodes: heap.domNodes
    },
    trace
  };
}

// --- 2. one transcript -----------------------------------------------------

async function measureTranscript(cdp, args, target, opts) {
  const { scrollSteps, timeout } = args;
  const url = args.base + '/#/chat/' + target.id + '?projectDir=' + encodeURIComponent(args.projectDir);
  const entry = {
    label: target.label,
    kind: target.kind,
    chatId: target.id,
    source: { rows: target.rows, bytes: target.bytes },
    scrollSteps
  };

  // Baseline after a GC on whatever page is showing, so this measurement's
  // heap delta is attributable to this transcript rather than to whatever the
  // previous one left behind in a long-lived tab.
  const baselineHeap = await forceGc(cdp);
  // Reset the in-page probe, then navigate.
  await cdp.evaluate('window.__perf = null').catch(() => {});
  const wallStart = nowMs();
  const { trace: openTrace } = await traceWhile(cdp, async () => {
    await navigate(cdp, url, timeout);
    await waitFor(cdp, 'document.querySelector(".chat-view__transcript")', { timeout });
    // First painted row and the end of the chunked backfill, from the probe.
    await waitFor(cdp, 'window.__perf && window.__perf.firstRowAt != null', { timeout });
    await waitFor(cdp, 'window.__perf && window.__perf.lastRowAt != null', { timeout: Math.max(timeout, 60000) });
    await cdp.evaluate(SETTLE);
  });
  const navWallMs = round(nowMs() - wallStart);

  const probe = await cdp.evaluate('window.__perf ? ({firstRowAt: window.__perf.firstRowAt, lastRowAt: window.__perf.lastRowAt, navStart: performance.now(), longTasks: window.__perf.longTasks}) : null');
  const metrics = await metricsNow(cdp);
  const vitals = await readVitals(cdp);
  const heap = await cdp.evaluate(HEAP_MEASURE);

  entry.open = {
    firstRowMs: probe && probe.firstRowAt != null ? round(probe.firstRowAt) : null,
    completeMs: probe && probe.lastRowAt != null ? round(probe.lastRowAt) : null,
    totalWallMs: navWallMs,
    domNodesAtOpen: heap.domNodes,
    jsHeapAtOpen: heap.jsHeapUsed,
    scriptTaskLongestMs: probe && probe.longTasks.length
      ? round(Math.max(...probe.longTasks.map((t) => t.dur)))
      : null,
    longTaskCountInPage: probe ? probe.longTasks.length : null,
    metrics: coreVitals(metrics, vitals.nav, vitals.paints)
  };
  entry.trace = openTrace;
  entry.heap = {
    baselineBeforeOpen: baselineHeap,
    baselineDelta: baselineHeap != null && heap.jsHeapUsed != null ? heap.jsHeapUsed - baselineHeap : null,
    jsHeapUsed: heap.jsHeapUsed,
    jsHeapTotal: heap.jsHeapTotal,
    jsHeapLimit: heap.jsHeapLimit,
    domNodes: heap.domNodes,
    transcriptNodes: heap.transcriptNodes,
    rows: heap.rows,
    toolCards: heap.toolCards,
    scrollHeight: heap.scrollHeight,
    bytesPerNode: heap.domNodes ? round(heap.jsHeapUsed / heap.domNodes) : null
  };

  // Scroll pass — what the transcript costs once it is fully drawn.
  const gcBefore = await forceGc(cdp);
  const scroll = await cdp.evaluate(SCROLL + '(' + scrollSteps + ')', { timeoutMs: timeout });
  const afterScroll = await cdp.evaluate(HEAP_MEASURE);
  entry.scroll = {
    steps: scroll && scroll.samples ? scroll.samples.length : 0,
    maxScrollHeight: scroll ? scroll.max : null,
    stepMs: summarize((scroll && scroll.samples || []).map((s) => s.ms)),
    frameToFrameMs: summarize((scroll && scroll.samples || []).map((s) => s.frameMs)),
    heapAfter: afterScroll.jsHeapUsed,
    msPerStep: scroll && scroll.samples && scroll.samples.length
      ? round(scroll.samples.reduce((n, s) => n + s.ms, 0) / scroll.samples.length)
      : null
  };
  entry.heap.gcBeforeScroll = gcBefore;

  // Full-history pass — open cost only covers the first page. Draining the
  // pagination is the other half of the long-chat story: the transcript keeps
  // every row it has ever loaded, so this is where a 10,000-row chat shows what
  // holding all of it costs.
  if (args.fullHistory && target.rows > 100) {
    const gcMid = await forceGc(cdp);
    const drain = await cdp.evaluate(
      SCROLL_ALL + '(' + JSON.stringify({ maxPages: args.maxPages, deadlineMs: args.drainDeadlineMs }) + ')',
      { timeoutMs: args.drainDeadlineMs + 60000 }
    ).catch((e) => ({ error: e.message }));
    const afterDrain = await cdp.evaluate(HEAP_MEASURE);
    const samples = (drain && drain.samples) || [];
    entry.fullHistory = {
      pages: drain && drain.pages != null ? drain.pages : null,
      // How the DOM and heap grow with the number of rows actually on screen:
      // the slope of this curve is what makes a long chat cost more the longer
      // it is read.
      growthCurve: samples.length
        ? [
            { rows: samples[0].rowsAfter, nodes: samples[0].nodes, heap: samples[0].heap },
            samples[Math.floor(samples.length / 2)]
              ? { rows: samples[Math.floor(samples.length / 2)].rowsAfter, nodes: samples[Math.floor(samples.length / 2)].nodes, heap: samples[Math.floor(samples.length / 2)].heap }
              : null,
            { rows: samples[samples.length - 1].rowsAfter, nodes: samples[samples.length - 1].nodes, heap: samples[samples.length - 1].heap }
          ].filter(Boolean)
        : null,
      exhausted: !!(drain && drain.exhausted),
      deadlineHit: !!(drain && drain.deadlineHit),
      error: drain && drain.error ? drain.error : null,
      ms: drain && drain.ms != null ? round(drain.ms) : null,
      rowsBefore: samples.length ? samples[0].rowsBefore : null,
      rowsAfter: drain && drain.rows != null ? drain.rows : afterDrain.rows,
      pageMs: summarize(samples.map((x) => x.ms)),
      nodesAfter: afterDrain.domNodes,
      heapBefore: gcMid,
      heapAfter: afterDrain.jsHeapUsed,
      heapGrowth: gcMid != null && afterDrain.jsHeapUsed != null ? afterDrain.jsHeapUsed - gcMid : null,
      perRowBytes: afterDrain.rows && afterDrain.jsHeapUsed
        ? round(afterDrain.jsHeapUsed / afterDrain.rows) : null,
      samples: samples.map((x) => ({
        page: x.page, ms: round(x.ms), added: x.added, rows: x.rowsAfter,
        nodes: x.nodes, heap: x.heap
      }))
    };
  }

  // Is the list actually windowed? Record how many rows the DOM holds against
  // how many the chat has, because that ratio is the whole memory story.
  entry.windowing = {
    renderedRows: heap.rows,
    sourceRows: target.rows,
    ratio: target.rows ? round(heap.rows / target.rows, 3) : null,
    renderedToolCards: heap.toolCards
  };

  // Optional V8 heap snapshot — taken AFTER the history pass, on purpose.
  //
  // A snapshot is a census of everything the tab retains. Taking it on the
  // freshly opened page would describe 100 rows and miss the case this profile
  // exists for: a long chat whose whole history has been scrolled in. The
  // constructor table in the report therefore describes the worst state the
  // chat reaches, which is the state a user's tab actually lives in.
  if (opts.takeSnapshot) {
    await forceGc(cdp);
    const file = path.join(opts.snapDir, (target.kind === 'real' ? 'real-' : '') + target.rows + '-rows.heapsnapshot');
    try {
      const chunks = [];
      const off = cdp.on('HeapProfiler.addHeapSnapshotChunk', (p) => { if (p && p.chunk) chunks.push(p.chunk); });
      try {
        await cdp.send('HeapProfiler.takeHeapSnapshot', {
          reportProgress: false,
          captureNumericValue: false,
          exposeInternals: false
        }, { timeoutMs: Math.max(timeout, 180000) });
      } finally {
        off();
      }
      if (!chunks.length) throw new Error('Chrome produced no heap snapshot chunks');
      fs.writeFileSync(file, chunks.join(''));
      entry.snapshot = {
        file: path.relative(ROOT, file),
        bytes: fs.statSync(file).size,
        at: entry.fullHistory ? 'after draining history (' + entry.fullHistory.rowsAfter + ' rows)' : 'after open',
        rowsInDom: (await cdp.evaluate(HEAP_MEASURE)).rows,
        retained: summarizeHeapSnapshot(file)
      };
    } catch (e) {
      entry.snapshotError = e.message;
    }
  }

  // Return to the chat list and settle. The heap here is what the tab keeps
  // after the transcript is gone: comparing it with baselineBeforeOpen is the
  // only way to tell "this tab grows with every chat visited" from "this chat
  // costs what it costs".
  await navigate(cdp, args.base + '/#/projects', timeout);
  // Wait for the transcript to be gone before believing a "settled" heap: a
  // GC fired while the chat view is still tearing down can return a number
  // below the pre-open baseline (which is why an earlier run reported
  // "retained -51 MB"). The retention number is only meaningful once no
  // transcript is in the DOM.
  await waitFor(cdp, '!document.querySelector(".chat-view__transcript")', { timeout: 30000 }).catch(() => {});
  await sleep(800);
  const afterLeave = await forceGc(cdp);
  entry.heap.afterLeaveBaseline = afterLeave;
  entry.heap.retainedAfterLeave = baselineHeap != null && afterLeave != null
    ? Math.max(0, afterLeave - baselineHeap)
    : null;
  return entry;
}

async function forceGc(cdp) {
  try {
    await cdp.send('HeapProfiler.collectGarbage', {}, { timeoutMs: 20000 });
    const m = await metricsNow(cdp);
    return m.JSHeapUsedSize != null ? round(m.JSHeapUsedSize) : null;
  } catch {
    return null;
  }
}

// summarizeHeapSnapshot(file) — the biggest retained constructors in a V8
// heap snapshot, parsed streaming so a 300 MB snapshot does not have to be
// JSON.parse'd in one piece.
//
// A .heapsnapshot is a JSON object whose `snapshot.meta` declares the field
// order of `nodes` (a flat number array) and `strings` (all names). Retained
// size needs the full dominator pass, which only DevTools does; what is cheap
// and still useful is self size per constructor plus instance counts, which is
// where a leak shows up (rows of arrays, strings, detached nodes).
function summarizeHeapSnapshot(file) {
  // A heap snapshot of a real chat is 40-200 MB of JSON. `JSON.parse` on that
  // needs several times its size in RAM and this box has 4 GB shared with the
  // app, Chrome and the server, so the file is read as text and the four flat
  // arrays the summary needs are pulled out with a scanner instead: `strings`
  // (all node names), `node_fields` / `node_types` (the header) and `nodes`
  // (a flat number array). That keeps peak memory at roughly the file size and
  // never builds an object graph for a million nodes.
  //
  // The summary is self size per constructor plus instance counts. Retained
  // size needs the dominator pass only DevTools does; self size is what makes a
  // leak visible (a class whose count and bytes keep climbing as rows are
  // added).
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }

  // ---- header -----------------------------------------------------------------
  const headerAt = text.indexOf('"snapshot"');
  if (headerAt < 0) return null;
  const metaAt = text.indexOf('"meta"', headerAt);
  const metaEnd = text.indexOf('"node_count"', metaAt) > 0 ? text.indexOf('"node_count"', metaAt) : metaAt + 20000;
  // The meta object is small: parse just its slice.
  const metaSlice = sliceObjectAt(text, text.indexOf('{', metaAt));
  let meta = null;
  try { meta = metaSlice ? JSON.parse(metaSlice) : null; } catch { meta = null; }
  if (!meta && metaSlice) {
    try { meta = JSON.parse(metaSlice.replace(/,\s*$/, '')); } catch { meta = null; }
  }
  const fields = (meta && meta.node_fields) || ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'];
  const types = (meta && meta.node_types) || [['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint']];
  void metaEnd;

  // ---- strings ----------------------------------------------------------------
  const stringsAt = text.indexOf('"strings"', headerAt);
  const strings = stringsAt > 0 ? readStringArray(text, text.indexOf('[', stringsAt)) : [];
  const typeList = types[fields.indexOf('type')] || types[0] || ['?'];

  // ---- nodes ------------------------------------------------------------------
  const nodesAt = text.indexOf('"nodes"', headerAt);
  if (nodesAt < 0) return null;
  const stride = fields.length;
  const typeIdx = Math.max(0, fields.indexOf('type'));
  const nameIdx = Math.max(0, fields.indexOf('name'));
  const selfIdx = Math.max(0, fields.indexOf('self_size'));
  const byType = new Map();
  let total = 0;
  let nodeCount = 0;
  // Walk the flat number array in place, `stride` numbers at a time.
  const nums = { i: text.indexOf('[', nodesAt) + 1 };
  while (nums.i < text.length) {
    const row = new Array(stride);
    let ok = true;
    for (let f = 0; f < stride; f++) {
      const v = readNumber(text, nums);
      if (v === null) { ok = false; break; }
      row[f] = v;
    }
    if (!ok) break;
    const type = typeList[row[typeIdx]] || '?';
    const name = strings[row[nameIdx]] || '?';
    const size = row[selfIdx] || 0;
    total += size;
    nodeCount++;
    const key = type + ':' + name;
    const prev = byType.get(key);
    if (prev) { prev.count++; prev.selfBytes += size; }
    else byType.set(key, { type, name, count: 1, selfBytes: size });
  }
  const top = [...byType.values()].sort((a, b) => b.selfBytes - a.selfBytes).slice(0, 12)
    .map((e) => ({ type: e.type, name: String(e.name).slice(0, 80), count: e.count, selfBytes: e.selfBytes }));
  return {
    nodeCount,
    stringCount: strings.length,
    totalSelfBytes: total,
    top
  };
}

// readNumber(text, cursor) — parse one JSON number at/after cursor, skipping
// separators. Returns null at the end of the array.
function readNumber(text, cursor) {
  while (cursor.i < text.length) {
    const c = text.charCodeAt(cursor.i);
    if (c === 93) return null;                                    // ']'
    if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46) break; // 0-9 - + .
    cursor.i++;
  }
  const start = cursor.i;
  while (cursor.i < text.length) {
    const c = text.charCodeAt(cursor.i);
    if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46 || c === 101 || c === 69) cursor.i++;
    else break;
  }
  if (cursor.i === start) return null;
  const n = Number(text.slice(start, cursor.i));
  return Number.isFinite(n) ? n : null;
}

// readStringArray(text, at) — read a top-level JSON string array starting at
// `at`. Strings in a heap snapshot may contain escapes, so this decodes them
// the same way JSON.parse would for the lengths and characters that matter.
function readStringArray(text, at) {
  const out = [];
  let i = at;
  if (text[i] !== '[') return out;
  i++;
  while (i < text.length) {
    while (i < text.length && (text[i] === ',' || text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++;
    if (text[i] === ']') break;
    if (text[i] !== '"') break;
    i++;
    let s = '';
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') {
        const next = text[i + 1];
        if (next === 'n') { s += '\n'; i += 2; continue; }
        if (next === 't') { s += '\t'; i += 2; continue; }
        if (next === 'r') { s += '\r'; i += 2; continue; }
        if (next === 'b') { s += '\b'; i += 2; continue; }
        if (next === 'f') { s += '\f'; i += 2; continue; }
        if (next === 'u') {
          const code = parseInt(text.slice(i + 2, i + 6), 16);
          if (Number.isFinite(code)) s += String.fromCharCode(code);
          i += 6;
          continue;
        }
        s += next === undefined ? '' : next;
        i += 2;
        continue;
      }
      s += text[i];
      i++;
    }
    out.push(s);
    i++;
  }
  return out;
}

// sliceObjectAt(text, at) — the balanced {...} object starting at `at`.
function sliceObjectAt(text, at) {
  if (at < 0 || text[at] !== '{') return null;
  let depth = 0;
  let inString = false;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(at, i + 1);
    }
  }
  return null;
}

// --- 3. chat list, stored history, inspector -------------------------------

async function measureChatsTab(cdp, args) {
  const { trace, result } = await traceWhile(cdp, async () => {
    await navigate(cdp, args.base + '/#/projects', args.timeout);
    await waitFor(cdp, 'document.querySelectorAll(".project-card").length > 0 || document.querySelectorAll(".project-card__chat").length > 0', { timeout: args.timeout });
    await cdp.evaluate(SETTLE);
    return cdp.evaluate(`(() => {
      const cards = document.querySelectorAll('.project-card');
      const rows = document.querySelectorAll('.project-card__chat');
      const t = document.querySelector('.projects') || document.body;
      return {
        projectCards: cards.length,
        chatRows: rows.length,
        listScrollHeight: t.scrollHeight,
        listClientHeight: t.clientHeight,
        scrollsPage: (t.scrollHeight > t.clientHeight + 4)
      };
    })()`);
  });
  const metrics = await metricsNow(cdp);
  const heap = await cdp.evaluate(HEAP_MEASURE);
  const vitals = await readVitals(cdp);
  return {
    ...result,
    vitals: coreVitals(metrics, vitals.nav, vitals.paints),
    heap: { jsHeapUsed: heap.jsHeapUsed, domNodes: heap.domNodes },
    trace
  };
}

// measureStoredHistory(cdp, args) — the paginated history endpoint on the
// project's longest real chat, timed in the page (so it includes the network
// round trip through the same origin the UI uses).
async function measureStoredHistory(cdp, args) {
  const longest = longestRealChats(process.env.MOUAIF_HOME, args.projectDir, 1)[0];
  if (!longest) return { skipped: 'no real chats in this project' };
  const out = { chatId: longest.id, title: String(longest.title || '').slice(0, 80), rows: longest.rows, bytes: longest.bytes };
  // The tab is signed in, so in-page fetches carry the session cookie.
  out.probe = await cdp.evaluate(`(async () => {
    const base = ${JSON.stringify(args.base)};
    const dir = ${JSON.stringify(args.projectDir)};
    const id = ${JSON.stringify(longest.id)};
    const time = async (url) => {
      const t0 = performance.now();
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      const text = await r.text();
      return { ms: performance.now() - t0, status: r.status, bytes: text.length };
    };
    const list = await time('/api/chats?projectDir=' + encodeURIComponent(dir) + '&limit=20');
    const page1 = await time('/api/chats/' + id + '/messages?projectDir=' + encodeURIComponent(dir) + '&limit=100');
    const full = await time('/api/chats/' + id + '/messages?projectDir=' + encodeURIComponent(dir));
    const rev = await time('/api/chats/' + id + '/revision?projectDir=' + encodeURIComponent(dir));
    const q = (n) => Math.round(n * 100) / 100;
    return {
      listPage20: { ms: q(list.ms), bytes: list.bytes, status: list.status },
      newestPage100: { ms: q(page1.ms), bytes: page1.bytes, status: page1.status },
      fullTranscript: { ms: q(full.ms), bytes: full.bytes, status: full.status },
      revision: { ms: q(rev.ms), bytes: rev.bytes, status: rev.status }
    };
  })()`, { timeoutMs: 60000 });
  return out;
}

async function measureInspectorTab(cdp, args) {
  const { trace } = await traceWhile(cdp, async () => {
    await navigate(cdp, args.base + '/#/inspector', args.timeout);
    await waitFor(cdp, 'document.querySelectorAll(".app__tab").length > 0', { timeout: args.timeout });
    await sleep(600);
  });
  const heap = await cdp.evaluate(HEAP_MEASURE);
  return {
    route: '#/inspector',
    heap: { jsHeapUsed: heap.jsHeapUsed, domNodes: heap.domNodes },
    trace
  };
}

// --- 4. summary ------------------------------------------------------------

function summarizeReport(report) {
  const t = report.transcripts || [];
  const byRows = [...t].sort((a, b) => a.source.rows - b.source.rows);
  return {
    shell: {
      shellMs: report.app && report.app.shellMs,
      fcpMs: report.app && report.app.vitals && report.app.vitals.fcpMs,
      lcpMs: report.app && report.app.vitals && report.app.vitals.lcpMs,
      domContentLoadedMs: report.app && report.app.vitals && report.app.vitals.domContentLoadedMs,
      loadMs: report.app && report.app.vitals && report.app.vitals.loadMs,
      heapUsedBytes: report.app && report.app.heapAfterLoad && report.app.heapAfterLoad.jsHeapUsed
    },
    transcripts: byRows.map((e) => ({
      label: e.label,
      rows: e.source.rows,
      bytes: e.source.bytes,
      firstRowMs: e.open && e.open.firstRowMs,
      completeMs: e.open && e.open.completeMs,
      domNodes: e.heap && e.heap.domNodes,
      heapUsedBytes: e.heap && e.heap.jsHeapUsed,
      longTasks: e.trace && e.trace.longTaskCount,
      longestTaskMs: e.trace && e.trace.longestTasks && e.trace.longestTasks[0] ? e.trace.longestTasks[0].ms : null,
      scrollMsPerStep: e.scroll && e.scroll.msPerStep,
      windowedRatio: e.windowing && e.windowing.ratio
    })),
    server: report.server || null
  };
}

// buildNotes(report) — plain-language observations, computed here so the doc
// can quote them and a future run can diff its own list. Every note states
// the measurement it comes from; nothing is inferred beyond the numbers.
function buildNotes(report) {
  const notes = [];
  const list = (report.transcripts || []).filter((e) => e.kind === 'synthetic').sort((a, b) => a.source.rows - b.source.rows);

  // Open cost, on like-for-like numbers only (the same measured field for
  // every chat). `firstRowMs` is "a row is on screen"; `completeMs` includes
  // the chunked backfill and therefore depends on how many rows the first page
  // holds, not on the size of the stored transcript.
  const timed = list.filter((e) => e.open && e.open.firstRowMs != null);
  if (timed.length >= 2) {
    const first = timed[0];
    const last = timed[timed.length - 1];
    const rowsRatio = last.source.rows / Math.max(1, first.source.rows);
    const timeRatio = last.open.firstRowMs / Math.max(1, first.open.firstRowMs);
    notes.push('Time to first row: ' + round(timeRatio, 2) + '× across a ' + round(rowsRatio, 1)
      + '× row increase (' + first.source.rows + ' → ' + last.source.rows + ' rows; '
      + fmtMs(first.open.firstRowMs) + ' → ' + fmtMs(last.open.firstRowMs) + '). '
      + (timeRatio < rowsRatio / 2
        ? 'A chat opens with only its newest page (100 rows), so open cost is dominated by the app shell, not by stored length.'
        : 'Open cost tracks stored length closely.'));
  }

  // Per-transcript heap cost, measured against the tab's own baseline so the
  // number is not polluted by whatever the previous measurement left behind.
  const deltas = list.filter((e) => e.heap && e.heap.baselineDelta != null);
  if (deltas.length >= 2) {
    const small = deltas[0];
    const big = deltas[deltas.length - 1];
    notes.push('Heap added by the open page: ' + fmtBytes(small.heap.baselineDelta) + ' at '
      + small.source.rows + ' rows vs ' + fmtBytes(big.heap.baselineDelta) + ' at ' + big.source.rows
      + ' rows (' + round(big.heap.baselineDelta / Math.max(1, small.heap.baselineDelta), 2) + '×).');
  }

  // Full history, when the pagination was drained.
  for (const e of list) {
    const fh = e.fullHistory;
    if (!fh || fh.error) continue;
    if (fh.rowsAfter && fh.perRowBytes) {
      notes.push(e.label + ': draining history to ' + fh.rowsAfter + ' rows costs '
        + fmtBytes(fh.heapAfter) + ' (' + fmtBytes(fh.perRowBytes) + '/row) and '
        + fh.nodesAfter + ' DOM nodes; ' + fh.pages + ' page(s) at a median of '
        + fmtMs(fh.pageMs && fh.pageMs.median) + ' each.');
    }
  }

  // Retention after leaving a chat.
  const retained = (report.transcripts || []).filter((e) => e.heap && e.heap.retainedAfterLeave != null)
    .sort((a, b) => b.heap.retainedAfterLeave - a.heap.retainedAfterLeave);
  if (retained.length && retained[0].heap.retainedAfterLeave > 2 * 1024 * 1024) {
    notes.push('Leaving a chat does not return the tab to its previous heap: after '
      + retained[0].source.rows + ' rows, the settled heap on the chat list is '
      + fmtBytes(retained[0].heap.retainedAfterLeave) + ' above the pre-open baseline '
      + '(largest retention of the ' + retained.length + ' transcripts measured).');
  } else if (retained.length) {
    notes.push('The tab returns to (or below) its pre-open heap after leaving every measured chat; '
      + 'largest retention ' + fmtBytes(retained[0].heap.retainedAfterLeave) + '.');
  }

  // Long tasks, capped to the three worst so a report stays readable.
  const tasks = (report.transcripts || []).filter((e) => e.trace && e.trace.longTaskCount > 0)
    .sort((a, b) => (b.trace.longestTasks[0] || {}).ms - (a.trace.longestTasks[0] || {}).ms)
    .slice(0, 3);
  for (const e of tasks) {
    notes.push(e.label + ': ' + e.trace.longTaskCount + ' long task(s) over 50 ms while opening, longest '
      + fmtMs(e.trace.longestTasks[0].ms) + '.');
  }

  if (report.server && report.server.rssBytes) {
    notes.push('The Node server serving the app holds ' + fmtBytes(report.server.rssBytes) + ' RSS with '
      + report.server.threads + ' threads (pid ' + report.server.pid + ').');
  }
  if (report.environment && report.environment.store) {
    notes.push('Measured against the real app store: ' + fmtBytes(report.environment.store.bytes) + ' ('
      + report.environment.store.path + ').');
  }
  return notes;
}

function writeReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
}

function printSummary(report, file) {
  const s = report.summary || {};
  log('\n────────────────────────────────────────────────────────');
  log(' shell      ' + fmtMs(s.shell && s.shell.shellMs)
    + '   FCP ' + fmtMs(s.shell && s.shell.fcpMs)
    + '   LCP ' + fmtMs(s.shell && s.shell.lcpMs)
    + '   heap ' + fmtBytes(s.shell && s.shell.heapUsedBytes));
  if (s.transcripts && s.transcripts.length) {
    log(' ' + 'transcript'.padEnd(12) + ' ' + 'rows'.padStart(8) + ' '
    + 'first row'.padStart(10) + ' ' + 'complete'.padStart(10) + ' '
    + 'nodes'.padStart(9) + ' ' + 'heap'.padStart(10));
    for (const t of s.transcripts) {
      const name = t.label.length > 12 ? t.label.slice(0, 12) : t.label;
      log(' ' + name.padEnd(12) + ' ' + String(t.rows).padStart(8) + ' '
        + fmtMs(t.firstRowMs).padStart(10) + ' ' + fmtMs(t.completeMs).padStart(10) + ' '
        + String(t.domNodes).padStart(9) + ' ' + fmtBytes(t.heapUsedBytes).padStart(10));
    }
  }
  if (s.server && s.server.rssBytes) log(' server RSS ' + fmtBytes(s.server.rssBytes) + ' (pid ' + s.server.pid + ')');
  log('────────────────────────────────────────────────────────');
  log(' report: ' + path.relative(ROOT, file));
  if (report.seeded && report.seeded.removed) {
    log(' seeded chats removed: ' + report.seeded.removed.removed);
  }
  for (const note of report.notes || []) log(' · ' + note);
}

// Exported for scripts/test-perf-profile.js: the report builders are pure, so
// the regression test can hold them to "only state measured numbers" without
// Chrome, the server, or a real store.
//
// `main()` only runs when this file is executed directly, so importing it for
// its helpers never seeds a chat or drives a browser.
export { summarizeReport, buildNotes, parseArgs, fmtBytes, fmtMs, summarize, summarizeHeapSnapshot };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    log('FAILED: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}
