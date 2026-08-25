'use strict';
// HTTP smoke test for project custom-action CRUD and CLI execution.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-actions-home-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-actions-project-'));
process.env.MOUAIF_HOME = home;
const { createServer } = require('../src/index.js');
const server = createServer(0);
function request(port, method, route, body) {
return new Promise((resolve, reject) => {
const req = http.request({ host: '127.0.0.1', port, method, path: route, headers: { 'Content-Type': 'application/json' } }, (res) => {
const chunks = [];
res.on('data', (chunk) => chunks.push(chunk));
res.on('end', () => {
const text = Buffer.concat(chunks).toString('utf8');
let parsed = text;
try { parsed = JSON.parse(text); } catch { /* plain body */ }
resolve({ status: res.statusCode, body: parsed });
});
});
req.on('error', reject);
if (body !== undefined) req.write(JSON.stringify(body));
req.end();
});
}
server.listen(0, '127.0.0.1', async () => {
const port = server.address().port;
try {
let response = await request(port, 'POST', '/api/actions', {
projectDir,
action: { id: 'hello', label: 'Say hello', kind: 'cli', command: 'node -e "process.stdout.write(\'hello action\')"' }
});
if (response.status !== 200) throw new Error('create failed: ' + JSON.stringify(response));
response = await request(port, 'GET', '/api/actions?projectDir=' + encodeURIComponent(projectDir));
if (response.status !== 200 || response.body.actions.length !== 1 || response.body.actions[0].id !== 'hello') throw new Error('list failed');
const chat = await request(port, 'POST', '/api/chats', { projectDir, title: 'Actions' });
if (chat.status !== 201) throw new Error('chat create failed');
const chatId = chat.body.chat.id;
const settings = require('../src/settings.js');
settings.setProject(projectDir, { tools: { shell: { mode: 'allow' } } });
response = await request(port, 'POST', '/api/actions/hello/run', { projectDir, chatId, callId: 'action-test' });
if (response.status !== 200 || !response.body.ok || response.body.result.stdout !== 'hello action') throw new Error('run failed: ' + JSON.stringify(response));
response = await request(port, 'DELETE', '/api/actions/hello?projectDir=' + encodeURIComponent(projectDir));
if (response.status !== 200 || response.body.actions.length !== 0) throw new Error('delete failed');
response = await request(port, 'POST', '/api/actions', { projectDir, action: { id: 'bad id', kind: 'cli', command: 'true' } });
if (response.status !== 400) throw new Error('invalid id should return 400');
console.log('custom actions: ok');
} catch (error) {
console.error(error && error.stack || error);
process.exitCode = 1;
} finally {
server.close();
fs.rmSync(projectDir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
}
});
