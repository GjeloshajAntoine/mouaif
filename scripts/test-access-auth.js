'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-access-auth-'));
process.env.MOUAIF_HOME = home;

const access = require('../src/access-auth.js');
const settings = require('../src/settings.js');
const qr = require('../src/qr.js');
const { createServer } = require('../src/index.js');

async function main() {
  assert.equal(access.configured(), false);
  assert.throws(() => access.setPassword('alice', 'short'), { code: 'EBADPASSWORD' });
  access.setPassword('alice', 'correct-horse');
  const stableSession = access.issueSession();
  access.setPassword('alice', 'correct-horse');
  assert.equal(!!access.session(stableSession.token), true);
  assert.equal(access.verifyPassword('alice', 'correct-horse'), true);
  assert.equal(access.verifyPassword('alice', 'wrong-password'), false);

  const setup = access.createSetupCode();
  assert.match(setup.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(access.setupCodeValid(setup.code.toLowerCase()), true);

  const server = createServer(0, { authEnabled: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let csrfCookie = '';
  try {
    const page = await fetch(origin + '/web/');
    csrfCookie = String(page.headers.get('set-cookie') || '').split(';')[0];

    const blocked = await fetch(origin + '/api/settings', { headers: { Origin: origin, Cookie: csrfCookie } });
    assert.equal(blocked.status, 401);

    const bad = await fetch(origin + '/api/access/login', {
      method: 'POST', headers: { Origin: origin, Cookie: csrfCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'bad-password' })
    });
    assert.equal(bad.status, 401);

    const login = await fetch(origin + '/api/access/login', {
      method: 'POST', headers: { Origin: origin, Cookie: csrfCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'correct-horse' })
    });
    assert.equal(login.status, 200);
    const accessCookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    assert.match(accessCookie, /^mouaif_access=/);

    const allowed = await fetch(origin + '/api/settings', { headers: { Origin: origin, Cookie: csrfCookie + '; ' + accessCookie } });
    assert.equal(allowed.status, 200);

    const basic = Buffer.from('alice:correct-horse').toString('base64');
    const cli = await fetch(origin + '/api/settings', { headers: { Authorization: 'Basic ' + basic } });
    assert.equal(cli.status, 200);

    const qrResponse = await fetch(origin + '/api/access/setup/qr?code=' + encodeURIComponent(setup.code), {
      headers: { Origin: origin, Cookie: csrfCookie }
    });
    assert.equal(qrResponse.status, 200);
    assert.match(await qrResponse.text(), /^<svg[^>]+/);

    const replace = await fetch(origin + '/api/access/setup', {
      method: 'POST', headers: { Origin: origin, Cookie: csrfCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: setup.code, username: 'bob', password: 'new-password' })
    });
    assert.equal(replace.status, 200);
    assert.equal(access.setupCodeValid(setup.code), false);
      assert.equal(access.verifyPassword('bob', 'new-password'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const openServer = createServer(0);
  await new Promise((resolve) => openServer.listen(0, '127.0.0.1', resolve));
  const openOrigin = 'http://127.0.0.1:' + openServer.address().port;
  try {
    const page = await fetch(openOrigin + '/web/');
    const cookie = String(page.headers.get('set-cookie') || '').split(';')[0];
    const status = await fetch(openOrigin + '/api/access/status', { headers: { Origin: openOrigin, Cookie: cookie } });
    assert.deepEqual(await status.json(), { enabled: false, configured: true, user: 'bob', passkeyCount: 0, authenticated: true });
    const allowed = await fetch(openOrigin + '/api/settings', { headers: { Origin: openOrigin, Cookie: cookie } });
    assert.equal(allowed.status, 200);
  } finally {
    await new Promise((resolve) => openServer.close(resolve));
    settings.close();
    fs.rmSync(home, { recursive: true, force: true });
  }

  assert.equal(qr.makeMatrix('https://example.test/web/#/setup?code=ABCD-2345').length >= 21, true);
  console.log('access auth: 20 assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
