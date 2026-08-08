'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-security-'));
process.env.MOUAIF_HOME = home;

const messages = require('../src/messages.js');
const trace = require('../src/trace.js');
const serverModule = require('../src/index.js');
const accessAuth = require('../src/access-auth.js');
const { createServer } = serverModule;

async function login(origin, csrfCookie, publicOrigin = origin) {
  const response = await fetch(origin + '/api/access/login', {
    method: 'POST',
    headers: { Origin: publicOrigin, Cookie: csrfCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'security', password: 'security-password' })
  });
  assert.equal(response.status, 200);
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

async function main() {
  accessAuth.setPassword('security', 'security-password');
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-project-'));
  assert.throws(() => messages.messagesFilePath(projectDir, '../../escape'), { code: 'EBADINPUT' });
  assert.throws(() => trace.traceFilePath(projectDir, '/../../escape'), { code: 'EBADINPUT' });
  assert.equal(path.dirname(messages.messagesFilePath(projectDir, 'a1b2c3d4')), projectDir);
  assert.equal(path.dirname(trace.traceFilePath(projectDir, 'a1b2c3d4')), path.join(projectDir, '.mouaif', 'traces'));

  const server = createServer(0, { authEnabled: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const ownOrigin = 'http://127.0.0.1:' + port;
  try {
    const hostile = await fetch(ownOrigin + '/api/settings', { headers: { Origin: 'https://evil.example' } });
    assert.equal(hostile.status, 403);

    const noSession = await fetch(ownOrigin + '/api/settings', { headers: { Origin: ownOrigin } });
    assert.equal(noSession.status, 401);

    const page = await fetch(ownOrigin + '/');
    assert.equal(page.status, 200);
    const cookie = String(page.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^mouaif_session=/);
    const userCookie = await login(ownOrigin, cookie);

    const allowed = await fetch(ownOrigin + '/api/settings', {
      headers: { Origin: ownOrigin, Cookie: cookie + '; ' + userCookie }
    });
    assert.equal(allowed.status, 200);

    const basic = Buffer.from('security:security-password').toString('base64');
    const localClient = await fetch(ownOrigin + '/api/settings', { headers: { Authorization: 'Basic ' + basic } });
    assert.equal(localClient.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const publicOrigin = 'https://mouaif.example.test';
  const proxiedServer = createServer(0, { publicOrigin, authEnabled: true });
  await new Promise((resolve) => proxiedServer.listen(0, '127.0.0.1', resolve));
  const proxiedAddress = 'http://127.0.0.1:' + proxiedServer.address().port;
  try {
    const page = await fetch(proxiedAddress + '/');
    const setCookie = String(page.headers.get('set-cookie') || '');
    assert.match(setCookie, /; Secure(?:;|$)/, 'public HTTPS origin produces a Secure session cookie');
    const cookie = setCookie.split(';')[0];
    const userCookie = await login(proxiedAddress, cookie, publicOrigin);
    const cookies = cookie + '; ' + userCookie;

    const wrongScheme = await fetch(proxiedAddress + '/api/push/config', {
      headers: { Origin: 'http://mouaif.example.test', Cookie: cookies }
    });
    assert.equal(wrongScheme.status, 403, 'public origin requires the configured HTTPS scheme');

    const config = await fetch(proxiedAddress + '/api/push/config', {
      headers: { Origin: publicOrigin, Cookie: cookies }
    });
    assert.equal(config.status, 200, 'configured public origin is accepted behind a proxy');
    const configBody = await config.json();
    assert.equal(configBody.origin, publicOrigin, 'push config reports the served public origin');
    assert.equal(configBody.subject, publicOrigin, 'VAPID contact adapts to the served domain');
    assert.equal(configBody.privateKeyConfigured, true, 'notification settings ensure a private VAPID key exists');
    assert.equal(Object.hasOwn(configBody, 'privateKey'), false, 'private VAPID key is never returned');

    const subscribe = await fetch(proxiedAddress + '/api/push/subscribe', {
      method: 'POST',
      headers: { Origin: publicOrigin, Cookie: cookies, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: 'https://spoofed.example',
        subscription: { endpoint: 'https://push.example/sub', keys: { p256dh: 'key', auth: 'auth' } }
      })
    });
    assert.equal(subscribe.status, 200, 'subscription accepts the configured public origin');
    const subscriptions = await fetch(proxiedAddress + '/api/push/subscriptions', {
      headers: { Origin: publicOrigin, Cookie: cookies }
    });
    const subscriptionsBody = await subscriptions.json();
    assert.equal(subscriptionsBody.subscriptions[0].origin, publicOrigin, 'subscription origin is derived by the server, not request JSON');
  } finally {
    await new Promise((resolve) => proxiedServer.close(resolve));
    serverModule.settings.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
  assert.throws(() => createServer(0, { publicOrigin: 'https://example.test/path' }), { code: 'EBAD_PUBLIC_ORIGIN' });
  console.log('security boundary: 19 assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});