'use strict';

// Regression coverage for the device-sized ASCII status bar.
//
// The status bar was one fixed 10-cell width for every device, so it either
// wrapped and pushed the status text off a phone's collapsed notification or
// wasted resolution on a desktop. The width is now derived from the body line
// the receiving browser reports at subscribe time and stored per
// subscription, and the two status bodies (chat and sign-in/test) resolve it
// per target.
//
// This test drives the real HTTP layer: it POSTs subscriptions with different
// reported widths, then fires a chat-style status push and asserts each
// device received a bar sized to its own screen. web-push is replaced with a
// recorder, so no network is used.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-status-bar-'));

const webpush = require('web-push');
const deliveries = [];
webpush.setVapidDetails = () => {};
webpush.sendNotification = (subscription, payload) => {
  deliveries.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
  return Promise.resolve();
};

const settings = require('../src/settings.js');
const push = require('../src/push.js');
const { handlePush } = require('../src/server-handlers-push.js');

push.ensureTable();
push.ensureVapidKeys();

// ---- Pure formatter ----------------------------------------------------

assert.equal(push.asciiStatusBar(40, 'narrow'), '[##----] 40%', 'narrow renders 6 cells');
assert.equal(push.asciiStatusBar(40, 'wide'), '[####------] 40%', 'wide renders 10 cells');
assert.equal(push.asciiStatusBar(40, 'huge'), '[########------------] 40%', 'huge renders 20 cells');
assert.equal(push.asciiStatusBar(1, 'huge'), '[#-------------------] 1%', 'a fine bar lights one cell for 1%');
assert.equal(push.asciiStatusBar(0, 'huge'), '[--------------------] 0%', 'zero progress lights no cells');
assert.equal(push.asciiStatusBar(null, 'narrow'), '[------]', 'an unlabelled bar has no percentage');
assert.equal(push.statusBarSizeForMaxChars(30), 'narrow', 'a phone line is narrow');
assert.equal(push.statusBarSizeForMaxChars(60), 'wide', 'a landscape phone line is wide');
assert.equal(push.statusBarSizeForMaxChars(120), 'huge', 'a desktop line is huge');
assert.equal(push.statusBarSizeForMaxChars(0), 'narrow', 'an unreported width defaults to narrow');
assert.equal(push.statusBarSizeForMaxChars(NaN), 'narrow', 'a non-numeric width defaults to narrow');

// ---- HTTP: subscribe with a reported body width ------------------------

function mockResponse() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(chunk) { if (chunk) this.body += chunk; }
  };
  return res;
}

async function postSubscription(sessionToken, endpoint, statusBarMaxChars) {
  const payload = JSON.stringify({
    subscription: {
      endpoint,
      keys: { p256dh: 'p-' + endpoint, auth: 'a-' + endpoint },
      ...(statusBarMaxChars === undefined ? {} : { statusBarMaxChars })
    }
  });
  const req = {
    method: 'POST',
    _body: payload,
    on(event, handler) {
      if (event === 'data') handler(Buffer.from(payload));
      if (event === 'end') handler();
      return this;
    },
    once(event, handler) { return this.on(event, handler); }
  };
  const res = mockResponse();
  await handlePush(req, res, { pathname: '/api/push/subscribe' }, sessionToken, 'https://mouaif.test');
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

(async () => {
  // Three devices, three reported body lines: a phone, a landscape phone, and
  // a desktop window.
  const session = 'session-mixed';
  const sid = push.sessionIdFromToken(session);
  assert.equal((await postSubscription(session, 'https://phone.example', 32)).status, 200, 'phone subscription accepted');
  assert.equal((await postSubscription(session, 'https://tablet.example', 60)).status, 200, 'tablet subscription accepted');
  assert.equal((await postSubscription(session, 'https://desktop.example', 140)).status, 200, 'desktop subscription accepted');

  const rows = push.listSubscriptions(sid);
  const byEndpoint = new Map(rows.map((r) => [r.endpoint, r]));
  assert.equal(byEndpoint.get('https://phone.example').status_bar, 32, 'the phone width is stored per device');
  assert.equal(byEndpoint.get('https://tablet.example').status_bar, 60, 'the tablet width is stored per device');
  assert.equal(byEndpoint.get('https://desktop.example').status_bar, 140, 'the desktop width is stored per device');

  // Rebinding without a width (an older/cached page) must not wipe a good one.
  await postSubscription(session, 'https://phone.example');
  assert.equal(push.listSubscriptions(sid).find((r) => r.endpoint === 'https://phone.example').status_bar, 32,
    'a rebind without a width keeps the stored width');

  // A brand-new subscription that never reports a width keeps the column NULL
  // and therefore gets the phone bar.
  await postSubscription(session, 'https://unknown.example');
  assert.equal(push.listSubscriptions(sid).find((r) => r.endpoint === 'https://unknown.example').status_bar, null,
    'a silent subscription stores no width');

  // ---- One push, three device-specific bars ---------------------------
  deliveries.length = 0;
  push.sendPushToSession(sid, {
    title: 'Chat one',
    // The chat handler passes a resolver, not a fixed body, which is what
    // lets each device get its own bar width.
    bodyFor: (sub) => push.asciiStatusBar(40, push.statusBarSizeForMaxChars(sub && sub.status_bar)) + '\nFix push layout — 2 of 5',
    tag: 'chat-abcd1234-status',
    chatId: 'abcd1234',
    projectDir: '/tmp/project'
  });
  await new Promise((r) => setTimeout(r, 20));

  const bodies = new Map(deliveries.map((d) => [d.endpoint, d.payload.body]));
  assert.equal(deliveries.length, 4, 'every device got the push');
  assert.equal(bodies.get('https://phone.example'),
    '[##----] 40%\nFix push layout — 2 of 5', 'the phone body uses a 6-cell bar');
  assert.equal(bodies.get('https://tablet.example'),
    '[####------] 40%\nFix push layout — 2 of 5', 'the tablet body uses a 10-cell bar');
  assert.equal(bodies.get('https://desktop.example'),
    '[########------------] 40%\nFix push layout — 2 of 5', 'the desktop body uses a 20-cell bar');
  assert.equal(bodies.get('https://unknown.example'),
    '[##----] 40%\nFix push layout — 2 of 5', 'a device that reported no width gets the phone bar');

  // Every bar row stays on one line in its device's own body width, so the
  // info row is never pushed out of a collapsed preview.
  for (const [endpoint, width] of [['https://phone.example', 32], ['https://tablet.example', 60], ['https://desktop.example', 140]]) {
    const firstLine = bodies.get(endpoint).split('\n')[0];
    assert.ok(firstLine.length <= width, endpoint + ' bar row fits its ' + width + '-char body line');
  }

  // ---- A body with no info is the bar alone ---------------------------
  deliveries.length = 0;
  push.sendPushToSession(sid, {
    title: 'Chat one',
    bodyFor: (sub) => push.asciiStatusBar(null, push.statusBarSizeForMaxChars(sub && sub.status_bar)) + '\nError: upstream error',
    tag: 'chat-abcd1234-status',
    chatId: 'abcd1234',
    projectDir: '/tmp/project'
  });
  await new Promise((r) => setTimeout(r, 20));
  const errorBody = deliveries.find((d) => d.endpoint === 'https://tablet.example').payload.body;
  assert.equal(errorBody, '[----------]\nError: upstream error', 'an error keeps the bar shape but has no percentage');

  // ---- A push without a resolver sends one body everywhere ------------
  deliveries.length = 0;
  push.sendPushToSession(sid, { title: 'Authorization needed', body: 'shell is waiting for approval.', tag: 'chat-abcd1234-attention' });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(deliveries.length > 0, 'the attention push is delivered');
  assert.ok(deliveries.every((d) => d.payload.body === 'shell is waiting for approval.'),
    'a push with no resolver sends the same body to every device');

  console.log('status bar sizing: ' + deliveries.length + ' deliveries, all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
