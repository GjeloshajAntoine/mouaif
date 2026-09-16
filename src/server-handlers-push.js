'use strict';

// Browser push notification REST handlers. Extracted from the original
// single-file http-server.js. Shared helpers live in src/server-shared.js.

const { sendJSON, readJsonOr400, push } = require('./server-shared.js');

async function handlePush(req, res, parsed, sessionToken, servedOrigin) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const sid = push.sessionIdFromToken(sessionToken);

  // GET /api/push/vapid-public-key
  if (urlPath === '/api/push/vapid-public-key' && method === 'GET') {
    const publicKey = push.getVapidPublicKey();
    if (!publicKey) return sendJSON(res, 500, { error: 'VAPID keys not initialised', code: 'ENOVAPID' });
    return sendJSON(res, 200, { publicKey });
  }

  // GET /api/push/config — safe notification configuration. Opening the
  // settings screen also repairs a missing VAPID pair. The private key never
  // leaves the server.
  if (urlPath === '/api/push/config' && method === 'GET') {
    try {
      return sendJSON(res, 200, push.getPushConfig(servedOrigin));
    } catch (e) {
      return sendJSON(res, 500, { error: e.message, code: 'EVAPID' });
    }
  }

  // POST /api/push/subscribe
  if (urlPath === '/api/push/subscribe' && method === 'POST') {
    if (!sid) return sendJSON(res, 401, { error: 'No session', code: 'ESESSION' });
    const body = await readJsonOr400(req, res);
    if (!body) return;
    if (!body.subscription || !body.subscription.endpoint) {
      return sendJSON(res, 400, { error: 'subscription with endpoint is required', code: 'EBADINPUT' });
    }
    const { endpoint, keys } = body.subscription;
    if (!keys || !keys.p256dh || !keys.auth) {
    return sendJSON(res, 400, { error: 'subscription must include keys.p256dh and keys.auth', code: 'EBADINPUT' });
    }
    // `statusBarMaxChars` is how many characters one notification body line
    // holds on this device. The status push uses it to pick the ASCII bar
    // width (src/push.js BAR_CELLS) instead of guessing a single size for
    // phone, tablet, and desktop. Optional: the page always sends it, and a
    // client that omits it keeps the phone default.
    const statusBarMaxChars = Number(body.subscription.statusBarMaxChars);
    try {
    const result = push.addSubscription({
      sessionId: sid,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      origin: servedOrigin || null,
      statusBarMaxChars: Number.isFinite(statusBarMaxChars) && statusBarMaxChars > 0 ? statusBarMaxChars : null
    });
    return sendJSON(res, 200, { ok: true, id: result.id });
    } catch (e) {
    return sendJSON(res, 500, { error: e.message, code: 'EDB' });
    }
  }

  // DELETE /api/push/subscribe  body: { endpoint }
  if (urlPath === '/api/push/subscribe' && method === 'DELETE') {
    if (!sid) return sendJSON(res, 401, { error: 'No session', code: 'ESESSION' });
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const endpoint = body && body.endpoint;
    if (!endpoint) return sendJSON(res, 400, { error: 'endpoint is required', code: 'EBADINPUT' });
    const removed = push.removeSubscription(endpoint, sid);
    return sendJSON(res, 200, { ok: true, removed });
  }

  // GET /api/push/subscriptions
  if (urlPath === '/api/push/subscriptions' && method === 'GET') {
    if (!sid) return sendJSON(res, 200, { subscriptions: [] });
    return sendJSON(res, 200, { subscriptions: push.listSubscriptions(sid) });
  }

  // POST /api/push/test
  if (urlPath === '/api/push/test' && method === 'POST') {
    if (!sid) return sendJSON(res, 401, { error: 'No session', code: 'ESESSION' });
    push.sendPushToSession(sid, {
      title: 'mouaif notifications',
      body: 'Notifications are ready on this browser.',
      tag: 'mouaif-notification-test',
      data: { kind: 'test', url: '/#/settings/notifications' }
    });
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: 'Not found', scope: 'push' });
}

module.exports = { handlePush };
