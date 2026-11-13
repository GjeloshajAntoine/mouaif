'use strict';

// End-to-end test for shared projects (docs/features/share-project.md):
// two mouaifs in ONE Node process. The sharing machine runs on the main
// thread; the adding mouaif runs in a worker thread with its own MOUAIF_HOME
// (src/settings.js keeps one store per module instance, so a worker is how two
// stores live in one process). No container, no CLI, no browser.
//
// The adding mouaif has a fake OpenAI-compatible provider; the sharing machine
// has no provider at all, so a chat through the share can only answer if the
// provider call really is made by the adding side (phase 2).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (!isMainThread) {
  runAddingMouaif().catch((e) => { console.error(e); process.exit(1); });
} else {
  runSharingMachine();
}

// ---- Worker: the adding mouaif ------------------------------------------------------------

async function runAddingMouaif() {
  const settings = require('../src/settings.js');
  const access = require('../src/access-auth.js');
  const { createServer } = require('../src/index.js');
  access.setPassword('bob', 'adder-password');

  let steps = [];
  const provider = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock' }, { id: 'live-only' }] }));
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      parentPort.postMessage({ type: 'provider-request', auth: req.headers.authorization || '', body });
      const step = steps.shift();
      if (step && step.fail) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'mock provider failure' } }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const write = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
      if (step && step.hang) {
        // Stream one delta, then wait: the test cancels the run and checks the
        // cancellation reaches this provider call on the adding side.
        write({ choices: [{ index: 0, delta: { content: 'partial ' } }] });
        res.on('close', () => { if (!res.writableEnded) parentPort.postMessage({ type: 'provider-closed' }); });
        return;
      }
      if (step && step.tool) {
        write({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_' + Date.now(), function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } }] } }] });
        write({ choices: [{ index: 0, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 3 } });
      } else {
        write({ choices: [{ index: 0, delta: { content: (step && step.text) || 'Done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  settings.setApp({
    providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + provider.address().port, apiKey: 'sk-adder-only' }],
    models: [{ id: 'mock', provider: 'openai-compatible', pricing: { inputPer1K: 1, outputPer1K: 2 } }]
  });
  const server = createServer(0, { authEnabled: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  parentPort.on('message', (msg) => {
    if (msg.type === 'steps') steps = msg.steps.slice();
    if (msg.type === 'stop') {
      server.close();
      provider.close();
      try { require('../src/share.js').detach(server); } catch { /* closed */ }
      setTimeout(() => process.exit(0), 50);
    }
  });
  parentPort.postMessage({ type: 'ready', port: server.address().port });
}

// ---- Main thread: the sharing machine --------------------------------------------------------

function runSharingMachine() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-share-e2e-'));
  process.env.MOUAIF_HOME = path.join(tmp, 'home-sharer');
  process.env.MOUAIF_MACHINE_NAME = 'sharer-box';
  process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
  main(tmp).then(() => {
    console.log('share e2e: all checks passed');
    process.exit(0);
  }, (e) => {
    console.error(e);
    process.exit(1);
  });
}

async function main(tmp) {
  const settings = require('../src/settings.js');
  const access = require('../src/access-auth.js');
  const projects = require('../src/projects.js');
  const share = require('../src/share.js');
  const { createServer } = require('../src/index.js');
  const WebSocket = require('ws');

  let passed = 0;
  const ok = (name) => { passed++; console.log('  ok   - ' + name); };

  // The project being shared, with one file and one outside it.
  const projectDir = path.join(tmp, 'work', 'shared-project');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'src', 'hello.txt'), 'hello from the sharing machine\n');
  fs.writeFileSync(path.join(tmp, 'work', 'secret.txt'), 'not shared\n');
  access.setPassword('alice', 'sharer-password');
  projects.registerProject(projectDir);

  let sharer = createServer(0, { authEnabled: true });
  await new Promise((r) => sharer.listen(0, '127.0.0.1', r));
  const A = 'http://127.0.0.1:' + sharer.address().port;

  const worker = new Worker(__filename, {
    env: Object.assign({}, process.env, { MOUAIF_HOME: path.join(tmp, 'home-adder'), MOUAIF_MACHINE_NAME: 'adder-box' })
  });
  const providerRequests = [];
  let providerClosed = 0;
  const ready = new Promise((resolve, reject) => {
    worker.on('message', (msg) => {
      if (msg.type === 'ready') resolve(msg.port);
      if (msg.type === 'provider-request') providerRequests.push(msg);
      if (msg.type === 'provider-closed') providerClosed++;
    });
    worker.once('error', reject);
  });
  const B = 'http://127.0.0.1:' + await ready;

  const basic = (user, pass) => 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
  const asAlice = { Authorization: basic('alice', 'sharer-password') };
  const asBob = { Authorization: basic('bob', 'adder-password') };
  async function call(origin, auth, method, url, body) {
    const r = await fetch(origin + url, {
      method,
      headers: Object.assign({}, auth, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* SSE or text */ }
    return { status: r.status, body: json, text };
  }
  const waitFor = async (what, fn, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out waiting for ' + what);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const q = (s) => encodeURIComponent(s);

  try {
    // ---- 1.5 rules: sharing needs app access --------------------------------------------
    share._state.serverConfig.authEnabled = false;
    const noAuth = await call(A, asAlice, 'POST', '/api/share/shares', { address: B, projectDir, access: 'files' });
    share._state.serverConfig.authEnabled = true;
    assert.equal(noAuth.status, 403);
    assert.equal(noAuth.body.code, 'ESHARE_AUTH_REQUIRED');
    ok('sharing refuses to work without app access (--auth)');

    // ---- Protocol version: a mismatch is refused with a clear message ----------------------
    const mismatch = await new Promise((resolve) => {
      const ws = new WebSocket(B.replace('http', 'ws') + '/api/share', { headers: { 'x-mouaif-share-proto': '99' } });
      ws.on('unexpected-response', (req, res) => {
        let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(t) }));
      });
      ws.on('error', () => {});
    });
    assert.equal(mismatch.status, 426);
    assert.equal(mismatch.body.code, 'EPROTO');
    assert.match(mismatch.body.error, /protocol v1.*v99/);
    ok('a share protocol mismatch is refused with a clear message');

    // ---- Share: the first time shows a code ------------------------------------------------
    const created = await call(A, asAlice, 'POST', '/api/share/shares', { address: B, projectDir, access: 'files' });
    assert.equal(created.status, 201, created.text);
    assert.match(created.body.code.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const shareId = created.body.share.id;
    ok('sharing with a new address shows a first-time code');

    const pending = await waitFor('the offer on the adding side', async () => {
      const s = await call(B, asBob, 'GET', '/api/share/state');
      return s.body.incoming.find((x) => x.id === shareId);
    });
    assert.equal(pending.status, 'pending');
    assert.equal(pending.machine, 'sharer-box');
    assert.equal(pending.projectDir, projectDir);
    assert.equal(pending.needsCode, true);
    assert.equal(pending.online, true);
    ok('the adding mouaif lists the pending share with project and machine name');

    // Not added yet: nothing is forwarded.
    const early = await call(B, asBob, 'GET', '/s/' + shareId + '/api/chats?projectDir=' + q(projectDir));
    assert.equal(early.status, 404);

    const wrong = await call(B, asBob, 'POST', '/api/share/shares/' + shareId + '/accept', { code: 'AAAA-AAAA' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.code, 'ESHARE_CODE');
    const accepted = await call(B, asBob, 'POST', '/api/share/shares/' + shareId + '/accept', { code: created.body.code.code });
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.body.share.status, 'active');
    const sharerView = await call(A, asAlice, 'GET', '/api/share/state');
    assert.equal(sharerView.body.outgoing[0].status, 'active');
    assert.equal(sharerView.body.outgoing[0].peer.paired, true);
    ok('a wrong code is refused; the right code adds the project and pairs the two');

    const S = (url) => '/s/' + shareId + url;

    // ---- 1.3 forwarding: REST through the share -------------------------------------------------
    const listing = await call(B, asBob, 'GET', S('/api/files?projectDir=' + q(projectDir) + '&dir=' + q(projectDir)));
    assert.equal(listing.status, 200, listing.text);
    assert.ok(JSON.stringify(listing.body).includes('src'));
    const file = await call(B, asBob, 'GET', S('/api/file?projectDir=' + q(projectDir) + '&path=src%2Fhello.txt'));
    assert.equal(file.status, 200, file.text);
    assert.match(file.body.content, /hello from the sharing machine/);
    ok('project files are read through the share');

    // ---- allowlist and project filter -----------------------------------------------------------
    for (const url of ['/api/settings', '/api/settings/app', '/api/restart', '/api/access/status', '/api/auth/accounts', '/api/projects/registered', '/api/projects?dir=%2F', '/api/share/state', '/data']) {
      const r = await call(B, asBob, 'GET', S(url));
      assert.equal(r.status, 403, url + ' -> ' + r.status);
      assert.equal(r.body.code, 'ESHARE_ROUTE', url);
    }
    ok('access, provider, restart, app-settings and folder-browsing routes are refused');
    const otherProject = await call(B, asBob, 'GET', S('/api/chats?projectDir=' + q(path.join(tmp, 'work'))));
    assert.equal(otherProject.body.code, 'ESHARE_PROJECT');
    const escape = await call(B, asBob, 'GET', S('/api/file?projectDir=' + q(projectDir) + '&path=..%2Fsecret.txt'));
    assert.equal(escape.body.code, 'ESHARE_PATH');
    const noProject = await call(B, asBob, 'GET', S('/api/chats'));
    assert.equal(noProject.body.code, 'ESHARE_PROJECT');
    ok('the project filter refuses other projects, missing projects and paths outside the project');

    const shell = await call(B, asBob, 'POST', S('/api/tools/shell'), { projectDir, cmd: 'echo hi' });
    assert.equal(shell.status, 403);
    assert.equal(shell.body.code, 'ESHARE_FILES_ONLY');
    ok('a files-only share refuses the shell route');

    // The chat's Tools card reads the same gate: refused tools are not listed,
    // read as off, and no MCP server is shown.
    const toolList = await call(B, asBob, 'GET', S('/api/tools/list?projectDir=' + q(projectDir)));
    assert.equal(toolList.status, 200, toolList.text);
    const listed = toolList.body.tools.map((t) => t.name);
    for (const name of ['shell', 'group_cli', 'webpreview', 'schedule_wake', 'webhook_create', 'hook_create', 'restart_app']) {
      assert.ok(!listed.includes(name), name + ' is not listed on a files-only share');
    }
    for (const name of ['read_file', 'subagent', 'ask_user', 'schedule_list']) assert.ok(listed.includes(name), name + ' is listed');
    const localList = await call(A, asAlice, 'GET', '/api/tools/list?projectDir=' + q(projectDir));
    assert.ok(localList.body.tools.some((t) => t.name === 'shell'), 'used directly, the project still lists shell');
    const authView = await call(B, asBob, 'GET', S('/api/tools/authorization?projectDir=' + q(projectDir)));
    assert.equal(authView.status, 200, authView.text);
    assert.equal(authView.body.tools.shell.mode, 'off');
    assert.equal(authView.body.tools.shell.share, 'denied');
    assert.notEqual(authView.body.tools.file && authView.body.tools.file.mode, 'off');
    // A change made from the panel answers with the same masked view.
    const authPut = await call(B, asBob, 'PUT', S('/api/tools/authorization'), { projectDir, tools: { file: { mode: authView.body.tools.file.mode } } });
    assert.equal(authPut.status, 200, authPut.text);
    assert.equal(authPut.body.tools.shell.mode, 'off');
    assert.equal(authPut.body.tools.shell.share, 'denied');
    const mcpList = await call(B, asBob, 'GET', S('/api/mcp/servers?projectDir=' + q(projectDir)));
    assert.deepEqual(mcpList.body.servers, []);
    ok('the Tools card catalog matches the share: refused tools are hidden and read as off');

    // The inspector WebSocket is never forwarded through a share.
    const inspectorWs = await new Promise((resolve) => {
      const ws = new WebSocket(B.replace('http', 'ws') + S('/api/inspector/proxy?host=x&targetId=y'), { headers: asBob });
      ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
      ws.on('open', () => { ws.close(); resolve('opened'); });
      ws.on('error', () => resolve('error'));
    });
    assert.equal(inspectorWs, 404);
    ok('the inspector WebSocket is not forwarded through a share');

    // ---- Phase 2: a chat through the share uses the adding mouaif's providers ---------------------
    const chat = await call(B, asBob, 'POST', S('/api/chats'), { projectDir });
    assert.equal(chat.status, 201, chat.text);
    const chatId = chat.body.chat.id;
    worker.postMessage({ type: 'steps', steps: [{ tool: 'shell', args: { cmd: 'echo should-not-run' } }, { text: 'Borrowed answer' }] });
    providerRequests.length = 0;
    const streamed = await call(B, asBob, 'POST', S('/api/chats/' + chatId + '/messages/stream'),
      { projectDir, modelId: 'mock', providerId: 'openai-compatible', content: 'Say hi' });
    assert.equal(streamed.status, 200, streamed.text);
    assert.match(streamed.text, /Borrowed answer/);
    assert.match(streamed.text, /event: done/);
    assert.equal(providerRequests.length, 2);
    assert.equal(providerRequests[0].auth, 'Bearer sk-adder-only', 'the adding mouaif signs with its own key');
    const advertised = (providerRequests[0].body.tools || []).map((t) => t.function.name);
    assert.ok(advertised.includes('read_file'), 'file tools are offered');
    assert.ok(!advertised.includes('shell'), 'the shell tool is not offered on a files-only share');
    const toolMsg = providerRequests[1].body.messages.find((m) => m.role === 'tool');
    assert.match(toolMsg.content, /files only/, 'a forged shell call is refused');
    ok('a chat through the share answers with the adding mouaif\'s provider; the shell tool is refused');

    // Stored on the sharing machine, readable through the share.
    const transcript = await call(B, asBob, 'GET', S('/api/chats/' + chatId + '/messages?projectDir=' + q(projectDir)));
    assert.equal(transcript.status, 200);
    assert.ok(JSON.stringify(transcript.body).includes('Borrowed answer'));
    const localChat = require('../src/messages.js').listMessages(projectDir, chatId);
    assert.ok(localChat.some((m) => m.role === 'assistant' && String(m.content).includes('Borrowed answer')));
    ok('the chat is stored on the sharing machine');

    const usage = await waitFor('usage on the adding side', async () => {
      const s = await call(B, asBob, 'GET', '/api/share/state');
      const u = s.body.incoming.find((x) => x.id === shareId).usage;
      return u.calls >= 2 ? u : null;
    });
    assert.equal(usage.promptTokens, 11 + 7);
    assert.equal(usage.completionTokens, 3 + 2);
    assert.equal(usage.known, true);
    assert.ok(Math.abs(usage.cost - ((18 / 1000) * 1 + (5 / 1000) * 2)) < 1e-9, 'priced with the adding mouaif\'s pricing');
    // The sharing machine prices the chat with the same (borrowed) pricing.
    const list = await call(B, asBob, 'GET', S('/api/chats?projectDir=' + q(projectDir)));
    const row = list.body.chats.find((c) => c.id === chatId);
    assert.equal(row.totalCost.known, true, 'the chat cost on the sharing machine is known');
    assert.ok(row.totalCost.total > 0);
    ok('usage and cost of borrowed calls are recorded on the adding mouaif and shown on both sides');

    // Retry after a provider error, as the chat's Retry button sends it: the
    // same content and the same clientId. Through a share it stores and sends
    // exactly what the same Retry stores on an unshared chat (src/chatdb.js
    // appendMessage: the re-sent turn is a fresh user row, its taken clientId
    // swapped for an `r_` one) — the share adds no copy of its own.
    const retryChat = await call(B, asBob, 'POST', S('/api/chats'), { projectDir });
    const retryChatId = retryChat.body.chat.id;
    worker.postMessage({ type: 'steps', steps: [{ fail: true }, { text: 'Retried answer' }] });
    providerRequests.length = 0;
    const turn = { projectDir, modelId: 'mock', providerId: 'openai-compatible', content: 'Retry me', clientId: 'u-e2e-retry' };
    const failed = await call(B, asBob, 'POST', S('/api/chats/' + retryChatId + '/messages/stream'), turn);
    assert.equal(failed.status, 200, failed.text);
    assert.match(failed.text, /event: error/);
    const retried = await call(B, asBob, 'POST', S('/api/chats/' + retryChatId + '/messages/stream'), turn);
    assert.match(retried.text, /Retried answer/);
    assert.equal(providerRequests.length, 2, 'one provider call per attempt, no extra forwarded request');
    const usersSent = providerRequests.map((r) => r.body.messages.filter((m) => m.role === 'user').length);
    assert.deepEqual(usersSent, [1, 2], 'the retry carries the earlier attempt too, as on an unshared chat');
    const retryRows = require('../src/messages.js').listMessages(projectDir, retryChatId);
    const userRows = retryRows.filter((m) => m.role === 'user');
    assert.equal(userRows.length, 2, 'two attempts, two user rows: one per POST');
    assert.equal(userRows[0].clientId, 'u-e2e-retry');
    assert.match(userRows[1].clientId, /^r_/);
    ok('Retry through a share stores one user row per attempt, the same as an unshared chat');

    // A model the adding mouaif does not offer is refused there.
    const chat2 = await call(B, asBob, 'POST', S('/api/chats'), { projectDir });
    const refused = await call(B, asBob, 'POST', S('/api/chats/' + chat2.body.chat.id + '/messages/stream'),
      { projectDir, modelId: 'gpt-free-for-all', providerId: 'openai-compatible', content: 'x' });
    assert.match(refused.text, /EMODEL_NOT_OFFERED/);
    const live = await call(B, asBob, 'POST', S('/api/chats/' + chat2.body.chat.id + '/messages/stream'),
      { projectDir, modelId: 'live-only', providerId: 'openai-compatible', content: 'y' });
    assert.match(live.text, /Done/);
    ok('the adding mouaif only signs requests for models it offers (configured or in its live list)');

    // Opened directly on the sharing machine, the project uses that machine's
    // own providers — it has none, so the chat says so.
    const direct = await call(A, asAlice, 'POST', '/api/chats/' + chatId + '/messages/stream',
      { projectDir, modelId: 'mock', providerId: 'openai-compatible', content: 'direct' });
    assert.equal(direct.status, 400);
    assert.match(direct.body.code, /EPROVIDER_NOT_FOUND|EMODEL_NOT_FOUND/);
    ok('used directly on the sharing machine, the project uses that machine\'s own providers');

    // Subagents of a shared chat borrow the same providers.
    settings.setProject(projectDir, { tools: { subagent: { mode: 'allow' } } });
    worker.postMessage({ type: 'steps', steps: [{ tool: 'subagent', args: { task: 'Look around' } }, { text: 'Sub result' }, { text: 'Parent done' }] });
    providerRequests.length = 0;
    const chat3 = await call(B, asBob, 'POST', S('/api/chats'), { projectDir });
    const delegated = await call(B, asBob, 'POST', S('/api/chats/' + chat3.body.chat.id + '/messages/stream'),
      { projectDir, modelId: 'mock', providerId: 'openai-compatible', content: 'delegate' });
    assert.match(delegated.text, /Parent done/);
    assert.equal(providerRequests.length, 3, 'parent, subagent and parent again all went to the adding mouaif');
    assert.ok(providerRequests.every((r) => r.auth === 'Bearer sk-adder-only'));
    ok('subagents of a shared chat use the adding mouaif\'s providers too');

    // Cancelling a run cancels the borrowed provider call on the adding side.
    worker.postMessage({ type: 'steps', steps: [{ hang: true }] });
    const chat4 = await call(B, asBob, 'POST', S('/api/chats'), { projectDir });
    const chat4Id = chat4.body.chat.id;
    const hanging = await fetch(B + S('/api/chats/' + chat4Id + '/messages/stream'), {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, asBob),
      body: JSON.stringify({ projectDir, modelId: 'mock', providerId: 'openai-compatible', content: 'hang' })
    });
    const reader = hanging.body.getReader();
    let seen = '';
    while (!seen.includes('partial')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += Buffer.from(value).toString();
    }
    assert.match(seen, /partial/, 'deltas stream through both mouaifs as they arrive');
    const cancel = await call(B, asBob, 'POST', S('/api/tools/authorization/cancel'), { projectDir, chatId: chat4Id });
    assert.equal(cancel.status, 200, cancel.text);
    await waitFor('the provider call to be cancelled', async () => providerClosed > 0);
    try { await reader.cancel(); } catch { /* closed */ }
    ok('cancelling a shared chat run aborts the provider call on the adding mouaif');

    // ---- Offline state and reconnection ---------------------------------------------------------
    const peerId = sharerView.body.outgoing[0].peer.id;
    share._state.conns.get(peerId).ws.terminate();
    const offline = await waitFor('the adding side to see it offline', async () => {
      const s = await call(B, asBob, 'GET', '/api/share/state');
      const row = s.body.incoming.find((x) => x.id === shareId);
      return row && row.online === false ? row : null;
    });
    assert.equal(offline.status, 'active');
    const whileOffline = await call(B, asBob, 'GET', S('/api/chats?projectDir=' + q(projectDir)));
    assert.ok(whileOffline.status === 503 || whileOffline.status === 200, 'offline answers 503 (or the redial already won)');
    if (whileOffline.status === 503) assert.equal(whileOffline.body.code, 'ESHARE_OFFLINE');
    await waitFor('the sharing machine to dial again', async () => {
      const s = await call(B, asBob, 'GET', '/api/share/state');
      return s.body.incoming.find((x) => x.id === shareId).online;
    }, 8000);
    const back = await call(B, asBob, 'GET', S('/api/chats?projectDir=' + q(projectDir)));
    assert.equal(back.status, 200);
    ok('a dropped connection shows the project offline, and the sharing machine dials again with backoff');

    // ---- Access change: files and shell ---------------------------------------------------------
    const upgraded = await call(A, asAlice, 'PATCH', '/api/share/shares/' + shareId, { access: 'full' });
    assert.equal(upgraded.status, 200);
    await waitFor('access change', async () => {
      const s = await call(B, asBob, 'GET', '/api/share/state');
      return s.body.incoming.find((x) => x.id === shareId).access === 'full';
    });
    const shellOk = await call(B, asBob, 'POST', S('/api/tools/shell'), { projectDir, cmd: 'echo through-share' });
    assert.notEqual(shellOk.body && shellOk.body.code, 'ESHARE_FILES_ONLY');
    const fullList = await call(B, asBob, 'GET', S('/api/tools/list?projectDir=' + q(projectDir)));
    assert.ok(fullList.body.tools.some((t) => t.name === 'shell'), 'a files-and-shell share lists shell');
    assert.ok(!fullList.body.tools.some((t) => t.name === 'restart_app'), 'restart_app is never listed through a share');
    ok('a files-and-shell share passes the shell route to the project\'s own tool settings');

    // ---- Stop sharing: immediate on both sides ----------------------------------------------------
    const stopped = await call(A, asAlice, 'DELETE', '/api/share/shares/' + shareId);
    assert.equal(stopped.status, 200);
    await waitFor('removal on the adding side', async () => {
      const s = await call(B, asBob, 'GET', '/api/share/state');
      return !s.body.incoming.some((x) => x.id === shareId);
    });
    const gone = await call(B, asBob, 'GET', S('/api/chats?projectDir=' + q(projectDir)));
    assert.equal(gone.status, 404);
    await waitFor('the connection to close', async () => !share.online(sharerView.body.outgoing[0].peer.id));
    ok('stop sharing removes the project from the other mouaif at once and closes the idle connection');

    // ---- Later shares need no code ------------------------------------------------------------------
    const again = await call(A, asAlice, 'POST', '/api/share/shares', { address: B, projectDir, access: 'files' });
    assert.equal(again.status, 201, again.text);
    assert.equal(again.body.code, null);
    const secondId = again.body.share.id;
    const pending2 = await waitFor('the second offer', async () => {
      const s = await call(B, asBob, 'GET', '/api/share/state');
      return s.body.incoming.find((x) => x.id === secondId);
    });
    assert.equal(pending2.needsCode, false);
    const added2 = await call(B, asBob, 'POST', '/api/share/shares/' + secondId + '/accept', {});
    assert.equal(added2.status, 200, added2.text);
    ok('a later share between the same two mouaifs needs no code');

    // ---- Restart: the connection is reopened from the stored shares -------------------------------------
    share.detach(sharer);
    await new Promise((r) => { sharer.closeAllConnections(); sharer.close(r); });
    await waitFor('the adding side to see the restart', async () => {
      const s = await call(B, asBob, 'GET', '/api/share/state');
      return !s.body.incoming.find((x) => x.id === secondId).online;
    });
    sharer = createServer(0, { authEnabled: true });
    await new Promise((r) => sharer.listen(0, '127.0.0.1', r));
    const A2 = 'http://127.0.0.1:' + sharer.address().port;
    await waitFor('the reopened connection', async () => {
      const s = await call(B, asBob, 'GET', '/api/share/state');
      return s.body.incoming.find((x) => x.id === secondId).online;
    }, 8000);
    const afterRestart = await call(B, asBob, 'GET', '/s/' + secondId + '/api/chats?projectDir=' + q(projectDir));
    assert.equal(afterRestart.status, 200);
    ok('after a restart the sharing machine reopens its stored connections');

    // ---- Stop from the adding side -------------------------------------------------------------------
    const removed = await call(B, asBob, 'DELETE', '/api/share/shares/' + secondId);
    assert.equal(removed.status, 200);
    await waitFor('removal on the sharing machine', async () => {
      const s = await call(A2, asAlice, 'GET', '/api/share/state');
      return !s.body.outgoing.some((x) => x.id === secondId);
    });
    ok('stop sharing works from the adding side too');

    console.log('share e2e: ' + passed + ' checks');
  } finally {
    worker.postMessage({ type: 'stop' });
    await new Promise((r) => setTimeout(r, 200));
    try { await worker.terminate(); } catch { /* stopped */ }
    share.detach(sharer);
    await new Promise((r) => sharer.close(r));
    try { settings.close(); } catch { /* closed */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
