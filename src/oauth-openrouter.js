'use strict';

// OpenRouter OAuth (PKCE) — the per-provider sign-in flow for the
// `openrouter` AI client provider.
//
// Implements docs/decisions.md section 12 (one provider per commit).
// This module registers an exchange function with src/auth.js that
// is invoked from the loopback callback (`/oauth/callback`) after the
// user authorises the app in their browser.
//
// OpenRouter's flow is a pure PKCE exchange — there is no client_id
// or client_secret to register, no separate app dashboard for a
// per-install app, and no refresh tokens. The shape mirrors
// https://openrouter.ai/docs/guides/overview/auth/oauth:
//
//   1. The mobile UI opens
//        https://openrouter.ai/auth?callback_url=<our-loopback>&code_challenge=<sha256(verifier)>&code_challenge_method=S256
//      in the user's browser. The user signs in to OpenRouter and
//      grants the requested scope (none — the PKCE flow does not
//      pass a `scope` parameter; OpenRouter grants "manage your own
//      API keys" by default).
//
//   2. OpenRouter redirects the user's browser back to our loopback
//      URL with a one-time `code` query parameter.
//
//   3. Our server POSTs
//        https://openrouter.ai/api/v1/auth/keys
//      with `{ code, code_verifier, code_challenge_method: 'S256' }`
//      and receives `{ key }` — a user-controlled OpenRouter API
//      key. The key is what `Authorization: Bearer <key>` expects on
//      every chat-completions call. The mobile UI then uses that key
//      exactly the way a manually pasted key is used; from the AI
//      client's perspective there is no OAuth token, just an OpenRouter
//      API key whose origin happens to be a sign-in.
//
// Storage: the keychain holds the API key as the `accessToken` field
// of a standard OAuth blob, plus `expiresAt: null` and
// `refreshToken: null`. The `account` slot is the key's first 16
// chars (`sk-or-v1-xxxxxxxx...`) so the UI picker can show one row
// per signed-in key without leaking the full secret.
//
// Refresh: OpenRouter does not issue refresh tokens. A leaked or
// revoked key is irrecoverable — the user signs in again, which
// issues a new key. The refresher registered with auth.registerRefresher
// is therefore a no-op (it returns the existing blob verbatim with
// `expiresAt: null` so the AI client's proactive-refresh code path is
// a clean no-op rather than a typed error).
//
// Public surface:
//
//   const oauthOpenRouter = require('mouaif/src/oauth-openrouter.js');
//
//   oauthOpenRouter.register();  // call once at server startup
//   oauthOpenRouter.buildAuthorizeUrl({ callbackUrl, state, verifier });
//   await oauthOpenRouter.exchangeAuthorizationCode({ code, verifier, callbackUrl });
//   // Internal — the AI client uses the key as a plain Bearer token;
//   //   src/ai.js does not need any per-provider helper for OpenRouter.

const crypto = require('crypto');
const auth = require('./auth.js');

// OpenRouter's PKCE endpoints. Documented at
// https://openrouter.ai/docs/guides/overview/auth/oauth. Both are
// public; there is no per-app identity, so no client_id constant
// exists in this module.
const AUTHORIZE_URL = 'https://openrouter.ai/auth';
const KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';

function randomUrlSafe(n) {
  return crypto.randomBytes(n).toString('base64url');
}

function pkceChallengeS256(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// Public — stable helpers used by the mobile UI and tests.
function newState() { return randomUrlSafe(32); }
function newVerifier() { return randomUrlSafe(64); }
function challengeFor(verifier) { return pkceChallengeS256(verifier); }

// Build the /auth URL the user's browser should open. Pure: takes the
// loopback URL + state + verifier and returns a fully-formed URL
// string. The mobile UI uses this; the server's handleOAuthCallback
// is the one that does the *exchange*.
//
// `callbackUrl` is the loopback URL (e.g. http://127.0.0.1:5732/oauth/callback?provider=openrouter).
// We pass it through as the `callback_url` query param verbatim —
// OpenRouter echoes it back on the redirect so the resulting `code`
// arrives at the same handler the Anthropic / GitHub flows use.
function buildAuthorizeUrl(opts) {
  const {
    callbackUrl,
    state,
    verifier,
    codeChallengeMethod = 'S256'
  } = opts || {};

  if (!callbackUrl) throw new Error('callbackUrl is required');
  if (!state) throw new Error('state is required');
  if (!verifier) throw new Error('verifier is required');
  if (codeChallengeMethod !== 'S256' && codeChallengeMethod !== 'plain') {
    throw new Error('codeChallengeMethod must be "S256" or "plain"');
  }

  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('callback_url', callbackUrl);
  u.searchParams.set('code_challenge', pkceChallengeS256(verifier));
  u.searchParams.set('code_challenge_method', codeChallengeMethod);
  // `state` is forwarded so the loopback handler can match the
  // callback to a pending record. OpenRouter echoes it back on the
  // redirect.
  u.searchParams.set('state', state);
  return u.toString();
}

// POST the authorization_code grant. Per OpenRouter's docs, the
// exchange endpoint accepts application/json with the `code`,
// `code_verifier`, and `code_challenge_method` fields. Response is
// `{ key }` — a user-controlled OpenRouter API key.
async function exchangeAuthorizationCode(opts) {
  const {
    keysUrl = KEYS_URL,
    code,
    verifier,
    codeChallengeMethod = 'S256',
    fetchImpl = globalThis.fetch
  } = opts || {};

  if (!code) throw new Error('code is required');
  if (!verifier) throw new Error('verifier is required');
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is not available');

  const res = await fetchImpl(keysUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: codeChallengeMethod
    })
  });
  return readKeyResponse(res);
}

async function readKeyResponse(res) {
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    if (parsed && parsed.error) {
      // OpenRouter returns `{ error: { message, code } }` for a
      // rejected sign-in. Older OAuth-style errors would carry the
      // standard `error` string + `error_description`; we handle both.
      const errObj = parsed.error;
      const errMsg = (errObj && typeof errObj === 'object' && errObj.message)
        ? errObj.message
        : (typeof errObj === 'string' ? errObj : JSON.stringify(errObj));
      const e = new Error('OpenRouter sign-in: ' + errMsg + (parsed.error_description ? ' (' + parsed.error_description + ')' : ''));
      e.code = 'EOAUTH';
      e.oauthError = errMsg;
      e.oauthDescription = parsed.error_description || null;
      throw e;
    }
    const e = new Error('OpenRouter sign-in failed: HTTP ' + res.status + ' ' + res.statusText);
    e.code = 'EUPSTREAM';
    e.status = res.status;
    e.body = text.slice(0, 2000);
    throw e;
  }
  let json;
  try { json = JSON.parse(text); }
  catch (err) {
    const e = new Error('OpenRouter sign-in returned non-JSON: ' + err.message);
    e.code = 'EPARSE';
    throw e;
  }
  if (!json.key || typeof json.key !== 'string') {
    const e = new Error('OpenRouter sign-in returned 200 with no `key`');
    e.code = 'ETOKEN';
    throw e;
  }
  return { key: json.key };
}

// ---- Account naming ----------------------------------------------------

// The PKCE flow hands back a single string (the API key), not a
// structured account object. The OAuth account picker needs a
// recognisable label per signed-in key. The user may supply an
// "app name" when starting the sign-in (e.g. "Work laptop",
// "Personal"); that name is forwarded through the pending record
// and becomes the `account` slot. When the user does not supply
// one, we synthesise a short label from the key's prefix so the
// picker can still tell two sign-ins apart without revealing the
// full secret. The key starts with "sk-or-v1-" by convention; we
// keep the first 16 chars which is unique enough to be useful but
// not a leak. Empty / short keys fall through to "default" so the
// picker always has a value.
function accountForKey(key, appName) {
  if (typeof appName === 'string') {
    const trimmed = appName.trim();
    if (trimmed) return trimmed.slice(0, 64);
  }
  if (typeof key !== 'string' || !key) return 'default';
  const trimmed = key.trim();
  if (!trimmed) return 'default';
  return trimmed.length <= 16 ? trimmed : trimmed.slice(0, 16);
}

// ---- Auth subsystem wiring --------------------------------------------

// Exchange function registered with auth.registerExchange. Mirrors
// the shape src/oauth-anthropic.js and src/oauth-github-copilot.js
// expect: ({ pending, code }) -> { accessToken, refreshToken?,
// expiresAt?, scope?, account }. The OpenRouter `key` lands in the
// `accessToken` field; the AI client treats it as a Bearer credential
// at chat time (see src/ai.js → ENDPOINTS.openrouter.authHeader).
async function exchange({ pending, code }) {
  if (!pending || !pending.codeVerifier) {
    const e = new Error('openrouter pending record is missing codeVerifier — start a new sign-in');
    e.code = 'EBADINPUT';
    throw e;
  }
  const out = await exchangeAuthorizationCode({
    code,
    verifier: pending.codeVerifier,
    // OpenRouter does not echo a `state` query param back to the
    // callback; the loopback handler in src/index.js carries the
    // `state` through `pending.state`, so it does not need to be
    // sent to the exchange endpoint.
  });
  return {
    // Map the OpenRouter API key to the standard OAuth blob. The AI
    // client reads `accessToken`; the model record's `auth: 'oauth'`
    // makes requireApiKey() take the OAuth branch, which then uses
    // the same Bearer-header path the apikey branch uses.
    accessToken: out.key,
    refreshToken: null, // OpenRouter does not issue refresh tokens
    expiresAt: null,    // OpenRouter keys do not expire unless revoked
    scope: 'openrouter',
    // The user-supplied "app name" (pending.appName, set by the
    // Settings form) wins over the auto-generated key prefix. A
    // user who signs in twice with the same OpenRouter account
    // (e.g. on two laptops) can give each sign-in its own
    // recognisable label without leaking the full key.
    account: accountForKey(out.key, pending && pending.appName)
  };
}

// Refresher registered with auth.registerRefresher. OpenRouter keys
// cannot be refreshed — a revocation requires a fresh sign-in. The
// AI client calls this just before a request when the stored
// `expiresAt` is within OAUTH_REFRESH_LEAD_MS, but `expiresAt` is
// always null for OpenRouter, so this is never called in practice.
// We register a no-op refresher so the auth subsystem's refresh path
// is a clean no-op (returns the existing blob verbatim) rather than
// a typed ENOREFRESHER error.
async function refresh({ provider, account, scope }) {
  if (provider !== 'openrouter') {
    const e = new Error('openrouter refresher called for provider "' + provider + '"');
    e.code = 'EBADINPUT';
    throw e;
  }
  return {
    accessToken: '',
    refreshToken: null,
    expiresAt: null,
    scope: scope || 'openrouter',
    account: account || null
  };
}

let _registered = false;
function register() {
  if (_registered) return;
  if (!auth.getExchange('openrouter')) auth.registerExchange('openrouter', exchange);
  if (!auth.getRefresher('openrouter')) auth.registerRefresher('openrouter', refresh);
  _registered = true;
}

module.exports = {
  // introspection
  AUTHORIZE_URL,
  KEYS_URL,
  // helpers
  newState,
  newVerifier,
  challengeFor,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  accountForKey,
  // registration
  register,
  // exposed for tests
  exchange,
  refresh
};
