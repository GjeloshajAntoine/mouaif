'use strict';

// Weekly download counts for MCP Registry entries — the store's popularity
// signal. The MCP Registry publishes no download counts or ratings, so the
// /api/mcp/registry proxy asks the package registries themselves:
//
//   npm   https://api.npmjs.org/downloads/point/last-week/<pkg>[,<pkg>…]
//   PyPI  https://pypistats.org/api/packages/<pkg>/recent?period=week
//
// Hosted-only servers and other package types (OCI, NuGet, MCPB, Cargo) have
// no public weekly count, so they get none — the store shows nothing rather
// than an invented number.
//
// Counts are kept in memory only (never on disk) for a few hours, so a search
// typed letter by letter does not re-ask npm for the same packages. A lookup
// that fails or times out is remembered briefly and the entry simply has no
// count. See docs/features/mcp-registry-browser.md.

const TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE = 3000;
const TIMEOUT_MS = 2500;
const CONCURRENCY = 6;
const NPM_BULK = 100; // npm accepts up to 128 unscoped names per bulk call

const cache = new Map(); // 'npm:<name>' -> { at, ttl, value: number|null }

function cacheGet(key, now) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (now - hit.at > hit.ttl) { cache.delete(key); return undefined; }
  return hit.value;
}

function cacheSet(key, value, now, ttl) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, { at: now, ttl, value });
}

function pypiName(name) {
  return String(name).trim().toLowerCase().replace(/[-_.]+/g, '-');
}

// packagesOf(entry) -> [{ source: 'npm'|'pypi', name }] the countable
// packages an entry ships, deduplicated.
function packagesOf(entry) {
  const pkgs = (entry && entry.server && Array.isArray(entry.server.packages)) ? entry.server.packages : [];
  const out = [];
  const seen = new Set();
  for (const p of pkgs) {
    if (!p || typeof p.identifier !== 'string' || !p.identifier.trim()) continue;
    const type = String(p.registryType || '').toLowerCase();
    let source = '';
    let name = p.identifier.trim();
    if (type === 'npm') source = 'npm';
    else if (type === 'pypi') { source = 'pypi'; name = pypiName(name); }
    if (!source) continue;
    const key = source + ':' + name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source, name });
  }
  return out;
}

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// Returns Map name -> number|null for the given npm names.
async function npmLookups(fetchImpl, names) {
  const tasks = [];
  const unscoped = names.filter((n) => !n.startsWith('@'));
  const scoped = names.filter((n) => n.startsWith('@'));
  // npm's bulk form is unscoped-only, and a single name answers in the
  // single-package shape, so one name goes through the per-package call.
  for (let i = 0; i < unscoped.length; i += NPM_BULK) {
    const chunk = unscoped.slice(i, i + NPM_BULK);
    if (chunk.length === 1) { scoped.push(chunk[0]); continue; }
    tasks.push(async () => {
      const body = await getJson(fetchImpl, 'https://api.npmjs.org/downloads/point/last-week/' + chunk.map(encodeURIComponent).join(','));
      return chunk.map((n) => [n, body && body[n] && Number.isFinite(body[n].downloads) ? body[n].downloads : null]);
    });
  }
  for (const n of scoped) {
    tasks.push(async () => {
      const body = await getJson(fetchImpl, 'https://api.npmjs.org/downloads/point/last-week/' + n.replace('/', '%2F'));
      return [[n, body && Number.isFinite(body.downloads) ? body.downloads : null]];
    });
  }
  return runTasks(tasks);
}

async function pypiLookups(fetchImpl, names) {
  const tasks = names.map((n) => async () => {
    const body = await getJson(fetchImpl, 'https://pypistats.org/api/packages/' + encodeURIComponent(n) + '/recent?period=week');
    const v = body && body.data && body.data.last_week;
    return [[n, Number.isFinite(v) ? v : null]];
  });
  return runTasks(tasks);
}

// Runs lookups CONCURRENCY at a time. A failed task leaves its names out of
// the result, so the caller can tell "no count" (null) from "unknown".
async function runTasks(tasks) {
  const out = new Map();
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const task = tasks[next++];
      try { for (const [k, v] of await task()) out.set(k, v); } catch { /* unknown, see FAIL_TTL_MS */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
  return out;
}

// weeklyDownloads(entries, opts) -> Array<null | { weekly, source, package }>
// aligned with `entries`. An entry with several countable packages reports
// its most downloaded one.
async function weeklyDownloads(entries, opts) {
  const o = opts || {};
  const fetchImpl = o.fetch || globalThis.fetch;
  const now = o.now || Date.now();
  const list = Array.isArray(entries) ? entries : [];
  const perEntry = list.map(packagesOf);
  const want = { npm: new Set(), pypi: new Set() };
  for (const pkgs of perEntry) {
    for (const p of pkgs) if (cacheGet(p.source + ':' + p.name, now) === undefined) want[p.source].add(p.name);
  }
  const [npm, pypi] = await Promise.all([
    want.npm.size ? npmLookups(fetchImpl, [...want.npm]) : new Map(),
    want.pypi.size ? pypiLookups(fetchImpl, [...want.pypi]) : new Map()
  ]);
  for (const [source, asked, got] of [['npm', want.npm, npm], ['pypi', want.pypi, pypi]]) {
    for (const name of asked) {
      if (got.has(name)) cacheSet(source + ':' + name, got.get(name), now, TTL_MS);
      else cacheSet(source + ':' + name, null, now, FAIL_TTL_MS);
    }
  }
  return perEntry.map((pkgs) => {
    let best = null;
    for (const p of pkgs) {
      const v = cacheGet(p.source + ':' + p.name, now);
      if (Number.isFinite(v) && (!best || v > best.weekly)) best = { weekly: v, source: p.source, package: p.name };
    }
    return best;
  });
}

function clearCache() { cache.clear(); }

module.exports = { weeklyDownloads, packagesOf, clearCache };
