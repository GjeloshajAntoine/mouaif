'use strict';

// App access authentication REST handlers. Extracted from the original
// single-file http-server.js. Shared helpers live in src/server-shared.js.

const {
sendJSON,
readJsonOr400,
parseCookies,
accessCookie,
accessRequestOrigin,
checkAccessAttempts,
recordAccessFailure,
clearAccessFailures,
publicAccessStatus,
ACCESS_COOKIE,
accessAuth,
qr,
push,
settings,
safeDecode
} = require('./server-shared.js');
const { resolveNotificationPrefs } = require('./notifications.js');

// notifyLogin(username, req) — best-effort push that a new browser signed
// in. Gated by the `notifications.login` preference (on by default) so it
// can be silenced from Settings. Broadcast to every subscribed endpoint
// (not the just-issued session, whose subscription list is empty until the
// page rebinds) so the alert reaches the user's other already-signed-in
// devices — the whole point of a sign-in notice.
function notifyLogin(username, req) {
try {
let prefs = {};
try { prefs = resolveNotificationPrefs((settings.getApp() || {}).notifications); } catch { /* defaults apply */ }
if (prefs.login !== true) return;
const agent = String((req && req.headers && req.headers['user-agent']) || '');
const label = /iphone|ipad|ipod/i.test(agent) ? 'iPhone or iPad'
: /android/i.test(agent) ? 'Android device'
: /mobile/i.test(agent) ? 'mobile browser'
: /macintosh|mac os/i.test(agent) ? 'Mac'
: /windows/i.test(agent) ? 'Windows'
: /linux/i.test(agent) ? 'Linux'
: 'this browser';
push.sendPushToAll({
title: 'mouaif sign-in',
body: `New sign-in as ${username || 'user'} from ${label}.`,
tag: 'mouaif-login',
data: { kind: 'login', url: '/#/projects' },
actions: [{ action: 'open', title: 'Open mouaif' }]
});
} catch { /* a notification failure must never block sign-in */ }
}

// notifyAccessChange(enabled) — best-effort push that app access protection
// changed. A security-relevant event, so it reuses the `login` channel
// ("sign in to / access of this server") rather than adding a preference;
// it broadcasts to every subscribed device, including the one that acted,
// so the state change is visible even if that phone is put down.
function notifyAccessChange(enabled) {
try {
let prefs = {};
try { prefs = resolveNotificationPrefs((settings.getApp() || {}).notifications); } catch { /* defaults apply */ }
if (prefs.login !== true) return;
push.sendPushToAll({
title: enabled ? 'mouaif access enabled' : 'mouaif access disabled',
body: enabled
? 'Password and passkey protection is on again.'
: 'App access is off. Anyone who can reach this server can open it.',
tag: 'mouaif-access',
data: { kind: 'login', url: '/#/settings/access' },
actions: [{ action: 'open', title: 'Open settings' }]
});
} catch { /* a notification failure must never change the access state */ }
}


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
    const status = publicAccessStatus(serverConfig.authEnabled);
    return sendJSON(res, 200, { ...status, session: !!activeSession, authenticated: !status.enabled || !!activeSession });
  }

  if (urlPath === '/api/access/login' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    if (!accessAuth.configured()) return sendJSON(res, 409, { error: 'Access is not configured yet', code: 'ENOTCONFIGURED' });
    if (!checkAccessAttempts(req)) return sendJSON(res, 429, { error: 'Too many sign-in attempts; wait a minute', code: 'ERATE_LIMIT' });
    if (!accessAuth.verifyPassword(body.username, body.password)) {
      recordAccessFailure(req);
      return sendJSON(res, 401, { error: 'User or password is incorrect', code: 'EBADCREDENTIALS' });
    }
    clearAccessFailures(req);
const issued = accessAuth.issueSession();
res.setHeader('Set-Cookie', accessCookie(issued.token, secure, accessAuth.SESSION_TTL_MS / 1000));
notifyLogin(accessAuth.user().username, req);
return sendJSON(res, 200, { ok: true, user: accessAuth.user().username });
}


  if (urlPath === '/api/access/logout' && method === 'POST') {
    accessAuth.revokeSession(accessToken);
    res.setHeader('Set-Cookie', accessCookie('', secure, 0));
    return sendJSON(res, 200, { ok: true });
  }

  // ---- Turn app access off / back on ------------------------------------
  // Disabling is signed-in-only and requires a fresh one-time code, so a
  // request that only holds a cookie (a script, a stale tab) cannot remove
  // the login wall by itself. The code is minted here — unlike setup codes
  // it is never printed to stdout or served to an unauthenticated caller.
  if (urlPath === '/api/access/disable/code' && method === 'POST') {
    if (!activeSession) return sendJSON(res, 401, { error: 'Sign in is required', code: 'EAUTH_REQUIRED' });
    const issued = accessAuth.createDisableCode();
    return sendJSON(res, 200, { code: issued.code, expiresAt: issued.expiresAt, ttlMs: accessAuth.DISABLE_TTL_MS });
  }

  // The QR is an image so a phone can open it with the system camera. It
  // encodes the confirmation page, which is what makes the code itself
  // unnecessary to type on the scanning device.
  if (urlPath === '/api/access/disable/qr' && method === 'GET') {
    if (!activeSession) return sendJSON(res, 401, { error: 'Sign in is required', code: 'EAUTH_REQUIRED' });
    const code = typeof parsed.query.code === 'string' ? parsed.query.code : '';
    if (!accessAuth.disableCodeValid(code)) return sendJSON(res, 404, { error: 'Disable code is missing or expired', code: 'EDISABLE_CODE' });
    const confirmUrl = servedOrigin + '/#/disable-access?code=' + encodeURIComponent(accessAuth.normalizeCode(code));
    const svg = qr.svg(confirmUrl);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(svg);
    return;
  }

  if (urlPath === '/api/access/disable' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    // An invalid code is a failed guess, so it counts against the same
    // per-address limit as a wrong password. The confirmation page is
    // deliberately reachable without a session, so nothing else slows down
    // a caller trying codes in a loop.
    if (!checkAccessAttempts(req)) return sendJSON(res, 429, { error: 'Too many attempts; wait a minute', code: 'ERATE_LIMIT' });
    if (!accessAuth.disableCodeValid(body.code)) {
      recordAccessFailure(req);
      return sendJSON(res, 401, { error: 'That code is invalid or expired', code: 'EDISABLE_CODE' });
    }
    if (!accessAuth.consumeDisableCode(body.code)) {
      recordAccessFailure(req);
      return sendJSON(res, 409, { error: 'That code was already used or expired', code: 'EDISABLE_CODE' });
    }
    clearAccessFailures(req);
    // Consume every other outstanding invitation and turn the gate off.
    // Sessions are intentionally kept: with the gate off they authorize
    // nothing, and holding on to them lets the device that disabled access
    // re-enable it without having to prove the password again.
    settings.getDb().prepare('DELETE FROM access_disable_codes').run();
    settings.getDb().prepare('DELETE FROM access_setup_codes').run();
    accessAuth.setEnabled(false);
    notifyAccessChange(false);
    return sendJSON(res, 200, { ok: true, enabled: false, configured: accessAuth.configured() });
  }

  // Turning protection back on is safe to do from an unauthenticated screen,
  // so it accepts any of the store's proofs: a live session, the account
  // password, or a CLI setup code. That keeps recovery possible even after
  // session cookies have expired while access was off.
  if (urlPath === '/api/access/enable' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const account = accessAuth.user();
    if (!account) return sendJSON(res, 409, { error: 'Create the access user before enabling protection', code: 'ENOTCONFIGURED' });
    const bySession = !!activeSession;
    const byPassword = !bySession && account
      && accessAuth.verifyPassword(body.username || account.username, body.password);
    const bySetupCode = !bySession && !byPassword && accessAuth.setupCodeValid(body.code);
    if (!bySession && !byPassword && !bySetupCode) {
      return sendJSON(res, 401, { error: 'Sign in, or enter the account password, to enable access', code: 'EAUTH_REQUIRED' });
    }
    if (bySetupCode && !accessAuth.consumeSetupCode(body.code)) {
      return sendJSON(res, 409, { error: 'Setup code was already used or expired', code: 'ESETUP_CODE' });
    }
    accessAuth.setEnabled(true);
    notifyAccessChange(true);
    return sendJSON(res, 200, { ok: true, enabled: true, configured: true });
  }

  // Password change from an authenticated browser session. Requires a real
  // cookie session (a Basic-auth API client cannot ask to rotate the
  // password through this endpoint). The current session survives the
  // rotation; every other browser is signed out.
  if (urlPath === '/api/access/password' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    if (!activeSession) return sendJSON(res, 401, { error: 'Sign in is required', code: 'EAUTH_REQUIRED' });
    try {
      const changed = accessAuth.changePassword(activeSession.username, body.currentPassword, body.newPassword, accessToken);
      res.setHeader('Set-Cookie', accessCookie(accessToken, secure, accessAuth.SESSION_TTL_MS / 1000));
      return sendJSON(res, 200, { ok: true, user: changed.user && changed.user.username, expiresAt: changed.expiresAt });
    } catch (e) {
      return sendJSON(res, e.code === 'EBADCREDENTIALS' ? 401 : 400, { error: e.message, code: e.code || 'EBADINPUT' });
    }
  }

  if (urlPath === '/api/access/setup/verify' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const valid = accessAuth.setupCodeValid(body.code);
    return sendJSON(res, valid ? 200 : 401, { valid });
  }

  if (urlPath === '/api/access/setup' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const setupAuthorized = accessAuth.setupCodeValid(body.code);
    if (!activeSession && !setupAuthorized) return sendJSON(res, 401, { error: 'A valid one-time setup code or signed-in session is required', code: 'ESETUP_CODE' });
    try {
      accessAuth.setPassword(body.username, body.password);
      if (setupAuthorized && !accessAuth.consumeSetupCode(body.code)) return sendJSON(res, 409, { error: 'Setup code was already used or expired', code: 'ESETUP_CODE' });
      const issued = accessAuth.issueSession();
res.setHeader('Set-Cookie', accessCookie(issued.token, secure, accessAuth.SESSION_TTL_MS / 1000));
notifyLogin(accessAuth.user() && accessAuth.user().username, req);
return sendJSON(res, 200, { ok: true, ...publicAccessStatus(serverConfig.authEnabled), authenticated: true });

    } catch (e) {
      return sendJSON(res, 400, { error: e.message, code: e.code || 'EBADINPUT' });
    }
  }

  if (urlPath === '/api/access/passkeys/register/options' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
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
    const body = await readJsonOr400(req, res);
    if (!body) return;
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
    const body = await readJsonOr400(req, res);
    if (!body) return;
    try {
      const account = accessAuth.finishAuthentication(body);
      clearAccessFailures(req);
const issued = accessAuth.issueSession();
res.setHeader('Set-Cookie', accessCookie(issued.token, secure, accessAuth.SESSION_TTL_MS / 1000));
notifyLogin(account.username, req);
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
    const id = safeDecode(urlPath.slice('/api/access/passkeys/'.length));
    return sendJSON(res, accessAuth.deletePasskey(id) ? 200 : 404, { ok: true });
  }

  if (urlPath === '/api/access/setup/qr' && method === 'GET') {
    const code = typeof parsed.query.code === 'string' ? parsed.query.code : '';
    if (!accessAuth.setupCodeValid(code)) return sendJSON(res, 404, { error: 'Setup code is missing or expired', code: 'ESETUP_CODE' });
    const setupUrl = servedOrigin + '/#/setup?code=' + encodeURIComponent(accessAuth.normalizeCode(code));
    const svg = qr.svg(setupUrl);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(svg);
    return;
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'access' });
}

module.exports = { handleAccess };
