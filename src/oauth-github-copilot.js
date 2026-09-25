'use strict';

// GitHub Copilot OAuth + per-request Copilot token exchange.
//
// Implements docs/decisions.md section 12 (one provider per commit).
// This module is the per-provider flow for `github-copilot`; the
// generic auth skeleton (keyring, non-secret index, loopback
// callback) lives in src/auth.js. The `github-copilot` namespace is
// shared between the auth subsystem and the AI client (`AI_TO_AUTH_PROVIDER`
// in src/auth.js).
//
// The flow has two stages:
//
//   1. GitHub OAuth web flow (with PKCE). The user signs in at
//      https://github.com/login/oauth/authorize?client_id=...&redirect_uri=...
//      GitHub redirects back to our loopback callback with a one-time
//      code; the server exchanges the code for a long-lived GitHub
//      OAuth access token (no expiry unless revoked).
//      This is the standard GitHub OAuth shape — same pattern as the
//      Anthropic flow in src/oauth-anthropic.js.
//
//   2. Per-request Copilot token exchange. A GitHub OAuth token does
//      not authenticate against api.githubcopilot.com. Every chat
//      exchanges the GitHub token for a short-lived Copilot API
//      token at https://api.github.com/copilot_internal/v2/token
//      (Authorization: Bearer <github_token>). The response carries
//      a `token` field and an `expires_at` timestamp; the AI client
//      uses that token for the actual chat-completions call. The
//      exchange is repeated proactively (decision §13) when the
//      stored Copilot token is within OAUTH_REFRESH_LEAD_MS of
//      expiry. The user never sees the short-lived token; it is
//      derived at request time and lives only on the request.
//
// Storage: the keychain holds the GitHub OAuth token plus its
// `expiresAt`, `scope`, and the GitHub account login. The Copilot
// token is NOT stored — it is always re-derived on demand. This
// matches the public Copilot CLI's behavior and means a revocation
// is observed within minutes rather than at the next sign-in.
//
// Client ID: GitHub does not enable device flow for third-party
// OAuth apps, and web flow requires a registered redirect URI. The
// public github/gh-copilot client_id does not work for our loopback
// because the callback URL would need to be registered. We therefore
// support a per-install client_id configured at
// github.com/settings/developers. The user creates an OAuth app
// (one-time, ~1 minute), copies the client_id, and pastes it into
// Settings → Providers. A fallback default is provided for users
// who just want to try the flow with a public client.
//
// Public surface:
//
//   const oauthCopilot = require('mouaif/src/oauth-github-copilot.js');
//
//   oauthCopilot.register();   // call once at server startup
//   oauthCopilot.buildAuthorizeUrl({ redirectUri, state, verifier }); // -> url string
//   await oauthCopilot.exchangeAuthorizationCode({ code, verifier, redirectUri, state }); // -> { accessToken, ... }
//   // Internal — the AI client (src/ai.js) calls exchangeCopilotToken
//   // for the `github-copilot` namespace.

const crypto = require('crypto');
const settings = require('./settings.js');
const auth = require('./auth.js');

// github/gh-copilot publishes this client_id as the public OAuth app
// used by the official Copilot CLI. Treating it as public matches the
// `gh-copilot` reference implementation. This default is overridden
// if the user has configured their own client_id in app settings.
const DEFAULT_CLIENT_ID = 'Iv1.b507a08c87cfe66e';

// Endpoints. The GitHub OAuth endpoints are public; the Copilot
// token exchange endpoint is documented by GitHub as part of the
// Copilot IDE integration.
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const COPILOT_USER_URL = 'https://api.github.com/user';

// Copilot API base for chat completions. Matches the reserved entry
// in src/ai.js; both default to api.githubcopilot.com.
const COPILOT_API_BASE = 'https://api.githubcopilot.com';

// Minimum GitHub OAuth scopes for Copilot. `read:user` is enough for
// the /user lookup that resolves the account login; Copilot itself
// only requires the user to have a subscription (no scope gate on
// the OAuth side). The Copilot token exchange uses the same token
// without a scope check, so any valid token works.
const DEFAULT_SCOPE = 'read:user';

function randomUrlSafe(n) {
  return crypto.randomBytes(n).toString('base64url');
}

function pkceChallengeS256(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// Public — these are stable helpers used by the mobile UI and tests.
function newState() { return randomUrlSafe(32); }
function newVerifier() { return randomUrlSafe(64); }
function challengeFor(verifier) { return pkceChallengeS256(verifier); }

// Client ID lookup. Reads the per-app client_id from settings; falls
// back to the public default.
function getClientId() {
  const app = settings.getApp();
  const cfg = app && app.githubCopilot && typeof app.githubCopilot === 'object' ? app.githubCopilot : null;
  if (cfg && typeof cfg.clientId === 'string' && cfg.clientId.trim()) {
    return cfg.clientId.trim();
  }
  return DEFAULT_CLIENT_ID;
}

// Build the /login/oauth/authorize URL the user's browser should
// open. Pure: takes a redirectUri + state + verifier and returns a
// fully-formed URL string. The mobile UI uses this; the server's
// handleOAuthCallback is the one that does the *exchange*.
function buildAuthorizeUrl(opts) {
  const {
    clientId = getClientId(),
    redirectUri,
    state,
    verifier,
    scope = DEFAULT_SCOPE,
    allowSignup = 'true'
  } = opts || {};

  if (!redirectUri) throw new Error('redirectUri is required');
  if (!state) throw new Error('state is required');
  if (!verifier) throw new Error('verifier is required');

  const u = new URL(GITHUB_AUTHORIZE_URL);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scope);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', pkceChallengeS256(verifier));
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('allow_signup', allowSignup);
  return u.toString();
}

// POST the authorization_code grant. Per GitHub's docs, the token
// endpoint accepts application/x-www-form-urlencoded with the
// grant_type, code, redirect_uri, client_id, and code_verifier
// (PKCE) fields. Response is JSON when Accept: application/json is
// set; we always request JSON.
async function exchangeAuthorizationCode(opts) {
  const {
    baseUrl = GITHUB_TOKEN_URL,
    clientId = getClientId(),
    code,
    verifier,
    redirectUri,
    state,
    fetchImpl = globalThis.fetch
  } = opts || {};

  if (!code) throw new Error('code is required');
  if (!verifier) throw new Error('verifier is required');
  if (!redirectUri) throw new Error('redirectUri is required');
  if (!state) throw new Error('state is required');
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is not available');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
    state
  });
  const res = await fetchImpl(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': 'mouaif/1.0'
    },
    body: body.toString()
  });
  return readTokenResponse(res, 'authorization_code exchange');
}

async function readTokenResponse(res, label) {
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    if (parsed && parsed.error) {
      const e = new Error('GitHub ' + label + ': ' + parsed.error + (parsed.error_description ? ' (' + parsed.error_description + ')' : ''));
      e.code = 'EOAUTH';
      e.oauthError = parsed.error;
      e.oauthDescription = parsed.error_description || null;
      throw e;
    }
    const e = new Error('GitHub ' + label + ' failed: HTTP ' + res.status + ' ' + res.statusText);
    e.code = 'EUPSTREAM';
    e.status = res.status;
    e.body = text.slice(0, 2000);
    throw e;
  }
  let json;
  try { json = JSON.parse(text); }
  catch (err) {
    const e = new Error('GitHub ' + label + ' returned non-JSON: ' + err.message);
    e.code = 'EPARSE';
    throw e;
  }
  if (json.error) {
    const e = new Error('GitHub ' + label + ': ' + json.error);
    e.code = 'EOAUTH';
    e.oauthError = json.error;
    e.oauthDescription = json.error_description || null;
    throw e;
  }
  if (!json.access_token) {
    const e = new Error('GitHub ' + label + ' returned 200 with no access_token');
    e.code = 'ETOKEN';
    throw e;
  }
  return {
    accessToken: json.access_token,
    refreshToken: null, // GitHub OAuth does not issue refresh tokens for this flow
    expiresIn: null,   // GitHub OAuth tokens do not expire (revocation is the only invalidation)
    scope: json.scope || null,
    tokenType: json.token_type || null
  };
}

// GET https://api.github.com/copilot_internal/v2/token
// Header: Authorization: Bearer <github_access_token>
// Response: { token, expires_at, refresh_in, endpoints, ... }
// `token` is the short-lived bearer for api.githubcopilot.com;
// `expires_at` is a Unix timestamp (seconds, not ms).
async function exchangeCopilotToken({ githubToken, fetchImpl = globalThis.fetch } = {}) {
  if (!githubToken) throw new Error('githubToken is required');
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is not available');
  const res = await fetchImpl(COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + githubToken,
      'Accept': 'application/json',
      'User-Agent': 'mouaif/1.0'
    }
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    const message = (parsed && parsed.message) ? parsed.message : ('HTTP ' + res.status);

    // Detect SAML/SSO required by an organization. GitHub returns 403 with
    // a `X-GitHub-SSO` header when the OAuth token needs SSO authorization.
    // The header value is "required; url=<sso_authorization_url>".
    const ssoHeader = res.headers && res.headers.get ? res.headers.get('X-GitHub-SSO') : null;
    if (ssoHeader && ssoHeader.startsWith('required;')) {
      const ssoUrlMatch = ssoHeader.match(/url=(\S+)/);
      const ssoUrl = ssoUrlMatch ? ssoUrlMatch[1] : null;
      const e = new Error('GitHub Copilot token exchange failed: ' + message
        + (ssoUrl ? '\n\nYour organization requires SAML/SSO authorization.\nAuthorize the OAuth app here: ' + ssoUrl : ''));
      e.code = 'ESSO_REQUIRED';
      e.status = res.status;
      e.body = text.slice(0, 2000);
      e.ssoUrl = ssoUrl;
      e.suggestion = 'The organization requires SAML/SSO authorization. Visit the URL below to authorize the OAuth app for your org, then try again.';
      throw e;
    }

    const e = new Error('Copilot token exchange failed: ' + message);
    e.code = 'EUPSTREAM';
    e.status = res.status;
    e.body = text.slice(0, 2000);
    // 403/404 typically mean: the GitHub user has no active Copilot
    // subscription. Surface that distinctly so the UI can prompt the
    // user to enable a Copilot plan.
    if (res.status === 404 || res.status === 403) {
      e.code = 'ENOCOPILOT';
      e.suggestion = 'A Copilot subscription is required on the signed-in GitHub account.';
    }
    throw e;
  }
  let json;
  try { json = JSON.parse(text); }
  catch (err) {
    const e = new Error('Copilot token exchange returned non-JSON: ' + err.message);
    e.code = 'EPARSE';
    throw e;
  }
  if (!json.token) {
    const e = new Error('Copilot token exchange returned no token');
    e.code = 'ETOKEN';
    throw e;
  }
  // expires_at is seconds-since-epoch; convert to ms.
  const expiresAtMs = typeof json.expires_at === 'number' ? json.expires_at * 1000 : (Date.now() + 30 * 60 * 1000);
  return {
    token: json.token,
    expiresAt: expiresAtMs,
    refreshInMs: typeof json.refresh_in === 'number' ? json.refresh_in * 1000 : null,
    endpoints: json.endpoints || null
  };
}

// ---- Device flow (RFC 8628) ---------------------------------------------
//
// The web flow above needs a GitHub OAuth app whose callback URL matches the
// mouaif origin, which a phone on a LAN address or a reverse-proxied install
// rarely has. The device flow needs no callback at all: the server asks
// GitHub for a short user code, the user types it at github.com/login/device
// on any device, and the server polls until GitHub issues the token. This is
// what the public Copilot client_id supports, so it is the default sign-in.

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

// POST /login/device/code -> { deviceCode, userCode, verificationUri, expiresIn, interval }
async function requestDeviceCode({ clientId = getClientId(), scope = DEFAULT_SCOPE, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is not available');
  const res = await fetchImpl(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'User-Agent': 'mouaif/1.0' },
    body: new URLSearchParams({ client_id: clientId, scope }).toString()
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* handled below */ }
  if (!res.ok || !json || json.error || !json.device_code) {
    const code = json && json.error;
    const e = new Error('GitHub device code request failed: ' + (code || ('HTTP ' + res.status))
      + (json && json.error_description ? ' (' + json.error_description + ')' : '')
      + (code === 'device_flow_disabled' ? ' — enable Device Flow on the OAuth app, or clear the custom client ID.' : ''));
    e.code = code === 'device_flow_disabled' ? 'EDEVICE_DISABLED' : 'EUPSTREAM';
    e.status = res.status;
    throw e;
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri || 'https://github.com/login/device',
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : 900,
    interval: typeof json.interval === 'number' ? json.interval : 5
  };
}

// One poll of the token endpoint. Returns { status: 'pending' | 'slow_down' |
// 'ok' | 'expired' | 'denied' | 'error', token?, interval?, error? }.
async function pollDeviceToken({ deviceCode, clientId = getClientId(), fetchImpl = globalThis.fetch } = {}) {
  if (!deviceCode) throw new Error('deviceCode is required');
  const res = await fetchImpl(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'User-Agent': 'mouaif/1.0' },
    body: new URLSearchParams({ client_id: clientId, device_code: deviceCode, grant_type: DEVICE_GRANT }).toString()
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* handled below */ }
  if (!json) return { status: 'error', error: 'HTTP ' + res.status };
  if (json.access_token) return { status: 'ok', token: { accessToken: json.access_token, scope: json.scope || null } };
  switch (json.error) {
    case 'authorization_pending': return { status: 'pending' };
    case 'slow_down': return { status: 'slow_down', interval: typeof json.interval === 'number' ? json.interval : null };
    case 'expired_token': return { status: 'expired', error: 'The code expired. Start sign-in again.' };
    case 'access_denied': return { status: 'denied', error: 'Sign-in was declined on GitHub.' };
    default: return { status: 'error', error: json.error_description || json.error || ('HTTP ' + res.status) };
  }
}

// In-memory device sign-ins, keyed by an opaque id handed to the browser.
// The device_code itself never leaves the server.
const _deviceFlows = new Map();
const DEVICE_FLOW_MAX = 8;

function publicDeviceFlow(f) {
  return {
    id: f.id,
    status: f.status,
    userCode: f.userCode,
    verificationUri: f.verificationUri,
    expiresAt: f.expiresAt,
    account: f.account || null,
    error: f.error || null
  };
}

// Start a device sign-in and poll GitHub in the background until it
// resolves. On success the GitHub token is stored in the keychain exactly as
// the web flow stores it, so the rest of the provider does not care which
// flow was used.
async function startDeviceFlow({ fetchImpl = globalThis.fetch, setToken = auth.setToken, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const clientId = getClientId();
  const dc = await requestDeviceCode({ clientId, fetchImpl });
  // Drop finished / oldest flows so abandoned sign-ins cannot pile up.
  for (const [k, f] of _deviceFlows) if (f.status !== 'pending') _deviceFlows.delete(k);
  while (_deviceFlows.size >= DEVICE_FLOW_MAX) _deviceFlows.delete(_deviceFlows.keys().next().value);
  const flow = {
    id: randomUrlSafe(18),
    status: 'pending',
    userCode: dc.userCode,
    verificationUri: dc.verificationUri,
    expiresAt: Date.now() + dc.expiresIn * 1000,
    interval: Math.max(1, dc.interval),
    cancelled: false
  };
  _deviceFlows.set(flow.id, flow);
  (async () => {
    while (!flow.cancelled && Date.now() < flow.expiresAt) {
      await sleep(flow.interval * 1000);
      if (flow.cancelled) return;
      let r;
      try { r = await pollDeviceToken({ deviceCode: dc.deviceCode, clientId, fetchImpl }); }
      catch (e) { r = { status: 'pending' }; void e; } // transient network error: keep polling
      if (r.status === 'pending') continue;
      if (r.status === 'slow_down') { flow.interval = (r.interval || flow.interval + 5); continue; }
      if (r.status === 'ok') {
        const who = await fetchAccount({ githubToken: r.token.accessToken, fetchImpl });
        const account = (who && who.login) || 'default';
        try {
          await setToken('github-copilot', account, JSON.stringify({
            accessToken: r.token.accessToken, refreshToken: null, expiresAt: null, scope: r.token.scope || DEFAULT_SCOPE
          }));
          flow.status = 'ok';
          flow.account = account;
        } catch (e) {
          flow.status = 'error';
          flow.error = 'Could not store the token: ' + e.message;
        }
        return;
      }
      flow.status = r.status === 'expired' || r.status === 'denied' ? r.status : 'error';
      flow.error = r.error || 'sign-in failed';
      return;
    }
    if (flow.status === 'pending') {
      flow.status = flow.cancelled ? 'cancelled' : 'expired';
      if (!flow.cancelled) flow.error = 'The code expired. Start sign-in again.';
    }
  })();
  return publicDeviceFlow(flow);
}

function getDeviceFlow(id) {
  const f = _deviceFlows.get(String(id || ''));
  return f ? publicDeviceFlow(f) : null;
}

function cancelDeviceFlow(id) {
  const f = _deviceFlows.get(String(id || ''));
  if (!f) return false;
  f.cancelled = true;
  if (f.status === 'pending') f.status = 'cancelled';
  return true;
}

// ---- Account resolution ------------------------------------------------

// Read the account the user authorized with. Returns a normalized
// handle (`login`) plus display name; falls back to the token's
// first 8 chars if /user fails (e.g. when the scope is too narrow).
async function fetchAccount({ githubToken, fetchImpl = globalThis.fetch } = {}) {
  if (!githubToken) throw new Error('githubToken is required');
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is not available');
  try {
    const res = await fetchImpl(COPILOT_USER_URL, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + githubToken,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'mouaif/1.0'
      }
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (!json || typeof json.login !== 'string') return null;
    return { login: json.login, name: json.name || null };
  } catch { return null; }
}

// ---- Auth subsystem wiring ---------------------------------------------

// The exchange function registered with auth.registerExchange.
// Mirrors src/oauth-anthropic.js — the loopback callback calls
// exchange({ pending, code }) and the function returns the
// { accessToken, refreshToken?, expiresAt?, account } shape that
// finishOAuth expects.
async function exchange({ pending, code }) {
  if (!pending || !pending.codeVerifier) {
    const e = new Error('github-copilot pending record is missing codeVerifier — start a new sign-in');
    e.code = 'EBADINPUT';
    throw e;
  }
  const out = await exchangeAuthorizationCode({
    code,
    verifier: pending.codeVerifier,
    redirectUri: pending.redirectUri,
    state: pending.state
  });
  // The user has authorized; resolve the GitHub login so the
  // keychain has a useful account name. fetchAccount is best-effort;
  // a failure (e.g. rate limit) falls back to the accountHint.
  const account = await fetchAccount({ githubToken: out.accessToken });
  return {
    accessToken: out.accessToken,
    refreshToken: null, // GitHub OAuth does not issue refresh tokens for this client_id
    expiresAt: null,    // GitHub OAuth tokens do not expire unless revoked
    scope: out.scope,
    account: (account && account.login) || pending.accountHint || 'default'
  };
}

// Refresher registered with auth.registerRefresher. GitHub OAuth
// tokens do not expire (revocation is the only invalidation), so
// this is a no-op. The AI client derives the short-lived Copilot
// token on demand via oauthCopilot.exchangeCopilotToken, and that
// derivation is what gives the user a usable credential for
// api.githubcopilot.com.
async function refresh({ provider, account, refreshToken, scope, baseUrl }) {
  if (provider !== 'github-copilot') {
    const e = new Error('github-copilot refresher called for provider "' + provider + '"');
    e.code = 'EBADINPUT';
    throw e;
  }
  // Return the same shape (without changes) so the auth subsystem's
  // refresh path doesn't write a new blob (which would be identical
  // to the existing one). expiresAt is null because GitHub tokens
  // do not expire.
  return {
    accessToken: '',
    refreshToken: null,
    expiresAt: null,
    scope: scope || DEFAULT_SCOPE,
    account: account || null
  };
}

let _registered = false;
function register() {
  if (_registered) return;
  if (!auth.getExchange('github-copilot')) auth.registerExchange('github-copilot', exchange);
  if (!auth.getRefresher('github-copilot')) auth.registerRefresher('github-copilot', refresh);
  _registered = true;
}

module.exports = {
  // introspection
  DEFAULT_CLIENT_ID,
  COPILOT_API_BASE,
  DEFAULT_SCOPE,
  GITHUB_AUTHORIZE_URL,
  GITHUB_TOKEN_URL,
  COPILOT_TOKEN_URL,
  // helpers
  getClientId,
  newState,
  newVerifier,
  challengeFor,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  exchangeCopilotToken,
  fetchAccount,
  // device flow (default sign-in)
  GITHUB_DEVICE_CODE_URL,
  requestDeviceCode,
  pollDeviceToken,
  startDeviceFlow,
  getDeviceFlow,
  cancelDeviceFlow,
  // registration
  register,
  // exposed for tests
  exchange,
  refresh
};
