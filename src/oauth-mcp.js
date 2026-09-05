'use strict';

// MCP OAuth is independent of AI-provider accounts. Credentials are scoped to
// the saved server identity and stored only in the OS keychain.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Entry } = require('@napi-rs/keyring');
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
      const text = new Entry('mouaif/mcp-oauth', key).getPassword();
      return text ? JSON.parse(text) : {};
    } catch (e) {
      if (/no matching entry|not found|No such file/i.test(e.message || '')) return {};
      throw error('EKEYRING', 'MCP OAuth needs an available OS keychain.');
    }
  },
  write(key, value) {
    try { new Entry('mouaif/mcp-oauth', key).setPassword(JSON.stringify(value)); }
    catch { throw error('EKEYRING', 'Could not save MCP OAuth credentials in the OS keychain.'); }
  },
  remove(key) {
    try { new Entry('mouaif/mcp-oauth', key).deletePassword(); }
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
  const generations = new Map();
  function prune() {
    for (const [state, item] of pending) if (item.expiresAt <= Date.now()) pending.delete(state);
  }
  function cancel(key) {
    generations.set(key, (generations.get(key) || 0) + 1);
    for (const [state, item] of pending) if (item.key === key) pending.delete(state);
  }
  function checkContext(context) {
    if (context.entry.transport !== 'http' || !context.entry.oauth?.enabled) {
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
    const saved = read();
    const redirectUrl = flow?.redirectUrl || saved.redirectUrl;
    if (!redirectUrl) throw error('EMCP_AUTH', 'Sign in to this MCP server in Settings first.');
    const configuredClient = context.entry.oauth.clientId;
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
      clientInformation: () => configuredClient ? { client_id: configuredClient } : read().client,
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
      saveDiscoveryState: (discovery) => { if (flow) flow.discovery = discovery; },
      invalidateCredentials(scope) {
        if (scope === 'all') update({ client: undefined, tokens: undefined });
        else if (scope === 'client') update({ client: undefined });
        else if (scope === 'tokens') update({ tokens: undefined });
        if (flow && (scope === 'all' || scope === 'verifier')) flow.verifier = undefined;
        if (flow && (scope === 'all' || scope === 'discovery')) flow.discovery = undefined;
      }
    };
  }
  async function begin(context, origin) {
    checkContext(context);
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
    return { connected: !!saved.tokens?.access_token, pending: [...pending.values()].some(item => item.key === key), redirectUrl: saved.redirectUrl || null };
  }
  function clear(context) {
    const key = identity(context);
    cancel(key);
    storage.remove(key);
  }
  return { begin, finish, provider, status, clear };
}

const manager = createManager({ resolveContext: (dir, id) => require('./mcp.js').getOAuthContext(dir, id) });
module.exports = { ...manager, createManager, identity, safeUrl, oauthFetch, CALLBACK_PATH };
