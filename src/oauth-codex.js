'use strict';

// ChatGPT's Codex device authorization. No callback listener or CLI process.
const crypto = require('node:crypto');
const auth = require('./auth.js');

const ISSUER = 'https://auth.openai.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const flows = new Map();
const refreshes = new Map();

function oauthError(message, code = 'EOAUTH') {
  return Object.assign(new Error(message), { code });
}

// Claims are routing/account hints, not locally verified authorization.
// The upstream validates the bearer; never use these claims to grant access.
function tokenClaims(token) {
  try {
    const claims = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : {};
  } catch { return {}; }
}

function accountIdFor(token) {
  const claims = tokenClaims(token);
  return claims['https://api.openai.com/auth']?.chatgpt_account_id || claims.chatgpt_account_id || null;
}

async function tokenRequest(body, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(ISSUER + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }).toString(),
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw oauthError('Codex token exchange failed (HTTP ' + res.status + '). Sign in again.');
  let json;
  try { json = await res.json(); } catch { throw oauthError('Codex returned an invalid token response.', 'EPARSE'); }
  if (!json.access_token) throw oauthError('Codex did not return an access token.', 'ETOKEN');
  const claims = tokenClaims(json.id_token || json.access_token);
  const chatgptAccountId = accountIdFor(json.id_token) || accountIdFor(json.access_token);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    expiresAt: Date.now() + (Number(json.expires_in) > 0 ? Number(json.expires_in) : 3600) * 1000,
    chatgptAccountId,
    account: chatgptAccountId ? ((claims.email || 'ChatGPT') + ' (' + chatgptAccountId + ')') : null
  };
}

async function refresh({ refreshToken, fetchImpl = globalThis.fetch } = {}) {
  if (!refreshToken) throw oauthError('Codex refresh token is missing. Sign in again.');
  // Concurrent chats must not race a rotating refresh token.
  if (!refreshes.has(refreshToken)) {
    refreshes.set(refreshToken, tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl)
      .finally(() => refreshes.delete(refreshToken)));
  }
  return refreshes.get(refreshToken);
}

function publicFlow(flow) {
  const { id, status, userCode, verificationUri, expiresAt, account, error } = flow;
  return { id, status, userCode, verificationUri, expiresAt, account, error };
}

function cancelDeviceFlow(id) {
  const flow = flows.get(String(id || ''));
  if (!flow) return false;
  if (flow.status === 'pending') {
    flow.status = 'cancelled';
    flow.controller.abort();
  }
  return true;
}

function getDeviceFlow(id) {
  const flow = flows.get(String(id || ''));
  return flow ? publicFlow(flow) : null;
}

async function startDeviceFlow({ fetchImpl = globalThis.fetch, setToken = auth.setToken,
  sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }) } = {}) {
  const res = await fetchImpl(ISSUER + '/api/accounts/deviceauth/usercode', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }), signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw oauthError('ChatGPT device sign-in failed (HTTP ' + res.status + '). Enable device code authorization in ChatGPT settings.');
  let dc;
  try { dc = await res.json(); } catch { throw oauthError('Invalid ChatGPT device code response.', 'EPARSE'); }
  const userCode = dc.user_code || dc.usercode;
  if (!dc.device_auth_id || !userCode) throw oauthError('ChatGPT did not return a device code.', 'EPARSE');
  for (const [id, flow] of flows) if (flow.status !== 'pending') flows.delete(id);
  while (flows.size >= 8) {
    const id = flows.keys().next().value;
    cancelDeviceFlow(id);
    flows.delete(id);
  }
  const flow = {
    id: crypto.randomBytes(18).toString('base64url'), status: 'pending', userCode,
    verificationUri: ISSUER + '/codex/device', expiresAt: Date.now() + 15 * 60 * 1000,
    account: null, error: null, controller: new AbortController()
  };
  flows.set(flow.id, flow);
  const interval = Math.min(30, Math.max(1, Number(dc.interval) || 5)) * 1000;
  (async () => {
    try {
      while (flow.status === 'pending' && Date.now() < flow.expiresAt) {
        await sleep(interval);
        if (flow.status !== 'pending') return;
        if (Date.now() >= flow.expiresAt) break;
        let polled;
        try {
          polled = await fetchImpl(ISSUER + '/api/accounts/deviceauth/token', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_auth_id: dc.device_auth_id, user_code: userCode }),
            signal: AbortSignal.any([flow.controller.signal, AbortSignal.timeout(30000)])
          });
        } catch (e) {
          if (flow.status !== 'pending') return;
          continue; // transient network failure; bounded by the flow expiry
        }
        if (polled.status === 403 || polled.status === 404) continue;
        if (!polled.ok) throw oauthError('ChatGPT device sign-in failed (HTTP ' + polled.status + ').');
        const code = await polled.json();
        if (!code.authorization_code || !code.code_verifier) throw oauthError('Invalid ChatGPT authorization response.', 'EPARSE');
        const token = await tokenRequest({ grant_type: 'authorization_code', code: code.authorization_code,
          code_verifier: code.code_verifier, redirect_uri: ISSUER + '/deviceauth/callback' }, fetchImpl);
        if (flow.status !== 'pending') return;
        if (!token.chatgptAccountId || !token.account) throw oauthError('ChatGPT account ID is missing from the token.', 'ETOKEN');
        await setToken('codex', token.account, JSON.stringify(token));
        if (flow.status !== 'pending') return;
        flow.account = token.account;
        flow.status = 'ok';
        return;
      }
      if (flow.status === 'pending') {
        flow.status = 'expired';
        flow.error = 'The code expired. Start sign-in again.';
      }
    } catch (e) {
      if (flow.status === 'pending') {
        flow.status = 'error';
        flow.error = e.code === 'EKEYRING' ? 'Could not store the token in the OS keychain.' : 'Codex sign-in failed. Start sign-in again.';
      }
    }
  })();
  return publicFlow(flow);
}

function register() {
  if (!auth.getRefresher('codex')) auth.registerRefresher('codex', refresh);
}

module.exports = { ISSUER, CLIENT_ID, accountIdFor, tokenClaims, refresh, startDeviceFlow, getDeviceFlow, cancelDeviceFlow, register };
