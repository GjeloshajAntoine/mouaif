'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

// Run after `docker compose -f compose.ui-review.yaml up -d --wait`.
const compose = ['compose', '-f', 'compose.ui-review.yaml'];
const config = JSON.parse(execFileSync('docker', [...compose, 'config', '--format', 'json'], { encoding: 'utf8' }));
assert.equal(config.services.app.network_mode, 'service:chrome');
assert.equal(config.services.app.environment.MOUAIF_CHROME_URL, 'http://127.0.0.1:9222');
assert.equal(config.services.app.depends_on.chrome.condition, 'service_healthy');
assert.ok(config.services.chrome.ports.every((port) => port.target !== 9222));

const probe = `
const assert = require('node:assert/strict');
(async () => {
  const response = await fetch('http://127.0.0.1:5732/api/inspector/targets');
  assert.equal(response.status, 200);
  const { targets } = await response.json();
  const target = targets.find(t => t.type === 'page');
  assert.ok(target && target.webSocketDebuggerUrl);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const timer = setTimeout(() => process.exit(1), 5000);
  ws.onerror = () => process.exit(1);
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1 + 1', returnByValue: true } }));
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    assert.equal(message.result.result.value, 2);
    clearTimeout(timer);
    ws.close();
    console.log('PASS Docker Inspector discovery and page CDP connection');
  };
})().catch(error => { console.error(error); process.exit(1); });
`;
execFileSync('docker', [...compose, 'exec', '-T', 'app', 'node', '-e', probe], { stdio: 'inherit' });
