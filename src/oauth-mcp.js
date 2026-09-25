'use strict';

// MCP OAuth is independent of AI-provider accounts. Credentials are scoped to
// the saved server identity and stored only in the OS keychain.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
// Native keyring addon, loaded on the first vault access.
let keyringMod = null;
function vaultEntry(key) {
  const { Entry } = keyringMod || (keyringMod = require('@napi-rs/keyring'));
  return new Entry('mouaif/mcp-oauth', key);
}
const CALLBACK_PATH = '/oauth/mcp/callback';
const PENDING_TTL = 10 * 60 * 1000;
const error = (code, message) => Object.assign(new Error(message), { code });

function identity({ entry, scope, projectDir }) {
  let project = scope === 'app' ? 'app' : path.resolve(projectDir);
  if (scope !== 'app') { try { project = fs.realpathSync(project); } catch { /* not yet created */ } }
  return crypto.createHash('sha256').update(JSON.stringify([
    project, entry.id, entry.url, entry.oauth || null
  ])).digest('hex');
}

// The client secret is configuration, not a grant: it lives in its own
// keychain entry keyed by the server (not by its OAuth settings), so
// Disconnect and a scope change keep it, and it never reaches .mcp.json.
function secretKey({ entry, scope, projectDir }) {
  let project = scope === 'app' ? 'app' : path.resolve(projectDir);
  if (scope !== 'app') { try { project = fs.realpathSync(project); } catch { /* not yet created */ } }
  return 'secret:' + crypto.createHash('sha256').update(JSON.stringify([project, entry.id])).digest('hex');
}

const isClientCredentials = (context) => context.entry.oauth?.grant === 'client_credentials';

function safeUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) {
    throw error('EBADINPUT', 'OAuth URLs must be HTTP(S) URLs without credentials.');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw error('EBADINPUT', 'OAuth requires HTTPS (HTTP is allowed only on loopback).');
  }
  return url;
}

const vault = {
  read(key) {
    try {
      const text = vaultEntry(key).getPassword();
      return text ? JSON.parse(text) : {};
    } catch (e) {
      if (/no matching entry|not found|No such file/i.test(e.message || '')) return {};
      throw error('EKEYRING', 'MCP OAuth needs an available OS keychain.');
    }
  },
  write(key, value) {
    try { vaultEntry(key).setPassword(JSON.stringify(value)); }
    catch { throw error('EKEYRING', 'Could not save MCP OAuth credentials in the OS keychain.'); }
  },
  remove(key) {
    try { vaultEntry(key).deletePassword(); }
    catch (e) {
      if (!/no matching entry|not found|No such file/i.test(e.message || '')) {
        throw error('EKEYRING', 'Could not remove MCP OAuth credentials from the OS keychain.');
      }
    }
  }
};

// Never follow redirects carrying OAuth credentials. Enforce TLS for discovered
// endpoints too, not just the configured MCP URL. Bound every network request.
async function oauthFetch(input, init = {}) {
  safeUrl(typeof input === 'string' || input instanceof URL ? input : input.url);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 30000);
  try { return await fetch(input, { ...init, redirect: 'error', signal: controller.signal }); }
  finally { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); }
}

function createManager({ storage = vault, resolveContext } = {}) {
  const pending = new Map();
  function readSecret(context) {
    const v = storage.read(secretKey(context)) || {};
    return typeof v.secret === 'string' && v.secret ? v.secret : null;
  }
  // setSecret(context, secret) — a string stores it; null/'' removes it.
  function setSecret(context, secret) {
    const key = secretKey(context);
    if (typeof secret === 'string' && secret) {
      if (secret.length > 4096) throw error('EBADINPUT', 'Client secret is too long.');
      storage.write(key, { secret });
    } else storage.remove(key);
  }
  function hasSecret(context) {
    try { return !!readSecret(context); } catch { return false; }
  }
  const generations = new Map();
  function prune() {
    for (const [state, item] of pending) if (item.expiresAt <= Date.now()) pending.delete(state);
  }
  function cancel(key) {
    generations.set(key, (generations.get(key) || 0) + 1);
    for (const [state, item] of pending) if (item.key === key) pending.delete(state);
  }
  function checkContext(context) {
    if (!['http', 'sse'].includes(context.entry.transport) || !context.entry.oauth?.enabled) {
      throw error('EBADINPUT', 'Save this HTTP server with OAuth enabled first.');
    }
    safeUrl(context.entry.url);
  }
  function provider(context, flow) {
    checkContext(context);
    const key = identity(context);
    const generation = flow ? flow.generation : (generations.get(key) || 0);
    function active() {
      const current = resolveContext(context.projectDir, context.entry.id);
      if (!current || identity(current) !== key || generation !== (generations.get(key) || 0) || (flow && flow.expiresAt <= Date.now())) {
        throw error('EMCP_AUTH', 'Sign-in was cancelled or expired. Start again.');
      }
    }
    function read() { active(); return storage.read(key) || {}; }
    function update(patch) { storage.write(key, { ...read(), ...patch }); }
    // Keep the revocation endpoint from discovery, so Disconnect can revoke
    // remotely without a fresh discovery round-trip.
    function rememberRevocation(discovery) {
      const md = discovery && discovery.authorizationServerMetadata;
      if (!md || !md.revocation_endpoint) return;
      const next = { endpoint: md.revocation_endpoint, authMethods: md.revocation_endpoint_auth_methods_supported || md.token_endpoint_auth_methods_supported || [] };
      const cur = read().revocation;
      if (!cur || cur.endpoint !== next.endpoint) update({ revocation: next });
    }
    const configuredClient = context.entry.oauth.clientId;
    const secret = readSecret(context);
    if (isClientCredentials(context)) {
      // Machine-to-machine: no browser, no redirect. The SDK treats a
      // provider without redirectUrl as non-interactive and asks
      // prepareTokenRequest for the grant; a 401 later just mints a new token.
      if (!configuredClient || !secret) throw error('EMCP_AUTH', 'Client credentials need a client ID and a client secret.');
      return {
        redirectUrl: undefined,
        clientMetadata: {
          client_name: 'mouaif', grant_types: ['client_credentials'], redirect_uris: [],
          token_endpoint_auth_method: 'client_secret_basic',
          ...(context.entry.oauth.scope ? { scope: context.entry.oauth.scope } : {})
        },
        clientInformation: () => ({ client_id: configuredClient, client_secret: secret }),
        tokens: () => read().tokens,
        saveTokens: (tokens) => update({ tokens }),
        prepareTokenRequest(scope) {
          const params = new URLSearchParams({ grant_type: 'client_credentials' });
          if (scope) params.set('scope', scope);
          return params;
        },
        redirectToAuthorization() { throw error('EMCP_AUTH', 'Client credentials do not use a browser sign-in.'); },
        saveCodeVerifier() { /* not used by client_credentials */ },
        codeVerifier() { throw error('EMCP_AUTH', 'Client credentials do not use PKCE.'); },
        discoveryState: () => flow?.discovery,
        saveDiscoveryState: (discovery) => { if (flow) flow.discovery = discovery; rememberRevocation(discovery); },
        invalidateCredentials(scope) {
          if (scope === 'all' || scope === 'tokens') update({ tokens: undefined });
        }
      };
    }
    const saved = read();
    const redirectUrl = flow?.redirectUrl || saved.redirectUrl;
    if (!redirectUrl) throw error('EMCP_AUTH', 'Sign in to this MCP server in Settings first.');
    return {
      redirectUrl,
      clientMetadata: {
        client_name: 'mouaif', redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(context.entry.oauth.scope ? { scope: context.entry.oauth.scope } : {})
      },
      state() {
        active();
        if (!flow) throw error('EMCP_AUTH', 'MCP authorization expired. Sign in again in Settings.');
        return flow.state;
      },
      // A confidential pre-registered client carries its secret; the SDK
      // picks client_secret_basic / _post from the server's metadata.
      clientInformation: () => configuredClient
        ? { client_id: configuredClient, ...(secret ? { client_secret: secret } : {}) }
        : read().client,
      saveClientInformation: (client) => update({ client }),
      tokens: () => read().tokens,
      saveTokens(tokens) {
        const previous = read().tokens;
        update({ tokens: { ...tokens, ...(tokens.refresh_token ? {} : previous?.refresh_token ? { refresh_token: previous.refresh_token } : {}) }, redirectUrl });
      },
      saveCodeVerifier(verifier) {
        active();
        if (!flow) throw error('EMCP_AUTH', 'Sign in again in Settings.');
        flow.verifier = verifier;
      },
      codeVerifier() {
        active();
        if (!flow?.verifier) throw error('EMCP_AUTH', 'Sign-in expired. Start again.');
        return flow.verifier;
      },
      redirectToAuthorization(url) {
        active();
        if (!flow) throw error('EMCP_AUTH', 'Sign in again in Settings.');
        flow.authorizationUrl = safeUrl(url).href;
      },
      discoveryState: () => flow?.discovery,
      saveDiscoveryState: (discovery) => { if (flow) flow.discovery = discovery; rememberRevocation(discovery); },
      invalidateCredentials(scope) {
        if (scope === 'all') update({ client: undefined, tokens: undefined });
        else if (scope === 'client') update({ client: undefined });
        else if (scope === 'tokens') update({ tokens: undefined });
        if (flow && (scope === 'all' || scope === 'verifier')) flow.verifier = undefined;
        if (flow && (scope === 'all' || scope === 'discovery')) flow.discovery = undefined;
      }
    };
  }
  // connect(context) — client_credentials: fetch a token right now.
  async function connect(context) {
    checkContext(context);
    const key = identity(context);
    cancel(key);
    const saved = storage.read(key) || {};
    storage.write(key, { ...saved, tokens: undefined });
    let p;
    try { p = provider(context); } catch (e) { throw e; }
    try {
      const { auth } = require('@modelcontextprotocol/sdk/client/auth.js');
      const result = await auth(p, { serverUrl: context.entry.url, fetchFn: oauthFetch });
      if (result !== 'AUTHORIZED') throw new Error('not authorized');
      return { connected: true, grant: 'client_credentials' };
    } catch (e) {
      if (e.code === 'EKEYRING') throw e;
      throw error('EMCP_AUTH', 'Could not get a token with client credentials. Check the client ID, secret, and scopes.');
    }
  }
  async function begin(context, origin) {
    checkContext(context);
    if (isClientCredentials(context)) return connect(context);
    prune();
    if (pending.size >= 100) throw error('EMCP_AUTH', 'Too many pending sign-ins. Try again later.');
    const key = identity(context);
    cancel(key);
    const redirectUrl = new URL(CALLBACK_PATH, safeUrl(origin)).href;
    const saved = storage.read(key) || {};
    // A dynamically registered client is bound to its original redirect URI.
    storage.write(key, { ...saved, tokens: undefined, redirectUrl,
      client: saved.redirectUrl === redirectUrl ? saved.client : undefined });
    const state = crypto.randomBytes(32).toString('base64url');
    const flow = { key, state, context, redirectUrl, generation: generations.get(key), expiresAt: Date.now() + PENDING_TTL };
    pending.set(state, flow);
    try {
      const { auth, extractWWWAuthenticateParams } = require('@modelcontextprotocol/sdk/client/auth.js');
      // Some servers advertise protected-resource metadata only through the
      // challenge rather than a conventional well-known path. Probe without
      // tokens or custom headers; GET is safe and a 405 still permits discovery.
      const probe = await oauthFetch(context.entry.url, { headers: { Accept: 'application/json, text/event-stream' } });
      const challenge = extractWWWAuthenticateParams(probe);
      await probe.body?.cancel();
      const result = await auth(provider(context, flow), {
        serverUrl: context.entry.url, fetchFn: oauthFetch,
        resourceMetadataUrl: challenge.resourceMetadataUrl, scope: challenge.scope
      });
      if (result !== 'REDIRECT' || !flow.authorizationUrl) throw error('EMCP_AUTH', 'Server did not provide an OAuth sign-in URL.');
      return { authorizationUrl: flow.authorizationUrl, redirectUrl, expiresAt: flow.expiresAt };
    } catch (e) {
      pending.delete(state);
      if (e.code === 'EKEYRING' || e.code === 'EBADINPUT') throw e;
      // SDK errors may contain raw upstream response bodies (including secrets).
      throw error('EMCP_AUTH', 'Could not start OAuth. Check server OAuth support and the client ID/redirect URI.');
    }
  }
  async function finish(state, code, denied) {
    prune();
    const flow = typeof state === 'string' && pending.get(state);
    if (!flow) throw error('EMCP_AUTH', 'Unknown, expired, or already used sign-in. Start again in Settings.');
    pending.delete(state); // one-shot, including provider denials and failed exchanges
    if (denied) throw error('EMCP_AUTH', 'Sign-in was declined. You can try again in Settings.');
    if (typeof code !== 'string' || !code || code.length > 8192) throw error('EBADINPUT', 'Missing or invalid authorization code.');
    const current = resolveContext(flow.context.projectDir, flow.context.entry.id);
    if (!current || identity(current) !== flow.key) throw error('EMCP_AUTH', 'Server configuration changed. Start sign-in again.');
    try {
      const { auth } = require('@modelcontextprotocol/sdk/client/auth.js');
      await auth(provider(current, flow), { serverUrl: current.entry.url, authorizationCode: code, fetchFn: oauthFetch });
      return { ok: true };
    } catch (e) {
      if (e.code === 'EKEYRING') throw e;
      throw error('EMCP_AUTH', 'OAuth exchange failed. Start sign-in again and check the server configuration.');
    }
  }
  function status(context) {
    checkContext(context);
    prune();
    const key = identity(context);
    const saved = storage.read(key) || {};
    return {
      connected: !!saved.tokens?.access_token,
      pending: [...pending.values()].some(item => item.key === key),
      redirectUrl: saved.redirectUrl || null,
      grant: isClientCredentials(context) ? 'client_credentials' : 'authorization_code',
      secretConfigured: hasSecret(context),
      revocationSupported: saved.revocation ? true : null
    };
  }
  // clear(context, { secret }) — drop tokens and client registration. The
  // client secret is kept unless `secret: true` (the server was removed).
  function clear(context, opts = {}) {
    const key = identity(context);
    cancel(key);
    storage.remove(key);
    if (opts.secret) { try { storage.remove(secretKey(context)); } catch { /* best-effort */ } }
  }
  // revoke(context) — RFC 7009 token revocation at the authorization server,
  // best-effort and bounded. Returns 'revoked' | 'unsupported' | 'failed' | 'none'.
  // The caller clears local credentials whatever the result.
  async function revoke(context, { timeoutMs = 10000 } = {}) {
    checkContext(context);
    const key = identity(context);
    const saved = storage.read(key) || {};
    const tokens = saved.tokens || {};
    if (!tokens.access_token && !tokens.refresh_token) return 'none';
    let endpoint = saved.revocation?.endpoint;
    let methods = saved.revocation?.authMethods || [];
    if (!endpoint) {
      try {
        const { discoverOAuthServerInfo } = require('@modelcontextprotocol/sdk/client/auth.js');
        const info = await discoverOAuthServerInfo(context.entry.url, { fetchFn: oauthFetch });
        const md = info && info.authorizationServerMetadata;
        endpoint = md && md.revocation_endpoint;
        methods = (md && (md.revocation_endpoint_auth_methods_supported || md.token_endpoint_auth_methods_supported)) || [];
      } catch { return 'failed'; }
    }
    if (!endpoint) return 'unsupported';
    let url;
    try { url = safeUrl(endpoint); } catch { return 'failed'; }
    const clientId = context.entry.oauth.clientId || saved.client?.client_id;
    const clientSecret = context.entry.oauth.clientId ? readSecret(context) : saved.client?.client_secret;
    if (!clientId) return 'failed';
    const { selectClientAuthMethod } = require('@modelcontextprotocol/sdk/client/auth.js');
    const method = selectClientAuthMethod({ client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) }, methods);
    let failed = false;
    // Refresh token first: revoking it usually invalidates its access tokens too.
    for (const [token, hint] of [[tokens.refresh_token, 'refresh_token'], [tokens.access_token, 'access_token']]) {
      if (!token) continue;
      const body = new URLSearchParams({ token, token_type_hint: hint });
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
      if (method === 'client_secret_basic' && clientSecret) {
        headers.Authorization = 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64');
      } else if (method === 'client_secret_post' && clientSecret) {
        body.set('client_id', clientId);
        body.set('client_secret', clientSecret);
      } else {
        body.set('client_id', clientId);
      }
      try {
        const res = await oauthFetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
        await res.body?.cancel();
        if (!res.ok) failed = true; // RFC 7009: 200 even for an already-invalid token
      } catch { failed = true; }
    }
    return failed ? 'failed' : 'revoked';
  }
  return { begin, connect, finish, provider, status, clear, revoke, setSecret, hasSecret };
}

const manager = createManager({ resolveContext: (dir, id) => require('./mcp.js').getOAuthContext(dir, id) });
module.exports = { ...manager, createManager, identity, secretKey, safeUrl, oauthFetch, CALLBACK_PATH };
