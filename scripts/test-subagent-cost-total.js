// Regression test: nested subagent billing must be persisted in the parent
// chat's total, not only returned by ai-stream's final aggregate.
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-subagent-cost-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
const { handleChatStream } = require('../src/server-handlers-chats.js');
const messages = require('../src/messages.js');
const chats = require('../src/chats.js');
const settings = require('../src/settings.js');
let passed = 0;
let failed = 0;
function check(name, condition, detail) {
if (condition) { passed++; console.log('PASS  ' + name); }
else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}
function serve() {
let count = 0;
const server = http.createServer((req, res) => {
req.resume();
req.on('end', () => {
count++;
res.writeHead(200, { 'Content-Type': 'text/event-stream' });
if (count === 1) {
res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_sub","function":{"name":"subagent","arguments":"{\\"task\\":\\"research\\"}"}}]},"index":0}]}\n\n');
res.write('data: {"choices":[{"finish_reason":"tool_calls","index":0}]}\n\n');
res.write('data: {"usage":{"prompt_tokens":100,"completion_tokens":10,"cost":0.001}}\n\n');
} else if (count === 2) {
res.write('data: {"choices":[{"delta":{"content":"Nested answer"},"index":0}]}\n\n');
res.write('data: {"choices":[{"finish_reason":"stop","index":0}]}\n\n');
res.write('data: {"usage":{"prompt_tokens":300,"completion_tokens":40,"cost":0.004}}\n\n');
} else {
res.write('data: {"choices":[{"delta":{"content":"Parent answer"},"index":0}]}\n\n');
res.write('data: {"choices":[{"finish_reason":"stop","index":0}]}\n\n');
res.write('data: {"usage":{"prompt_tokens":200,"completion_tokens":10,"cost":0.0005}}\n\n');
}
res.write('data: [DONE]\n\n');
res.end();
});
});
return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests: () => count })));
}
function mockReq(body) {
return {
method: 'POST',
headers: { 'content-type': 'application/json' },
on(event, cb) {
if (event === 'data') process.nextTick(() => cb(Buffer.from(JSON.stringify(body))));
if (event === 'end') process.nextTick(cb);
}
};
}
function mockRes() {
return {
statusCode: 0,
body: '',
writeHead(code) { this.statusCode = code; },
write(chunk) { this.body += chunk; },
end() {},
setHeader() {},
getHeader() { return undefined; }
};
}
(async function main() {
const projectDir = path.join(tmp, 'project');
fs.mkdirSync(projectDir, { recursive: true });
const { server, port, requests } = await serve();
settings.setProject(projectDir, {
models: [{ id: 'mock', provider: 'openai-compatible', label: 'Mock' }],
tools: { subagent: { enabled: true, mode: 'allow' } }
});
settings.setApp({
providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k' }]
});
const chat = chats.createChat(projectDir, { title: 'subagent cost test' });
const req = mockReq({ projectDir, modelId: 'mock', content: 'delegate this' });
const res = mockRes();
await handleChatStream(req, res, chat.id, null);
server.close();
check('parent, nested, and final requests ran', requests() === 3, 'got ' + requests());
check('stream completed', res.statusCode === 200, 'status=' + res.statusCode);
const assistant = messages.listMessages(projectDir, chat.id).filter((m) => m && m.role === 'assistant');
check('one final parent message persisted', assistant.length === 1, 'got ' + assistant.length);
const total = assistant[0] && assistant[0].cost && assistant[0].cost.total;
check('persisted total includes parent rounds and subagent (0.0055)', Math.abs(total - 0.0055) < 1e-9, 'got ' + total);
const chatTotal = chats.chatTotalCost(projectDir, chat.id);
check('chat aggregate includes subagent cost', chatTotal.known && Math.abs(chatTotal.total - 0.0055) < 1e-9, JSON.stringify(chatTotal));
console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
