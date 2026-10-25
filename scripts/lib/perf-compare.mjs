// Compare two perf-profile reports.
//
// Pure functions: reports in, a plain result object out, so the regression test
// can hold them to the rules below without Chrome or a server.
//
//   * Every metric is "lower is better", so a rise is a regression.
//   * A change inside the noise band is reported as "same". Timings from one
//     run each move by 15% or more (a 30-row chat opened slower than a
//     500-row one in the recorded baseline), so the default band is wide.
//   * Transcripts are paired by exact label. Synthetic labels are stable; a
//     real chat's label carries its title, so a chat that changed or was
//     renamed is listed as unmatched instead of being compared with another.
//   * Reports from different machines, browsers or viewports are still
//     compared, but the result says so.

const DEFAULT_TOLERANCE = 15;
// Counts that come from a fixed fixture barely move between runs.
const COUNT_TOLERANCE = 2;
// A change smaller than this is noise whatever the percentage says.
const MIN_ABS = { ms: 25, bytes: 1024 * 1024, count: 5 };

const SHELL_METRICS = [
  { key: 'shellMs', label: 'shell load', unit: 'ms', get: (r) => r.summary && r.summary.shell && r.summary.shell.shellMs },
  { key: 'fcpMs', label: 'first contentful paint', unit: 'ms', get: (r) => r.summary && r.summary.shell && r.summary.shell.fcpMs },
  { key: 'loadMs', label: 'document load', unit: 'ms', get: (r) => r.summary && r.summary.shell && r.summary.shell.loadMs },
  { key: 'heapUsedBytes', label: 'JS heap after load', unit: 'bytes', get: (r) => r.summary && r.summary.shell && r.summary.shell.heapUsedBytes }
];

const SERVER_METRICS = [
  { key: 'rssBytes', label: 'server RSS', unit: 'bytes', get: (r) => r.server && r.server.rssBytes },
  { key: 'threads', label: 'server threads', unit: 'count', get: (r) => r.server && r.server.threads }
];

// Read from the full transcript entry, not the summary, so the whole-history
// numbers (where memory actually grows) take part in the comparison.
const TRANSCRIPT_METRICS = [
  { key: 'firstRowMs', label: 'first row', unit: 'ms', get: (e) => e.open && e.open.firstRowMs },
  { key: 'completeMs', label: 'complete', unit: 'ms', get: (e) => e.open && e.open.completeMs },
  { key: 'domNodes', label: 'DOM nodes', unit: 'count', get: (e) => e.heap && e.heap.domNodes },
  { key: 'heapUsedBytes', label: 'JS heap', unit: 'bytes', get: (e) => e.heap && e.heap.jsHeapUsed },
  { key: 'retainedAfterLeaveBytes', label: 'heap kept after leaving', unit: 'bytes', get: (e) => e.heap && e.heap.retainedAfterLeave },
  { key: 'longestTaskMs', label: 'longest task', unit: 'ms', get: (e) => e.trace && e.trace.longestTasks && e.trace.longestTasks[0] && e.trace.longestTasks[0].ms },
  { key: 'scrollMsPerStep', label: 'scroll per step', unit: 'ms', get: (e) => e.scroll && e.scroll.msPerStep },
  { key: 'drainMedianPageMs', label: 'history page (median)', unit: 'ms', get: (e) => e.fullHistory && e.fullHistory.pageMs && e.fullHistory.pageMs.median },
  { key: 'drainHeapGrowthBytes', label: 'heap growth draining history', unit: 'bytes', get: (e) => e.fullHistory && e.fullHistory.heapGrowth },
  { key: 'drainNodes', label: 'DOM nodes after draining', unit: 'count', get: (e) => e.fullHistory && e.fullHistory.nodesAfter }
];

const ENV_FIELDS = [
  ['browser', 'Chrome version'],
  ['platform', 'platform'],
  ['nodeVersion', 'Node version'],
  ['host', 'host'],
  ['cpus', 'CPU count'],
  ['visibility', 'tab visibility'],
  ['auth', 'sign-in mode']
];

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// compareValue(base, head, unit, tolerance) → one metric's verdict.
function compareValue(base, head, unit, tolerance = DEFAULT_TOLERANCE) {
  const a = num(base);
  const b = num(head);
  if (a == null || b == null) return { base: a, head: b, delta: null, pct: null, verdict: 'missing' };
  const delta = b - a;
  const pct = a === 0 ? (b === 0 ? 0 : null) : (delta / Math.abs(a)) * 100;
  const band = unit === 'count' ? Math.min(tolerance, COUNT_TOLERANCE) : tolerance;
  const small = Math.abs(delta) < MIN_ABS[unit];
  const inside = small || (pct != null && Math.abs(pct) <= band);
  const verdict = inside ? 'same' : delta > 0 ? 'worse' : 'better';
  return { base: a, head: b, delta, pct, verdict };
}

function envDifferences(base, head) {
  const a = base.environment || {};
  const b = head.environment || {};
  const out = [];
  for (const [key, label] of ENV_FIELDS) {
    if (a[key] !== b[key]) out.push({ field: label, base: a[key] == null ? null : a[key], head: b[key] == null ? null : b[key] });
  }
  const va = a.viewport || {};
  const vb = b.viewport || {};
  if (va.width !== vb.width || va.height !== vb.height || va.deviceScaleFactor !== vb.deviceScaleFactor) {
    const fmt = (v) => (v.width ? v.width + '×' + v.height + ' @' + v.deviceScaleFactor + 'x' : null);
    out.push({ field: 'viewport', base: fmt(va), head: fmt(vb) });
  }
  return out;
}

function pairMetrics(metrics, readBase, readHead, tolerance) {
  const out = [];
  for (const m of metrics) {
    const r = compareValue(m.get(readBase), m.get(readHead), m.unit, tolerance);
    if (r.verdict === 'missing' && r.base == null && r.head == null) continue;
    out.push({ key: m.key, label: m.label, unit: m.unit, ...r });
  }
  return out;
}

// compareReports(base, head, { tolerance }) → { environment, shell, server,
// transcripts, unmatched, counts }. `base` is the older run.
function compareReports(base, head, opts = {}) {
  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : DEFAULT_TOLERANCE;
  const baseList = (base && base.transcripts) || [];
  const headList = (head && head.transcripts) || [];

  const transcripts = [];
  const matchedHead = new Set();
  for (const be of baseList) {
    const he = headList.find((e) => e.label === be.label);
    if (!he) continue;
    matchedHead.add(he);
    transcripts.push({
      label: be.label,
      kind: be.kind,
      rows: { base: be.source && be.source.rows, head: he.source && he.source.rows },
      metrics: pairMetrics(TRANSCRIPT_METRICS, be, he, tolerance)
    });
  }
  const unmatched = [
    ...baseList.filter((e) => !headList.some((h) => h.label === e.label)).map((e) => ({ label: e.label, only: 'base' })),
    ...headList.filter((e) => !matchedHead.has(e)).map((e) => ({ label: e.label, only: 'head' }))
  ];

  const shell = pairMetrics(SHELL_METRICS, base, head, tolerance);
  const server = pairMetrics(SERVER_METRICS, base, head, tolerance);

  const counts = { worse: 0, better: 0, same: 0, missing: 0 };
  for (const m of [...shell, ...server, ...transcripts.flatMap((t) => t.metrics)]) counts[m.verdict]++;

  return {
    tolerance,
    base: { stamp: base.stamp || null, generatedAt: base.generatedAt || null },
    head: { stamp: head.stamp || null, generatedAt: head.generatedAt || null },
    environment: envDifferences(base, head),
    shell,
    server,
    transcripts,
    unmatched,
    counts
  };
}

export { compareReports, compareValue, envDifferences, DEFAULT_TOLERANCE };
