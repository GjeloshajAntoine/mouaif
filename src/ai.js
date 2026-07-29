'use strict';

// AI client core.
//
// Implements docs/decisions.md section 10: server-side proxy with SSE
// streaming for six providers (openai-compatible, anthropic, gemini,
// ollama, github-copilot, openrouter). The mobile UI never holds an
// API key — it POSTs to /api/ai/chat and reads the SSE stream back.
//
// Per-model auth (decision 11) is wired but only 'apikey' is honored in
// this commit. 'oauth' is recognized and produces a typed ENOAUTH error;
// the OAuth commits land separately.
//
// Public surface:
//
//   streamChat({ model, messages, signal, onEvent }) -> Promise<{ ok, usage, error? }>
//
// `model` is the resolved model record (id, provider, baseUrl, apiKey,
// contextWindow, ...). `messages` is the OpenAI-style array:
//   [{ role: 'system'|'user'|'assistant', content: '...' }, ...]
// `signal` is an AbortSignal so the HTTP layer can cancel mid-stream.
// `onEvent(eventName, data)` is called for every SSE event as it
// arrives. The function returns once the upstream has finished (or
// failed). Usage is reported in `{ promptTokens, completionTokens }`.
//
// Each provider has a `buildRequest(model, messages)` and a
// `parseEvent(eventName, data)` so adding a new provider is a localized
// change.

const toolFeedback = require('./toolFeedback.js');

// ---- Provider endpoints ------------------------------------------------

const ENDPOINTS = {
  'openai-compatible': {
    chatPath: '/chat/completions',
    authHeader: (apiKey) => ({ 'Authorization': 'Bearer ' + apiKey }),
    // GET {baseUrl}/models — OpenAI-shaped. Optional key in practice,
    // but in this env the upstream returns 401 when no Authorization
    // header is sent, so treat "no cred" as a typed ENO_APIKEY error
    // instead of a generic upstream 401.
    listModels: async (cred, signal) => {
      const def = ENDPOINTS['openai-compatible'];
      const url = (def.baseUrl || 'https://api.openai.com/v1') + '/models';
      let r;
      try { r = await fetch(url, { headers: cred ? def.authHeader(cred) : {}, signal }); }
      catch (e) { throw unreachableError('openai-compatible', e); }
      if (r.status === 401 || r.status === 403) {
        if (!cred) throw noApiKeyError('openai-compatible');
        throw httpError(r);
      }
      if (!r.ok) throw httpError(r);
      const body = await r.json();
      return parseOpenAIShapedModels(body, (m) => thinkingForOpenAIModel(m.id));
    }
  },
  'anthropic': {
    baseUrl: 'https://api.anthropic.com',
    chatPath: '/v1/messages',
    anthropicVersion: '2023-06-01',
    // Anthropic does not expose a public list-models endpoint; the
    // /v1/models beta is OAuth-only and is not reachable with a
    // standard API key. Ship a curated catalog that mirrors the
    // models documented at https://docs.claude.com/en/docs/about-claude/models.
    // Every current Claude model supports extended thinking with a raw
    // token budget, so the descriptor is uniform across the catalog.
    listModels: async () => parseCuratedModels(ANTHROPIC_MODEL_CATALOG, { kind: 'budget' }),
    // Per the official `ant` CLI source and the platform.claude.com
    // docs: API-key auth uses the `x-api-key` header; OAuth user_oauth
    // tokens use `Authorization: Bearer ...` and require the
    // `anthropic-beta: oauth-2025-04-20` header. The header is decided
    // at request time from model.auth so the same provider can serve
    // both flows.
    authHeader: (cred, model) => {
      if (model && model.auth === 'oauth') {
        return {
          'Authorization': 'Bearer ' + cred,
          'anthropic-beta': 'oauth-2025-04-20'
        };
      }
      return { 'x-api-key': cred, 'anthropic-version': '2023-06-01' };
    }
  },
  'gemini': {
    // Gemini uses a per-model action path; see buildRequest.
    baseUrl: 'https://generativelanguage.googleapis.com',
    authHeader: (apiKey) => ({ 'x-goog-api-key': apiKey }),
    // GET /v1beta/models?key=<key> — Gemini-shaped (no Bearer header;
    // key is a query param). The unauthenticated call used to be
    // public, but the public list endpoint now returns 403 without
    // a key, so a missing cred is a typed ENO_APIKEY error rather
    // than a generic upstream 403.
    listModels: async (cred, signal) => {
      const url = ENDPOINTS.gemini.baseUrl + '/v1beta/models?pageSize=200'
        + (cred ? '&key=' + encodeURIComponent(cred) : '');
      let r;
      try { r = await fetch(url, { signal }); }
      catch (e) { throw unreachableError('gemini', e); }
      if (r.status === 401 || r.status === 403) {
        if (!cred) throw noApiKeyError('gemini');
        throw httpError(r);
      }
      if (!r.ok) throw httpError(r);
      const body = await r.json();
      return parseGeminiModels(body);
    }
  },
  'ollama': {
    baseUrl: 'http://127.0.0.1:11434',
    chatPath: '/api/chat',
    // No auth header. Ollama streams NDJSON, not SSE — we adapt below.
    authHeader: () => ({}),
    streamFormat: 'ndjson',
    // GET /api/tags — Ollama's local catalog (no auth). When the local
    // server is not running, fetch() throws TypeError("fetch failed")
    // (Node 18+ collapses ECONNREFUSED / ENOTFOUND into a generic
    // failure). Surface that as EUNREACHABLE so the HTTP layer can
    // return 503 "service unavailable" instead of a misleading 502
    // "bad gateway".
    listModels: async (cred, signal) => {
      const url = ENDPOINTS.ollama.baseUrl + '/api/tags';
      let r;
      try { r = await fetch(url, { signal }); }
      catch (e) { throw unreachableError('ollama', e); }
      if (!r.ok) throw httpError(r);
      const body = await r.json();
      return parseOllamaModels(body);
    },
    // Ollama exposes reasoning as a boolean `think` flag on the chat
    // request for thinking-capable models (deepseek-r1, qwq, gpt-oss).
    thinkingDescriptor: { kind: 'toggle' }
  },
  'github-copilot': {
    // The base URL points at the public Copilot API. Calls require a
    // short-lived Copilot token that is derived per-request from the
    // GitHub OAuth token stored in the keychain. The exchange is
    // performed by oauth-github-copilot.js and the resolved token
    // lands on model.__accessToken (replacing the GitHub token that
    // requireApiKey wrote there). The auth header is identical to
    // the openai-compatible path: a plain Bearer credential.
    baseUrl: 'https://api.githubcopilot.com',
    chatPath: '/chat/completions',
    authHeader: (cred) => ({ 'Authorization': 'Bearer ' + cred }),
    // Copilot does not expose a public list-models endpoint. Return
    // a small curated list of the model ids the Copilot API actually
    // serves today. Kept in sync with the public Copilot docs; the
    // `contextWindow` field is the upstream maximum. Thinking support
    // is inferred per family: OpenAI reasoning models take effort
    // levels, Claude models take a token budget, Gemini 2.5+ takes a
    // thinking budget.
    listModels: async () => parseCuratedModels(COPILOT_MODEL_CATALOG, (m) => {
      const id = String(m.id || '');
      if (/^(gpt-5|o\d)/.test(id)) return { kind: 'levels', levels: OPENAI_THINKING_LEVELS.slice() };
      if (/^claude-/.test(id)) return { kind: 'budget' };
      if (/^gemini-(2\.5|[3-9])/.test(id)) return { kind: 'budget' };
      return undefined;
    }),
    // Copilot requires a handful of editor-identifying headers. The
    // values mirror the public Copilot CLI; they identify this
    // client as a third-party tool without sending PII. Tests can
    // override these by setting model.headers at the call site.
    staticHeaders: {
      'Editor-Version': 'vscode/1.95.0',
      'Editor-Plugin-Version': 'copilot/1.0.0',
      'Editor-Schema-Version': 'v1',
      'User-Agent': 'mouaif/1.0',
      'Copilot-Integration-Id': 'mouaif'
    }
  },
  // OpenRouter: OpenAI-shaped chat completions at
  // https://openrouter.ai/api/v1/chat/completions. API-key only
  // (OpenRouter does not expose an OAuth flow); the key lives in
  // the standard OpenAI keyring namespace so users do not have to
  // juggle a second credential store. Per OpenRouter's docs, every
  // request should carry an `HTTP-Referer` and `X-OpenRouter-Title`
  // header so the app shows up correctly on the public leaderboard.
  // The X-OpenRouter-Title is resolved at request time from
  // app.openRouter.appName; the shipped defaults are the floor
  // (mouaif is the only client that makes these calls).
  'openrouter': {
    baseUrl: 'https://openrouter.ai/api/v1',
    chatPath: '/chat/completions',
    authHeader: (cred) => ({ 'Authorization': 'Bearer ' + cred }),
    // GET /api/v1/models — OpenAI-shaped. OpenRouter allows the public
    // list unauthenticated, so missing cred is fine here; upstream
    // errors are surfaced as EUPSTREAM with the upstream status, and
    // a network failure is EUNREACHABLE (handled like the others).
    listModels: async (cred, signal) => {
      const url = ENDPOINTS.openrouter.baseUrl + '/models';
      let r;
      try { r = await fetch(url, { headers: cred ? ENDPOINTS.openrouter.authHeader(cred) : {}, signal }); }
      catch (e) { throw unreachableError('openrouter', e); }
      if (!r.ok) throw httpError(r);
      const body = await r.json();
      return parseOpenAIShapedModels(body, thinkingForOpenRouterModel);
    },
    staticHeaders: {
      'HTTP-Referer': 'https://mouaif.local',
      // The current OpenRouter API uses `X-OpenRouter-Title` as the
      // canonical attribution header. The earlier `X-Title` alias is
      // still accepted for back-compat but is silently dropped on
      // newer versions of the SSO/leaderboard path, so it is no
      // longer the primary signal. We send BOTH names so older and
      // newer OpenRouter releases both attribute the request
      // correctly. The values are placeholders; the real ones are
      // resolved at request time from app.openRouter.appName via
      // resolveOpenRouterStaticHeaders(). The shipped 'mouaif' is
      // the fallback when the user has not configured one.
      'X-OpenRouter-Title': 'mouaif',
      'X-Title': 'mouaif'
    }
  }
};

// resolveOpenRouterStaticHeaders() — returns the shipped static headers for
// the OpenRouter endpoint verbatim. The per-install app name override was
// removed; only the shipped defaults are used.
//
// Exists as a function so the call site (buildOpenAIRequest) can branch on
// `model.provider === 'openrouter'` without an ENDPOINTS mutation.
function resolveOpenRouterStaticHeaders() {
  return ENDPOINTS.openrouter.staticHeaders;
}

// ---- Model-list adapters ----------------------------------------------
//
// The chat <select> is populated dynamically from the upstream
// /models endpoint. Each ENDPOINTS entry above carries a listModels(cred)
// that returns a normalized [{ id, label, contextWindow? }]. Curated
// catalogs (Copilot) are listed inline so the picker still works when the
// upstream has no public list endpoint.

const COPILOT_MODEL_CATALOG = [
  { id: 'gpt-4o',           label: 'GPT-4o',                      contextWindow: 128000 },
  { id: 'gpt-4.1',          label: 'GPT-4.1',                     contextWindow: 1047576 },
  { id: 'gpt-5',            label: 'GPT-5',                       contextWindow: 400000 },
  { id: 'gpt-5-mini',       label: 'GPT-5 mini',                  contextWindow: 400000 },
  { id: 'claude-sonnet-4',  label: 'Claude Sonnet 4',             contextWindow: 200000 },
  { id: 'claude-sonnet-4.5',label: 'Claude Sonnet 4.5',           contextWindow: 200000 },
  { id: 'claude-opus-4',    label: 'Claude Opus 4',               contextWindow: 200000 },
  { id: 'gemini-2.5-pro',   label: 'Gemini 2.5 Pro',              contextWindow: 1048576 }
];

const ANTHROPIC_MODEL_CATALOG = [
  { id: 'claude-opus-4',    label: 'Claude Opus 4',               contextWindow: 200000 },
  { id: 'claude-opus-4.1',  label: 'Claude Opus 4.1',             contextWindow: 200000 },
  { id: 'claude-opus-4.5',  label: 'Claude Opus 4.5',             contextWindow: 200000 },
  { id: 'claude-sonnet-4',  label: 'Claude Sonnet 4',             contextWindow: 200000 },
  { id: 'claude-sonnet-4.5',label: 'Claude Sonnet 4.5',           contextWindow: 200000 },
  { id: 'claude-sonnet-5',  label: 'Claude Sonnet 5',             contextWindow: 1000000 },
  { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5',            contextWindow: 200000 },
  { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (legacy)', contextWindow: 200000 },
  { id: 'claude-3-5-haiku-20241022',  label: 'Claude 3.5 Haiku (legacy)',  contextWindow: 200000 }
];

function httpError(resp) {
  const e = new Error('upstream ' + resp.status + ' ' + resp.statusText);
  e.code = 'EUPSTREAM';
  e.status = resp.status;
  return e;
}

// noApiKeyError(provider, hint) — typed error thrown by listModels adapters
// when a provider requires a credential but none is configured. Lets the
// HTTP layer distinguish "add a key" (400 ENO_APIKEY) from "upstream
// misbehaved" (502 EUPSTREAM) so the chat UI can show an actionable
// message instead of a generic "model list failed".
function noApiKeyError(provider, hint) {
  const e = new Error('No API key configured for ' + provider + '. ' + (hint || 'Add one in Settings \u2192 Providers.'));
  e.code = 'ENO_APIKEY';
  e.provider = provider;
  return e;
}

// unreachableError(provider, cause) — typed error thrown when the upstream
// is not reachable (ECONNREFUSED, ENOTFOUND, fetch failed). Distinct from
// EUPSTREAM (upstream answered with a non-2xx) so the HTTP layer can
// return 503 "service unavailable" instead of 502 "bad gateway".
function unreachableError(provider, cause) {
  const e = new Error('Cannot reach ' + provider + ' upstream: ' + (cause && cause.message ? cause.message : String(cause || 'unknown')));
  e.code = 'EUNREACHABLE';
  e.provider = provider;
  e.cause = cause;
  return e;
}

// abortedError(provider) — typed error thrown when the upstream call was
// aborted by the per-call AbortController (timeout). Distinct from
// EUNREACHABLE so the HTTP layer can return 504 "gateway timeout" with
// a clear message instead of 503.
function abortedError(provider) {
  const e = new Error('Timed out waiting for ' + provider + ' upstream');
  e.code = 'EABORTED';
  e.provider = provider;
  return e;
}

// ---- Thinking capability descriptors ----------------------------------
//
// Each live model record may carry a `thinking` field describing the
// reasoning controls the provider actually accepts for that model:
//
//   { kind: 'levels', levels: ['low','medium','high'] }  — effort presets
//   { kind: 'budget'  }                                   — raw token budget
//
// The chat UI builds its thinking dropdown from this descriptor when
// present; when absent it falls back to the generic presets. The
// request builders accept any provider-reported level verbatim (they
// no longer whitelist only low/medium/high) so new upstream values
// (e.g. OpenAI's "minimal"/"xhigh") work without a client update.

// Effort levels known to be valid on OpenAI-shaped reasoning endpoints.
// Order matters: the UI shows them in this sequence.
const OPENAI_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

// thinkingForOpenAIModel(id) — best-effort static inference for the
// openai-compatible provider, whose /models endpoint does not report
// reasoning support. Returns undefined when the id gives no signal so
// the UI falls back to generic presets.
function thinkingForOpenAIModel(id) {
  const s = String(id || '').toLowerCase();
  // OpenAI reasoning families (o1/o3/o4, gpt-5*), plus common
  // reasoning-flagged models on OpenAI-shaped third-party endpoints.
  const isReasoning = /^(o\d|gpt-5)/.test(s)
    || /reasoning|think|\br1\b|qwq/.test(s);
  if (!isReasoning) return undefined;
  return { kind: 'levels', levels: OPENAI_THINKING_LEVELS.slice() };
}

// thinkingForOpenRouterModel(m) — OpenRouter reports per-model
// `supported_parameters` (and on some revisions a `reasoning` block)
// on GET /api/v1/models. Map that onto our descriptor.
function thinkingForOpenRouterModel(m) {
  const sp = Array.isArray(m && m.supported_parameters) ? m.supported_parameters : [];
  const supportsReasoning = sp.indexOf('reasoning') >= 0
    || sp.indexOf('reasoning_effort') >= 0
    || sp.indexOf('include_reasoning') >= 0;
  if (!supportsReasoning) return undefined;
  // Anthropic-family models behind OpenRouter take a token budget;
  // everything else takes effort levels. OpenRouter accepts either
  // shape on its /chat/completions, so levels are a safe default.
  if (/^anthropic\//.test(String(m.id || ''))) return { kind: 'budget' };
  return { kind: 'levels', levels: OPENAI_THINKING_LEVELS.slice() };
}

function parseOpenAIShapedModels(body, thinkingFor) {
  const arr = Array.isArray(body && body.data) ? body.data : [];
  const out = [];
  for (const m of arr) {
    if (!m || !m.id) continue;
    const rec = {
      id: String(m.id),
      label: m.id,
      contextWindow: typeof m.context_window === 'number' ? m.context_window : undefined
    };
    const thinking = typeof thinkingFor === 'function' ? thinkingFor(m) : undefined;
    if (thinking) rec.thinking = thinking;
    out.push(rec);
  }
  return out;
}

function parseGeminiModels(body) {
  // Gemini: { models: [{ name: 'models/<id>', displayName, inputTokenLimit, ... }] }
  const arr = Array.isArray(body && body.models) ? body.models : [];
  const out = [];
  for (const m of arr) {
    if (!m || !m.name) continue;
    const id = String(m.name).replace(/^models\//, '');
    // Only show models that can actually generate (text-to-text).
    const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
    if (methods.length && !methods.includes('generateContent')) continue;
    const rec = {
      id,
      label: m.displayName || id,
      contextWindow: typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : undefined
    };
    // Gemini 2.5+ models accept generationConfig.thinkingConfig with a
    // raw thinkingBudget token count.
    if (/gemini-(2\.5|[3-9])/.test(id)) rec.thinking = { kind: 'budget' };
    out.push(rec);
  }
  return out;
}

function parseOllamaModels(body) {
  const arr = Array.isArray(body && body.models) ? body.models : [];
  const out = [];
  for (const m of arr) {
    if (!m || !m.name) continue;
    out.push({
      id: String(m.name),
      label: m.name,
      contextWindow: undefined  // Ollama doesn't expose context in /api/tags.
    });
  }
  return out;
}

function parseCuratedModels(catalog, thinkingFor) {
  return catalog.map((m) => {
    const rec = {
      id: m.id,
      label: m.label || m.id,
      contextWindow: m.contextWindow
    };
    const thinking = typeof thinkingFor === 'function'
      ? thinkingFor(m)
      : (thinkingFor || m.thinking);
    if (thinking) rec.thinking = thinking;
    return rec;
  });
}

// listModels(provider, cred, signal) -> Promise<[{ id, label, contextWindow? }]>
// Returns the live list for a provider; throws on upstream error so the
// caller can surface a typed error to the chat UI.
async function listModels(provider, cred, signal) {
  const def = ENDPOINTS[provider];
  if (!def || typeof def.listModels !== 'function') {
    const e = new Error('no listModels for provider: ' + provider);
    e.code = 'ENO_LIST';
    throw e;
  }
  const out = await def.listModels(cred, signal);
  // Stable, friendly order: by id ascending. Dedupe.
  const seen = new Set();
  const dedup = [];
  for (const m of out.sort((a, b) => a.id.localeCompare(b.id))) {
    if (!m || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    dedup.push(m);
  }
  return dedup;
}

function endpointFor(model) {
  const def = ENDPOINTS[model.provider];
  if (!def) {
    const e = new Error('Unknown provider: ' + model.provider);
    e.code = 'EUNKNOWN_PROVIDER';
    throw e;
  }
  return def;
}

// requireApiKey(model, def) — returns true when the model has a usable
// credential (or doesn't need one), throws a typed error otherwise.
// The def is the ENDPOINTS[model.provider] record, passed in by the
// caller so we can branch on the provider's auth shape (e.g. Ollama's
// authHeader: () => ({}) doesn't take a credential at all).
//
// Async because the OAuth path may need to proactively refresh an
// expiring access token (and persist the new blob) before the chat
// hits the wire. The API-key path is sync-fast and does not await.
async function requireApiKey(model, def) {
  if (model.auth === 'oauth') {
    // OAuth path: the access token comes from the OS keychain via
    // src/auth.js. The keychain is keyed by auth provider (openai,
    // anthropic, google, github-copilot), not by AI client provider
    // (openai-compatible, etc). The mapping from the model record's
    // `provider` to the auth provider lives in src/auth.js
    // (AI_TO_AUTH_PROVIDER); the same function (authProviderFor) is
    // what the auth subsystem uses to look up accounts, so adding a
    // new AI client only requires one edit.
    const authMod = require('./auth.js');
    const authProvider = authMod.authProviderFor(model);
    if (!authProvider) {
      const e = new Error('Cannot resolve auth provider for "' + model.provider + '"');
      e.code = 'EUNKNOWN_PROVIDER';
      throw e;
    }
    const lookModel = Object.assign({}, model, { provider: authProvider });
    const token = authMod.tokenForModel(lookModel);
    if (!token) {
      const e = new Error(
        'No OAuth account is signed in for provider "' + authProvider + '"' +
        (model.oauthAccount ? '' : ' (no oauthAccount on model, no signed-in account found)') +
        '. Sign in via the loopback callback.'
      );
      e.code = 'ENOAUTH';
      throw e;
    }
    let parsed;
    try { parsed = JSON.parse(token); }
    catch {
      const e = new Error('Stored OAuth token for "' + authProvider + '" is not valid JSON');
      e.code = 'EOAUTH_BLOB';
      throw e;
    }
    if (!parsed.accessToken) {
      const e = new Error('Stored OAuth token for "' + authProvider + '" has no accessToken');
      e.code = 'EOAUTH_BLOB';
      throw e;
    }
    // Proactive refresh. If the stored access_token expires within
    // OAUTH_REFRESH_LEAD_MS (or is already past), and the provider
    // has a registered refresher + we have a refresh_token, swap
    // it for a fresh one and persist the new blob to the keychain.
    // Skipped silently when no refresher is registered yet, or when
    // the user signed in via a flow that did not issue a
    // refresh_token. A failure here is non-fatal: we fall through
    // with the existing token; the upstream will return a clean
    // 401 if the token is actually stale, which the user can
    // recover from by re-signing in.
    const now = Date.now();
    const nearExpiry = typeof parsed.expiresAt === 'number'
      ? (parsed.expiresAt - now) <= OAUTH_REFRESH_LEAD_MS
      : false;
    if (nearExpiry && parsed.refreshToken) {
      const refresher = authMod.getRefresher(authProvider);
      if (refresher) {
        const baseUrl = (model.baseUrl
          || (ENDPOINTS[authProvider] && ENDPOINTS[authProvider].baseUrl)
          || null);
        const account = lookModel.oauthAccount || parsed.account || null;
        try {
          const next = await refresher({
            provider: authProvider,
            account,
            refreshToken: parsed.refreshToken,
            scope: parsed.scope || null,
            baseUrl
          });
          if (next && next.accessToken) {
            parsed = Object.assign({}, parsed, {
              accessToken: next.accessToken,
              refreshToken: next.refreshToken || parsed.refreshToken,
              expiresAt: typeof next.expiresAt === 'number' ? next.expiresAt : parsed.expiresAt,
              scope: next.scope || parsed.scope
            });
            // Persist the new blob. Best-effort: a keyring failure
            // here does not poison the in-memory token we are about
            // to use, and the next chat will re-refresh as needed.
            try {
              await authMod.setToken(authProvider, account || 'default', JSON.stringify(parsed));
            } catch { /* swallow; in-memory token is still valid for this chat */ }
          }
        } catch { /* swallow; fall through to the stored token */ }
      }
    }
    model.__accessToken = parsed.accessToken;
    // Per-request Copilot token exchange. The keychain holds a
    // long-lived GitHub OAuth token; api.githubcopilot.com expects
    // a short-lived Copilot API token in the Authorization header.
    // The exchange is performed on every chat; the resulting token
    // is request-scoped (we never persist it) and a revocation
    // takes effect within minutes rather than at next sign-in.
    // Failure to exchange (no subscription, revoked token, network)
    // is surfaced as a typed error so the UI can prompt the user.
    if (model.provider === 'github-copilot') {
      let copilot;
      try {
        copilot = await exchangeCopilotTokenIfNeeded(model, parsed);
      } catch (e) {
        // Re-throw with the typed code preserved.
        throw e;
      }
      if (copilot) model.__accessToken = copilot;
    }
    return true;
  }
  if (!model.apiKey || typeof model.apiKey !== 'string') {
    // Providers whose authHeader takes no parameters (Ollama today)
    // don't need a credential. We detect that by arity: zero = no
    // credential, one or more = needs a key. Robust to future providers.
    if (def && typeof def.authHeader === 'function' && def.authHeader.length === 0) return true;
    const e = new Error('Model "' + model.id + '" has no apiKey.');
    e.code = 'ENOAPIKEY';
    throw e;
  }
  return true;
}

// Refresh lead window. If a stored access token expires within this
// many ms, we proactively swap it for a fresh one before the chat
// hits the wire. 60s matches the SDK's typical advisory-refresh
// threshold and is short enough that a flaky refresh never holds a
// chat hostage for long.
const OAUTH_REFRESH_LEAD_MS = 60 * 1000;

// Copilot token cache. The exchange is per-request but the result
// is request-scoped — there's no value in caching it across chats
// because it expires in ~30 min and a fresh derivation costs one
// HTTPS round-trip. We keep a small in-process LRU so a chat that
// streams multiple turns does not re-exchange on every turn; each
// entry tracks the GitHub token + the resolved Copilot token + its
// expiry. The cache key includes the GitHub token, so a sign-out /
// sign-in of a different account starts fresh.
const _copilotCache = new Map(); // key: githubToken -> { copilotToken, expiresAt, ts }
const COPILOT_CACHE_TTL_MS = 5 * 60 * 1000; // drop cache entries after 5 min idle

function copilotCacheGet(githubToken) {
  const entry = _copilotCache.get(githubToken);
  if (!entry) return null;
  if (Date.now() - entry.ts > COPILOT_CACHE_TTL_MS) { _copilotCache.delete(githubToken); return null; }
  if (typeof entry.expiresAt === 'number' && entry.expiresAt - Date.now() <= OAUTH_REFRESH_LEAD_MS) {
    _copilotCache.delete(githubToken);
    return null;
  }
  // Touch on read so a streaming chat does not evict its own entry.
  entry.ts = Date.now();
  return entry;
}
function copilotCachePut(githubToken, copilotToken, expiresAt) {
  // Cap the map at 16 entries — should never hit this in practice
  // (one per signed-in account per process), but defensive against
  // memory growth in a long-lived server.
  if (_copilotCache.size >= 16) {
    const first = _copilotCache.keys().next().value;
    if (first !== undefined) _copilotCache.delete(first);
  }
  _copilotCache.set(githubToken, { copilotToken, expiresAt, ts: Date.now() });
}
function copilotCacheClear() { _copilotCache.clear(); }

// exchangeCopilotTokenIfNeeded(model, parsedBlob) — derives a
// short-lived Copilot API token from the GitHub OAuth token stored
// in the keychain. Returns the token string, or throws a typed
// error. Caches per-GitHub-token to avoid re-deriving within a
// streaming chat.
async function exchangeCopilotTokenIfNeeded(model, parsedBlob) {
  const githubToken = (parsedBlob && parsedBlob.accessToken) || model.__accessToken;
  if (!githubToken) {
    const e = new Error('GitHub Copilot: no GitHub access token on the stored blob');
    e.code = 'EOAUTH_BLOB';
    throw e;
  }
  const cached = copilotCacheGet(githubToken);
  if (cached) return cached.copilotToken;
  let oauthCopilot;
  try {
    oauthCopilot = require('./oauth-github-copilot.js');
  } catch {
    const e = new Error('GitHub Copilot OAuth module is not available in this build');
    e.code = 'EMODULE';
    throw e;
  }
  let out;
  try {
    out = await oauthCopilot.exchangeCopilotToken({ githubToken });
  } catch (e) {
    // Re-throw with the typed code preserved (ESSO_REQUIRED, ENOCOPILOT,
    // EUPSTREAM, EPARSE, ETOKEN).
    throw e;
  }
  if (!out || !out.token) {
    const e = new Error('GitHub Copilot: token exchange returned no token');
    e.code = 'ETOKEN';
    throw e;
  }
  copilotCachePut(githubToken, out.token, out.expiresAt);
  return out.token;
}

// ---- Request builders --------------------------------------------------

// Returns the effective bearer-style credential: the OAuth access token
// if one was resolved by requireApiKey, otherwise the plain apiKey.
function credential(model) {
  return model.__accessToken || model.apiKey;
}

function buildOpenAIRequest(model, messages, stream) {
  const def = ENDPOINTS[model.provider] || ENDPOINTS['openai-compatible'];
  // Fall back to the per-provider defaultBaseUrl when the saved
  // record's baseUrl is empty. Without this, an openai-compatible or
  // openrouter model with baseUrl: '' would collapse the URL to the
  // relative path '/chat/completions' instead of the upstream
  // endpoint. The Settings UI snaps baseUrl to defaultBaseUrl on
  // save, but a hand-edited .mouaif.json or a future provider that
  // forgets to set one would otherwise break.
  const baseUrl = (model && model.baseUrl) || (def && def.baseUrl) || '';
  const headers = { 'Content-Type': 'application/json', ...ENDPOINTS['openai-compatible'].authHeader(credential(model)) };
  // Per-provider static headers. github-copilot requires editor
  // identification headers; openrouter carries the per-install
  // X-OpenRouter-Title (canonical) + X-Title (deprecated alias)
  // + HTTP-Referer, resolved at request time from
  // app.openRouter.appName. The order (auth first,
  // static second) means a caller-supplied model.headers can
  // still override the defaults — useful for tests and for a
  // future per-model override.
  if (def && def.staticHeaders) {
    Object.assign(headers, model.provider === 'openrouter'
      ? resolveOpenRouterStaticHeaders()
      : def.staticHeaders);
  }
  if (model && model.headers && typeof model.headers === 'object') Object.assign(headers, model.headers);
  const body = {
    model: model.id,
    messages,
    stream: !!stream
  };
  if (stream && (model.provider === 'openai-compatible' || model.provider === 'openrouter')) {
    // OpenAI-shaped streaming APIs do not include final token usage by
    // default. Request it explicitly so the chat's Context/Cost line is
    // based on upstream counts instead of staying at zero.
    body.stream_options = { include_usage: true };
  }
  if (stream && model.provider === 'openrouter') {
    // OpenRouter only includes its authoritative billed `usage.cost` when
    // asked. Prefer that over local pricing when present.
    body.usage = { include: true };
  }
  // Inject thinking level (reasoning_effort) for OpenAI-compatible
  // providers. Empty string means off/default. Any non-empty value is
  // passed through verbatim — the valid set comes from the provider
  // (surface via the model's `thinking.levels` descriptor) and varies
  // by model ("minimal"/"low"/"medium"/"high"/"xhigh" today), so
  // whitelisting here would just lag the upstream.
  if (model.thinkingLevel) {
    const tl = String(model.thinkingLevel).trim();
    if (tl) body.reasoning_effort = tl;
  }
  return {
    url: joinUrl(baseUrl, ENDPOINTS['openai-compatible'].chatPath),
    headers,
    body
  };
}

function openAIContentToAnthropic(content) {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!part || typeof part !== 'object') return { type: 'text', text: String(part || '') };
    if (part.type === 'text') return { type: 'text', text: part.text || '' };
    if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
      const m = part.image_url.url.match(/^data:([^;]+);base64,(.*)$/);
      if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
    }
    return { type: 'text', text: '' };
  }).filter((part) => part.type !== 'text' || part.text);
}

function openAIContentToGeminiParts(content) {
  if (!Array.isArray(content)) return [{ text: content == null ? '' : String(content) }];
  return content.map((part) => {
    if (!part || typeof part !== 'object') return { text: String(part || '') };
    if (part.type === 'text') return { text: part.text || '' };
    if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
      const m = part.image_url.url.match(/^data:([^;]+);base64,(.*)$/);
      if (m) return { inlineData: { mimeType: m[1], data: m[2] } };
    }
    return { text: '' };
  }).filter((part) => part.text || part.inlineData);
}

function buildAnthropicRequest(model, messages, stream) {
  const systemMsgs = messages.filter(m => m.role === 'system');
  const systemContent = systemMsgs.map(m => m.content).filter(Boolean).join('\n\n');
  const chatMessages = messages.filter(m => m.role !== 'system');
  const body = {
    model: model.id,
    max_tokens: model.maxTokens || 1024,
    system: systemContent || undefined,
    messages: chatMessages.map(m => ({ role: m.role, content: openAIContentToAnthropic(m.content) })),
    stream: !!stream
  };
  // Inject thinking budget for Anthropic. The thinking level maps to
  // a budget_tokens value. When the level is a plain number string, use
  // it directly as budget_tokens. Known presets: "low"=2048, "medium"=8192, "high"=16384.
  // An empty string means no thinking block (default).
  if (model.thinkingLevel) {
    const tl = String(model.thinkingLevel).trim();
    let budget = 0;
    if (tl === 'low') budget = 2048;
    else if (tl === 'medium') budget = 8192;
    else if (tl === 'high') budget = 16384;
    else {
      const n = parseInt(tl, 10);
      if (isFinite(n) && n > 0) budget = n;
    }
    if (budget > 0) {
      body.thinking = { type: 'enabled', budget_tokens: Math.min(budget, 100000) };
      // ensure max_tokens is at least budget + 256
      if (body.max_tokens < budget + 256) body.max_tokens = budget + 256;
    }
  }
  return {
    // model.baseUrl wins when set, so test mocks and Anthropic-compatible
    // proxies (Bedrock, Vertex, Foundry) can route the call. Production
    // Anthropic usage leaves baseUrl unset, in which case the
    // per-provider default applies.
    url: joinUrl(model.baseUrl || ENDPOINTS.anthropic.baseUrl, ENDPOINTS.anthropic.chatPath),
    headers: {
      'Content-Type': 'application/json',
      ...ENDPOINTS.anthropic.authHeader(credential(model), model)
    },
    body
  };
}

function buildGeminiRequest(model, messages, stream) {
  // Gemini uses ?alt=sse for streaming responses.
  const url = joinUrl(ENDPOINTS.gemini.baseUrl, '/v1beta/models/' + encodeURIComponent(model.id) + ':' + (stream ? 'streamGenerateContent?alt=sse' : 'generateContent'));
  const systemMsgs = messages.filter(m => m.role === 'system');
  const systemContent = systemMsgs.map(m => m.content).filter(Boolean).join('\n\n');
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: openAIContentToGeminiParts(m.content) }));
  const body = { contents };
  if (systemContent) body.systemInstruction = { role: 'system', parts: [{ text: systemContent }] };
  // Inject thinking budget for Gemini 2.5+ models. The thinking level
  // maps to generationConfig.thinkingConfig.thinkingBudget. Known
  // presets: "low"=2048, "medium"=8192, "high"=16384; a plain number
  // string is used directly. Empty string leaves thinking at the
  // upstream default (dynamic).
  if (model.thinkingLevel) {
    const tl = String(model.thinkingLevel).trim();
    let budget = 0;
    if (tl === 'low') budget = 2048;
    else if (tl === 'medium') budget = 8192;
    else if (tl === 'high') budget = 16384;
    else {
      const n = parseInt(tl, 10);
      if (isFinite(n) && n > 0) budget = n;
    }
    if (budget > 0) {
      body.generationConfig = Object.assign({}, body.generationConfig, {
        thinkingConfig: { thinkingBudget: budget }
      });
    }
  }
  return {
    url,
    headers: { 'Content-Type': 'application/json', ...ENDPOINTS.gemini.authHeader(credential(model)) },
    body
  };
}

function buildOllamaRequest(model, messages, stream) {
  const body = { model: model.id, messages, stream: !!stream };
  // Ollama's reasoning switch is a boolean `think` flag. Any non-empty
  // thinking level means "on"; empty means upstream default (off for
  // most models).
  if (model.thinkingLevel && String(model.thinkingLevel).trim()) body.think = true;
  return {
    url: joinUrl(model.baseUrl || ENDPOINTS.ollama.baseUrl, ENDPOINTS.ollama.chatPath),
    headers: { 'Content-Type': 'application/json' },
    body
  };
}

const BUILDERS = {
  'openai-compatible': buildOpenAIRequest,
  'anthropic': buildAnthropicRequest,
  'gemini': buildGeminiRequest,
  'ollama': buildOllamaRequest,
  'github-copilot': buildOpenAIRequest, // same shape; ENOAUTH gate above
  'openrouter':       buildOpenAIRequest  // same shape; apikey-only, reuses staticHeaders
};

// ---- Event parsers -----------------------------------------------------
// Each parser reads one event from the upstream and emits zero or more
// normalized events. The normalized event names are:
//   message   -> { delta: 'text' }
//   reasoning -> { delta: 'thinking/reasoning text' }
//   done      -> { usage: { promptTokens, completionTokens } }
//   error     -> { code, message }
// Anything else from the upstream is passed through as `passthrough` so
// the UI can render it for debugging.

const PARSERS = {
  'openai-compatible': parseOpenAISSE,
  'github-copilot':   parseOpenAISSE,
  'openrouter':       parseOpenAISSE,     // OpenAI-shaped SSE; [DONE] sentinel suppressed
  'anthropic':        parseAnthropicSSE,
  'gemini':           parseGeminiSSE,
  'ollama':           parseOllamaNDJSON
};

function firstFiniteNumber(...values) {
  const n = firstFiniteNumberOrNull(...values);
  return n == null ? 0 : n;
}

function firstFiniteNumberOrNull(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (isFinite(n) && n >= 0) return n;
  }
  return null;
}

function firstStringField(obj, names) {
  if (!obj || typeof obj !== 'object') return '';
  for (const name of names) {
    if (typeof obj[name] === 'string') return obj[name];
  }
  return '';
}

function* parseOpenAISSE(eventName, data) {
  if (!data) return;
  // OpenAI uses the literal "[DONE]" as a stream terminator. Suppress it.
  if (data.trim() === '[DONE]') return;
  let obj;
  try { obj = JSON.parse(data); } catch { yield { name: 'passthrough', data: { raw: data } }; return; }
  if (obj.error) {
    yield { name: 'error', data: { code: 'EUPSTREAM', message: obj.error.message || String(obj.error) } };
    return;
  }
  const choice = obj.choices && obj.choices[0];
  const delta = choice && choice.delta;
  const reasoning = firstStringField(delta, [
    'reasoning',
    'reasoning_content',
    'reasoningContent',
    'thinking',
    'thought',
    'chain_of_thought'
  ]);
  if (reasoning) {
    yield { name: 'reasoning', data: { delta: reasoning } };
  }
  if (choice && choice.message) {
    const messageReasoning = firstStringField(choice.message, [
      'reasoning',
      'reasoning_content',
      'reasoningContent',
      'thinking',
      'thought',
      'chain_of_thought'
    ]);
    if (messageReasoning) yield { name: 'reasoning', data: { delta: messageReasoning } };
  }
  if (delta && typeof delta.content === 'string') {
    yield { name: 'message', data: { delta: delta.content } };
  }
  // OpenAI tool calls stream as a `delta.tool_calls` array. The id
  // appears on the first delta for a given index; subsequent deltas
  // fill in `function.name` and the streamed `function.arguments`
  // string. We accumulate by index and emit a `tool_call` event when
  // we see a `finish_reason === 'tool_calls'`.
  if (choice && Array.isArray(choice.delta && choice.delta.tool_calls)) {
    for (const tc of choice.delta.tool_calls) {
      yield { name: 'tool_call_delta', data: tc };
    }
  }
  if (choice && choice.finish_reason) {
    yield { name: 'finish', data: { reason: choice.finish_reason } };
  }
  if (obj.usage) {
    const promptTokens = firstFiniteNumber(
      obj.usage.prompt_tokens,
      obj.usage.input_tokens,
      obj.usage.promptTokens,
      obj.usage.inputTokens
    );
    const completionTokens = firstFiniteNumber(
      obj.usage.completion_tokens,
      obj.usage.output_tokens,
      obj.usage.completionTokens,
      obj.usage.outputTokens
    );
    const providerCost = firstFiniteNumberOrNull(
      obj.usage.cost,
      obj.usage.total_cost,
      obj.usage.totalCost
    );
    // OpenRouter additionally reports a cost split under cost_details
    // (docs: usage.cost_details.upstream_inference_prompt_cost /
    // completions_cost). Capture it so persisted segments can show a
    // real input/output cost breakdown instead of a bare total. Missing
    // cost fields stay null; otherwise an absent field would look like a
    // provider-authoritative $0.00 and suppress local pricing fallback.
    const cd = (obj.usage && obj.usage.cost_details) || {};
    const providerCostInput = firstFiniteNumberOrNull(
      cd.upstream_inference_prompt_cost,
      cd.prompt_cost,
      cd.input_cost
    );
    const providerCostOutput = firstFiniteNumberOrNull(
      cd.upstream_inference_completions_cost,
      cd.completion_cost,
      cd.completions_cost,
      cd.output_cost
    );
    yield {
      name: 'done',
      data: {
        usage: { promptTokens, completionTokens },
        providerCost,
        providerCostInput,
        providerCostOutput
      }
    };
  }
}

// Some models routed through OpenRouter (notably MiniMax) occasionally put
// their private tool-call serialization in `delta.content` instead of using
// the OpenAI `delta.tool_calls` field. OpenRouter forwards that text verbatim:
//
//   ]<]minimax[>[<tool_call> ... <invoke name="search_files"> ...
//
// Parse that compatibility form only after a complete upstream turn. Keeping
// it out of parseOpenAISSE avoids interpreting ordinary XML/code examples as
// calls, and the MiniMax sentinel makes the fallback deliberately narrow.
function parseMiniMaxTextToolCalls(text) {
  const source = String(text || '');
  if (source.indexOf(']<]minimax[>[') < 0 || source.indexOf('<tool_call>') < 0) {
    return { text: source, calls: [] };
  }

  const calls = [];
  const blockRe = /\]<\]minimax\[>\[<tool_call>[\s\S]*?\]<\]minimax\[>\[<\/tool_call>/g;
  let match;
  while ((match = blockRe.exec(source))) {
    const block = match[0];
    const invoke = /<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/.exec(block);
    if (!invoke) continue;
    const args = {};
    const argRe = /<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\1>/g;
    let arg;
    while ((arg = argRe.exec(invoke[2]))) {
      const value = arg[2].trim();
      try { args[arg[1]] = JSON.parse(value); }
      catch { args[arg[1]] = value; }
    }
    calls.push({
      id: 'call_minimax_' + (calls.length + 1),
      name: invoke[1],
      arguments: JSON.stringify(args)
    });
  }

  if (!calls.length) return { text: source, calls: [] };
  return { text: source.replace(blockRe, '').trim(), calls };
}

function* parseAnthropicSSE(eventName, data) {
  if (!data) return;
  let obj;
  try { obj = JSON.parse(data); } catch { yield { name: 'passthrough', data: { raw: data } }; return; }
  switch (obj.type) {
    case 'message_start':
      // usage is reported here for input tokens.
      if (obj.message && obj.message.usage) {
        yield { name: 'usage_input', data: { promptTokens: obj.message.usage.input_tokens || 0 } };
      }
      break;
    case 'content_block_start':
      break;
    case 'content_block_delta':
      if (obj.delta && obj.delta.type === 'text_delta' && typeof obj.delta.text === 'string') {
        yield { name: 'message', data: { delta: obj.delta.text } };
      } else if (obj.delta && obj.delta.type === 'thinking_delta' && typeof obj.delta.thinking === 'string') {
        yield { name: 'reasoning', data: { delta: obj.delta.thinking } };
      } else if (obj.delta && obj.delta.type === 'signature_delta') {
        // Anthropic signs extended-thinking blocks; the signature is not user-facing.
      }
      break;
    case 'content_block_stop':
      break;
    case 'message_delta':
      if (obj.usage && typeof obj.usage.output_tokens === 'number') {
        yield { name: 'usage_output', data: { completionTokens: obj.usage.output_tokens } };
      }
      break;
    case 'message_stop':
      yield { name: 'done', data: {} };
      break;
    case 'error':
      yield { name: 'error', data: { code: 'EUPSTREAM', message: obj.error && obj.error.message || 'anthropic error' } };
      break;
  }
}

function* parseGeminiSSE(eventName, data) {
  if (!data) return;
  let obj;
  try { obj = JSON.parse(data); } catch { yield { name: 'passthrough', data: { raw: data } }; return; }
  const cand = obj.candidates && obj.candidates[0];
  if (cand && cand.content && cand.content.parts) {
    for (const part of cand.content.parts) {
      if (typeof part.thought === 'string') yield { name: 'reasoning', data: { delta: part.thought } };
      else if (part.thought === true && typeof part.text === 'string') yield { name: 'reasoning', data: { delta: part.text } };
      else if (typeof part.text === 'string') yield { name: 'message', data: { delta: part.text } };
    }
  }
  if (cand && cand.finishReason) yield { name: 'finish', data: { reason: cand.finishReason } };
  if (obj.usageMetadata) {
    yield {
      name: 'done',
      data: { usage: { promptTokens: obj.usageMetadata.promptTokenCount || 0, completionTokens: obj.usageMetadata.candidatesTokenCount || 0 } }
    };
  }
  if (obj.error) {
    yield { name: 'error', data: { code: 'EUPSTREAM', message: obj.error.message || 'gemini error' } };
  }
}

function* parseOllamaNDJSON(_eventName, data) {
  if (!data) return;
  let obj;
  try { obj = JSON.parse(data); } catch { yield { name: 'passthrough', data: { raw: data } }; return; }
  if (obj.message) {
    const reasoning = firstStringField(obj.message, [
      'thinking',
      'reasoning',
      'reasoning_content',
      'reasoningContent',
      'thought'
    ]);
    if (reasoning) yield { name: 'reasoning', data: { delta: reasoning } };
  }
  if (obj.message && typeof obj.message.content === 'string') {
    yield { name: 'message', data: { delta: obj.message.content } };
  }
  if (obj.done) {
    yield {
      name: 'done',
      data: {
        usage: {
          promptTokens: obj.prompt_eval_count || 0,
          completionTokens: obj.eval_count || 0
        }
      }
    };
  }
  if (obj.error) {
    yield { name: 'error', data: { code: 'EUPSTREAM', message: obj.error } };
  }
}

// ---- Streaming core ----------------------------------------------------

function joinUrl(base, path) {
  if (!base) return path;
  if (base.endsWith('/') && path.startsWith('/')) return base + path.slice(1);
  if (!base.endsWith('/') && !path.startsWith('/')) return base + '/' + path;
  return base + path;
}

// Walks an SSE byte stream and yields {eventName, data} pairs.
// `stream` is a ReadableStream<Uint8Array> from fetch().
async function* readSSE(stream) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseSSEFrame(frame);
      if (ev) yield ev;
    }
  }
  // Tail without trailing blank line.
  if (buf.trim()) {
    const ev = parseSSEFrame(buf);
    if (ev) yield ev;
  }
}

function parseSSEFrame(frame) {
  let eventName = 'message';
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (!line) continue;
    if (line.startsWith(':')) continue; // comment / heartbeat
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }
  // No data lines -> comment-only / heartbeat / empty frame; skip.
  if (!dataLines.length) return null;
  return { eventName, data: dataLines.join('\n') };
}

// Walks an NDJSON byte stream and yields one parsed object per line.
async function* readNDJSON(stream) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { yield JSON.parse(line); }
      catch { /* ignore malformed line, upstream is responsible */ }
    }
  }
  if (buf.trim()) {
    try { yield JSON.parse(buf); } catch { /* ignore */ }
  }
}

// ---- Single tool-call runner ---------------------------------------------
// Executes one tool call through the full native pipeline — circuit
// breaker, authorization gate, dispatch — emitting tool_call/tool_result
// events and appending the `tool` message to `cx.convo` (when provided).
// Shared by the streamChat tool loop and by POST /api/tools/subagent
// (direct @agent dispatch from the composer).
//
// cx = {
//   opts, onEvent, convo,               // streamChat closure (convo optional)
//   toolSpecs, promptProfilesMod, discoveredToolNames,
//   modelContentForTool,                // (name, exec) -> string
//   dispatchTool, firstStringArgument, toolResultImageParts, // helpers
//   getLastToolCallKey/setLastToolCallKey,
//   getRepeatedToolCallCount/setRepeatedToolCallCount, REPEATED_TOOL_CALL_LIMIT,
//   onDelegatedUsage                    // optional subagent usage hook
// }
async function runSingleToolCall(c, cx) {
  const { opts, onEvent, convo, toolSpecs, promptProfilesMod, discoveredToolNames, modelContentForTool } = cx;
  const dispatchTool = cx.dispatchTool;
  const firstStringArgument = cx.firstStringArgument;
  const toolResultImageParts = cx.toolResultImageParts;
  let args = {};
  if (c.arguments) {
    try { args = JSON.parse(c.arguments); }
    catch { args = { __raw: c.arguments }; }
  }
  let exec;
  let callEmitted = false;
  // Captured when the authorization gate resolves a prompt for an
  // `ask_user` call. The runner reads it to fold the user's
  // structured answer into the `tool` message it returns.
  let callOptsAnswerPayload = null;
  const pushToolMessage = (name, content) => {
    if (convo) convo.push({ role: 'tool', tool_call_id: c.id || undefined, name, content });
  };
  // Identical-call circuit breaker. A model retrying the exact same
  // call with the exact same arguments (typically after a tool
  // error) never converges — enforce that the returned result is
  // identical, so nothing was learned from the retry. Refuse it
  // with an explanatory tool error so the model is forced to vary
  // the command or answer in plain text. Counts per consecutive
  // identical call; any different call resets the streak.
  const callKey = c.name + '\n' + (c.arguments || '');
  if (callKey === cx.getLastToolCallKey()) {
    cx.setRepeatedToolCallCount(cx.getRepeatedToolCallCount() + 1);
  } else {
    cx.setLastToolCallKey(callKey);
    cx.setRepeatedToolCallCount(0);
  }
  const loopLimit = typeof cx.REPEATED_TOOL_CALL_LIMIT === 'number' ? cx.REPEATED_TOOL_CALL_LIMIT : 3;
  if (cx.getRepeatedToolCallCount() >= loopLimit) {
    const r = {
      error: {
        code: 'ELOOP',
        message: 'You have called ' + c.name + ' with identical arguments ' + (cx.getRepeatedToolCallCount() + 1) + ' times in a row with identical results. The call was refused. Do not retry it — change the command/arguments or answer the user in plain text instead.'
      }
    };
    exec = { ok: false, content: JSON.stringify(r), result: r };
    onEvent('tool_call', { id: c.id || null, name: c.name, args });
    callEmitted = true;
    onEvent('tool_result', { id: c.id || null, name: c.name, ok: false, result: exec.result });
    pushToolMessage(c.name, modelContentForTool(c.name, exec));
    return exec;
  }
  try {
    // list_features is a read-only metadata tool that bypasses
    // the authorization gate — it only returns feature state.
    if (c.name === 'list_features') {
      let af;
      try { af = require('./agentFeatures.js'); }
      catch (e) {
        exec = { ok: false, content: JSON.stringify({ error: { code: 'EMODULE', message: 'agentFeatures module unavailable: ' + (e.message || e) } }), result: { error: { code: 'EMODULE' } } };
      }
      if (!exec) {
        exec = await af.dispatchListFeatures(args, Object.assign({}, opts, { callId: c.id || null }));
      }
      onEvent('tool_call', { id: c.id || null, name: c.name, args });
      callEmitted = true;
    } else if (c.name === 'activate_skill') {
      // Activation is a read-only lookup constrained to the enum of enabled,
      // project-contained skills, so it does not require a separate approval.
      onEvent('tool_call', { id: c.id || null, name: c.name, args });
      callEmitted = true;
      exec = await dispatchTool(c.name, args, Object.assign({}, opts, { callId: c.id || null }));
    } else if (c.name === 'report_progress') {
      // report_progress is a read-only UI/update tool. It honors
      // the project `off` visibility gate, but does not show an
      // interactive authorization prompt because progress updates
      // do not read or modify project resources.
      try {
        const authGate = require('./tools/authorization.js');
        const cfg = authGate.effectiveConfig(opts && opts.projectDir, c.name);
        if (cfg && cfg.mode === 'off') {
          exec = { ok: false, content: JSON.stringify({ ok: false, code: 'ETOOL_DISABLED', reason: 'tool is disabled' }), result: { ok: false, code: 'ETOOL_DISABLED', reason: 'tool is disabled' } };
        }
      } catch { /* unreadable authorization state: keep compatibility path */ }
      // Emit the running card before dispatch so the subsequent
      // progress_update can attach to the same call id.
      onEvent('tool_call', { id: c.id || null, name: c.name, args });
      callEmitted = true;
      if (!exec) exec = await dispatchTool(c.name, args, Object.assign({}, opts, { callId: c.id || null }));
    } else if (promptProfilesMod && c.name === promptProfilesMod.DISCOVER_TOOL_NAME) {
      const requested = args && (args.toolName || args.name || args.tool);
      const spec = (toolSpecs || []).find(s => s && s.function && s.function.name === requested);
      if (!spec) {
        exec = {
          ok: false,
          content: JSON.stringify({ error: { code: 'EUNKNOWN_TOOL', message: 'Unknown tool: ' + requested } }),
          result: { error: { code: 'EUNKNOWN_TOOL', message: 'Unknown tool: ' + requested } }
        };
      } else {
        if (discoveredToolNames) discoveredToolNames.add(requested);
        const fn = spec.function || {};
        exec = {
          ok: true,
          content: JSON.stringify({ name: fn.name, description: fn.description, parameters: fn.parameters }),
          result: { name: fn.name, description: fn.description, parameters: fn.parameters }
        };
      }
      onEvent('tool_call', { id: c.id || null, name: c.name, args });
      callEmitted = true;
    } else {
      const authGate = require('./tools/authorization.js');
      // The summary shown on the "Authorization required" card and
      // matched against the file-tool allowlist needs the right
      // argument per tool family. For shell it's the command; for
      // the file tools it's the path (with the optional query /
      // content as a hint, when relevant).
      let summary;
      if (c.name === 'shell') summary = (args && args.cmd) || '';
      else if (c.name === 'subagent') summary = (args && args.task) || '';
      else if (c.name === 'read_file' || c.name === 'list_files' || c.name === 'search_files' || c.name === 'write_file' || c.name === 'edit_file') {
        summary = (args && (args.path || args.file)) || (args && args.query) || '';
      } else if (String(c.name).startsWith('mcp__')) {
        // MCP allowlists (shared or per-server/per-tool) match
        // against "<composedName> <firstStringArg>" so a pattern
        // can pin either the tool itself (^mcp__fs__read_file$)
        // or the resource it touches (^mcp__fs__read_file src/).
        const first = firstStringArgument(args);
        summary = first ? (c.name + ' ' + first) : c.name;
      } else {
        summary = firstStringArgument(args);
      }
      const authResult = await authGate.authorize({
        projectDir: opts && opts.projectDir,
        chatId: opts && opts.chatId,
        tool: c.name,
        callId: c.id,
        cmd: args && args.cmd,
        path: args && args.path,
        query: args && args.query,
        summary,
        timeoutMs: args && args.timeoutMs,
        args
      });

      // `ask_user` rides a separate UI card (question + options +
      // free-form "extra" textbox). The same authorization gate is
      // reused so the audit log, session grants, and `off` /
      // `allow-always` semantics work the same as for the other
      // tools. The dedicated `ask_user_required` event carries the
      // validated question payload so the chat UI can render the
      // right component without parsing `args` itself.
      let askUserPayload = null;
      if (c.name === 'ask_user') {
        try {
          const askMod = require('./tools/ask.js');
          askUserPayload = askMod.validateArgs(args);
        } catch (e) {
          // The model fed us a bad question (too many options,
          // duplicate value, missing label, ...). Surface the
          // validation error directly as a tool_result so the
          // model can self-correct on the next turn; do NOT block
          // the gate on a user prompt, because the bug is on the
          // model side, not the user side.
          const r = { error: { code: e.code || 'EBADINPUT', message: e.message } };
          exec = { ok: false, content: JSON.stringify(r), result: r };
          onEvent('tool_call', { id: c.id || null, name: c.name, args });
          callEmitted = true;
          onEvent('tool_result', { id: c.id || null, name: c.name, ok: false, result: exec.result });
          pushToolMessage(c.name, modelContentForTool(c.name, exec));
          return exec;
        }
      }

      if (authResult.decision === 'prompt') {
        if (c.name === 'ask_user' && askUserPayload) {
          onEvent('ask_user_required', {
            chatId: opts && opts.chatId,
            callId: c.id,
            tool: c.name,
            question: askUserPayload.question,
            options: askUserPayload.options,
            multiSelect: askUserPayload.multiSelect,
            presets: askUserPayload.presets,
            projectDir: opts && opts.projectDir
          });
        } else {
          onEvent('authorization_required', {
            chatId: opts && opts.chatId,
            callId: c.id,
            tool: c.name,
            cmd: args && args.cmd,
            path: args && args.path,
            query: args && args.query,
            summary,
            timeoutMs: args && args.timeoutMs,
            projectDir: opts && opts.projectDir
          });
        }
        // Capture the resolved value (allow, payload, ...) so the
        // `ask_user` runner can read the user's structured answer.
        // For every other tool the payload is undefined and the
        // runner ignores it.
        const authDecision = await authResult.wait;
        if (c.name === 'ask_user' && authDecision && authDecision.payload) {
          callOptsAnswerPayload = authDecision.payload;
        }
      }
      // Only announce a running tool after authorization has completed.
      // Previously the UI showed "tool call — running" while the server
      // was actually blocked waiting for an authorization decision. If the
      // authorization card was missed or the page reloaded, the transcript
      // appeared permanently stuck on a tool call with no messages.
      onEvent('tool_call', { id: c.id || null, name: c.name, args });
      callEmitted = true;
      exec = await dispatchTool(c.name, args, Object.assign({}, opts, { callId: c.id || null, answerPayload: callOptsAnswerPayload }));
    }
  } catch (e) {
    // Denied/disabled/error calls still need a call card immediately
    // before their result so persisted history remains a valid pair.
    if (!callEmitted) onEvent('tool_call', { id: c.id || null, name: c.name, args });
    if (e.code === 'EDENIED') {
      // For `ask_user` we want the runner to produce a
      // `cancelled: true` result so the model can decide what to
      // do next (fall back to a free-form chat, stop, ask a
      // different question, ...). For every other tool a deny
      // stays a plain EDENIED stub.
      if (c.name === 'ask_user') {
        exec = await dispatchTool('ask_user', args, Object.assign({}, opts, { callId: c.id || null, answerPayload: { cancelled: true } }));
      } else {
        exec = { ok: false, content: JSON.stringify({ ok: false, code: 'EDENIED', reason: 'user denied' }), result: { ok: false, code: 'EDENIED', reason: 'user denied' } };
      }
    } else if (e.code === 'ETOOL_DISABLED') {
      exec = { ok: false, content: JSON.stringify({ ok: false, code: 'ETOOL_DISABLED', reason: 'tool is disabled' }), result: { ok: false, code: 'ETOOL_DISABLED', reason: 'tool is disabled' } };
    } else {
      exec = { ok: false, content: JSON.stringify({ ok: false, error: e.message }), result: { ok: false, error: e.message } };
    }
  }

  if (c.name === 'subagent' && typeof cx.onDelegatedUsage === 'function') cx.onDelegatedUsage(exec && exec.result);

  onEvent('tool_result', { id: c.id || null, name: c.name, ok: exec.ok, result: exec.result });

  pushToolMessage(c.name, modelContentForTool(c.name, exec));
  return { exec, imageParts: toolResultImageParts(exec && exec.result) };
}

async function streamChat(opts) {
  const { model, messages, signal, onEvent, onRoundUsage, thinkingLevel } = opts || {};
  if (!model || !model.provider) {
    return { ok: false, error: { code: 'EBADMODEL', message: 'Missing model.provider' } };
  }
  if (!Array.isArray(messages) || !messages.length) {
    return { ok: false, error: { code: 'EBADINPUT', message: 'messages must be a non-empty array' } };
  }
  if (typeof onEvent !== 'function') {
    return { ok: false, error: { code: 'EBADINPUT', message: 'onEvent must be a function' } };
  }
  // Pass thinking level down to the request builders so they can
  // inject provider-specific fields (reasoning_effort, thinking budget, etc.)
  if (typeof thinkingLevel === 'string' && thinkingLevel) {
    model.thinkingLevel = thinkingLevel;
  }

  let def, build, parse;
  try {
    def = endpointFor(model);
    // requireApiKey is async on the OAuth path (proactive refresh);
    // sync-fast on the API-key path. We always `await` it here.
    await requireApiKey(model, def);
    build = BUILDERS[model.provider];
    parse = PARSERS[model.provider];
  } catch (e) {
    return { ok: false, error: { code: e.code || 'EBADMODEL', message: e.message } };
  }
  if (!build || !parse) {
    return { ok: false, error: { code: 'EUNKNOWN_PROVIDER', message: 'No builder/parser for ' + model.provider } };
  }

  // ---- Tool specs advertised to the model ----------------------------
  // Three sources feed the `tools` field of the outgoing request:
  //   1. The native `shell` tool (src/tools/shell.js), always present.
  //   2. The native `report_progress` tool (src/tools/progress.js), always present.
  //   3. The native `subagent` tool (src/tools/subagent.js), always present.
  //   4. The native `ask_user` tool (src/tools/ask.js), always present.
  //      Lets the model pause and ask the user a structured question
  //      with a list of options (2+, no cap). The user always has a
  //      free-form "extra" textbox alongside their pick, so the answer
  //      is never constrained to the offered options. See
  //      docs/features/ask-user-tool.md.
  //   5. The native file tools (read_file / list_files / search_files /
  //      write_file, src/tools/files.js), always present. Authorization
  //      decides whether a call prompts, runs, or is rejected. These cover
  //      "read this file / find where X is used / patch a small file"
  //      loop without requiring an MCP server.
  //   6. MCP-discovered tools (decision §18), which use the
  //      mcp__<serverSlug>__<toolName> name convention.
  // Tool calling and the multi-turn loop below are wired only for the
  // OpenAI-compatible tool shape (openai-compatible + github-copilot).
  // Other providers stream normally and never see a `tools` field, so
  // their happy path is unchanged.
  const toolSpecs = [];
  try { toolSpecs.push(require('./tools/shell.js').SPEC); }
  catch { /* shell tool module unavailable; skip */ }
  try { toolSpecs.push(require('./tools/progress.js').SPEC); }
  catch { /* progress tool module unavailable; skip */ }
  try {
    const sub = require('./tools/subagent.js');
    // Enumerate the project's agent names in the `agent` parameter
    // description so the model knows exactly what it can delegate to.
    let agentNames = [];
    try {
      if (opts && opts.projectDir) agentNames = require('./agents.js').list(opts.projectDir).map((a) => a.name);
    } catch { /* no agents */ }
    toolSpecs.push(sub.buildSpec ? sub.buildSpec(agentNames) : sub.SPEC);
  }
  catch { /* subagent tool module unavailable; skip */ }
  try { toolSpecs.push(require('./tools/ask.js').SPEC); }
  catch { /* ask_user tool module unavailable; skip */ }
  try { toolSpecs.push(require('./agentFeatures.js').LIST_FEATURES_SPEC); }
  catch { /* list_features tool module unavailable; skip */ }
  try { toolSpecs.push(require('./tools/task.js').SPEC); }
  catch { /* task tool module unavailable; skip */ }
  try {
    const skillSpec = require('./agentSkills.js').buildSpec(opts && opts.projectDir, opts && opts.chat);
    if (skillSpec) toolSpecs.push(skillSpec);
  } catch { /* skills unavailable; skip */ }
  try {
    const ft = require('./tools/files.js');
    for (const name of ft.FILE_TOOL_NAMES) toolSpecs.push(ft.SPECS[name]);
  } catch { /* file tools module unavailable; skip */ }
  try {
    if (opts && opts.projectDir) {
      const mcpMod = require('./mcp.js');
      const specs = mcpMod.listComposedToolSpecs(opts.projectDir);
      if (specs && specs.length) {
        for (const s of specs) {
          toolSpecs.push({
            type: 'function',
            function: { name: s.name, description: s.description, parameters: s.parameters }
          });
        }
      }
    }
  } catch { /* mcp module not loaded or project dir invalid; fall through without MCP tools */ }

  // Tools in `off` authorization mode are dropped from the advertised
  // set: a hidden tool costs zero prompt tokens and the model cannot
  // waste turns calling something that would fail with ETOOL_DISABLED.
  // authorize() still rejects `off` calls at execution time as
  // defense-in-depth (e.g. a hand-crafted REST call or a stale spec
  // name kept in a chat's tool filter). File tools resolve through
  // their `file` family name; MCP tools resolve per tool / per server
  // through the layered .mcp.json authorization block.
  try {
    if (opts && opts.projectDir) {
      const authz = require('./tools/authorization.js');
      const authState = authz.getAuthorization(opts.projectDir);
      for (const family of ['shell', 'subagent', 'file', 'ask_user', 'report_progress', 'task']) {
        const cfg = authState.tools[family];
        if (cfg && cfg.mode === 'off') {
          const hidden = family === 'file' ? authz.FILE_TOOL_NAMES : new Set([family]);
          for (let i = toolSpecs.length - 1; i >= 0; i--) {
            const spec = toolSpecs[i];
            if (spec && spec.function && hidden.has(spec.function.name)) toolSpecs.splice(i, 1);
          }
        }
      }
      // MCP tools resolve through the layered gate (per-tool →
      // per-server → shared, see authorization.mcpLayeredConfig): an
      // `off` at any level hides exactly the mcp__<slug>__<tool> specs
      // it covers — one server, or one tool — at zero prompt-token
      // cost. Execution still rejects forged calls with ETOOL_DISABLED
      // through authorize().
      for (let i = toolSpecs.length - 1; i >= 0; i--) {
        const spec = toolSpecs[i];
        if (!spec || !spec.function || !String(spec.function.name).startsWith('mcp__')) continue;
        const cfg = authz.effectiveConfig(opts.projectDir, spec.function.name);
        if (cfg && cfg.mode === 'off') toolSpecs.splice(i, 1);
      }
    }
  } catch { /* authorization state unreadable; keep every tool advertised */ }

  // Per-chat tool filter. opts.enabledTools === null / undefined:
  //   legacy behavior — every collected spec is advertised. An array
  //   (even empty): restrict to those names exactly. Unknown names
  //   are dropped silently so a stale chat (a tool that was renamed
  //   or whose MCP server was stopped) does not fail the request.
  //   The array is captured here once — the chat UI persists the
  //   same set on the chat record, so we don't need to re-read it.
  let visibleToolSpecs = toolSpecs;
  if (opts && Array.isArray(opts.enabledTools)) {
    const allow = new Set(opts.enabledTools.map((n) => String(n)));
    visibleToolSpecs = toolSpecs.filter((s) => s && s.function && allow.has(s.function.name));
  }

  // Shrink the tool declaration according to the active prompt-size
  // profile (decisions §4). For very-small, the first request advertises
  // discover_tool only; its description lists tool names. When the model
  // discovers a specific tool, later requests include that tool's full
  // schema too. average/extensive send the full specs from the start.
  const discoveredToolNames = new Set();
  let promptProfilesMod = null;
  try { promptProfilesMod = require('./promptProfiles.js'); } catch { /* optional */ }

  // The multi-turn tool loop. `convo` is the working message array; it
  // grows by one assistant (tool-call) message + N tool-result messages
  // each iteration the model asks for tools. The model decides when its
  // task is complete; tool use is not cut off after an arbitrary count.
  const convo = messages.slice();
  const usage = { promptTokens: 0, completionTokens: 0 };
  const delegatedUsage = { promptTokens: 0, completionTokens: 0 };
  let providerCost = null;
  let delegatedProviderCost = null;
  let completedToolRound = false;
  let emptyPostToolRetries = 0;
  const FINAL_ANSWER_RETRIES = 2;
  // Identical-call circuit breaker state (enforced in runOneCall below).
  // The loop has no fixed turn limit, so a model retrying the exact
  // same failing call (e.g. an interactive command that exits
  // immediately) would otherwise spin forever.
  let lastToolCallKey = null;
  let repeatedToolCallCount = 0;
  const REPEATED_TOOL_CALL_LIMIT = 3;

  function modelContentForTool(name, exec) {
    return toolFeedback.compactToolFeedback({
      name,
      content: exec && exec.content,
      result: exec && exec.result,
      maxBytes: opts && opts.appSettings && opts.appSettings.toolFeedbackMaxBytes
    });
  }

  while (true) {
    let effectiveToolSpecs = visibleToolSpecs;
    try {
      effectiveToolSpecs = promptProfilesMod
        ? promptProfilesMod.reduceToolSpecs(visibleToolSpecs, opts && opts.promptSize, { discoveredToolNames })
        : visibleToolSpecs;
    } catch { /* non-fatal; fall back to the per-chat filtered set */ }
    const result = await runUpstreamTurn(convo, effectiveToolSpecs);
    if (!result.ok) return { ok: false, error: result.error, usage };

    const calls = result.toolCalls;
    if (!calls || !calls.length) {
      // Some OpenAI-compatible models end the first follow-up request with
      // `stop` but no content after receiving a tool result. Treat that as
      // an incomplete exchange rather than a successful empty answer. A
      // short system reminder reliably gets the model to summarize the tool
      // output, while the retry cap prevents a silent model from looping.
      if (completedToolRound && !String(result.assistantText || '').trim() && emptyPostToolRetries < FINAL_ANSWER_RETRIES) {
        emptyPostToolRetries++;
        convo.push({
          role: 'system',
          content: 'Your previous response was empty. Return the final user-facing answer now. Do not call a tool and do not return an empty response.'
        });
        continue;
      }
      if (completedToolRound && !String(result.assistantText || '').trim()) {
        onEvent('message', {
          delta: 'Tool execution finished, but the model did not provide a final response. Review the tool results above before retrying.'
        });
      }
      // No tool calls this turn -> the assistant is done. Emit the
      // final `done` with the accumulated usage and return. Parent
      // prompt tokens stay last-round-wins, but delegated subagent
      // requests are separate upstream calls and must be added so the
      // chat's total usage/cost matches what providers billed.
      const finalUsage = usageWithDelegated();
      const finalProviderCost = totalProviderCost();
      onEvent('done', { usage: finalUsage, providerCost: finalProviderCost });
      return { ok: true, usage: finalUsage, providerCost: finalProviderCost };
    }

    for (const c of calls) {
      if (!c.id) c.id = 'call_' + Math.random().toString(36).slice(2, 12);
    }

    // The model asked for tools. Append the assistant's tool-call
    // message (OpenAI shape) so the follow-up request has the context.
    convo.push({
      role: 'assistant',
      content: result.assistantText || null,
      tool_calls: calls.map(c => ({
        id: c.id || undefined,
        type: 'function',
        function: { name: c.name, arguments: c.arguments || '{}' }
      }))
    });

    // Close the streamed assistant segment before tool cards are emitted.
    // A model may send explanatory text and then request a tool; without an
    // explicit boundary the browser keeps one live bubble above the tool
    // cards and appends the post-tool answer back into that old bubble.
    onEvent('assistant_turn_end', { content: result.assistantText || '', hasToolCalls: true });

    // Execute each call, emit tool_call + tool_result, and append the
    // `tool` result message the upstream needs on the next turn.
    // Image blocks are also attached as native vision message parts after
    // all required tool messages have been added.
    //
    // Parallelism: when every call in this turn is a `subagent`, run them
    // concurrently — subagents are read-mostly nested chats, so the model
    // can fan out independent research/analysis tasks in one turn. Mixed
    // batches (subagent + file/shell/MCP) stay sequential so ordering
    // guarantees hold for tools with side effects. The authorization
    // session is keyed by callId and the UI routes nested events by
    // parentCallId, so concurrent subagents prompt and render correctly.
    const runParallel = calls.length > 1 && calls.every((c) => c.name === 'subagent');
    const postToolImageMessages = [];
    // Single-call runner shared with POST /api/tools/subagent (direct
    // @agent dispatch from the composer). Closure state: convo (tool
    // messages), call-key circuit breaker, delegated-usage counters,
    // and the discoveredToolNames set for the very-small profile.
    const runOneCall = async (c) => {
      const out = await runSingleToolCall(c, {
        opts,
        onEvent,
        convo,
        toolSpecs,
        visibleToolSpecs,
        promptProfilesMod,
        discoveredToolNames,
        modelContentForTool,
        dispatchTool,
        firstStringArgument,
        toolResultImageParts,
        getLastToolCallKey: () => lastToolCallKey,
        setLastToolCallKey: (k) => { lastToolCallKey = k; },
        getRepeatedToolCallCount: () => repeatedToolCallCount,
        setRepeatedToolCallCount: (n) => { repeatedToolCallCount = n; },
        REPEATED_TOOL_CALL_LIMIT,
        onDelegatedUsage: (result) => addDelegatedUsage(result)
      });
      const imageParts = out && out.imageParts;
      if (imageParts && imageParts.length) {
        postToolImageMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: 'Image result from tool `' + c.name + '`:' },
            ...imageParts
          ]
        });
      }
      return out.exec;
    };
    if (runParallel) {
      // Concurrent subagent fan-out. `convo` and `postToolImageMessages`
      // are appended from each async worker; ordering of the tool
      // messages in the follow-up request doesn't carry semantics (each
      // is matched by tool_call_id), so completion order is fine.
      await Promise.all(calls.map((c) => runOneCall(c)));
    } else {
      for (const c of calls) await runOneCall(c);
    }
    if (postToolImageMessages.length) convo.push(...postToolImageMessages);
    completedToolRound = true;
    emptyPostToolRetries = 0;
    // Loop: request again with the tool results in context.
  }

  // ---- One upstream request (stream + accumulate) --------------------
  // Performs a single request/response against the provider, streaming
  // `message` deltas through onEvent as they arrive. Returns
  //   { ok: true, assistantText, toolCalls: [{ id, name, arguments }] }
  // or { ok: false, error }. `done` is NOT emitted here — the caller
  // decides when the whole exchange is finished.
  async function runUpstreamTurn(convoMessages, specs) {
  const req = build(model, convoMessages, true);
  const supportsOpenAITools = model.provider === 'openai-compatible'
    || model.provider === 'openrouter'
    || model.provider === 'github-copilot';
  if (supportsOpenAITools && specs && specs.length) {
    const builderBody = req.body;
    if (builderBody && typeof builderBody === 'object') {
      builderBody.tools = specs;
    }
  }
  // Idle watchdog on the upstream request. The provider can accept the
  // socket and then go silent (dead gateway, stalled network, overloaded
  // model): without a deadline the server waits forever, the chat shows
  // "streaming…" permanently, and the running marker wedges the chat
  // (every retry gets 409 EALREADY_RUNNING). The timer resets on every
  // streamed byte, so a slow-but-chatty model never trips it — only a
  // genuinely silent one does. UPSTREAM_IDLE_MS covers the quiet gap
  // before the first token too (models can "think" for a long time
  // before emitting anything).
  const UPSTREAM_IDLE_MS = 180000; // 3 min of total silence = stuck
  const upstreamCtl = new AbortController();
  let idleTimer = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      try { upstreamCtl.abort(new Error('provider idle timeout')); } catch { /* already settled */ }
    }, UPSTREAM_IDLE_MS);
  };
  resetIdle();
  const stopIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
  // An outer signal (client disconnect) aborts the same request.
  let outerAbort = null;
  if (signal) {
    outerAbort = () => { try { upstreamCtl.abort(signal.reason || new Error('client disconnected')); } catch { /* already settled */ } };
    if (signal.aborted) outerAbort();
    else signal.addEventListener('abort', outerAbort, { once: true });
  }
  const upstream = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal: upstreamCtl.signal
  }).catch((e) => {
    return { __networkError: e };
  });

  if (upstream && upstream.__networkError) {
    stopIdle();
    if (signal && outerAbort) signal.removeEventListener('abort', outerAbort);
    const e = upstream.__networkError;
    if (e && e.name === 'AbortError') {
      const idle = upstreamCtl.signal.reason && upstreamCtl.signal.reason.message === 'provider idle timeout';
      const clientGone = signal && signal.aborted;
      if (clientGone) return { ok: false, error: { code: 'EABORTED', message: 'aborted' } };
      if (idle) return { ok: false, error: { code: 'ETIMEOUT', message: 'Provider sent nothing for 3 minutes — the request was cancelled. Try again.' } };
      return { ok: false, error: { code: 'EABORTED', message: 'aborted' } };
    }
    return { ok: false, error: { code: 'ENETWORK', message: e.message || 'network error' } };
  }
  if (!upstream.ok) {
    stopIdle();
    if (signal && outerAbort) signal.removeEventListener('abort', outerAbort);
    let detail = '';
    try { detail = await upstream.text(); } catch { /* ignore */ }
    return {
      ok: false,
      error: {
        code: 'EUPSTREAM',
        message: 'Upstream ' + upstream.status + ' ' + upstream.statusText,
        detail: detail.slice(0, 2000)
      }
    };
  }

  // Stream -> normalize -> onEvent. Assistant text and any tool-call
  // deltas are accumulated locally; the caller (the tool loop) decides
  // what to do with them. `done` is NOT emitted here.
  let sawError = null;
  let assistantText = '';
  let reasoningText = '';
  // OpenAI tool-call accumulator. Deltas arrive split across frames;
  // we assemble by `index`. The accumulator lives only for the
  // duration of one turn.
  const toolAcc = new Map(); // index -> { id, name, arguments }
  // Per-round usage trackers. OpenAI-shaped providers report usage once
  // on the final chunk (with stream_options.include_usage), but some
  // compatible gateways stamp a running total on every chunk. Summing
  // those would double-count, so the round's LAST non-zero report is
  // committed once by commitRoundUsage() when the stream ends. Across
  // tool rounds, completion tokens and cost are genuinely new and do sum.
  let roundPromptTokens = null;
  let roundCompletionTokens = null;
  let roundProviderCost = null;
  let roundProviderCostInput = null;
  let roundProviderCostOutput = null;
  let roundUsageCommitted = false;
  const stream = upstream.body;
  const isNDJSON = def.streamFormat === 'ndjson';
  try {
    if (isNDJSON) {
      for await (const obj of readNDJSON(stream)) {
        resetIdle(); // any upstream byte proves the provider is alive
        for (const ev of parse('', JSON.stringify(obj))) {
          apply(ev);
        }
      }
    } else {
      for await (const ev of readSSE(stream)) {
        resetIdle(); // any upstream byte proves the provider is alive
        for (const out of parse(ev.eventName, ev.data)) {
          apply(out);
        }
      }
    }
  } catch (e) {
    stopIdle();
    if (signal && outerAbort) signal.removeEventListener('abort', outerAbort);
    if (e && e.name === 'AbortError') {
      const idle = upstreamCtl.signal.reason && upstreamCtl.signal.reason.message === 'provider idle timeout';
      const clientGone = signal && signal.aborted;
      if (!clientGone && idle) {
        onEvent('error', { code: 'ETIMEOUT', message: 'Provider went silent mid-stream — the request was cancelled. Try again.' });
        return { ok: false, error: { code: 'ETIMEOUT', message: 'Provider went silent mid-stream — the request was cancelled. Try again.' } };
      }
      if (!clientGone) onEvent('error', { code: 'EABORTED', message: 'aborted' });
      return { ok: false, error: { code: 'EABORTED', message: 'aborted' } };
    }
    onEvent('error', { code: 'EUPSTREAM', message: e.message || 'stream error' });
    return { ok: false, error: { code: 'EUPSTREAM', message: e.message || 'stream error' } };
  }
  stopIdle();
  if (signal && outerAbort) signal.removeEventListener('abort', outerAbort);

  // Commit the round's usage exactly once. Providers that stamp usage
  // on every chunk (not just the final one) would otherwise have their
  // running totals summed into the turn aggregate (double-count). The
  // last non-zero report of the round wins — see apply()'s `done`.
  commitRoundUsage();

  if (sawError) return { ok: false, error: sawError };

  // Collapse the accumulator into an ordered list of tool calls.
  const toolCalls = [];
  for (const tc of toolAcc.values()) {
    if (tc.name) toolCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
  }
  // MiniMax/OpenRouter compatibility: if no native OpenAI tool call was
  // emitted, recover calls serialized into assistant text. OpenRouter text is
  // buffered for one turn so private sentinels never flash in the browser.
  if (!toolCalls.length && model.provider === 'openrouter') {
    const compat = parseMiniMaxTextToolCalls(assistantText);
    if (compat.calls.length) {
      assistantText = compat.text;
      toolCalls.push(...compat.calls);
    }
  }
  if (model.provider === 'openrouter') {
    if (reasoningText) onEvent('reasoning', { delta: reasoningText });
    if (assistantText) onEvent('message', { delta: assistantText });
  }
  return { ok: true, assistantText, toolCalls };

  function apply(ev) {
    if (ev.name === 'message') {
      if (ev.data && typeof ev.data.delta === 'string') assistantText += ev.data.delta;
      // OpenRouter is buffered until the turn completes because MiniMax may
      // serialize a tool call across several ordinary content deltas.
      if (model.provider !== 'openrouter') onEvent('message', ev.data);
    }
    else if (ev.name === 'reasoning') {
      if (ev.data && typeof ev.data.delta === 'string') reasoningText += ev.data.delta;
      if (model.provider !== 'openrouter') onEvent('reasoning', ev.data);
    }
    else if (ev.name === 'done') {
      // Record the round's usage into per-round trackers; committed once
      // by commitRoundUsage() when the stream ends. Do NOT emit `done`
      // here — the outer tool loop owns the single final `done` after
      // the whole exchange (all tool round-trips) has completed.
      //
      // promptTokens: the last report wins. Every round-trip re-sends the
      // full conversation, so summing would double-count the context on
      // tool-heavy turns (N rounds × full convo). The final round's
      // prompt is the accurate footprint.
      // completionTokens / providerCost: summed ACROSS rounds (each
      // round's output is genuinely new) but last-wins WITHIN a round,
      // so a provider that stamps running totals on intermediate chunks
      // is not double-counted.
      if (ev.data && ev.data.usage) {
        const p = Number(ev.data.usage.promptTokens);
        const c = Number(ev.data.usage.completionTokens);
        // Only overwrite when the provider actually reported a count;
        // a 0/absent value must not clobber a real number.
        if (isFinite(p) && p > 0) roundPromptTokens = p;
        if (isFinite(c) && c > 0) roundCompletionTokens = c;
        // Surface the round's prompt footprint so the chat UI can
        // refresh its context-usage line mid-exchange (tool rounds).
        // Anthropic already streams usage_input/usage_output; this
        // covers OpenAI-shaped providers that only report on `done`.
        if (isFinite(p) && p > 0) onEvent('usage_input', { promptTokens: p });
      }
      const cost = ev.data && ev.data.providerCost;
      if (typeof cost === 'number' && isFinite(cost) && cost >= 0) {
        roundProviderCost = cost;
        // firstFiniteNumberOrNull leaves absent fields null; keep "no
        // breakdown reported" distinct from a genuine $0 so the split
        // doesn't masquerade as known.
        const norm = (v) => (typeof v === 'number' && isFinite(v) && v > 0) ? v : null;
        roundProviderCostInput = norm(ev.data && ev.data.providerCostInput);
        roundProviderCostOutput = norm(ev.data && ev.data.providerCostOutput);
      }
    } else if (ev.name === 'usage_input') {
      const p = Number(ev.data && ev.data.promptTokens);
      // Anthropic reports this once at message_start; last wins so the
      // final round's prompt (the full conversation footprint) prevails.
      if (isFinite(p) && p > 0) roundPromptTokens = p;
      onEvent('usage_input', ev.data);
    } else if (ev.name === 'usage_output') {
      const c = Number(ev.data && ev.data.completionTokens);
      if (isFinite(c) && c > 0) roundCompletionTokens = c;
      onEvent('usage_output', ev.data);
      // Anthropic does not put usage on its `done` frame; the output
      // count arrives on `message_delta` and the input count on
      // `message_start`. Emit the round snapshot here so per-round cost
      // reaches intermediate segments for Anthropic too. Anthropic's
      // deltas are cumulative, so fire per delta — the server keeps the
      // last (richest) value. The trackers are intentionally NOT
      // committed here; the end-of-stream commitRoundUsage() folds the
      // final values into the turn aggregate exactly once.
      if (typeof onRoundUsage === 'function') {
        try {
          if ((roundPromptTokens || 0) > 0 || (roundCompletionTokens || 0) > 0) {
            onRoundUsage({
              promptTokens: roundPromptTokens || 0,
              completionTokens: roundCompletionTokens || 0,
              providerCost: null,
              providerCostInput: null,
              providerCostOutput: null
            });
            // The round has a snapshot; commitRoundUsage() must not
            // emit a duplicate when it folds the aggregates.
            roundUsageCommitted = true;
          }
        } catch { /* listener errors must not abort the stream */ }
      }
    } else if (ev.name === 'finish') {
      // The tool-call finish reason is handled by the outer loop
      // (it emits tool_call / tool_result). Pass through only the
      // non-tool finish reasons so the UI can show them.
      if (!(ev.data && ev.data.reason === 'tool_calls')) {
        onEvent('finish', ev.data);
      }
    } else if (ev.name === 'tool_call_delta') {
      // OpenAI streams tool calls as a list of deltas. Accumulate
      // by `index`. The first delta carries the `id`; subsequent
      // deltas fill in `function.name` (sometimes) and
      // `function.arguments` (a JSON string we concatenate).
      const d = ev.data;
      const idx = (typeof d.index === 'number') ? d.index : 0;
      let cur = toolAcc.get(idx);
      if (!cur) { cur = { id: null, name: '', arguments: '' }; toolAcc.set(idx, cur); }
      if (d.id) cur.id = d.id;
      if (d.function) {
        if (typeof d.function.name === 'string' && d.function.name) cur.name = d.function.name;
        if (typeof d.function.arguments === 'string') cur.arguments += d.function.arguments;
      }
    } else if (ev.name === 'error') {
      sawError = { code: ev.data.code || 'EUPSTREAM', message: ev.data.message || 'upstream error' };
      onEvent('error', ev.data);
    } else if (ev.name === 'passthrough') {
      onEvent('passthrough', ev.data);
    }
  }

  // Fold the round's latest usage report into the turn aggregate. The
  // trackers are consumed, so each report is added exactly once: a
  // provider that stamps usage on every chunk overwrites the pending
  // value (last-wins) instead of accumulating it. Anthropic commits per
  // `usage_output` delta; the end-of-stream call is then a no-op and the
  // real commit for providers that report on `done` (OpenAI-shaped,
  // Ollama). The per-round snapshot for segment costing is emitted once
  // per round, carrying the most recent numbers.
  function commitRoundUsage() {
    const promptTokens = roundPromptTokens || 0;
    const completionTokens = roundCompletionTokens || 0;
    const hasUsage = promptTokens > 0 || completionTokens > 0;
    const hasCost = typeof roundProviderCost === 'number' && isFinite(roundProviderCost) && roundProviderCost >= 0;
    if (!hasUsage && !hasCost) return;
    if (promptTokens > 0) usage.promptTokens = promptTokens;
    if (completionTokens > 0) usage.completionTokens = (usage.completionTokens || 0) + completionTokens;
    if (hasCost) providerCost = (providerCost || 0) + roundProviderCost;
    if (!roundUsageCommitted && hasUsage && typeof onRoundUsage === 'function') {
      try {
        onRoundUsage({
          promptTokens,
          completionTokens,
          providerCost: hasCost ? roundProviderCost : null,
          providerCostInput: roundProviderCostInput,
          providerCostOutput: roundProviderCostOutput
        });
      } catch { /* listener errors must not abort the stream */ }
    }
    roundUsageCommitted = true;
    roundPromptTokens = null;
    roundCompletionTokens = null;
    roundProviderCost = null;
    roundProviderCostInput = null;
    roundProviderCostOutput = null;
  }
  } // end runUpstreamTurn

  function usageWithDelegated() {
    return {
      promptTokens: (usage.promptTokens || 0) + (delegatedUsage.promptTokens || 0),
      completionTokens: (usage.completionTokens || 0) + (delegatedUsage.completionTokens || 0)
    };
  }

  function totalProviderCost() {
    const parent = (typeof providerCost === 'number' && isFinite(providerCost) && providerCost >= 0) ? providerCost : null;
    const delegated = (typeof delegatedProviderCost === 'number' && isFinite(delegatedProviderCost) && delegatedProviderCost >= 0) ? delegatedProviderCost : null;
    // Only publish an authoritative providerCost when the parent turn
    // reported one too. If just a delegated call reported cost, leave
    // providerCost null so src/index.js computes the whole turn from
    // the aggregated token usage instead of showing only the subagent.
    if (parent == null) return null;
    return parent + (delegated || 0);
  }

  function addDelegatedUsage(result) {
    if (!result || !result.ok) return;
    if (result.usage && typeof result.usage === 'object') {
      const promptTokens = Number(result.usage.promptTokens);
      const completionTokens = Number(result.usage.completionTokens);
      if (isFinite(promptTokens) && promptTokens > 0) delegatedUsage.promptTokens += promptTokens;
      if (isFinite(completionTokens) && completionTokens > 0) delegatedUsage.completionTokens += completionTokens;
    }
    const cost = Number(result.providerCost);
    if (isFinite(cost) && cost >= 0) delegatedProviderCost = (delegatedProviderCost || 0) + cost;
  }

  function toolResultImageParts(result) {
    if (!result || !Array.isArray(result.content)) return [];
    const out = [];
    for (const block of result.content) {
      if (!block || block.type !== 'image') continue;
      const data = block.data || block.base64;
      const mimeType = block.mimeType || block.mime_type || block.mediaType || block.media_type || 'image/png';
      if (typeof data === 'string' && data) {
        const url = data.startsWith('data:') ? data : ('data:' + mimeType + ';base64,' + data);
        out.push({ type: 'image_url', image_url: { url } });
      }
    }
    return out;
  }

  function firstStringArgument(value) {
    if (!value || typeof value !== 'object') return '';
    for (const item of Object.values(value)) {
      if (typeof item === 'string') return item;
    }
    return '';
  }

  // ---- Tool dispatcher -----------------------------------------------
  // Routes one tool call to its runner and returns
  //   { ok, content, result } where `content` is the string fed back
  //   to the model as the `tool` message, and `result` is the richer
  //   object surfaced to the chat UI in the tool_result SSE event.
  async function dispatchTool(name, args, callOpts) {
    // Native shell tool.
    if (name === 'shell') {
      let out;
      try {
        const shell = require('./tools/shell.js');
        const parentOnEvent = callOpts && callOpts.onEvent;
        const callId = callOpts && callOpts.callId;
        out = await shell.runShell({
          projectDir: callOpts.projectDir,
          cmd: args && args.cmd,
          timeoutMs: args && args.timeoutMs,
          // Stream decoded output chunks to the chat UI while the
          // command is still running so the tool card shows a live
          // preview instead of a silent spinner.
          onOutput: typeof parentOnEvent === 'function'
            ? (stream, delta) => {
              try {
                parentOnEvent('shell_output', { id: callId || null, stream, delta });
                // Inside a subagent run, re-emit under the nested event
                // name so the chunk lands in the parent subagent card
                // instead of a standalone transcript card.
                if (callOpts && callOpts.nestedSubagent) {
                  parentOnEvent('subagent_event', {
                    parentCallId: callOpts.callId || null,
                    kind: 'shell_output',
                    data: { id: callId || null, stream, delta }
                  });
                }
              } catch { /* best-effort */ }
            }
            : null
        });
      } catch (e) {
        out = { ok: false, error: e.message || String(e), code: 'ESHELL' };
      }
      // The first tool message line tells the model which software and
      // which shell ran the command (the spec description says the same
      // thing up front; the per-call line survives prompt compaction).
      const identity = (out && out.identity) || 'mouaif shell';
      return { ok: !!out.ok, content: '# ' + identity + '\n' + JSON.stringify(out), result: out };
    }

    if (name === 'activate_skill') {
      try {
        return require('./agentSkills.js').activate(callOpts && callOpts.projectDir, opts && opts.chat, args && args.name);
      } catch (e) {
        return { ok: false, content: JSON.stringify({ error: e.message, code: e.code || 'ENO_SKILL' }), result: { error: e.message, code: e.code || 'ENO_SKILL' } };
      }
    }

    // Native task tool. Manages structured tasks with subtasks, progress
    // tracking, and completion. Tasks are in-memory per chat (do not
    // survive a server restart).
    if (name === 'task') {
      try {
        const taskMod = require('./tools/task.js');
        const validated = taskMod.validateArgs(args);
        const out = taskMod.dispatchTask(callOpts && callOpts.chatId, validated);
        // Surface task progress changes as a progress_update event so the
        // frontend progress card and the per-chat updatable push
        // notification (tag chat-<id>-progress) show the current task
        // title and count — the same notification slot the
        // report_progress tool uses. Creation is skipped: a fresh task
        // always starts at 0%, which would be a noise notification.
        if (out && out.ok && out.result && out.result.task
          && (out.result.action === 'progress_updated' || out.result.action === 'completed')
          && callOpts && typeof callOpts.onEvent === 'function') {
          const t = out.result.task;
          const completed = out.result.action === 'completed';
          callOpts.onEvent('progress_update', {
            callId: (callOpts && callOpts.callId) || null,
            kind: 'task',
            title: t.title || 'Task',
            current: typeof t.current === 'number' ? t.current : 0,
            total: typeof t.total === 'number' ? t.total : 100,
            status: completed ? 'completed' : 'running',
            message: completed
              ? 'Task complete'
              : ((typeof t.current === 'number' && typeof t.total === 'number')
                  ? t.current + ' of ' + t.total
                  : '')
          });
        }
        return out;
      } catch (e) {
        const r = { error: { code: e.code || 'ETASK', message: e.message || String(e) } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
    }

    // Native subagent tool. It delegates to the same model with the same
    // project tool surface, including MCP. The nested call intentionally omits
    // only `subagent` itself to avoid unbounded recursive delegation loops.
    // Authorization uses the parent chat id so the existing chat popup/card is
    // reused for any nested tool or MCP call that needs approval.
    if (name === 'subagent') {
      const task = args && typeof args.task === 'string' ? args.task.trim() : '';
      const context = args && typeof args.context === 'string' ? args.context.trim() : '';
      const agentName = args && typeof args.agent === 'string' ? args.agent.trim() : '';
      if (!task) {
        const r = { error: { code: 'EBADINPUT', message: 'task is required' } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      // Resolve the requested agent persona (if any). Agents are
      // named subagent personas from .mouaif.json — an unknown name is
      // a hard, typed error so the model can retry with a valid one
      // instead of silently delegating to a generic subagent.
      let agentTools = null;
      let nestedModel = model; // default: inherit the chat's model
      const nestedMessages = [];
      if (agentName) {
        if (!callOpts || !callOpts.projectDir) {
          const r = { error: { code: 'EUNKNOWN_AGENT', message: 'No project context to resolve agent "' + agentName + '"', available: [] } };
          return { ok: false, content: JSON.stringify(r), result: r };
        }
        let agent = null;
        let available = [];
        let agentMod = null;
        try {
          agentMod = require('./agents.js');
          const all = agentMod.list(callOpts.projectDir);
          available = all.map((a) => a.name);
          agent = all.find((a) => a.name === agentName) || null;
        } catch { /* fall through to typed error */ }
        if (!agent) {
          const r = { error: { code: 'EUNKNOWN_AGENT', message: 'Unknown agent "' + agentName + '"', available } };
          return { ok: false, content: JSON.stringify(r), result: r };
        }
        // Optional per-agent model pin. When set, the nested call runs
        // on that project model (hydrated with its provider connection)
        // instead of inheriting the chat's model. Unknown model ids
        // fail loudly — never a silent fallback.
        if (agent.modelId) {
          try {
            const rec = agentMod.resolveModel(callOpts.projectDir, agent);
            const settingsMod = require('./settings.js');
            const app = settingsMod.getApp();
            const providers = Array.isArray(app.providers) ? app.providers : [];
            const connection = providers.find((p) => p && p.id === rec.provider) || null;
            nestedModel = Object.assign({}, connection || {}, rec, {
              provider: rec.provider,
              auth: rec.auth || (connection && connection.auth) || 'apikey'
            });
          } catch (e) {
            const r = { error: { code: e.code || 'EUNKNOWN_MODEL', message: e.message || String(e) } };
            return { ok: false, content: JSON.stringify(r), result: r };
          }
        }
        nestedMessages.push({ role: 'system', content: agent.content });
        agentTools = Array.isArray(agent.tools) && agent.tools.length ? agent.tools : null;
      } else {
        nestedMessages.push({
          role: 'system',
          content: 'You are a focused subagent. Answer only the delegated task. Be concise. You may use the available project tools and MCP tools when they help; authorization prompts are handled by the parent chat.'
        });
      }
      nestedMessages.push({
        role: 'user',
        content: context ? ('Task:\n' + task + '\n\nContext:\n' + context) : task
      });
      const nestedEvents = [];
      const parentEnabled = callOpts && Array.isArray(callOpts.enabledTools) ? callOpts.enabledTools : null;
      let nestedEnabled = parentEnabled
        ? parentEnabled.filter((toolName) => toolName !== 'subagent')
        : visibleToolSpecs
            .map((spec) => spec && spec.function && spec.function.name)
            .filter((toolName) => toolName && toolName !== 'subagent');
      // An agent's tool allowlist restricts the nested call's surface.
      // Agent tool entries can be exact tool names (e.g. "shell") or MCP
      // server slugs (e.g. "mcp__fs") which should allow every tool from
      // that server (mcp__fs__read_file, mcp__fs__write_file, ...).
      if (agentTools) {
        const allow = new Set(agentTools);
        nestedEnabled = nestedEnabled.filter((toolName) => {
          if (allow.has(toolName)) return true;
          // Prefix match for MCP server slugs: "mcp__fs" allows
          // "mcp__fs__read_file", "mcp__fs__write_file", etc.
          for (const prefix of allow) {
            if (prefix.startsWith('mcp__') && toolName.startsWith(prefix + '__')) return true;
          }
          return false;
        });
      }
      const nested = await streamChat({
        model: nestedModel,
        messages: nestedMessages,
        signal,
        projectDir: callOpts && callOpts.projectDir,
        chatId: callOpts && callOpts.chatId,
        appSettings: callOpts && callOpts.appSettings,
        promptSize: callOpts && callOpts.promptSize,
        enabledTools: nestedEnabled,
        // Marker the shell dispatcher reads to re-emit live output
        // chunks as subagent_event so they render inside this card.
        nestedSubagent: true,
        onEvent: (eventName, data) => {
          nestedEvents.push({ name: eventName, data });
          if (typeof onEvent !== 'function') return;
          // Authorization (and ask_user) still ride the normal event
          // so the parent chat popup/card handles the nested
          // approval. The `parentTool` tag tells the chat UI to
          // route the card into the subagent's live container.
          if (eventName === 'authorization_required' || eventName === 'ask_user_required') {
            onEvent(eventName, Object.assign({}, data, { parentTool: 'subagent' }));
            return;
          }
          // Forward nested progress under a distinct event name. The
          // parent's SSE layer persists every `tool_call` / `tool_result`
          // / `message` it sees, so reusing those names would corrupt
          // the transcript with the subagent's internal turns.
          if (eventName === 'tool_call' || eventName === 'tool_result' || eventName === 'message') {
            onEvent('subagent_event', {
              parentCallId: (callOpts && callOpts.callId) || null,
              kind: eventName,
              data
            });
          }
        }
      });
      let text = '';
      const nestedToolEvents = [];
      for (const ev of nestedEvents) {
        if (ev.name === 'message' && ev.data && typeof ev.data.delta === 'string') text += ev.data.delta;
        else if (ev.name === 'tool_call' || ev.name === 'tool_result' || ev.name === 'authorization_required') nestedToolEvents.push(ev);
      }
      // Rebuild a faithful nested transcript for the UI. The plain
      // `chat` (system+user+final assistant) hides every tool turn,
      // which made the subagent preview look like no tools ran. We fold
      // streamed tool_call / tool_result events back into OpenAI-shaped
      // messages so the chat card can render them.
      const chat = nestedMessages.slice();
      {
        let pendingCalls = [];
        const flushCalls = () => {
          if (!pendingCalls.length) return;
          chat.push({
            role: 'assistant',
            content: null,
            tool_calls: pendingCalls.map((c) => ({
              id: c.id || undefined,
              type: 'function',
              function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args || {}) }
            }))
          });
          pendingCalls = [];
        };
        for (const ev of nestedToolEvents) {
          const d = ev.data || {};
          if (ev.name === 'tool_call') {
            pendingCalls.push({ id: d.id, name: d.name, args: d.args });
          } else if (ev.name === 'tool_result') {
            flushCalls();
            chat.push({
              role: 'tool',
              tool_call_id: d.id || undefined,
              name: d.name,
              content: typeof d.result === 'string' ? d.result : JSON.stringify(d.result)
            });
          }
        }
        flushCalls();
      }
      chat.push({ role: 'assistant', content: text });
      const r = nested && nested.ok
        ? { ok: true, text, chat, toolEvents: nestedToolEvents, usage: nested.usage || null, providerCost: nested.providerCost || null }
        : { ok: false, text, chat, toolEvents: nestedToolEvents, error: nested && nested.error ? nested.error : { code: 'ESUBAGENT', message: 'subagent failed' } };
      return { ok: !!(nested && nested.ok), content: JSON.stringify(r), result: r };
    }

    // Native ask_user tool. The runner is a thin shim: it folds the
    // user's structured answer (carried on callOpts.answerPayload, set
    // by the authorization gate above) into a { ok, content, result }
    // triple the AI client returns to the model. The actual user
    // interaction rides the `ask_user_required` SSE event; the chat
    // UI is the only thing that ever sees the question payload.
    if (name === 'ask_user') {
      let askMod;
      try { askMod = require('./tools/ask.js'); }
      catch (e) {
        const r = { error: { code: 'EMODULE', message: 'ask_user tool module unavailable: ' + (e.message || e) } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      let validated;
      try { validated = askMod.validateArgs(args); }
      catch (e) {
        const r = { error: { code: e.code || 'EBADINPUT', message: e.message } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      // The deny path passes { cancelled: true } explicitly. Any other
      // missing payload means the gate resolved without prompting — a
      // bug, not a user dismissal — so surface it as an internal error
      // the model can report instead of a silent "cancelled".
      const payload = (callOpts && callOpts.answerPayload);
      if (!payload) {
        const r = { error: { code: 'ENOANSWER', message: 'ask_user resolved without a user answer; the question was not shown or the session was stale. Ask the user again.' } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      const choice = payload && Array.isArray(payload.choice) ? payload.choice.slice() : (payload && typeof payload.choice === 'string' ? payload.choice : '');
      const extra = askMod.clampExtra(payload && typeof payload.extra === 'string' ? payload.extra : '');
      const out = askMod.buildResult({
        choice,
        extra,
        options: validated.options,
        multiSelect: validated.multiSelect,
        cancelled: !!(payload && payload.cancelled)
      });
      return { ok: out.ok, content: out.content, result: out.result };
    }

    // Native list_features tool — returns the full structured feature
    // state for the current project and chat. Not gated by authorization:
    // it is read-only metadata, does not execute commands or modify files.
    if (name === 'list_features') {
      let af;
      try { af = require('./agentFeatures.js'); }
      catch (e) {
        const r = { error: { code: 'EMODULE', message: 'agentFeatures module unavailable: ' + (e.message || e) } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      return await af.dispatchListFeatures(args, {
        projectDir: callOpts && callOpts.projectDir,
        chatId: callOpts && callOpts.chatId,
        chat: callOpts && callOpts.chat
      });
    }

    // Native report_progress tool — validates args, emits a
    // progress_update SSE event so the frontend can show a live
    // progress bar, and returns the structured data to the model.
    if (name === 'report_progress') {
      let progMod;
      try { progMod = require('./tools/progress.js'); }
      catch (e) {
        const r = { error: { code: 'EMODULE', message: 'report_progress tool module unavailable: ' + (e.message || e) } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      let validated;
      try { validated = progMod.validateArgs(args); }
      catch (e) {
        const r = { error: { code: e.code || 'EBADINPUT', message: e.message } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      // Emit progress_update SSE event for the frontend.
      if (callOpts && callOpts.onEvent && typeof callOpts.onEvent === 'function') {
        callOpts.onEvent('progress_update', {
          callId: (callOpts && callOpts.callId) || null,
          title: validated.title,
          current: validated.current,
          total: validated.total,
          status: validated.status,
          message: validated.message || ''
        });
      }
      return progMod.buildResult(validated);
    }

    // Native file tools: read_file, list_files, search_files, write_file,
    // edit_file (compatibility alias for a full-file write).
    // Gated by callOpts.fileToolsEnabled (matches the spec-collection
    // branch above). Dispatched in one shot — all four share the same
    // path-safety, size-cap, and authorization story, so a single
    // dispatch helper keeps the call site readable.
    if (name === 'read_file' || name === 'list_files' || name === 'search_files' || name === 'write_file' || name === 'edit_file') {
      let ft;
      try { ft = require('./tools/files.js'); }
      catch (e) {
        const r = { error: { code: 'EMODULE', message: 'file tools module unavailable: ' + (e.message || e) } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      return await ft.runFileTool(name, {
        projectDir: callOpts && callOpts.projectDir,
        args,
        settings: callOpts && callOpts.appSettings
      });
    }

    // MCP tools (mcp__<serverSlug>__<toolName>).
    if (callOpts && callOpts.projectDir) {
      let mcpMod;
      try { mcpMod = require('./mcp.js'); }
      catch (e) {
        const r = { error: { code: 'EMODULE', message: 'MCP module unavailable: ' + (e.message || e) } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      const parsed = mcpMod.parseServerSlugAndToolName(name);
      if (parsed) {
        let out;
        try {
          out = await mcpMod.callTool(callOpts.projectDir, parsed.serverSlug, parsed.toolName, args);
        } catch (e) {
          out = { ok: false, content: [{ type: 'text', text: 'MCP error: ' + (e.message || e) }], isError: true };
        }
        const result = { content: out.content, isError: !!out.isError };
        return { ok: !!out.ok, content: JSON.stringify(result), result };
      }
    }

    // Unknown tool.
    const r = { error: { code: 'EUNKNOWN_TOOL', message: 'Unknown tool: ' + name } };
    return { ok: false, content: JSON.stringify(r), result: r };
  }
} // end streamChat

// Non-streaming variant for tests and one-shot calls.
async function chat(model, messages, opts) {
  const events = [];
  const r = await streamChat({
    model, messages,
    signal: opts && opts.signal,
    onEvent: (name, data) => events.push({ name, data })
  });
  let text = '';
  for (const e of events) if (e.name === 'message' && e.data && typeof e.data.delta === 'string') text += e.data.delta;
  return Object.assign({ text }, r);
}

module.exports = {
  // public
  streamChat,
  chat,
  runSingleToolCall,
  ENDPOINTS,
  listModels,
  // exposed for tests
  parseSSEFrame,
  readSSE,
  readNDJSON,
  BUILDERS,
  PARSERS,
  // exposed for tests + the OAuth module's refresher path
  copilotCacheClear
};
