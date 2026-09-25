// Background terminal: the CLI session outlives the modal and a reopening
// client replays what it missed (docs/features/background-terminal.md).
//
// Unit half: the ring buffer keeps seq order, evicts from the front once the
// byte cap is exceeded, and reports a dropped prefix to a caller that asks
// from before the retained window.
//
// HTTP half: a real session keeps running with no SSE client attached,
// GET /api/tools/cli/output replays its output with seq tags,
// GET /api/tools/cli/sessions lists it as running, and POST /cli/close (the
// explicit Stop) removes it.
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-cli-bg-'));
fs.writeFileSync(path.join(projDir, '.mouaif.json'), JSON.stringify({ name: 'cli-bg-test' }, null, 2) + '\n');

const settings = require('../src/settings.js');
settings.setProject(projDir, { chats: [], tools: { shell: { enabled: true, mode: 'allow' } } });

const tools = require('../src/server-handlers-tools.js');
const { createServer } = require('../src/index.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

// ---- unit: ring buffer ------------------------------------------------------
{
  const s = {};
  for (let i = 1; i <= 5; i++) tools.bufferCliChunk(s, 'stdout', 'c' + i);
  const all = tools.readCliBuffer(s, 0);
  check('seq increases per chunk', all.chunks.map((c) => c.seq).join(',') === '1,2,3,4,5');
  check('replay keeps order', all.chunks.map((c) => c.data).join('') === 'c1c2c3c4c5');
  check('nothing dropped yet', all.dropped === false);
  const tail = tools.readCliBuffer(s, 3);
  check('since is exclusive', tail.chunks.map((c) => c.seq).join(',') === '4,5');
  check('since at head returns nothing', tools.readCliBuffer(s, 5).chunks.length === 0);

  // Force eviction with a tiny cap.
  s.output.cap = 6;
  tools.bufferCliChunk(s, 'stdout', 'xyz'); // seq 6
  const after = tools.readCliBuffer(s, 0);
  check('ring stays within cap', after.bytes <= 6, 'bytes=' + after.bytes);
  check('oldest chunks evicted first', after.chunks[0].seq > 1 && after.chunks[after.chunks.length - 1].seq === 6);
  check('dropped prefix is reported from 0', after.dropped === true);
  check('no drop reported for a caller already past the window', tools.readCliBuffer(s, after.chunks[0].seq - 1).dropped === false);

  const big = {};
  tools.bufferCliChunk(big, 'stdout', 'a');
  big.output.cap = 4;
  tools.bufferCliChunk(big, 'stdout', 'x'.repeat(50));
  const b = tools.readCliBuffer(big, 0);
  check('an oversized single chunk is kept', b.chunks.length === 1 && b.chunks[0].data.length === 50);
}

// ---- http: detach, replay, stop --------------------------------------------
const server = createServer(0);
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  function req(method, url, body) {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { 'Content-Type': 'application/json' } }, (res) => {
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    try {
      const s1 = await req('GET', '/api/tools/cli/session?projectDir=' + encodeURIComponent(projDir));
      check('session created', s1.status === 200 && !!s1.body.id, 'HTTP ' + s1.status);
      check('session reports a seq', typeof s1.body.seq === 'number');
      const id = s1.body.id;

      // No SSE client is attached: output must still be captured.
      await req('POST', '/api/tools/cli/command', { projectDir: projDir, cmd: 'echo bg-marker-$((40+2))' });
      let replay = null;
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        replay = await req('GET', '/api/tools/cli/output?id=' + encodeURIComponent(id) + '&since=0');
        const text = (replay.body.chunks || []).map((c) => c.data).join('');
        if (/bg-marker-42/.test(text)) break;
      }
      const text = (replay.body.chunks || []).map((c) => c.data).join('');
      check('detached output is buffered and replayed', /bg-marker-42/.test(text), JSON.stringify(text.slice(-200)));
      check('replayed chunks carry seq', (replay.body.chunks || []).every((c, i, a) => typeof c.seq === 'number' && (i === 0 || c.seq > a[i - 1].seq)));
      check('output reports running', replay.body.running === true);

      const s2 = await req('GET', '/api/tools/cli/session?projectDir=' + encodeURIComponent(projDir));
      check('reopen reattaches to the same session', s2.body.id === id);

      const list = await req('GET', '/api/tools/cli/sessions?projectDir=' + encodeURIComponent(projDir));
      const mine = (list.body.sessions || []).find((x) => x.id === id);
      check('sessions lists the live shell', !!mine && mine.running === true && mine.seq >= replay.body.seq);

      const missing = await req('GET', '/api/tools/cli/output?id=nope');
      check('unknown id is 404', missing.status === 404);

      await req('POST', '/api/tools/cli/close', { projectDir: projDir });
      const after = await req('GET', '/api/tools/cli/sessions?projectDir=' + encodeURIComponent(projDir));
      check('explicit stop removes the session', !(after.body.sessions || []).some((x) => x.id === id));
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
