// Live-server smoke test for /api/tools/list and the per-chat
// tools PATCH flow. Stands up an in-process server on an
// ephemeral port, then exercises the routes the chat UI will
// hit when a user toggles a tool chip on a brand-new chat.
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-tl-'));

// Minimal .mouaif.json so the project is discoverable.
fs.writeFileSync(path.join(projDir, '.mouaif.json'), JSON.stringify({ name: 'tools-test' }, null, 2) + '\n');

const { createServer } = require('../src/index.js');

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
      // 1. List the catalog.
      const r1 = await req('GET', '/api/tools/list?projectDir=' + encodeURIComponent(projDir));
      console.log('GET /api/tools/list ->', r1.status, JSON.stringify(r1.body, null, 2));
      if (r1.status !== 200) throw new Error('list failed: HTTP ' + r1.status);
      const names = r1.body.tools.map((t) => t.name);
      for (const expected of ['shell', 'subagent', 'read_file', 'list_files', 'search_files', 'write_file', 'edit_file']) {
        if (names.indexOf(expected) < 0) throw new Error('missing tool: ' + expected);
      }

      // 2. Create a chat.
      const r2 = await req('POST', '/api/chats', { projectDir: projDir, title: 'T1' });
      console.log('POST /api/chats ->', r2.status, JSON.stringify(r2.body, null, 2));
      if (r2.status !== 201) throw new Error('create failed: HTTP ' + r2.status);
      const chatId = r2.body.chat.id;

      // 3. PATCH the chat with a tools filter.
      const r3 = await req('PATCH', '/api/chats/' + chatId, { projectDir: projDir, tools: ['shell', 'read_file'] });
      console.log('PATCH tools ->', r3.status, JSON.stringify(r3.body, null, 2));
      if (r3.status !== 200) throw new Error('patch failed: HTTP ' + r3.status);
      if (JSON.stringify(r3.body.chat.tools) !== JSON.stringify(['shell', 'read_file'])) {
        throw new Error('PATCH did not round-trip the tools filter');
      }

      // 4. GET the chat to confirm persistence.
      const r4 = await req('GET', '/api/chats/' + chatId + '?projectDir=' + encodeURIComponent(projDir));
      console.log('GET /api/chats/:id ->', r4.status, JSON.stringify(r4.body, null, 2));
      if (r4.status !== 200) throw new Error('get failed: HTTP ' + r4.status);
      if (JSON.stringify(r4.body.chat.tools) !== JSON.stringify(['shell', 'read_file'])) {
        throw new Error('persisted tools do not match PATCH body');
      }

      // 5. Empty array (explicitly no tools).
      const r5 = await req('PATCH', '/api/chats/' + chatId, { projectDir: projDir, tools: [] });
      if (r5.status !== 200) throw new Error('empty patch failed: HTTP ' + r5.status);
      if (JSON.stringify(r5.body.chat.tools) !== JSON.stringify([])) {
        throw new Error('empty array did not round-trip');
      }
      console.log('PATCH tools=[] ->', JSON.stringify(r5.body.chat.tools));

      // 6. Null means "all tools" (no restriction), so it round-trips as null.
      const r6 = await req('PATCH', '/api/chats/' + chatId, { projectDir: projDir, tools: null });
      if (r6.status !== 200) throw new Error('null patch failed: HTTP ' + r6.status);
      if (r6.body.chat.tools !== null) {
        throw new Error('null should round-trip as null (all tools)');
      }
      console.log('PATCH tools=null ->', JSON.stringify(r6.body.chat.tools));

      // 7. Bad shape must preserve previous value (which is null from step 6).
      const r7 = await req('PATCH', '/api/chats/' + chatId, { projectDir: projDir, tools: 'shell' });
      if (r7.status !== 200) throw new Error('bad-shape patch should not 500: HTTP ' + r7.status);
      if (r7.body.chat.tools !== null) {
        throw new Error('bad shape should preserve previous tools (null)');
      }
      console.log('PATCH bad shape preserved previous ->', JSON.stringify(r7.body.chat.tools));

      // 8. Confirm GET reflects it.
      const r8 = await req('GET', '/api/chats/' + chatId + '?projectDir=' + encodeURIComponent(projDir));
      if (r8.status !== 200) throw new Error('post-bad-shape get failed: HTTP ' + r8.status);
      console.log('GET after bad-shape ->', JSON.stringify(r8.body.chat.tools));

      console.log('OK');
      server.close();
      fs.rmSync(projDir, { recursive: true, force: true });
      process.exit(0);
    } catch (e) {
      console.error('FAIL:', e && e.stack || e);
      server.close();
      fs.rmSync(projDir, { recursive: true, force: true });
      process.exit(1);
    }
  })();
});
