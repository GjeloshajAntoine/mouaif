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
      return parseOpenAIShapedModels(body);
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
    listModels: async () => parseCuratedModels(ANTHROPIC_MODEL_CATALOG),
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
    }
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
    // `contextWindow` field is the upstream maximum.
    listModels: async () => parseCuratedModels(COPILOT_MODEL_CATALOG),
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
      return parseOpenAIShapedModels(body);
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

function parseOpenAIShapedModels(body) {
  const arr = Array.isArray(body && body.data) ? body.data : [];
  const out = [];
  for (const m of arr) {
    if (!m || !m.id) continue;
    out.push({
      id: String(m.id),
      label: m.id,
      contextWindow: typeof m.context_window === 'number' ? m.context_window : undefined
    });
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
    out.push({
      id,
      label: m.displayName || id,
      contextWindow: typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : undefined
    });
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

function parseCuratedModels(catalog) {
  return catalog.map((m) => ({
    id: m.id,
    label: m.label || m.id,
    contextWindow: m.contextWindow
  }));
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
    // Re-throw with the typed code preserved (ENOCOPILOT, EUPSTREAM, EPARSE, ETOKEN).
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
  return {
    url: joinUrl(baseUrl, ENDPOINTS['openai-compatible'].chatPath),
    headers,
    body: {
      model: model.id,
      messages,
      stream: !!stream
    }
  };
}

function buildAnthropicRequest(model, messages, stream) {
  const systemMsgs = messages.filter(m => m.role === 'system');
  const systemContent = systemMsgs.map(m => m.content).filter(Boolean).join('\n\n');
  const chatMessages = messages.filter(m => m.role !== 'system');
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
    body: {
      model: model.id,
      max_tokens: model.maxTokens || 1024,
      system: systemContent || undefined,
      messages: chatMessages.map(m => ({ role: m.role, content: m.content })),
      stream: !!stream
    }
  };
}

function buildGeminiRequest(model, messages, stream) {
  // Gemini uses ?alt=sse for streaming responses.
  const url = joinUrl(ENDPOINTS.gemini.baseUrl, '/v1beta/models/' + encodeURIComponent(model.id) + ':' + (stream ? 'streamGenerateContent?alt=sse' : 'generateContent'));
  const systemMsgs = messages.filter(m => m.role === 'system');
  const systemContent = systemMsgs.map(m => m.content).filter(Boolean).join('\n\n');
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = { contents };
  if (systemContent) body.systemInstruction = { role: 'system', parts: [{ text: systemContent }] };
  return {
    url,
    headers: { 'Content-Type': 'application/json', ...ENDPOINTS.gemini.authHeader(credential(model)) },
    body
  };
}

function buildOllamaRequest(model, messages, stream) {
  return {
    url: joinUrl(model.baseUrl || ENDPOINTS.ollama.baseUrl, ENDPOINTS.ollama.chatPath),
    headers: { 'Content-Type': 'application/json' },
    body: { model: model.id, messages, stream: !!stream }
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
  if (choice && choice.delta && typeof choice.delta.content === 'string') {
    yield { name: 'message', data: { delta: choice.delta.content } };
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
    yield { name: 'done', data: { usage: { promptTokens: obj.usage.prompt_tokens || 0, completionTokens: obj.usage.completion_tokens || 0 } } };
  }
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
      if (typeof part.text === 'string') yield { name: 'message', data: { delta: part.text } };
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

async function streamChat(opts) {
  const { model, messages, signal, onEvent } = opts || {};
  if (!model || !model.provider) {
    return { ok: false, error: { code: 'EBADMODEL', message: 'Missing model.provider' } };
  }
  if (!Array.isArray(messages) || !messages.length) {
    return { ok: false, error: { code: 'EBADINPUT', message: 'messages must be a non-empty array' } };
  }
  if (typeof onEvent !== 'function') {
    return { ok: false, error: { code: 'EBADINPUT', message: 'onEvent must be a function' } };
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
  //   2. The native file tools (read_file / list_files / search_files /
  //      write_file, src/tools/files.js), always present. Authorization
  //      decides whether a call prompts, runs, or is rejected. These cover
  //      "read this file / find where X is used / patch a small file"
  //      loop without requiring an MCP server.
  //   3. MCP-discovered tools (decision §18), which use the
  //      mcp__<serverSlug>__<toolName> name convention.
  // Tool calling and the multi-turn loop below are wired only for the
  // OpenAI-compatible tool shape (openai-compatible + github-copilot).
  // Other providers stream normally and never see a `tools` field, so
  // their happy path is unchanged.
  const toolSpecs = [];
  try { toolSpecs.push(require('./tools/shell.js').SPEC); }
  catch { /* shell tool module unavailable; skip */ }
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

  // Shrink the tool declaration according to the active prompt-size
  // profile (decisions §4). very-small advertises tool names + short
  // descriptions with no parameter schema; average/extensive send the
  // full specs. This is applied AFTER both sources (shell + MCP) are
  // collected so every advertised tool is reduced uniformly.
  let effectiveToolSpecs = toolSpecs;
  try {
    const pp = require('./promptProfiles.js');
    effectiveToolSpecs = pp.reduceToolSpecs(toolSpecs, opts && opts.promptSize);
  } catch { /* non-fatal; fall back to the full specs */ }

  // The multi-turn tool loop. `convo` is the working message array; it
  // grows by one assistant (tool-call) message + N tool-result messages
  // each iteration the model asks for tools. Bounded by MAX_TOOL_TURNS
  // so a runaway model cannot spin forever.
  const MAX_TOOL_TURNS = (opts && typeof opts.maxToolTurns === 'number') ? opts.maxToolTurns : 12;
  const convo = messages.slice();
  const usage = { promptTokens: 0, completionTokens: 0 };

  for (let turn = 0; turn <= MAX_TOOL_TURNS; turn++) {
    const isFinalAllowedTurn = turn === MAX_TOOL_TURNS;
    const result = await runUpstreamTurn(convo, effectiveToolSpecs, isFinalAllowedTurn);
    if (!result.ok) return { ok: false, error: result.error, usage };

    const calls = result.toolCalls;
    if (!calls || !calls.length) {
      // No tool calls this turn -> the assistant is done. Emit the
      // final `done` with the accumulated usage and return.
      onEvent('done', { usage });
      return { ok: true, usage };
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
    for (const c of calls) {
      let args = {};
      if (c.arguments) {
        try { args = JSON.parse(c.arguments); }
        catch { args = { __raw: c.arguments }; }
      }
      let exec;
      let callEmitted = false;
      try {
        const authGate = require('./tools/authorization.js');
        // The summary shown on the "Authorization required" card and
        // matched against the file-tool allowlist needs the right
        // argument per tool family. For shell it's the command; for
        // the file tools it's the path (with the optional query /
        // content as a hint, when relevant).
        let summary;
        if (c.name === 'shell') summary = (args && args.cmd) || '';
        else if (c.name === 'read_file' || c.name === 'list_files' || c.name === 'search_files' || c.name === 'write_file' || c.name === 'edit_file') {
          summary = (args && (args.path || args.file)) || (args && args.query) || '';
        } else {
          summary = firstStringArgument(args);
        }
        const authResult = await authGate.authorize({
          projectDir: opts && opts.projectDir,
          chatId: opts && opts.chatId,
          tool: c.name,
          callId: c.id,
          cmd: args && args.cmd,
          summary,
          timeoutMs: args && args.timeoutMs
        });

        if (authResult.decision === 'prompt') {
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
          await authResult.wait;
        }
        // Only announce a running tool after authorization has completed.
        // Previously the UI showed "tool call — running" while the server
        // was actually blocked waiting for an authorization decision. If the
        // authorization card was missed or the page reloaded, the transcript
        // appeared permanently stuck on a tool call with no messages.
        onEvent('tool_call', { id: c.id || null, name: c.name, args });
        callEmitted = true;
        exec = await dispatchTool(c.name, args, opts);
      } catch (e) {
        // Denied/disabled/error calls still need a call card immediately
        // before their result so persisted history remains a valid pair.
        if (!callEmitted) onEvent('tool_call', { id: c.id || null, name: c.name, args });
        if (e.code === 'EDENIED') {
          exec = { ok: false, content: JSON.stringify({ ok: false, code: 'EDENIED', reason: 'user denied' }), result: { ok: false, code: 'EDENIED', reason: 'user denied' } };
        } else if (e.code === 'ETOOL_DISABLED') {
          exec = { ok: false, content: JSON.stringify({ ok: false, code: 'ETOOL_DISABLED', reason: 'tool is disabled' }), result: { ok: false, code: 'ETOOL_DISABLED', reason: 'tool is disabled' } };
        } else {
          exec = { ok: false, content: JSON.stringify({ ok: false, error: e.message }), result: { ok: false, error: e.message } };
        }
      }

      onEvent('tool_result', { id: c.id || null, name: c.name, ok: exec.ok, result: exec.result });

      convo.push({
        role: 'tool',
        tool_call_id: c.id || undefined,
        name: c.name,
        content: typeof exec.content === 'string' ? exec.content : JSON.stringify(exec.content)
      });
    }
    // Loop: request again with the tool results in context.
  }

  // We fell out of the loop at MAX_TOOL_TURNS with tool calls still
  // pending. runUpstreamTurn on the final turn suppresses tool specs
  // so the model is forced to answer, so this is defensive only.
  onEvent('done', { usage });
  return { ok: true, usage };

  // ---- One upstream request (stream + accumulate) --------------------
  // Performs a single request/response against the provider, streaming
  // `message` deltas through onEvent as they arrive. Returns
  //   { ok: true, assistantText, toolCalls: [{ id, name, arguments }] }
  // or { ok: false, error }. `done` is NOT emitted here — the caller
  // decides when the whole exchange is finished.
  async function runUpstreamTurn(convoMessages, specs, suppressTools) {
  const req = build(model, convoMessages, true);
  if (specs && specs.length && !suppressTools) {
    const builderBody = req.body;
    if (builderBody && typeof builderBody === 'object') {
      builderBody.tools = specs;
    }
  }
  const upstream = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal
  }).catch((e) => {
    return { __networkError: e };
  });

  if (upstream && upstream.__networkError) {
    const e = upstream.__networkError;
    if (e && e.name === 'AbortError') {
      return { ok: false, error: { code: 'EABORTED', message: 'aborted' } };
    }
    return { ok: false, error: { code: 'ENETWORK', message: e.message || 'network error' } };
  }
  if (!upstream.ok) {
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
  // OpenAI tool-call accumulator. Deltas arrive split across frames;
  // we assemble by `index`. The accumulator lives only for the
  // duration of one turn.
  const toolAcc = new Map(); // index -> { id, name, arguments }
  const stream = upstream.body;
  const isNDJSON = def.streamFormat === 'ndjson';
  try {
    if (isNDJSON) {
      for await (const obj of readNDJSON(stream)) {
        for (const ev of parse('', JSON.stringify(obj))) {
          apply(ev);
        }
      }
    } else {
      for await (const ev of readSSE(stream)) {
        for (const out of parse(ev.eventName, ev.data)) {
          apply(out);
        }
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      onEvent('error', { code: 'EABORTED', message: 'aborted' });
      return { ok: false, error: { code: 'EABORTED', message: 'aborted' } };
    }
    onEvent('error', { code: 'EUPSTREAM', message: e.message || 'stream error' });
    return { ok: false, error: { code: 'EUPSTREAM', message: e.message || 'stream error' } };
  }

  if (sawError) return { ok: false, error: sawError };

  // Collapse the accumulator into an ordered list of tool calls.
  const toolCalls = [];
  for (const tc of toolAcc.values()) {
    if (tc.name) toolCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
  }
  return { ok: true, assistantText, toolCalls };

  function apply(ev) {
    if (ev.name === 'message') { if (ev.data && typeof ev.data.delta === 'string') assistantText += ev.data.delta; onEvent('message', ev.data); }
    else if (ev.name === 'done') {
      // Accumulate usage into the shared counter. Do NOT emit `done`
      // here — the outer tool loop owns the single final `done` after
      // the whole exchange (all tool round-trips) has completed.
      if (ev.data && ev.data.usage) {
        usage.promptTokens = (usage.promptTokens || 0) + (ev.data.usage.promptTokens || 0);
        usage.completionTokens = (usage.completionTokens || 0) + (ev.data.usage.completionTokens || 0);
      }
    } else if (ev.name === 'usage_input') {
      usage.promptTokens = (usage.promptTokens || 0) + (ev.data.promptTokens || 0);
      onEvent('usage_input', ev.data);
    } else if (ev.name === 'usage_output') {
      usage.completionTokens = (usage.completionTokens || 0) + (ev.data.completionTokens || 0);
      onEvent('usage_output', ev.data);
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
  } // end runUpstreamTurn

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
        out = await shell.runShell({
          projectDir: callOpts.projectDir,
          cmd: args && args.cmd,
          timeoutMs: args && args.timeoutMs
        });
      } catch (e) {
        out = { ok: false, error: e.message || String(e), code: 'ESHELL' };
      }
      return { ok: !!out.ok, content: JSON.stringify(out), result: out };
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
