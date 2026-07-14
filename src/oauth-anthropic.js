'use strict';

// Anthropic OAuth — the per-provider flow registered with src/auth.js.
//
// Implements docs/decisions.md section 12. Shape mirrors the public
// `ant` CLI's `auth login` (https://github.com/anthropics/anthropic-cli
// pkg/cmd/cmd_auth.go) and the platform.claude.com OAuth docs:
//   - Public client_id (no secret) from the official CLI source.
//   - PKCE S256, 64-byte verifier, base64url. `code_challenge_method=S256`.
//   - State: 32 random bytes, base64url. Validated server-side on the
//     authorize redirect AND on the token exchange (the Python oauth
//     server requires `state` on the token exchange as a bound CSRF
//     check across both legs).
//   - Authorize: GET https://platform.claude.com/oauth/authorize?...
//   - Token:    POST https://api.anthropic.com/v1/oauth/token
//                - authorization_code grant: application/x-www-form-urlencoded
//                - refresh_token grant:      application/json
//                - Header on user_oauth: anthropic-beta: oauth-2025-04-20
//   - Default scope: "user:profile user:inference user:developer".
//
// Public surface:
//
//   register() — call once at server startup; hooks the exchange function
//   into auth.registerExchange('anthropic', fn). Idempotent.

const crypto = require('crypto');
const settings = require('./settings.js');
const auth = require('./auth.js');

// Public OAuth client_id used by the official `ant` CLI. Sourced from
// pkg/cmd/cmd_auth.go: const oauthClientIDProd. Public per the source
// comment; safe to embed in a third-party CLI.
const CLIENT_ID = '41077d10-94b8-4194-be48-d251e9eb21b4';

const DEFAULT_CONSOLE_URL = 'https://platform.claude.com';
// Test-only override. Production is locked to https://api.anthropic.com.
// Set MOUAIF_ANTHROPIC_API_BASE to redirect at runtime (e.g. in tests).
const DEFAULT_API_BASE = process.env.MOUAIF_ANTHROPIC_API_BASE || 'https://api.anthropic.com';
const DEFAULT_SCOPE = 'user:profile user:inference user:developer';
const BETA_HEADER = 'oauth-2025-04-20';
const GRANT_AUTHORIZATION_CODE = 'authorization_code';
const GRANT_REFRESH_TOKEN = 'refresh_token';

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

// Build the /oauth/authorize URL the user's browser should open. Pure:
// takes a redirectUri and the parameters from auth.recordPending and
// returns a fully-formed URL string. The mobile UI uses this; the
// server's handleOAuthCallback is the one that does the *exchange*.
//
// `pending` is the record returned by auth.recordPending (or just the
// fields we need: redirectUri, scopes, accountHint). `state` is opaque
// and must match the `state` recorded by recordPending.

function buildAuthorizeUrl(opts) {
  const {
    consoleUrl = DEFAULT_CONSOLE_URL,
    clientId = CLIENT_ID,
    redirectUri,
    state,
    verifier,
    scope = DEFAULT_SCOPE,
    workspaceId
  } = opts || {};

  if (!redirectUri) throw new Error('redirectUri is required');
  if (!state) throw new Error('state is required');
  if (!verifier) throw new Error('verifier is required');

  const u = new URL('/oauth/authorize', consoleUrl.replace(/\/+$/, '') + '/');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scope);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', pkceChallengeS256(verifier));
  u.searchParams.set('code_challenge_method', 'S256');
  if (workspaceId) u.searchParams.set('workspace_id', workspaceId);
  return u.toString();
}

// POST the authorization_code grant. application/x-www-form-urlencoded,
// no anthropic-beta header — the Python oauth_server routes that form
// to the AuthCodeTokenRequest handler.

async function exchangeAuthorizationCode(opts) {
  const {
    baseUrl = DEFAULT_API_BASE,
    clientId = CLIENT_ID,
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
    grant_type: GRANT_AUTHORIZATION_CODE,
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
    state
  });
  const res = await fetchImpl(baseUrl.replace(/\/+$/, '') + '/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  return readTokenResponse(res, 'authorization_code exchange');
}

// POST the refresh_token grant. application/json WITH anthropic-beta
// header — the Python oauth_server requires the beta on the
// refresh_token grant for user_oauth credentials.
async function exchangeRefreshToken(opts) {
  const {
    baseUrl = DEFAULT_API_BASE,
    clientId = CLIENT_ID,
    refreshToken,
    fetchImpl = globalThis.fetch
  } = opts || {};

  if (!refreshToken) throw new Error('refreshToken is required');
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is not available');

  const res = await fetchImpl(baseUrl.replace(/\/+$/, '') + '/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-beta': BETA_HEADER
    },
    body: JSON.stringify({ grant_type: GRANT_REFRESH_TOKEN, refresh_token: refreshToken, client_id: clientId })
  });
  return readTokenResponse(res, 'refresh_token exchange');
}

async function readTokenResponse(res, label) {
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`Anthropic ${label} failed: HTTP ${res.status} ${res.statusText}`);
    err.code = 'EUPSTREAM';
    err.status = res.status;
    err.body = text.slice(0, 2000);
    throw err;
  }
  let json;
  try { json = JSON.parse(text); } catch (e) {
    const err = new Error(`Anthropic ${label} returned non-JSON: ${e.message}`);
    err.code = 'EPARSE';
    throw err;
  }
  if (!json.access_token) {
    const err = new Error(`Anthropic ${label} returned 200 with no access_token`);
    err.code = 'ETOKEN';
    throw err;
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : null,
    scope: json.scope || null,
    organization: json.organization || null,
    account: json.account || null,
    workspace: json.workspace || null
  };
}

// The exchange function registered with auth.registerExchange.
// Signature: ({ pending, code, state }) -> { accessToken, refreshToken, ... }
// `pending.codeVerifier` is read from the pending record (stored by
// auth.recordPending) so the client never round-trips the verifier
// through the loopback callback.
async function exchange({ pending, code }) {
  if (!pending || !pending.codeVerifier) {
    const e = new Error('Anthropic pending record is missing codeVerifier — start a new sign-in');
    e.code = 'EBADINPUT';
    throw e;
  }
  const out = await exchangeAuthorizationCode({
    code,
    verifier: pending.codeVerifier,
    redirectUri: pending.redirectUri,
    state: pending.state
  });
  return {
    accessToken: out.accessToken,
    refreshToken: out.refreshToken,
    expiresAt: out.expiresIn ? Date.now() + out.expiresIn * 1000 : null,
    scope: out.scope,
    account: (out.account && (out.account.email_address || out.account.emailAddress)) || pending.accountHint || 'default'
  };
}

let _registered = false;
function register() {
  if (_registered) return;
  // Guard against re-registration in test harnesses; auth.registerExchange
  // itself overwrites, so this is just a guard for *our* bookkeeping.
  if (!auth.getExchange('anthropic')) auth.registerExchange('anthropic', exchange);
  if (!auth.getRefresher('anthropic')) auth.registerRefresher('anthropic', refresh);
  _registered = true;
}

// Proactive refresher registered with auth.registerRefresher. Called
// by src/ai.js when a stored access token is within 60s of expiry.
// Posts the refresh_token grant per spec (JSON body, with the
// anthropic-beta header — see exchangeRefreshToken above for the
// rationale). Returns the same shape as a fresh login so the AI
// client can drop it straight into the keychain blob:
//
//   { accessToken, refreshToken?, expiresAt?, scope?, account? }
//
// `account` is forwarded as-is from the caller; `expiresAt` is
// computed from `expires_in`. The token exchange must hit the same
// deployment as the Console that issued the code (per `ant auth
// status` / cmd_auth.go), so we prefer the model's `baseUrl` (lets
// test mocks and Anthropic-compatible proxies route the refresh) and
// fall back to the production default.
async function refresh({ provider, account, refreshToken, scope, baseUrl }) {
  if (provider !== 'anthropic') {
    const e = new Error('Anthropic refresher called for provider "' + provider + '"');
    e.code = 'EBADINPUT';
    throw e;
  }
  if (!refreshToken) {
    const e = new Error('refreshToken is required');
    e.code = 'EBADINPUT';
    throw e;
  }
  const out = await exchangeRefreshToken({
    baseUrl: baseUrl || DEFAULT_API_BASE,
    refreshToken
  });
  return {
    accessToken: out.accessToken,
    refreshToken: out.refreshToken || refreshToken,
    expiresAt: typeof out.expiresIn === 'number' ? Date.now() + out.expiresIn * 1000 : null,
    scope: out.scope || scope || null,
    account: (out.account && (out.account.email_address || out.account.emailAddress)) || account || null
  };
}

module.exports = {
  // introspection
  CLIENT_ID,
  DEFAULT_CONSOLE_URL,
  DEFAULT_API_BASE,
  DEFAULT_SCOPE,
  BETA_HEADER,
  // helpers
  newState,
  newVerifier,
  challengeFor,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  // registration
  register,
  exchange,
  refresh
};

