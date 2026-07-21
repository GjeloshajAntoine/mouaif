'use strict';
const { WebSocket } = require('ws');
async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  console.log('page:', page.webSocketDebuggerUrl);
  // No Origin header at all.
  await new Promise((res, rej) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on('open', () => { console.log('no-origin: OPEN'); ws.close(); res(); });
    ws.on('error', (e) => rej(new Error('no-origin: ' + e.message)));
  });
}
main().catch((e) => { console.error(e.message); process.exit(1); });
