'use strict';

// The per-provider live model list, shared by the two endpoints that need it.
//
// `/api/ai/models/live` (the chat picker's refresh) and
// `/api/ai/transcribe/models` (the Dictate tab) ask the same question of the
// same upstream — "what models does this provider offer right now?" — and an
// hour-long cache keyed by provider + credential hash already existed for the
// first. Dictation needs a *filtered* slice of the same answer, so the fetch
// and the cache moved here rather than being duplicated.
//
// Errors are typed and propagated; callers decide what a failure means.
// `/api/ai/models/live` maps them onto 4xx/5xx statuses, while the dictation
// catalog treats a provider that cannot answer as "no extra models" — one
// unreachable provider must not empty the whole picker.

const { ai, credentialForProvider, hashShort, MODEL_LIST_CACHE, MODEL_LIST_TTL_MS, MODEL_LIST_TIMEOUT_MS } = require('./server-shared.js');

// liveModelsFor(provider, opts) -> { models, fetchedAt, cached }
//
// opts.force — bypass the cache (the chat picker's explicit refresh).
//
// `cached` reports whether the returned list came from the in-memory cache,
// which the HTTP layer echoes to the client; it must reflect the actual hit,
// not merely that no bypass was requested.
//
// Typed errors: `EUNKNOWN_PROVIDER`, `ENO_APIKEY`, `EUNREACHABLE`, `EUPSTREAM`
// (with `.status`), `ETIMEOUT`. The http-server maps them the same way it
// always did.
async function liveModelsFor(provider, opts) {
  if (!provider || !ai.ENDPOINTS[provider]) {
    const e = new Error('unknown provider');
    e.code = 'EUNKNOWN_PROVIDER';
    throw e;
  }
  let cred = null;
  try { cred = credentialForProvider(provider); }
  catch { /* the adapter surfaces ENO_APIKEY when a credential is required */ }

  // Keyed by provider + credential hash so rotating a key cannot serve the
  // previous account's list.
  const cacheKey = provider + ':' + (cred ? hashShort(cred) : '-');
  const now = Date.now();
  if (opts && opts.force) MODEL_LIST_CACHE.delete(cacheKey);
  const cached = MODEL_LIST_CACHE.get(cacheKey);
  if (cached && (now - cached.fetchedAt) < MODEL_LIST_TTL_MS) {
    return { models: cached.models, fetchedAt: cached.fetchedAt, cached: true };
  }

  // Bound the call so a slow upstream cannot hang the request.
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, MODEL_LIST_TIMEOUT_MS);
  try {
    const models = await ai.listModels(...(cred ? [provider, cred, ac.signal] : [provider, null, ac.signal]));
    clearTimeout(timer);
    // Discard the late result: the caller already saw the timeout.
    if (timedOut) {
      const e = new Error('Timed out after ' + Math.round(MODEL_LIST_TIMEOUT_MS / 1000) + 's waiting for ' + provider + ' upstream');
      e.code = 'ETIMEOUT';
      e.status = 504;
      throw e;
    }
    const fetchedAt = Date.now();
    MODEL_LIST_CACHE.set(cacheKey, { models, fetchedAt });
    return { models, fetchedAt, cached: false };
  } catch (err) {
    clearTimeout(timer);
    if (timedOut || (err && err.code === 'ETIMEOUT')) {
      const e = new Error('Timed out after ' + Math.round(MODEL_LIST_TIMEOUT_MS / 1000) + 's waiting for ' + provider + ' upstream');
      e.code = 'ETIMEOUT';
      e.status = 504;
      throw e;
    }
    throw err;
  }
}

// liveModelsForMany(providers, opts) -> { list, failures }
//
// Best-effort across providers, for the dictation catalog: a provider that
// cannot answer contributes nothing and is reported in `failures` instead of
// failing the whole request. Rows are tagged with their provider so a caller
// that merges several catalogs can tell them apart.
async function liveModelsForMany(providers, opts) {
  const list = [];
  const failures = [];
  const results = await Promise.all((Array.isArray(providers) ? providers : []).map(async (provider) => {
    try {
      const result = await liveModelsFor(provider, opts);
      return { provider, models: result.models };
    } catch (e) {
      return { provider, error: e };
    }
  }));
  for (const result of results) {
    if (result.error) {
      failures.push({ provider: result.provider, code: result.error.code || 'EUPSTREAM', error: result.error.message || String(result.error) });
      continue;
    }
    for (const m of (result.models || [])) {
      if (!m || !m.id) continue;
      list.push(Object.assign({}, m, { provider: result.provider }));
    }
  }
  return { list, failures };
}

module.exports = { liveModelsFor, liveModelsForMany };
