'use strict';
// Live-server smoke test for the direct user-facing webpreview refresh
// endpoint (POST /api/tools/webpreview). Stands up an in-process server on an
// ephemeral port and exercises the validation + authorization gates that
// return before the tool ever opens a debug tab (so no Chrome is needed):
//   1. missing url            -> 400
//   2. unknown chat           -> 404
//   3. tool disabled ('off')  -> 403 ETOOL_DISABLED
//   4. 'ask' mode, no grant   -> 409 EAUTH_REQUIRED
//
// The actual capture path (which needs the debug Chrome + MOUAIF_CHROME_URL)
// is covered by the unit test in test-webpreview-viewport.js and the model
// path, so this test deliberately stops short of the CDP round-trip.

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Isolate the app store before requiring any src module.
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-wp-'));
process.env.MOUAIF_HOME = path.join(d, 'home');

const projDir = path.join(d, 'proj');
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, '.mouaif.json'), JSON.stringify({ name: 'wp-test' }, null, 2) + '\n');

const { createServer } = require('../src/index.js');
const chats = require('../src/chats.js');

const server = createServer(0);
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log('listening on', port);

  function req(method, url, body) {
    return new Promise((resolve, reject) => {
      const opts = { host: '127.0.0.1', port, method, path: url, headers: { 'Content-Type': 'application/json' } };
      const r = http.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      r.on('error', reject);
      if (body != null) r.write(JSON.stringify(body));
      r.end();
    });
  }

  (async () => {
    try {
      const chat = chats.createChat(projDir, { title: 'WP' });
      const chatId = chat.id;

      // 1. Missing url -> 400
      const r0 = await req('POST', '/api/tools/webpreview', { projectDir: projDir, chatId });
      console.log('missing url ->', r0.status);
      if (r0.status !== 400) throw new Error('missing url should be 400, got ' + r0.status);

      // 2. Unknown chat -> 404
      const r1 = await req('POST', '/api/tools/webpreview', { projectDir: projDir, chatId: 'nope', url: 'https://example.com' });
      console.log('unknown chat ->', r1.status);
      if (r1.status !== 404) throw new Error('unknown chat should be 404, got ' + r1.status);

      // Configure the tool disabled. The persisted shape is
      // project.tools.webpreview.mode.
      const settings = require('../src/settings.js');
      settings.setProject(projDir, { tools: { webpreview: { mode: 'off' } } });

      // 3. Disabled -> 403 ETOOL_DISABLED
      const r2 = await req('POST', '/api/tools/webpreview', { projectDir: projDir, chatId, url: 'https://example.com' });
      console.log('disabled ->', r2.status, r2.body && r2.body.code);
      if (r2.status !== 403 || r2.body.code !== 'ETOOL_DISABLED') {
        throw new Error('disabled should be 403 ETOOL_DISABLED, got ' + r2.status + ' ' + (r2.body && r2.body.code));
      }

      // Configure ask mode -> the gate prompts.
      settings.setProject(projDir, { tools: { webpreview: { mode: 'ask' } } });
      const r3 = await req('POST', '/api/tools/webpreview', { projectDir: projDir, chatId, url: 'https://example.com' });
      console.log('ask ->', r3.status, r3.body && r3.body.code, 'callId auto-gen', !!(r3.body && r3.body.callId));
      if (r3.status !== 409 || r3.body.code !== 'EAUTH_REQUIRED') {
        throw new Error('ask should be 409 EAUTH_REQUIRED, got ' + r3.status + ' ' + (r3.body && r3.body.code));
      }
      if (!r3.body.callId) throw new Error('ask prompt should include an auto-generated callId');

      console.log('OK');
      server.close();
      fs.rmSync(d, { recursive: true, force: true });
      process.exit(0);
    } catch (e) {
      console.error('FAIL:', e && (e.stack || e.message));
      server.close();
      fs.rmSync(d, { recursive: true, force: true });
      process.exit(1);
    }
  })();
});
