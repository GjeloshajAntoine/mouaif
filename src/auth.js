'use strict';

// Auth — @napi-rs/keyring wrapper + non-secret account index.
//
// Implements docs/decisions.md section 11. OAuth tokens live in the OS
// keychain; the app SQLite store keeps a non-secret index of which
// provider/account pairs are signed in, so the UI can list "logged in
// as ..." without ever touching the keychain.
//
// In this commit, the keyring is the only auth storage. Provider-specific
// OAuth flows (authorization endpoints, code exchange, refresh) land in
// later commits — one per provider. The loopback callback in src/index.js
// is wired but provider-neutral: it routes by `provider` and stores the
// token blob returned by the provider's exchange.
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
// Errors are typed: EKEYRING (OS keychain unavailable), ENOENT (no such
// account), EBADINPUT (validation), EPROVIDER (unknown provider).

const { Entry } = require('@napi-rs/keyring');
const settings = require('./settings.js');

// 'mouaif' is the keyring service prefix; per-provider accounts are
// namespaced under 'mouaif/<provider>'. Linux/Windows Credential Manager
// will show entries with the full name; we do not strip the prefix.
const SERVICE_PREFIX = 'mouaif';

const SUPPORTED_PROVIDERS = ['openai', 'anthropic', 'google', 'github-copilot'];

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
  let entry;
  try {
    entry = new Entry(serviceName(provider), account);
    entry.setPassword(blob);
  } catch (e) {
    const wrapped = new Error('Keyring set failed: ' + (e && e.message || e));
    wrapped.code = 'EKEYRING';
    wrapped.cause = e;
    throw wrapped;
  }
  // Update the non-secret index only after the keychain write succeeded.
  indexAdd(provider, account);
  return { provider, account };
}

function getToken(provider, account) {
  validateAccount(provider, account);
  let entry;
  try {
    entry = new Entry(serviceName(provider), account);
    return entry.getPassword();
  } catch (e) {
    // @napi-rs/keyring throws when the entry does not exist. That's our
    // "no such account" signal; map it to null so callers don't have to
    // distinguish "absent" from "wrong password".
    const msg = (e && e.message) || String(e);
    if (/no matching entry|not found|No such file/i.test(msg)) return null;
    const wrapped = new Error('Keyring get failed: ' + msg);
    wrapped.code = 'EKEYRING';
    wrapped.cause = e;
    throw wrapped;
  }
}

function deleteToken(provider, account) {
  validateAccount(provider, account);
  try {
    const entry = new Entry(serviceName(provider), account);
    entry.deletePassword();
    indexRemove(provider, account);
    return { provider, account, deleted: true };
  } catch (e) {
    // deletePassword throws if the entry does not exist; we treat that
    // as a successful no-op (idempotent delete).
    const msg = (e && e.message) || String(e);
    if (/no matching entry|not found|No such file/i.test(msg)) {
      indexRemove(provider, account);
      return { provider, account, deleted: false };
    }
    const wrapped = new Error('Keyring delete failed: ' + msg);
    wrapped.code = 'EKEYRING';
    wrapped.cause = e;
    throw wrapped;
  }
}

// ---- Non-secret account index ------------------------------------------
// The keychain is the source of truth for credentials; this index is a
// hint so the UI can list "signed in accounts" without round-tripping
// the keychain. Out of sync is recoverable: getToken/deleteToken still
// work, and the index can be rebuilt by walking the keychain (later
// commit, when @napi-rs/keyring exposes a find-by-service API).

function readIndex() {
  const app = settings.getApp();
  const raw = app.authAccounts;
  const out = {};
  for (const p of SUPPORTED_PROVIDERS) {
    out[p] = Array.isArray(raw && raw[p]) ? raw[p].slice() : [];
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
// `provider` field) to the auth provider that the keychain is keyed
// under. The model record keeps the AI client provider verbatim per
// decision §10; the mapping lives here, in the auth module, because
// that is the subsystem that owns the keyring namespace.
//
// Today's pairs are 1:1 except for the OpenAI-compatible family, which
// uses the openai keyring namespace so any signed-in OpenAI account
// can serve an openai-compatible model. New AI clients that should
// re-use an existing auth flow register here.
const AI_TO_AUTH_PROVIDER = Object.freeze({
  'openai-compatible': 'openai',
  'anthropic':         'anthropic',
  'gemini':            'google',
  'ollama':            'ollama', // no keychain; rejected upstream as a non-OAuth model
  'github-copilot':    'github-copilot',
  // OpenRouter uses an OpenAI-shaped key in the same 'openai' keyring
  // namespace. The model record keeps the AI client provider verbatim
  // ('openrouter') per decision §10, and this mapping is what lets the
  // apikey path read the right keychain entry.
  'openrouter':        'openai'
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
// echoed by the provider. Persisted in the app store (not the keychain —
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
