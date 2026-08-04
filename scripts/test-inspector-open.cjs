// One-shot test for src/inspector.js openInspectorTarget() against a mock
// Chrome. Verifies both the modern CDP Target.createTarget path and the
// classic PUT /json/new fallback, and that a genuinely broken Chrome does
// NOT get masked by the fallback.
//
// Not part of `npm test` (needs no real Chrome, but keeps ws dependency
// and a local listener). Run: node scripts/test-inspector-open.cjs
'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const inspector = require('../src/inspector.js');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok:', msg);
}

function mockChrome({ mode }) {
  // mode: 'cdp' — /json/version has webSocketDebuggerUrl, /json/new 404s
  //       'legacy' — /json/version has NO webSocketDebuggerUrl, /json/new PUT works
  //       'broken' — /json/version 500s
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/json/version')) {
      if (mode === 'broken') { res.writeHead(500); res.end('boom'); return; }
      const payload = { Browser: 'Chrome/' + (mode === 'cdp' ? '137.0.0.0' : '100.0.0.0') };
      if (mode === 'cdp') payload.webSocketDebuggerUrl = 'ws://127.0.0.1:' + server.address().port + '/devtools/browser/abc';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }
    if (req.url.startsWith('/json/new')) {
      if (mode === 'cdp') { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      if (req.method === 'PUT') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'legacy-tab', type: 'page', url: req.url.split('?')[1] ? decodeURIComponent(req.url.split('?')[1]) : '', title: '', webSocketDebuggerUrl: 'ws://127.0.0.1:' + server.address().port + '/devtools/page/legacy-tab' }));
        return;
      }
      res.writeHead(405); res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/devtools/browser/')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.method === 'Target.createTarget') {
            ws.send(JSON.stringify({ id: msg.id, result: { targetId: 'cdp-tab' } }));
          }
        });
      });
    } else socket.destroy();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, wss, base: 'http://127.0.0.1:' + server.address().port }));
  });
}

async function main() {
  // 1. Modern Chrome: CDP path wins, /json/new 404 is ignored.
  {
    const { server, wss, base } = await mockChrome({ mode: 'cdp' });
    const t = await inspector.openInspectorTarget(base, 'http://example.com/a');
    assert(t.id === 'cdp-tab', 'CDP path returns target from Target.createTarget');
    assert(t.webSocketDebuggerUrl.indexOf('devtools/page/cdp-tab') > 0, 'CDP target has webSocketDebuggerUrl');
    server.close(); wss.close();
  }
  // 2. Legacy Chrome: /json/version has no browser WS -> falls back to PUT /json/new.
  {
    const { server, wss, base } = await mockChrome({ mode: 'legacy' });
    const t = await inspector.openInspectorTarget(base, 'http://example.com/b');
    assert(t.id === 'legacy-tab', 'fallback PUT /json/new returns legacy target');
    server.close(); wss.close();
  }
  // 3. Broken Chrome: /json/version 500 -> the CDP error is surfaced, NOT masked.
  {
    const { server, wss, base } = await mockChrome({ mode: 'broken' });
    let caught = null;
    try { await inspector.openInspectorTarget(base, 'http://example.com/c'); }
    catch (e) { caught = e; }
    assert(caught && caught.code === 'EUPSTREAM', 'broken Chrome surfaces EUPSTREAM (not masked)');
    server.close(); wss.close();
  }
  console.log('ALL OK');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
