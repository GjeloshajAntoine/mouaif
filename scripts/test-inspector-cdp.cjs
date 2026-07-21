// One-shot smoke test for the new Inspector CDP paths. Runs through the
// mouaif WS proxy against the debug Chrome on 9222:
//   1. Page.enable + Page.captureScreenshot -> non-empty JPEG
//   2. Performance.enable + getMetrics -> Documents/Nodes present
//   3. Network.enable, trigger a fetch in the page, getResponseBody works
// Not part of `npm test`; requires the debug Chrome to be running.
'use strict';
const { WebSocket } = require('ws');

const BASE = process.env.MOUAIF_URL || 'http://127.0.0.1:5732';

async function main() {
  const cfg = await (await fetch(BASE + '/api/inspector/config')).json();
  console.log('config:', cfg.url);
  const targets = (await (await fetch(BASE + '/api/inspector/targets')).json()).targets || [];
  const page = targets.find((t) => t.type === 'page' && /127\.0\.0\.1:5732/.test(t.url)) || targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  console.log('target:', page.title, page.url);

  const wsUrl = BASE.replace(/^http/, 'ws') + '/api/inspector/proxy?host=' + encodeURIComponent(cfg.url) + '&targetId=' + encodeURIComponent(page.id);
  const ws = new WebSocket(wsUrl);
  let id = 1;
  const pending = new Map();
  const events = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg);
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const send = (method, params) => new Promise((res, rej) => {
    const mid = id++;
    pending.set(mid, (msg) => msg.error ? rej(new Error(msg.error.message)) : res(msg.result || {}));
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  await send('Page.enable');
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 55 });
  if (!shot.data || shot.data.length < 1000) throw new Error('screenshot too small');
  console.log('screenshot: OK,', Math.round(shot.data.length * 3 / 4 / 1024), 'KB jpeg');

  await send('Performance.enable');
  const m = await send('Performance.getMetrics');
  const names = (m.metrics || []).map((x) => x.name);
  for (const need of ['Documents', 'Nodes', 'JSHeapUsedSize', 'LayoutCount']) {
    if (!names.includes(need)) throw new Error('missing metric ' + need);
  }
  console.log('metrics: OK,', names.length, 'counters');

  await send('Network.enable');
  await send('Runtime.enable');
  await send('Runtime.evaluate', { expression: "fetch('/api/projects').then(r=>r.text())", awaitPromise: true });
  await new Promise((r) => setTimeout(r, 800));
  const reqEv = events.find((e) => e.method === 'Network.requestWillBeSent' && /\/api\/projects/.test(e.params.request.url));
  if (!reqEv) throw new Error('requestWillBeSent for /api/projects not seen');
  const body = await send('Network.getResponseBody', { requestId: reqEv.params.requestId });
  if (!body.body || !body.body.includes('projects')) throw new Error('response body unexpected');
  console.log('getResponseBody: OK,', body.body.length, 'chars');

  ws.close();
  console.log('ALL OK');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
