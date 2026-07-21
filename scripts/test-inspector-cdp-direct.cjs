// Smoke test for the CDP commands the new Inspector tabs use, straight
// against the debug Chrome (bypasses the mouaif WS proxy, which only
// accepts authenticated browser handshakes by design).
'use strict';
const { WebSocket } = require('ws');

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1:5732/.test(t.url)) || list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  console.log('target:', page.title, page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
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
    pending.set(mid, (msg) => msg.error ? rej(new Error(method + ': ' + msg.error.message)) : res(msg.result || {}));
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  await send('Page.enable');
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 55 });
  if (!shot.data || shot.data.length < 1000) throw new Error('screenshot too small');
  console.log('captureScreenshot: OK ~' + Math.round(shot.data.length * 3 / 4 / 1024) + ' KB jpeg');

  await send('Performance.enable');
  const m = await send('Performance.getMetrics');
  const names = (m.metrics || []).map((x) => x.name);
  for (const need of ['Documents', 'Nodes', 'JSHeapUsedSize', 'LayoutCount', 'RecalcStyleCount', 'JSEventListeners']) {
    if (!names.includes(need)) throw new Error('missing metric ' + need);
  }
  console.log('Performance.getMetrics: OK (' + names.length + ' counters)');

  await send('Network.enable');
  await send('Runtime.enable');
  await send('Runtime.evaluate', { expression: "fetch('/api/projects').then(r=>r.text())", awaitPromise: true });
  await new Promise((r) => setTimeout(r, 1000));
  const reqEv = events.find((e) => e.method === 'Network.requestWillBeSent' && /\/api\/projects/.test(e.params.request.url));
  if (!reqEv) throw new Error('requestWillBeSent for /api/projects not seen');
  const body = await send('Network.getResponseBody', { requestId: reqEv.params.requestId });
  if (typeof body.body !== 'string') throw new Error('response body missing');
  console.log('Network.getResponseBody: OK (' + body.body.length + ' chars, starts ' + JSON.stringify(body.body.slice(0, 40)) + ')');

  // Console event shape check: log an object and confirm preview properties arrive.
  const consolePromise = new Promise((res) => {
    const iv = setInterval(() => {
      const ev = events.find((e) => e.method === 'Runtime.consoleAPICalled');
      if (ev) { clearInterval(iv); res(ev); }
    }, 50);
  });
  await send('Runtime.evaluate', { expression: "console.log('mouaif-test', {a:1,b:2,c:3})" });
  const cev = await consolePromise;
  const objArg = (cev.params.args || []).find((a) => a.type === 'object');
  if (!objArg || !objArg.preview || !Array.isArray(objArg.preview.properties)) throw new Error('no object preview on console event');
  console.log('consoleAPICalled preview: OK (' + objArg.preview.properties.map((p) => p.name).join(',') + ')');

  ws.close();
  console.log('ALL OK');
  process.exit(0);
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
