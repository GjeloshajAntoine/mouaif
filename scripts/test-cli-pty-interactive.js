// Regression test for the CLI modal's pseudo-terminal session.
//
// The CLI modal used to spawn its persistent shell with piped stdio
// (`stdio: ['pipe', ...]`). A child on a pipe is not a TTY, so any program
// that asks a question fails: `read` returns an empty answer immediately
// (stdin is at EOF), and `npm publish` under 2FA answers `EOTP` with a
// redacted auth URL instead of prompting for a one-time password. The
// symptom the user reported was publishing from the modal printing
// `https://www.npmjs.com/auth/cli/***`.
//
// The session now runs on a node-pty pseudo-terminal, so the question
// reaches the screen and the answer typed into the modal's prompt line is
// delivered to the still-running child. This test drives the real HTTP
// endpoints and asserts the round trip:
//
//   1. the session reports itself interactive (a PTY was allocated);
//   2. a program that prompts can see the question on its stdout;
//   3. the answer POSTed to /api/tools/cli/command is read back by it.
//
// It skips (exit 0) when node-pty is unavailable, because that install is
// the documented degraded mode, not a failure.

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

let ptyAvailable = true;
try { require('node-pty'); } catch { ptyAvailable = false; }

if (!ptyAvailable) {
  console.log('SKIP  node-pty is not installed — piped fallback documented in docs/features/cli-modal.md');
  process.exit(0);
}

const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-cli-pty-'));
// A tiny program that asks a question and echoes the answer. It only proves
// the point if stdin is a TTY: the same script under a pipe reads EOF and
// prints an empty answer, which is exactly the old behaviour.
fs.writeFileSync(
  path.join(projDir, 'ask.sh'),
  '#!/bin/bash\n' +
  'read -r -p "OTP: " code\n' +
  'echo "ANSWER=[$code]"\n'
);
fs.chmodSync(path.join(projDir, 'ask.sh'), 0o755);

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

  // Collect cli_output frames for the session over a window, in the
  // background, so the assertion can run against the accumulated screen.
  function collect(sessionId, ms) {
    const frames = [];
    let buf = '';
    const req2 = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/events' }, (res) => {
      res.on('data', (c) => {
        buf += c.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = block.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let data; try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (data && data.id === sessionId) frames.push(data);
        }
      });
      res.on('error', () => {});
    });
    req2.on('error', () => {});
    req2.end();
    return new Promise((resolve) => setTimeout(() => { try { req2.destroy(); } catch {} resolve(frames); }, ms));
  }

  (async () => {
    try {
      const session = await req('GET', '/api/tools/cli/session?projectDir=' + encodeURIComponent(projDir));
      check('session created', session.status === 200 && !!session.body.id, 'HTTP ' + session.status);
      check('session reports interactive (PTY allocated)', session.body.interactive === true, JSON.stringify(session.body));
      const sessionId = session.body.id;

      const collecting = collect(sessionId, 2600);
      await new Promise((r) => setTimeout(r, 300));

      // Ask the question by running the script that prompts.
      await req('POST', '/api/tools/cli/command', { projectDir: projDir, cmd: './ask.sh' });
      await new Promise((r) => setTimeout(r, 700));

      // Answer it through the same endpoint a typed line uses.
      const answer = await req('POST', '/api/tools/cli/command', { projectDir: projDir, cmd: '424242' });

      const frames = await collecting;
      const output = frames.filter((f) => f.stream === 'stdout').map((f) => f.data).join('');

      check('prompt reached the screen', /OTP:/.test(output), JSON.stringify(output.slice(0, 300)));
      check('answer was read by the prompting child', /ANSWER=\[424242\]/.test(output), JSON.stringify(output.slice(-300)));
      check('answer command accepted', answer.status === 200 && answer.body.ok === true, 'HTTP ' + answer.status);

      await req('POST', '/api/tools/cli/close', { projectDir: projDir });
      console.log('\n' + passed + ' passed, ' + failed + ' failed');
      server.close();
      process.exit(failed ? 1 : 0);
    } catch (err) {
      console.log('FAIL  unexpected error: ' + (err && err.stack || err));
      server.close();
      process.exit(1);
    }
  })();
});