'use strict';

// AI proxy REST handlers. Extracted from the original single-file
// http-server.js. Shared helpers + model resolution live in
// src/server-shared.js.

const {
  sendJSON,
  readJsonOr400,
  resolveModel,
  credentialForProvider,
  settings,
  projects,
  ai
} = require('./server-shared.js');
const modelList = require('./modelList.js');

async function handleAI(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;

  // GET /api/ai/models?projectDir=<abs>  -> list models visible to this project
  if (urlPath === '/api/ai/models' && method === 'GET') {
    const projectDir = typeof parsed.query.projectDir === 'string' ? parsed.query.projectDir : '';
    const resolved = settings.getResolved(projectDir || null);
    const models = (resolved.models || []).map(m => {
      const rec = {
        id: m.id, provider: m.provider, label: m.label, auth: m.auth || 'apikey'
      };
      // Thinking options come from the provider when it reports them
      // (per-model on live lists, provider-level otherwise); a
      // user-set model.thinking always wins.
      const def = ai.ENDPOINTS[m.provider];
      const thinking = m.thinking || (def && def.thinkingDescriptor) || null;
      if (thinking) rec.thinking = thinking;
      return rec;
    });
    return sendJSON(res, 200, { models, providers: Object.keys(ai.ENDPOINTS) });
  }

  // GET /api/ai/models/live?provider=<id>  -> { models, fetchedAt, cached }
  // Live model list fetched from the upstream /models endpoint
  // (OpenAI-shaped), Gemini's /v1beta/models, Ollama's /api/tags, or
  // the curated Copilot catalog. Results are cached per-provider in
  // memory for an hour so opening many chats does not re-hit the
  // upstream. The chat UI calls this from the refresh button next to
  // the model <select>.
  //
  // The fetch + cache live in src/modelList.js, because the dictation
  // catalog needs the same answer filtered differently. `_bust=1` forces a
  // reload (the picker's explicit refresh).
  if (urlPath === '/api/ai/models/live' && method === 'GET') {
    const provider = typeof parsed.query.provider === 'string' ? parsed.query.provider : '';
    if (!provider || !ai.ENDPOINTS[provider]) {
      return sendJSON(res, 400, { error: 'unknown provider', provider });
    }
    // `purpose` selects which slice of the provider's catalog to read:
    // `chat` (default) or `transcription`. A provider without a separate
    // slice returns its chat list.
    const purposeRaw = typeof parsed.query.purpose === 'string' ? parsed.query.purpose : '';
    const purpose = purposeRaw === 'transcription' ? purposeRaw : undefined;
    try {
    const result = await modelList.liveModelsFor(provider, { force: !!parsed.query._bust, purpose });
    return sendJSON(res, 200, { models: result.models, fetchedAt: result.fetchedAt, cached: result.cached });
    } catch (err) {
      // Map typed error codes to HTTP statuses. 502 is reserved for
      // "upstream answered with a non-2xx" (EUPSTREAM) — anything
      // that isn't a recognized failure shape falls through to a
      // generic 502 so a regression in the adapter still surfaces
      // somewhere observable. Distinct failure modes get distinct
      // statuses so the chat UI can show a useful next step.
      const code = err && err.code;
      let status;
      if (code === 'ENO_LIST')       status = 400;
      else if (code === 'ENO_APIKEY') status = 400;
      else if (code === 'EUNREACHABLE') status = 503;
      else if (code === 'ETIMEOUT') status = 504;
      else if (code === 'EUPSTREAM' && typeof err.status === 'number') status = err.status;
      else                            status = 502;
      const body = { error: String((err && err.message) || err), code: code || 'ELIVE', provider };
      if (code === 'EUPSTREAM' && typeof err.status === 'number') body.upstreamStatus = err.status;
      return sendJSON(res, status, body);
    }
  }

  // GET /api/ai/provider-credit?provider=<id> -> { supported, remaining? }
  // Provider-specific account balance lookup. Only OpenRouter exposes a
  // simple key-scoped credits endpoint; unsupported providers return
  // { supported: false } so the chat head can hide the pill.
  if (urlPath === '/api/ai/provider-credit' && method === 'GET') {
    const provider = typeof parsed.query.provider === 'string' ? parsed.query.provider : '';
    if (provider !== 'openrouter') return sendJSON(res, 200, { provider, supported: false });
    let cred;
    try { cred = credentialForProvider(provider); }
    catch (e) { return sendJSON(res, 400, { provider, supported: true, error: e.message, code: e.code || 'ENO_APIKEY' }); }
    if (!cred) return sendJSON(res, 400, { provider, supported: true, error: 'OpenRouter API key required', code: 'ENO_APIKEY' });
    let r;
    try {
      r = await fetch(ai.ENDPOINTS.openrouter.baseUrl + '/credits', {
        headers: { ...ai.ENDPOINTS.openrouter.authHeader(cred), ...ai.ENDPOINTS.openrouter.staticHeaders }
      });
    } catch (e) {
      return sendJSON(res, 503, { provider, supported: true, error: 'OpenRouter unreachable', code: 'EUNREACHABLE' });
    }
    if (!r.ok) return sendJSON(res, r.status, { provider, supported: true, error: 'OpenRouter returned ' + r.status, code: 'EUPSTREAM' });
    const body = await r.json().catch(() => ({}));
    const data = body && body.data ? body.data : body;
    const totalCredits = Number(data && (data.total_credits ?? data.totalCredits ?? data.credits));
    const totalUsage = Number(data && (data.total_usage ?? data.totalUsage ?? data.usage));
    const remaining = Number(data && (data.remaining_credits ?? data.remainingCredits ?? data.remaining));
    const value = isFinite(remaining) ? remaining : (isFinite(totalCredits) && isFinite(totalUsage) ? totalCredits - totalUsage : NaN);
    if (!isFinite(value)) return sendJSON(res, 502, { provider, supported: true, error: 'OpenRouter credit response missing totals', code: 'EBAD_CREDITS' });
    return sendJSON(res, 200, { provider, supported: true, label: 'Balance', remaining: value, totalCredits: isFinite(totalCredits) ? totalCredits : undefined, totalUsage: isFinite(totalUsage) ? totalUsage : undefined });
  }

  // GET /api/ai/models/providers -> { providers: [{ id }] }
  // The chat uses this when a project has no model records yet. Returning
  // every configured connection avoids the old "first provider wins"
  // fallback, which silently queried OpenAI when the user wanted OpenRouter.
  if (urlPath === '/api/ai/models/providers' && method === 'GET') {
    const app = settings.getApp();
    const providers = (Array.isArray(app.providers) ? app.providers : [])
      .filter((p) => p && typeof p.id === 'string' && ai.ENDPOINTS[p.id])
      .map((p) => ({ id: p.id }));
    return sendJSON(res, 200, { providers });
  }

  // GET /api/ai/models-all  -> { ids: [..] }
  // Union of every model id the user has configured across every
  // registered project + the app-level models list. Used by the
  // SettingsPricing view to surface "the ids you might want to
  // price" without forcing the user to remember project paths.
  if (urlPath === '/api/ai/models-all' && method === 'GET') {
    const ids = new Set();
    // App-level models (legacy / inline pricing tests)
    const app = settings.getApp();
    if (Array.isArray(app.models)) {
      for (const m of app.models) if (m && m.id) ids.add(m.id);
    }
    // Project-level models. Each registered project has its own
    // .mouaif.json; the registry is the source of truth for which
    // projects still exist on disk.
    const registered = projects.listProjects();
    for (const p of registered) {
      if (!p || !p.path) continue;
      try {
        const projSettings = settings.getProject(p.path);
        if (Array.isArray(projSettings.models)) {
          for (const m of projSettings.models) if (m && m.id) ids.add(m.id);
        }
      } catch { /* unreadable project file — skip */ }
    }
    return sendJSON(res, 200, { ids: Array.from(ids).sort() });
  }

  // POST /api/ai/test  body: { modelId, projectDir? }  -> { ok, error? }
  // Lightweight connectivity test: sends a single "hi" message and
  // checks whether the upstream returns a typed error or a 200 SSE
  // stream. Aborts after 10 s so the user never waits long.
  if (urlPath === '/api/ai/test' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;

    let model;
    try { model = resolveModel(body.modelId, body.projectDir); }
    catch (e) { return sendJSON(res, 400, { error: e.message, code: e.code }); }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10000);
    try {
      const result = await ai.streamChat({
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        signal: controller.signal,
        onEvent: () => {} // discard events, we only care about ok/error
      });
      clearTimeout(timer);
      if (result.ok) return sendJSON(res, 200, { ok: true });
      if (timedOut && result.error && result.error.code === 'EABORTED') {
        return sendJSON(res, 200, { ok: false, error: 'timed out after 10 s', code: 'ETIMEDOUT' });
      }
      return sendJSON(res, 200, { ok: false, error: (result.error && result.error.message) || 'upstream error' });
    } catch (e) {
      clearTimeout(timer);
      const code = e.code || 'ETEST';
      if (timedOut || code === 'EABORTED') {
        return sendJSON(res, 200, { ok: false, error: 'timed out after 10 s', code: 'ETIMEDOUT' });
      }
      return sendJSON(res, 200, { ok: false, error: e.message, code });
    }
  }

  // POST /api/ai/chat  body: { modelId, messages, projectDir? }  -> SSE stream
  if (urlPath === '/api/ai/chat' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;

    let model;
    try { model = resolveModel(body.modelId, body.projectDir); }
    catch (e) { return sendJSON(res, 400, { error: e.message, code: e.code }); }

    // Open SSE.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    // Initial comment so the client sees headers immediately.
    res.write(': connected\n\n');

    const controller = new AbortController();
    req.on('close', () => { try { controller.abort(); } catch { /* ignore */ } });

    function emit(name, data) {
      try {
        res.write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n');
      } catch { /* socket already closed */ }
    }

    const result = await ai.streamChat({
      model,
      messages: body.messages || [],
      signal: controller.signal,
      onEvent: (name, data) => emit(name, data)
    });

    if (!result.ok) {
      emit('error', Object.assign({ code: result.error.code || 'EUPSTREAM' }, result.error));
    }
    res.end();
    return;
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'ai' });
}

module.exports = { handleAI };
