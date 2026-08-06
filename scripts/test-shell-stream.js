// Live-server test for POST /api/tools/shell streaming. Stands up an
// in-process server on an ephemeral port and verifies that a direct
// /shell run answers with an NDJSON stream: `output` frames arrive
// while the command is still running, a final `result` frame carries
// the complete tool result, and the pre-run authorization gate still
// answers plain JSON (409 EAUTH_REQUIRED in ask mode).
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-shellstream-'));
fs.writeFileSync(path.join(projDir, '.mouaif.json'), JSON.stringify({ name: 'shell-stream-test' }, null, 2) + '\n');

const settings = require('../src/settings.js');
// Allow mode for the streaming part of the test.
settings.setProject(projDir, {
  chats: [],
  tools: { shell: { enabled: true, mode: 'allow' }, subagent: { enabled: true, mode: 'allow' }, file: { enabled: true, mode: 'allow' } }
});

const { createServer } = require('../src/index.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

const server = createServer(0);
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log('listening on', port);

  function req(method, url, body) {
    return new Promise((resolve, reject) => {
      const r = http.request({
        host: '127.0.0.1', port, method, path: url,
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
          resolve({ status: res.statusCode, ct: res.headers['content-type'], body: parsed });
        });
      });
      r.on('error', reject);
      if (body != null) r.write(JSON.stringify(body));
      r.end();
    });
  }

  // Streamed read: parse NDJSON lines as they arrive and record the
  // order of `output` vs `result` frames.
  function reqShellStream(payload) {
    return new Promise((resolve, reject) => {
      const frames = [];
      let buf = '';
      const r = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/tools/shell',
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        res.on('data', (c) => {
          buf += c.toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
            if (!line) continue;
            let frame; try { frame = JSON.parse(line); } catch { frame = { raw: line }; }
            frames.push(frame);
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'], frames }));
      });
      r.on('error', reject);
      r.write(JSON.stringify(payload));
      r.end();
    });
  }

  (async () => {
    try {
      const c = await req('POST', '/api/chats', { projectDir: projDir, title: 'S1' });
      check('chat created', c.status === 201 && !!c.body.chat.id, 'HTTP ' + c.status);
      const chatId = c.body.chat.id;
      const callId = 'direct_stream_test';

      // 1. Streaming run: a command that emits two lines with a pause
      // between them. The first `output` frame must arrive before the
      // final `result` frame, and the result must carry the full text.
      const out = await reqShellStream({
        projectDir: projDir, chatId, callId,
        cmd: process.platform === 'win32' ? 'echo first-line & ping -n 2 127.0.0.1 >nul & echo second-line' : 'echo first-line; sleep 0.4; echo second-line'
      });
      const types = out.frames.map((f) => f.type);
      const outputIdx = types.indexOf('output');
      const resultIdx = types.indexOf('result');
      check('ndjson content type', out.status === 200 && String(out.ct).includes('ndjson'), out.status + ' ' + out.ct);
      check('output frames precede result', outputIdx >= 0 && resultIdx > outputIdx, JSON.stringify(types));
      check('first frame is stdout first-line', out.frames[outputIdx] && out.frames[outputIdx].stream === 'stdout' && /first-line/.test(out.frames[outputIdx].delta || ''), JSON.stringify(out.frames[outputIdx]));
      const res = out.frames[resultIdx] && out.frames[resultIdx].result;
      check('result ok with full stdout', !!(res && res.ok === true && /first-line[\s\S]*second-line/.test(res.stdout || '')), JSON.stringify(res));
      check('result carries identity', !!(res && res.identity), res && res.identity);

      // 2. Ask mode: the pre-run gate still answers plain JSON 409, so
      // the composer can show its authorization card.
      settings.setProject(projDir, {
        chats: [],
        tools: { shell: { enabled: true, mode: 'ask' }, subagent: { enabled: true, mode: 'ask' }, file: { enabled: true, mode: 'ask' } }
      });
      const denied = await req('POST', '/api/tools/shell', {
        projectDir: projDir, chatId, callId: 'direct_gate_test', cmd: 'echo hi'
      });
      check('ask-mode gate is JSON 409 EAUTH_REQUIRED', denied.status === 409 && String(denied.ct).includes('json') && denied.body.code === 'EAUTH_REQUIRED', denied.status + ' ' + denied.ct);
    } catch (e) {
      failed++;
      console.log('FAIL  unexpected error  ' + (e && e.stack || e));
    } finally {
      server.close();
      console.log(passed + ' passed, ' + failed + ' failed');
      process.exit(failed ? 1 : 0);
    }
  })();
});
