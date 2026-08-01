'use strict';

// Auth + OAuth loopback callback REST handlers. Extracted from the
// original single-file http-server.js. Shared helpers live in
// src/server-shared.js.

const {
  sendJSON,
  readJsonBody,
  htmlPage,
  redirectMeta,
  finishOAuth,
  auth,
  oauthAnthropic,
  oauthCopilot,
  oauthOpenRouter
} = require('./server-shared.js');

async function handleAuth(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  if (urlPath === '/api/auth/accounts' && method === 'GET') {
    return sendJSON(res, 200, { accounts: auth.listAccounts() });
  }

  if (urlPath === '/api/auth/status' && method === 'GET') {
    const provider = typeof q.provider === 'string' ? q.provider : '';
    if (!provider) return sendJSON(res, 400, { error: 'provider query param is required' });
    if (!auth.SUPPORTED_PROVIDERS.includes(provider)) {
      return sendJSON(res, 400, { error: 'Unknown provider', provider });
    }
    const accounts = auth.listAccounts();
    return sendJSON(res, 200, {
      provider,
      accounts: accounts[provider] || [],
      hasExchange: !!auth.getExchange(provider)
    });
  }

  const delMatch = urlPath.match(/^\/api\/auth\/accounts\/([a-z0-9-]+)\/(.+)$/);
  if (delMatch && method === 'DELETE') {
    const provider = delMatch[1];
    const account = decodeURIComponent(delMatch[2]);
    if (!auth.SUPPORTED_PROVIDERS.includes(provider)) {
      return sendJSON(res, 400, { error: 'Unknown provider', provider });
    }
    try {
      const r = auth.deleteToken(provider, account);
      return sendJSON(res, 200, Object.assign({ ok: true }, r));
    } catch (e) {
      return sendJSON(res, 500, { error: e.message, code: e.code || 'EKEYRING' });
    }
  }

  // POST /api/auth/sign-in/anthropic  -> { authorizeUrl, state, expiresAt }
  // The UI calls this, opens authorizeUrl in the user's browser, and
  // polls GET /api/auth/status?provider=anthropic until hasExchange
  // (already registered) and accounts include the signed-in email.
  if (urlPath === '/api/auth/sign-in/anthropic' && method === 'POST') {
    if (!auth.getExchange('anthropic')) {
      return sendJSON(res, 501, { error: 'Anthropic OAuth is not registered in this build' });
    }
    let body = {};
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }

    const state = oauthAnthropic.newState();
    const verifier = oauthAnthropic.newVerifier();
    const callbackUrl = new URL(body.redirectUri || ('http://127.0.0.1:' + (req.socket.address() && req.socket.address().port) + '/oauth/callback'));
    // The callback handler is shared by providers and therefore requires the
    // provider name. OAuth providers return our redirect URI verbatim, so
    // bind the provider into it before recording the pending exchange.
    if (!callbackUrl.searchParams.has('provider')) callbackUrl.searchParams.set('provider', 'anthropic');
    const redirectUri = callbackUrl.toString();
    const scope = body.scope || oauthAnthropic.DEFAULT_SCOPE;

    auth.recordPending('anthropic', {
      state,
      codeVerifier: verifier,
      redirectUri,
      scopes: scope,
      accountHint: body.accountHint || ''
    });

    const authorizeUrl = oauthAnthropic.buildAuthorizeUrl({
      redirectUri,
      state,
      verifier,
      scope
    });

    return sendJSON(res, 200, {
      authorizeUrl,
      redirectUri,
      state,
      expiresAt: Date.now() + 5 * 60 * 1000,
      // Echoed for debugging; the production base is https://api.anthropic.com
      // unless MOUAIF_ANTHROPIC_API_BASE is set (test override).
      apiBase: oauthAnthropic.DEFAULT_API_BASE
    });
  }

  // POST /api/auth/sign-in/github-copilot  -> { authorizeUrl, state, expiresAt }
  // GitHub Copilot uses the standard GitHub OAuth web flow with PKCE
  // (decision §12: each provider picks its own auth shape). The user
  // signs in at github.com/login/oauth/authorize, gets redirected
  // back to /oauth/callback, the server exchanges the code for a
  // long-lived GitHub OAuth access token, and the per-request
  // Copilot API token is derived on demand by src/ai.js.
  if (urlPath === '/api/auth/sign-in/github-copilot' && method === 'POST') {
    if (!auth.getExchange('github-copilot')) {
      return sendJSON(res, 501, { error: 'GitHub Copilot OAuth is not registered in this build' });
    }
    let body = {};
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }

    const state = oauthCopilot.newState();
    const verifier = oauthCopilot.newVerifier();
    const callbackUrl = new URL(body.redirectUri || ('http://127.0.0.1:' + (req.socket.address() && req.socket.address().port) + '/oauth/callback'));
    if (!callbackUrl.searchParams.has('provider')) callbackUrl.searchParams.set('provider', 'github-copilot');
    const redirectUri = callbackUrl.toString();
    const scope = body.scope || oauthCopilot.DEFAULT_SCOPE;

    auth.recordPending('github-copilot', {
      state,
      codeVerifier: verifier,
      redirectUri,
      scopes: scope,
      accountHint: body.accountHint || ''
    });

    const authorizeUrl = oauthCopilot.buildAuthorizeUrl({
      redirectUri,
      state,
      verifier,
      scope
    });

    return sendJSON(res, 200, {
      authorizeUrl,
      redirectUri,
      state,
      expiresAt: Date.now() + 10 * 60 * 1000,
      // Echoed for debugging; the production base is the default.
      apiBase: oauthCopilot.COPILOT_API_BASE
    });
  }

  // POST /api/auth/sign-in/openrouter  -> { authorizeUrl, state, expiresAt }
  // OpenRouter's PKCE flow (docs/decisions.md §12). Unlike
  // Anthropic / GitHub Copilot, the loopback URL the user is
  // redirected back to is the same URL we pass in — OpenRouter
  // echoes it via the `callback_url` query param rather than
  // expecting a pre-registered redirect. The user signs in at
  // openrouter.ai/auth and OpenRouter redirects back to our
  // /oauth/callback with `?code=...&state=...`. The server
  // exchanges the code for a user-controlled OpenRouter API key
  // (src/oauth-openrouter.js) and stores it in the keyring under
  // the `openrouter` namespace. Subsequent chats use the same
  // Bearer header path as a manually pasted OpenRouter key.
  if (urlPath === '/api/auth/sign-in/openrouter' && method === 'POST') {
    if (!auth.getExchange('openrouter')) {
      return sendJSON(res, 501, { error: 'OpenRouter OAuth is not registered in this build' });
    }
    let body = {};
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }

    const rawState = oauthOpenRouter.newState();
    // Encode the provider in the state prefix so it survives the
    // OAuth redirect. OpenRouter does not forward ?provider= from
    // the callback_url, so we need the provider in a field the
    // IdP echoes back faithfully. See finishOAuth()'s state parsing.
    const state = 'openrouter:' + rawState;
    const verifier = oauthOpenRouter.newVerifier();
    const callbackUrl = new URL(body.redirectUri || ('http://127.0.0.1:' + (req.socket.address() && req.socket.address().port) + '/oauth/callback'));
    if (!callbackUrl.searchParams.has('provider')) callbackUrl.searchParams.set('provider', 'openrouter');
    const redirectUri = callbackUrl.toString();

    auth.recordPending('openrouter', {
      state,
      codeVerifier: verifier,
      redirectUri,
      scopes: 'openrouter',
      accountHint: body.accountHint || ''
    });

    const authorizeUrl = oauthOpenRouter.buildAuthorizeUrl({
      callbackUrl: redirectUri,
      state,
      verifier
    });

    return sendJSON(res, 200, {
      authorizeUrl,
      redirectUri,
      state,
      expiresAt: Date.now() + 10 * 60 * 1000,
      apiBase: oauthOpenRouter.KEYS_URL
    });
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'auth' });
}

async function handleOAuthCallback(req, res, parsed) {
  const q = parsed.query || {};
  const provider = typeof q.provider === 'string' ? q.provider : '';
  const state = typeof q.state === 'string' ? q.state : '';
  const code = typeof q.code === 'string' ? q.code : '';
  const errorParam = typeof q.error === 'string' ? q.error : '';

  const result = await finishOAuth({ provider, state, code, errorParam, format: 'html' });
  res.writeHead(result.status, { 'Content-Type': 'text/html; charset=utf-8' });
  // On iOS (especially PWA standalone mode) the popup that opened the OAuth
  // provider may be the current page itself — there is no other tab to close.
  // Auto-redirect back to the app after a brief pause so the user sees the
  // result and lands back at the UI. The redirect is relative (same origin)
  // so the existing session cookie carries over.
  const returnUrl = '/web/';
  if (result.status === 200) {
    res.end(htmlPage('Signed in', '<p class="ok">Signed in to <code>' + provider + '</code> as <code>' + result.account + '</code>.</p>'
      + redirectMeta(returnUrl)));
  } else if (result.code === 'EPROVIDER_ERROR') {
    res.end(htmlPage('Sign-in failed', '<p class="err">' + result.error + '</p>'
      + redirectMeta(returnUrl)));
  } else if (result.code === 'ENOEXCHANGE') {
    res.end(htmlPage('OAuth not configured', '<p class="err">Sign-in for <code>' + provider + '</code> is not configured in this build. A later commit will register the provider exchange.</p>'
      + redirectMeta(returnUrl)));
  } else {
    res.end(htmlPage('OAuth callback', '<p class="err">' + (result.error || 'unknown error') + '</p>'
      + redirectMeta(returnUrl)));
  }
}

async function handleOAuthCallbackPost(req, res, parsed) {
  let body = {};
  try { body = await readJsonBody(req); }
  catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
  const provider = typeof body.provider === 'string' ? body.provider : '';
  const state = typeof body.state === 'string' ? body.state : '';
  const code = typeof body.code === 'string' ? body.code : '';
  const errorParam = typeof body.error === 'string' ? body.error : '';
  const result = await finishOAuth({ provider, state, code, errorParam, format: 'json' });
  if (result.status === 200) {
    return sendJSON(res, 200, { ok: true, provider, account: result.account });
  }
  return sendJSON(res, result.status, { ok: false, error: result.error, code: result.code });
}

module.exports = { handleAuth, handleOAuthCallback, handleOAuthCallbackPost };
