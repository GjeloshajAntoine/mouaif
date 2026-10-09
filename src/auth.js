'use strict';

// Auth — app-database credentials + non-secret account index.
// OAuth tokens live in a dedicated SQLite table, not the settings JSON
// returned to clients. Accessible legacy keychain entries migrate on read.
//
// Public surface:
//
//   const auth = require('./auth.js');
//
//   await auth.setToken('openai', 'me@example.com', JSON.stringify(blob));
//   const blob = await auth.getToken('openai', 'me@example.com'); // string | null
//   await auth.deleteToken('openai', 'me@example.com');
//
//   auth.listAccounts(); // -> { openai: ['me@example.com'], anthropic: [], ... }
//   auth.resolveAccount(model); // -> account string or null, for a model with auth='oauth'
//   auth.tokenForModel(model);  // -> blob string or null, the credential the AI client needs
//
//   auth.recordPending(provider, { state, codeVerifier?, redirectUri, scopes, accountHint? });
//   auth.consumePending(provider, state);  // -> the pending record or null
//   auth.clearPending(provider, state);
//
// Errors are typed: ECREDENTIALS (database unavailable), EBADINPUT
// (validation), EPROVIDER (unknown provider).
const settings = require('./settings.js');
const credentials = require('./credentialStore.js');

// Preserve the legacy service names for copy-on-read migration; per-provider
// accounts remain namespaced under 'mouaif/<provider>'.
const SERVICE_PREFIX = 'mouaif';

// Credential namespaces. Every provider id that appears as a *value* in
// AI_TO_AUTH_PROVIDER below must be listed here: serviceName()/validateAccount()
// reject anything else with EPROVIDER, and readIndex() builds the non-secret
// account index by walking this list, so a namespace that is missing here is
// silently dropped from the index and makes indexAdd() throw. The API-key-only
// providers have a namespace but no sign-in flow: the namespace keeps a key
// stored under one provider from ever being read as another's credential, and
// gives an oauth-flagged record a clean ENOAUTH instead of a spurious EPROVIDER.
const SUPPORTED_PROVIDERS = [
  'openai', 'anthropic', 'google', 'github-copilot', 'openrouter', 'codex',
  'azure', 'mistral', 'groq', 'deepseek', 'ollama'
];

function serviceName(provider) {
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    const e = new Error('Unknown provider: ' + provider);
    e.code = 'EPROVIDER';
    throw e;
  }
  return SERVICE_PREFIX + '/' + provider;
}

function validateAccount(provider, account) {
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    const e = new Error('Unknown provider: ' + provider);
    e.code = 'EPROVIDER';
    throw e;
  }
  if (!account || typeof account !== 'string' || !account.length) {
    const e = new Error('Account is required');
    e.code = 'EBADINPUT';
    throw e;
  }
}

// ---- Token CRUD --------------------------------------------------------

async function setToken(provider, account, blob) {
  validateAccount(provider, account);
  if (typeof blob !== 'string') {
    const e = new Error('Token blob must be a string');
    e.code = 'EBADINPUT';
    throw e;
  }
  settings.getDb().transaction(() => {
    credentials.write(serviceName(provider), account, blob);
    indexAdd(provider, account);
  })();
  return { provider, account };
}

function getToken(provider, account) {
  validateAccount(provider, account);
  return credentials.read(serviceName(provider), account);
}

function deleteToken(provider, account) {
  validateAccount(provider, account);
  const service = serviceName(provider);
  const deleted = credentials.read(service, account) !== null;
  settings.getDb().transaction(() => {
    credentials.remove(service, account);
    indexRemove(provider, account);
  })();
  return { provider, account, deleted };
}

// ---- Non-secret account index ------------------------------------------
// Preserve the legacy account index for migration; merge saved DB accounts
// without returning credential values to the UI.

function readIndex() {
  const app = settings.getApp();
  const raw = app.authAccounts;
  const out = {};
  for (const p of SUPPORTED_PROVIDERS) {
    out[p] = [...new Set([
      ...(Array.isArray(raw && raw[p]) ? raw[p] : []),
      ...credentials.accounts(serviceName(p))
    ])].sort();
  }
  return out;
}

function writeIndex(idx) {
  settings.setApp({ authAccounts: idx });
}

function indexAdd(provider, account) {
  const idx = readIndex();
  if (!idx[provider].includes(account)) idx[provider].push(account);
  idx[provider].sort();
  writeIndex(idx);
}

function indexRemove(provider, account) {
  const idx = readIndex();
  idx[provider] = idx[provider].filter(a => a !== account);
  writeIndex(idx);
}

function listAccounts() {
  return readIndex();
}

// ---- Model integration -------------------------------------------------

// Map an AI client provider (the value stored on the model record's
// `provider` field) to the auth provider that the credential table is keyed
// under. The model record keeps the AI client provider verbatim per
// decision §10; the mapping lives here, in the auth module, because
// that is the subsystem that owns the credential namespace.
//
// Today's pairs are 1:1 except for the OpenAI-compatible family, which
// uses the openai credential namespace so any signed-in OpenAI account
// can serve an openai-compatible model. New AI clients that should
// re-use an existing auth flow register here.
const AI_TO_AUTH_PROVIDER = Object.freeze({
  'openai-compatible': 'openai',
  'anthropic':         'anthropic',
  'gemini':            'google',
  'ollama':            'ollama', // no OAuth; rejected upstream as a non-OAuth model
  'github-copilot':    'github-copilot',
  'codex':             'codex',
  // Azure, Mistral, Groq, DeepSeek and the other OpenAI-shaped
  // providers take API keys only; they map to their own credential
  // namespaces so a key stored under one provider is never treated
  // as a credential for another (the settings UI never offers an
  // OAuth option for them anyway).
  'azure':             'azure',
  'mistral':           'mistral',
  'groq':              'groq',
  'deepseek':          'deepseek',
  // OpenRouter has its own credential namespace ('openrouter'). The
  // PKCE sign-in flow (src/oauth-openrouter.js) stores the issued
  // API key under that namespace; the apikey path uses
  // model.apiKey directly and does not use the credential table. Two
  // signed-in OpenRouter accounts therefore live as separate rows
  // in the OAuth account picker; an OpenAI key in the 'openai'
  // namespace is NOT a valid OpenRouter credential — the two
  // services have different billing.
  'openrouter':        'openrouter'
});

function authProviderFor(model) {
  if (!model || !model.provider) return null;
  if (Object.prototype.hasOwnProperty.call(AI_TO_AUTH_PROVIDER, model.provider)) {
    return AI_TO_AUTH_PROVIDER[model.provider];
  }
  // Unknown AI provider: best-effort fall through. The AI client will
  // surface this as EUNKNOWN_PROVIDER before we ever read a token.
  return model.provider;
}

function resolveAccount(model) {
  if (!model || model.auth !== 'oauth') return null;
  if (model.oauthAccount) return model.oauthAccount;
  // Fallback: if the model has no explicit account but the user has a
  // single account on the auth provider, use it. Multi-account users
  // must set oauthAccount explicitly.
  const idx = readIndex();
  const authProv = authProviderFor(model);
  const list = idx[authProv] || [];
  if (list.length === 1) return list[0];
  return null;
}

function tokenForModel(model) {
  const account = resolveAccount(model);
  if (!account) return null;
  const authProv = authProviderFor(model);
  if (!authProv) return null;
  return getToken(authProv, account);
}

// ---- Pending OAuth state ----------------------------------------------
// Used by the loopback callback to remember which (state, code_verifier,
// redirect_uri, scopes) tuple the client started, so the callback can
// finish the exchange. The state is opaque, generated by the client and
// echoed by the provider. Persisted in the app settings store (separate from saved credentials —
// these are not secrets per se, but the code_verifier is a PKCE secret
// and we treat it as one).
//
// In-memory would be enough for a single-process server, but the
// callback is a separate HTTP request and the rest of the auth commit's
// code can land across processes (CLI + server). SQLite is the right
// home; we use the same app_kv table with a 'auth_pending' key.

function readPending() {
  const app = settings.getApp();
  return Array.isArray(app.authPending) ? app.authPending : [];
}

function writePending(list) {
  settings.setApp({ authPending: list });
}

function recordPending(provider, rec) {
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    const e = new Error('Unknown provider: ' + provider);
    e.code = 'EPROVIDER';
    throw e;
  }
  if (!rec || !rec.state) {
    const e = new Error('state is required');
    e.code = 'EBADINPUT';
    throw e;
  }
  const list = readPending().filter(p => !(p.provider === provider && p.state === rec.state));
  list.push(Object.assign({ provider, createdAt: new Date().toISOString() }, rec));
  writePending(list);
}

function consumePending(provider, state) {
  const list = readPending();
  const idx = list.findIndex(p => p.provider === provider && p.state === state);
  if (idx === -1) return null;
  const [rec] = list.splice(idx, 1);
  writePending(list);
  return rec;
}

function clearPending(provider, state) {
  writePending(readPending().filter(p => !(p.provider === provider && p.state === state)));
}

// A pending record is only removed on success (consumePending) or explicit
// cancel (clearPending). If the user closes the OAuth tab, the record leaks
// forever and the app store grows unbounded. Drop anything older than
// maxAgeMs (default 1h — far longer than any real OAuth round-trip). Returns
// the number of records pruned. Records with a missing/unparseable createdAt
// are treated as stale and pruned.
const PENDING_MAX_AGE_MS = 60 * 60 * 1000;

function prunePending(maxAgeMs = PENDING_MAX_AGE_MS) {
  const now = Date.now();
  const list = readPending();
  const kept = list.filter((p) => {
    const t = p && p.createdAt ? Date.parse(p.createdAt) : NaN;
    return Number.isFinite(t) && (now - t) < maxAgeMs;
  });
  if (kept.length !== list.length) writePending(kept);
  return list.length - kept.length;
}

module.exports = {
  // introspection
  SUPPORTED_PROVIDERS,
  SERVICE_PREFIX,
  // token CRUD
  setToken,
  getToken,
  deleteToken,
  // index
  listAccounts,
  // model helpers (used by src/ai.js)
  resolveAccount,
  tokenForModel,
  // pending OAuth state
  recordPending,
  consumePending,
  clearPending,
  prunePending,
  // provider exchange + refresher registration (used by per-provider OAuth commits)
  registerExchange,
  getExchange,
  registerRefresher,
  getRefresher,
  // model integration
  authProviderFor,
  AI_TO_AUTH_PROVIDER
};

// ---- Provider exchange registration -----------------------------------
// Each per-provider OAuth commit calls registerExchange('openai', async fn)
// where `fn` takes the pending record + the authorization code and
// returns { accessToken, refreshToken?, expiresAt?, account } or
// { error: '...' }. The callback in src/index.js calls getExchange(provider)
// to find the right fn. If none is registered, the callback returns 501
// with a clear message — that is the expected state in this commit.

const _exchanges = Object.create(null);
const _refreshers = Object.create(null);

function registerExchange(provider, fn) {
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    const e = new Error('Unknown provider: ' + provider);
    e.code = 'EPROVIDER';
    throw e;
  }
  if (typeof fn !== 'function') {
    const e = new Error('Exchange must be a function');
    e.code = 'EBADINPUT';
    throw e;
  }
  _exchanges[provider] = fn;
}

function getExchange(provider) {
  return _exchanges[provider] || null;
}

// registerRefresher / getRefresher — same shape as the exchange
// registry, but for proactive refresh. A refresher takes
// ({ provider, account, refreshToken, scope, baseUrl }) and returns
// the same shape as a fresh login:
//   { accessToken, refreshToken?, expiresAt?, scope?, account? }
// The AI client (src/ai.js) calls this just before an OAuth request
// if the stored access_token expires within the next minute, so a
// long chat doesn't hit a 401 mid-stream. Persisting the new blob
// is the refresh path's responsibility; see oauth-anthropic.js.
function registerRefresher(provider, fn) {
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    const e = new Error('Unknown provider: ' + provider);
    e.code = 'EPROVIDER';
    throw e;
  }
  if (typeof fn !== 'function') {
    const e = new Error('Refresher must be a function');
    e.code = 'EBADINPUT';
    throw e;
  }
  _refreshers[provider] = fn;
}

function getRefresher(provider) {
  return _refreshers[provider] || null;
}
