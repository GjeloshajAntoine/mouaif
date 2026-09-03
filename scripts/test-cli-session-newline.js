// Regression test for the interactive CLI session's line terminator.
//
// The CLI modal spawns a persistent platform shell and POSTs each command
// line to /api/tools/cli/command, which the server writes to the child's
// stdin. It must terminate the line with LF on POSIX (sh/bash) and CRLF on
// Windows (cmd.exe) — writing CRLF to a POSIX shell makes the trailing \r
// part of the command token (e.g. `ls\r`), so bash reports
// `$'ls\r': command not found`. This test drives the real endpoint over the
// SSE channel and asserts that a plain `ls` lists files instead.
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// A temp project with a couple of known files so `ls` has deterministic output.
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-cli-session-'));
fs.writeFileSync(path.join(projDir, 'alpha.txt'), 'a\n');
fs.writeFileSync(path.join(projDir, 'beta.txt'), 'b\n');
fs.writeFileSync(path.join(projDir, '.mouaif.json'), JSON.stringify({ name: 'cli-session-test' }, null, 2) + '\n');

const settings = require('../src/settings.js');
settings.setProject(projDir, { chats: [], tools: { shell: { enabled: true, mode: 'allow' } } });

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
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      r.on('error', reject);
      if (body != null) r.write(JSON.stringify(body));
      r.end();
    });
  }

  // Open the SSE channel and collect `cli_output` frames for our session.
  function openSse(sessionId) {
    return new Promise((resolve, reject) => {
      const frames = [];
      let buf = '';
      const req = http.request({
        host: '127.0.0.1', port, method: 'GET', path: '/events'
      }, (res) => {
        res.on('data', (c) => {
          buf += c.toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            let data; try { data = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
            if (data && data.id === sessionId) frames.push(data);
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
      // Wait a short moment for frames to arrive, then close.
      setTimeout(() => { resolve(frames); req.destroy(); }, 1500);
    });
  }

  (async () => {
    try {
      const session = await req('GET', '/api/tools/cli/session?projectDir=' + encodeURIComponent(projDir));
      check('session created', session.status === 200 && !!session.body.id, 'HTTP ' + session.status);
      const sessionId = session.body.id;

      const sse = openSse(sessionId);

      // Small delay so the SSE subscription is live before the command runs.
      await new Promise((r) => setTimeout(r, 300));

      const cmd = await req('POST', '/api/tools/cli/command', { projectDir: projDir, cmd: 'ls' });
      check('command accepted', cmd.status === 200 && cmd.body.ok === true, 'HTTP ' + cmd.status);

      const frames = await sse;
      const output = frames
        .filter((f) => f.stream === 'stdout')
        .map((f) => f.data)
        .join('');

      check('output is not a command-not-found error', !/command not found/.test(output), JSON.stringify(output));
      check('output lists the project files', /alpha\.txt/.test(output) && /beta\.txt/.test(output), JSON.stringify(output));

      await req('POST', '/api/tools/cli/close', { projectDir: projDir });
    } catch (e) {
      failed++;
      console.log('FAIL  unexpected error  ' + ((e && e.stack) || e));
    } finally {
      server.close();
      console.log(passed + ' passed, ' + failed + ' failed');
      process.exit(failed ? 1 : 0);
    }
  })();
});
