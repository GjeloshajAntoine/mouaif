'use strict';

// App access authentication REST handlers. Extracted from the original
// single-file http-server.js. Shared helpers live in src/server-shared.js.

const {
  sendJSON,
  readJsonBody,
  parseCookies,
  accessCookie,
  accessRequestOrigin,
  checkAccessAttempts,
  recordAccessFailure,
  clearAccessFailures,
  publicAccessStatus,
  ACCESS_COOKIE,
  accessAuth,
  qr
} = require('./server-shared.js');

async function handleAccess(req, res, parsed, serverConfig) {
  const urlPath = parsed.pathname;
  const method = req.method;
  let servedOrigin;
  try { servedOrigin = accessRequestOrigin(req, serverConfig.publicOrigin); }
  catch (e) { return sendJSON(res, 400, { error: e.message, code: e.code || 'EORIGIN' }); }
  const secure = servedOrigin.startsWith('https://');
  const accessToken = parseCookies(req.headers.cookie)[ACCESS_COOKIE] || '';
  const activeSession = accessAuth.session(accessToken);

  if (urlPath === '/api/access/status' && method === 'GET') {
    return sendJSON(res, 200, { ...publicAccessStatus(serverConfig.authEnabled), authenticated: !serverConfig.authEnabled || !!activeSession });
  }

  if (urlPath === '/api/access/login' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    if (!accessAuth.configured()) return sendJSON(res, 409, { error: 'Access is not configured yet', code: 'ENOTCONFIGURED' });
    if (!checkAccessAttempts(req)) return sendJSON(res, 429, { error: 'Too many sign-in attempts; wait a minute', code: 'ERATE_LIMIT' });
    if (!accessAuth.verifyPassword(body.username, body.password)) {
      recordAccessFailure(req);
      return sendJSON(res, 401, { error: 'User or password is incorrect', code: 'EBADCREDENTIALS' });
    }
    clearAccessFailures(req);
    const issued = accessAuth.issueSession();
    res.setHeader('Set-Cookie', accessCookie(issued.token, secure, accessAuth.SESSION_TTL_MS / 1000));
    return sendJSON(res, 200, { ok: true, user: accessAuth.user().username });
  }

  if (urlPath === '/api/access/logout' && method === 'POST') {
    accessAuth.revokeSession(accessToken);
    res.setHeader('Set-Cookie', accessCookie('', secure, 0));
    return sendJSON(res, 200, { ok: true });
  }

  if (urlPath === '/api/access/setup/verify' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const valid = accessAuth.setupCodeValid(body.code);
    return sendJSON(res, valid ? 200 : 401, { valid });
  }

  if (urlPath === '/api/access/setup' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const setupAuthorized = accessAuth.setupCodeValid(body.code);
    if (!activeSession && !setupAuthorized) return sendJSON(res, 401, { error: 'A valid one-time setup code or signed-in session is required', code: 'ESETUP_CODE' });
    try {
      accessAuth.setPassword(body.username, body.password);
      if (setupAuthorized && !accessAuth.consumeSetupCode(body.code)) return sendJSON(res, 409, { error: 'Setup code was already used or expired', code: 'ESETUP_CODE' });
      const issued = accessAuth.issueSession();
      res.setHeader('Set-Cookie', accessCookie(issued.token, secure, accessAuth.SESSION_TTL_MS / 1000));
      return sendJSON(res, 200, { ok: true, ...publicAccessStatus(serverConfig.authEnabled), authenticated: true });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message, code: e.code || 'EBADINPUT' });
    }
  }

  if (urlPath === '/api/access/passkeys/register/options' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    if (!accessAuth.configured()) return sendJSON(res, 409, { error: 'Create the access user before adding a passkey', code: 'ENOTCONFIGURED' });
    const setupAuthorized = accessAuth.setupCodeValid(body.code);
    if (!activeSession && !setupAuthorized) return sendJSON(res, 401, { error: 'Sign in or provide a valid setup code first', code: 'EAUTH_REQUIRED' });
    const username = activeSession ? activeSession.username : String(body.username || accessAuth.user()?.username || '').trim();
    if (!username) return sendJSON(res, 400, { error: 'username is required' });
    try {
      return sendJSON(res, 200, accessAuth.beginRegistration({
        origin: servedOrigin, username,
        authorizedBy: setupAuthorized ? accessAuth.normalizeCode(body.code) : 'session'
      }));
    } catch (e) { return sendJSON(res, 400, { error: e.message, code: e.code || 'EWEBAUTHN' }); }
  }

  if (urlPath === '/api/access/passkeys/register/verify' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    try {
      const result = accessAuth.finishRegistration(body);
      return sendJSON(res, 200, { ok: true, passkeys: result.passkeys });
    } catch (e) { return sendJSON(res, 400, { error: e.message, code: e.code || 'EWEBAUTHN' }); }
  }

  if (urlPath === '/api/access/passkeys/login/options' && method === 'POST') {
    if (!checkAccessAttempts(req)) return sendJSON(res, 429, { error: 'Too many sign-in attempts; wait a minute', code: 'ERATE_LIMIT' });
    try { return sendJSON(res, 200, accessAuth.beginAuthentication({ origin: servedOrigin })); }
    catch (e) { return sendJSON(res, 400, { error: e.message, code: e.code || 'EWEBAUTHN' }); }
  }

  if (urlPath === '/api/access/passkeys/login/verify' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    try {
      const account = accessAuth.finishAuthentication(body);
      clearAccessFailures(req);
      const issued = accessAuth.issueSession();
      res.setHeader('Set-Cookie', accessCookie(issued.token, secure, accessAuth.SESSION_TTL_MS / 1000));
      return sendJSON(res, 200, { ok: true, user: account.username });
    } catch (e) {
      recordAccessFailure(req);
      return sendJSON(res, 401, { error: e.message, code: e.code || 'EWEBAUTHN' });
    }
  }

  if (urlPath === '/api/access/passkeys' && method === 'GET') {
    if (!activeSession) return sendJSON(res, 401, { error: 'Sign in is required', code: 'EAUTH_REQUIRED' });
    return sendJSON(res, 200, { passkeys: accessAuth.passkeys() });
  }

  if (urlPath.startsWith('/api/access/passkeys/') && method === 'DELETE') {
    if (!activeSession) return sendJSON(res, 401, { error: 'Sign in is required', code: 'EAUTH_REQUIRED' });
    const id = decodeURIComponent(urlPath.slice('/api/access/passkeys/'.length));
    return sendJSON(res, accessAuth.deletePasskey(id) ? 200 : 404, { ok: true });
  }

  if (urlPath === '/api/access/setup/qr' && method === 'GET') {
    const code = typeof parsed.query.code === 'string' ? parsed.query.code : '';
    if (!accessAuth.setupCodeValid(code)) return sendJSON(res, 404, { error: 'Setup code is missing or expired', code: 'ESETUP_CODE' });
    const setupUrl = servedOrigin + '/web/#/setup?code=' + encodeURIComponent(accessAuth.normalizeCode(code));
    const svg = qr.svg(setupUrl);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(svg);
    return;
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'access' });
}

module.exports = { handleAccess };
