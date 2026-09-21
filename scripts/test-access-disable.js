'use strict';

// Coverage for turning app access off and back on from inside the app:
//   - a signed-in browser mints a single-use disable code and its QR;
//   - the confirmation endpoint is reachable without a session (the code is
//     the proof, which is what makes disabling possible on a second device);
//   - disabling takes effect immediately for the running worker, not only
//     after a restart;
//   - protection can be turned back on from the signed-out screen with the
//     account password, so a forgotten password is recoverable;
//   - the state change broadcasts a notification to every subscribed device.
//
// The worker is started with `authEnabled: true` while the store already says
// "disabled", which is the case a restart after an in-app disable produces.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-access-disable-'));
process.env.MOUAIF_HOME = home;

// ---- Recorder web-push (must be installed before push.js loads) --------
const webpush = require('web-push');
const deliveries = [];
webpush.setVapidDetails = () => {};
webpush.sendNotification = (subscription, payload) => {
  deliveries.push({ subscription, payload: JSON.parse(payload) });
  return Promise.resolve();
};

const access = require('../src/access-auth.js');
const push = require('../src/push.js');
const settings = require('../src/settings.js');
const { createServer } = require('../src/index.js');

async function main() {
  push.ensureTable();
  push.ensureVapidKeys();
  push.addSubscription({ sessionId: 'phone', endpoint: 'https://push.test/phone', p256dh: 'p', auth: 'a', origin: 'https://mouaif.test' });

  access.setPassword('alice', 'correct-horse');
  const session = access.issueSession();
  const goodCookie = 'mouaif_access=' + session.token;

  // A fresh store is armed-on by default; the explicit state flips it off.
  assert.equal(access.disabled(), false, 'a store that never disabled access is not disabled');
  assert.equal(access.effectiveEnabled(true), true, 'the process flag arms the gate');
  access.setEnabled(false);
  assert.equal(access.disabled(), true, 'the disable switch persists');
  assert.equal(access.effectiveEnabled(true), false, 'the store overrides the process flag');
  access.setEnabled(true);
  assert.equal(access.effectiveEnabled(true), true, 'turning it back on re-arms the gate');
  access.setEnabled(false);

  // The worker is told auth is on; the store says otherwise, so it must serve
  // without a login — the same state a restart after an in-app disable hits.
  const server = createServer(0, { authEnabled: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    const page = await fetch(origin + '/');
    const csrfCookie = String(page.headers.get('set-cookie') || '').split(';')[0];

    const status = await fetch(origin + '/api/access/status', { headers: { Origin: origin, Cookie: csrfCookie } });
    const statusBody = await status.json();
    assert.equal(statusBody.enabled, false, 'a store-disabled worker reports access as off');
    assert.equal(statusBody.disabled, true, 'the status names the in-app switch');
    assert.equal(statusBody.armed, true, 'the status remembers that the process was armed');
    assert.equal(statusBody.authenticated, true, 'no session is needed while access is off');

    const open = await fetch(origin + '/api/settings', { headers: { Origin: origin, Cookie: csrfCookie } });
    assert.equal(open.status, 200, 'app data is reachable while access is off');

    // Turn it back on with no session: the password is accepted as proof.
    access.setEnabled(true);
    const armedStatus = await fetch(origin + '/api/access/status', { headers: { Origin: origin, Cookie: csrfCookie } });
    const armedBody = await armedStatus.json();
    assert.equal(armedBody.enabled, true, 're-enabling the store re-arms the gate immediately');
    assert.equal(armedBody.session, false, 'that request carried no session');

    const blocked = await fetch(origin + '/api/settings', { headers: { Origin: origin, Cookie: csrfCookie } });
    assert.equal(blocked.status, 401, 'the same worker now requires a session');

    // ---- Mint a disable code (signed-in only) -------------------------
    const anonymousCode = await fetch(origin + '/api/access/disable/code', {
      method: 'POST', headers: { Origin: origin, Cookie: csrfCookie }
    });
    assert.equal(anonymousCode.status, 401, 'a disable code requires a signed-in session');

    const minted = await fetch(origin + '/api/access/disable/code', {
      method: 'POST', headers: { Origin: origin, Cookie: csrfCookie + '; ' + goodCookie }
    });
    assert.equal(minted.status, 200);
    const mintedBody = await minted.json();
    assert.match(mintedBody.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'the disable code has the shared short-code shape');
    assert.equal(access.disableCodeValid(mintedBody.code), true);
    assert.equal(access.disableCodeValid('ZZZZ-9999'), false, 'an unrelated code is not a disable code');
    assert.equal(access.setupCodeValid(mintedBody.code), false, 'a disable code is not accepted as a setup code');

    const qrResponse = await fetch(origin + '/api/access/disable/qr?code=' + encodeURIComponent(mintedBody.code), {
      headers: { Origin: origin, Cookie: csrfCookie + '; ' + goodCookie }
    });
    assert.equal(qrResponse.status, 200);
    const qrSvg = await qrResponse.text();
    assert.match(qrSvg, /^<svg[^>]+/, 'the disable QR is an SVG');

    const anonymousQr = await fetch(origin + '/api/access/disable/qr?code=' + encodeURIComponent(mintedBody.code), {
      headers: { Origin: origin, Cookie: csrfCookie }
    });
    assert.equal(anonymousQr.status, 401, 'the QR is not served before sign-in');
    const wrongQr = await fetch(origin + '/api/access/disable/qr?code=ZZZZ-9999', {
      headers: { Origin: origin, Cookie: csrfCookie + '; ' + goodCookie }
    });
    assert.equal(wrongQr.status, 404, 'the QR is not rendered for an unknown code');

    // ---- Use the code from a device with no session -------------------
    const badDisable = await fetch(origin + '/api/access/disable', {
    method: 'POST', headers: { Origin: origin, Cookie: csrfCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'ZZZZ-9999' })
    });
    assert.equal(badDisable.status, 401, 'an invalid code cannot turn access off');
    assert.equal(access.disabled(), false, 'a rejected code leaves access on');

    deliveries.length = 0;
    const disabled = await fetch(origin + '/api/access/disable', {
      method: 'POST', headers: { Origin: origin, Cookie: csrfCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: mintedBody.code })
    });
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).enabled, false);
    assert.equal(access.disabled(), true, 'the confirmation page turns access off');

    const afterDisable = await fetch(origin + '/api/settings', { headers: { Origin: origin, Cookie: csrfCookie } });
    assert.equal(afterDisable.status, 200, 'disabling takes effect without a restart');

    const consumed = await fetch(origin + '/api/access/disable', {
      method: 'POST', headers: { Origin: origin, Cookie: csrfCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: mintedBody.code })
    });
    assert.equal(consumed.status, 401, 'a disable code is single use');

    assert.equal(deliveries.length, 1, 'disabling broadcasts one notification');
    assert.equal(deliveries[0].payload.tag, 'mouaif-access');
    assert.equal(deliveries[0].payload.data.kind, 'login', 'the notification honours the sign-in alert channel');
    assert.match(deliveries[0].payload.body, /access is off/i);

    // ---- Turn it back on from the signed-out screen -------------------
    const noProof = await fetch(origin + '/api/access/enable', {
      method: 'POST', headers: { Origin: origin, Cookie: csrfCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(noProof.status, 401, 'enabling needs a session, password, or setup code');

    const wrongPassword = await fetch(origin + '/api/access/enable', {
      method: 'POST', headers: { Origin: origin, Cookie: csrfCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'nope' })
    });
    assert.equal(wrongPassword.status, 401, 'a wrong password does not re-arm access');

    deliveries.length = 0;
    const reEnabled = await fetch(origin + '/api/access/enable', {
      method: 'POST', headers: { Origin: origin, Cookie: csrfCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'correct-horse' })
    });
    assert.equal(reEnabled.status, 200);
    assert.equal(access.effectiveEnabled(true), true, 'the password re-arms the gate');
    assert.equal(deliveries.length, 1, 're-enabling broadcasts one notification');
    assert.match(deliveries[0].payload.body, /protection is on again/i);

    const reBlocked = await fetch(origin + '/api/settings', { headers: { Origin: origin, Cookie: csrfCookie } });
    assert.equal(reBlocked.status, 401, 'protection is enforced again');

    // The session that minted the code survived the round trip, so the
    // device that disabled access can still operate without signing in.
    const stillSignedIn = await fetch(origin + '/api/settings', {
      headers: { Origin: origin, Cookie: csrfCookie + '; ' + goodCookie }
    });
    assert.equal(stillSignedIn.status, 200, 'the disabling device keeps its session');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    settings.close();
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log('access disable: assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
