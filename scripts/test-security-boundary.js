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
const { createServer } = serverModule;

async function main() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-project-'));
  assert.throws(() => messages.messagesFilePath(projectDir, '../../escape'), { code: 'EBADINPUT' });
  assert.throws(() => trace.traceFilePath(projectDir, '/../../escape'), { code: 'EBADINPUT' });
  assert.equal(path.dirname(messages.messagesFilePath(projectDir, 'a1b2c3d4')), projectDir);
  assert.equal(path.dirname(trace.traceFilePath(projectDir, 'a1b2c3d4')), path.join(projectDir, '.mouaif', 'traces'));

  const server = createServer(0);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const ownOrigin = 'http://127.0.0.1:' + port;
  try {
    const hostile = await fetch(ownOrigin + '/api/settings', { headers: { Origin: 'https://evil.example' } });
    assert.equal(hostile.status, 403);

    const noSession = await fetch(ownOrigin + '/api/settings', { headers: { Origin: ownOrigin } });
    assert.equal(noSession.status, 401);

    const page = await fetch(ownOrigin + '/web/');
    assert.equal(page.status, 200);
    const cookie = String(page.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^mouaif_session=/);

    const allowed = await fetch(ownOrigin + '/api/settings', {
      headers: { Origin: ownOrigin, Cookie: cookie }
    });
    assert.equal(allowed.status, 200);

    const localClient = await fetch(ownOrigin + '/api/settings');
    assert.equal(localClient.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    serverModule.settings.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log('security boundary: 9 assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});