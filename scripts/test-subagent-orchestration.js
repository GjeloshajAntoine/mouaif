'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Scope, PARENT_TOOLS, SIBLING_TOOLS } = require('../src/tools/subagent-orchestration.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-orchestration-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const { handleChatStream } = require('../src/server-handlers-chats.js');
const auth = require('../src/tools/authorization.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const result = (text = 'done') => ({ ok: true, result: { text, model: { id: 'mock' } } });

async function unit() {
  const scope = new Scope('/p', 'chat');
  let resolve;
  const a = scope.start('a', 'Review', () => new Promise((r) => { resolve = r; }), () => {});
  await tick();
  for (let i = 0; i < 150; i++) scope.event(a, 'message', { delta: String(i) });
  scope.event(a, 'reasoning', { delta: 'secret reasoning' });
  scope.event(a, 'tool_result', { result: { body: 'hidden file' } });
  const lines = scope.dispatch('subagent_messages', { callId: 'a', limit: 50 });
  assert.equal(lines.lines.length, 50);
  assert.equal(lines.truncated, true);
  assert.equal(a.lines.length, 128);
  assert.ok(!JSON.stringify(lines).includes('secret'));
  scope.dispatch('subagent_send', { callId: 'a', message: 'focus on tests' });
  assert.deepEqual(scope.drain(a.author), ['focus on tests']);
  assert.deepEqual(scope.drain(a.author), []);
  for (const name of PARENT_TOOLS) assert.throws(() => scope.dispatch(name, { callId: 'a' }, a.author), { code: 'EPARENT_ONLY' });
  assert.throws(() => scope.get('alien'), { code: 'EUNKNOWN_CALL' });
  const isolated = new Scope('/p', 'chat');
  assert.throws(() => isolated.get('a'), { code: 'EUNKNOWN_CALL' });
  const b = scope.start('b', '', async () => result(), () => {});
  scope.dispatch('subagent_publish', { name: 'review', summary: 'bounded handoff', files: ['src/ai-stream.js'] }, a.author);
  const read = scope.dispatch('subagent_read', { name: 'review' }, b.author);
  assert.equal(read.author, 'a');
  read.files.push('mutated');
  assert.equal(scope.dispatch('subagent_read', { name: 'review' }).files.length, 1);
  assert.throws(() => scope.dispatch('subagent_publish', { name: 'review', summary: 'overwrite' }), { code: 'EEXISTS' });
  assert.throws(() => scope.dispatch('subagent_publish', { name: 'bad', summary: 'x', files: ['../secret'] }), { code: 'EBADINPUT' });
  assert.throws(() => isolated.dispatch('subagent_read', { name: 'review' }), { code: 'EUNKNOWN_PUBLICATION' });
  assert.equal(scope.stop(a).alreadyFinished, false);
  assert.equal(a.controller.signal.aborted, true);
  assert.equal(b.controller.signal.aborted, false);
  resolve(result());
  await a.promise; await b.promise;
  assert.equal(scope.stop(a).alreadyFinished, true);
  assert.equal(scope.status(a).state, 'cancelled');
  assert.deepEqual(scope.status(a).published, ['review']);
  const parentCtl = new AbortController();
  const abortedScope = new Scope('/p', 'chat', parentCtl.signal);
  const child = abortedScope.start('abort-child', '', (row) => new Promise((resolve) => {
    if (row.controller.signal.aborted) resolve(result());
    else row.controller.signal.addEventListener('abort', () => resolve(result()), { once: true });
  }), () => {});
  parentCtl.abort();
  await abortedScope.finish();
  assert.equal(child.state, 'cancelled');
  await scope.finish(); await isolated.finish();
  assert.equal(scope.runs.size, 0);
  assert.equal(scope.publications.size, 0);
  assert.throws(() => scope.dispatch('subagent_read', { name: 'review' }), { code: 'EABORTED' });

  const projectDir = path.join(tmp, 'auth'); fs.mkdirSync(projectDir);
  settings.setProject(projectDir, { tools: { shell: { mode: 'ask' } } });
  const ctl = new AbortController();
  const first = await auth.authorize({ projectDir, chatId: 'auth', tool: 'shell', callId: 'first', signal: ctl.signal });
  const second = await auth.authorize({ projectDir, chatId: 'auth', tool: 'shell', callId: 'second' });
  const rejection = assert.rejects(first.wait, { code: 'EABORTED' });
  ctl.abort(); await rejection;
  assert.deepEqual(auth.listPending(projectDir, 'auth').map((p) => p.callId), ['second']);
  assert.throws(() => auth.recordDecision(projectDir, 'auth', 'first', 'allow-once'), { code: 'ENOTFOUND' });
  auth.recordDecision(projectDir, 'auth', 'second', 'allow-once'); await second.wait;
}

async function integration() {
  let mode = 'steer';
  let parentRound = 0;
  let childRound = 0;
  let childPending;
  let nestedTools;
  let parentObservedRunning = false;
  let steeringObserved = false;
  let parentToolResults = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const nested = body.messages.some((m) => m.role === 'user' && (m.content === 'child task' || m.content?.[0]?.text === 'child task'));
      const send = (name, args, id) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const delta = name ? { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } : { content: nested ? 'child final' : 'parent final' };
        res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 }, cost: 0.001 }) + '\n\n');
        res.end('data: [DONE]\n\n');
      };
      if (nested) {
        nestedTools = body.tools.map((s) => s.function.name);
        childRound++;
        if (mode === 'steer' && childRound === 1) {
          childPending = () => send('subagent_publish', { name: 'draft', summary: 'sibling handoff' }, 'duplicate');
          return;
        }
        if (mode === 'cancel' || mode === 'end') return; // provider interrupted by child abort
        if (mode === 'approval') return send('shell', { cmd: 'echo must-not-run' }, 'approval');
        if (childRound === 2) {
          steeringObserved = body.messages.some((m) => m.content === 'Parent steering: revise scope');
          return send('subagent_read', { name: 'draft' }, 'duplicate');
        }
        return send();
      }
      parentRound++;
      parentToolResults = body.messages.filter((m) => m.role === 'tool').map((m) => ({ name: m.name, result: JSON.parse(m.content) }));
      if (parentRound === 1) return send('subagent', { task: 'child task', background: true }, 'child');
      assert.equal(parentToolResults[0].result.callId, 'child');
      assert.equal(parentToolResults[0].result.background, true);
      if (parentRound === 2) {
        parentObservedRunning = true;
        if (mode === 'steer') return send('subagent_send', { callId: 'child', message: 'revise scope' }, 'steer');
        if (mode === 'end') return send();
        // Wait for child fetch/tool approval before stopping it.
        const wait = () => {
          if (mode === 'approval' ? auth.listPending(currentProject, currentChat).length : childRound) send('subagent_stop', { callId: 'child' }, 'stop');
          else setTimeout(wait, 5);
        };
        return wait();
      }
      if (parentRound === 3) {
        if (mode === 'steer') {
          const release = () => { if (childPending) childPending(); else setTimeout(release, 5); };
          release();
        }
        // Fixture scheduling only; production status never waits.
        return setTimeout(() => send('subagent_status', { callId: 'child' }, 'status'), 100);
      }
      assert.equal(parentToolResults.at(-1).result.state, mode === 'steer' ? 'completed' : 'cancelled');
      send();
    });
  });
  let currentProject, currentChat;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  settings.setApp({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + server.address().port }] });
  try {
    for (mode of ['steer', 'cancel', 'approval', 'end']) {
      parentRound = childRound = 0; childPending = null;
      currentProject = path.join(tmp, mode); fs.mkdirSync(currentProject);
      settings.setProject(currentProject, { models: [{ id: 'mock', provider: 'openai-compatible' }], tools: { subagent: { mode: 'allow' }, shell: { mode: 'ask' } } });
      const chat = chats.createChat(currentProject, {}); currentChat = chat.id;
      const req = { method: 'POST', headers: {}, on(event, cb) {
        if (event === 'data') process.nextTick(() => cb(Buffer.from(JSON.stringify({ projectDir: currentProject, modelId: 'mock', content: 'parent task' }))));
        if (event === 'end') process.nextTick(cb);
      } };
      const res = { body: '', writeHead() {}, write(chunk) { this.body += chunk; }, end() {}, setHeader() {}, getHeader() {}, on() {}, off() {} };
      await handleChatStream(req, res, chat.id, null);
      const events = res.body.split('\n\n').map((frame) => {
        const match = /event: (.*)\ndata: (.*)/.exec(frame);
        return match ? { name: match[1], data: JSON.parse(match[2]) } : null;
      }).filter(Boolean);
      const settled = events.filter((e) => e.name === 'tool_result' && e.data.id === 'child');
      assert.equal(settled.length, 1, mode + ': one persisted final result, not a receipt/result duplicate');
      assert.equal(settled[0].data.result.state, mode === 'steer' ? 'completed' : 'cancelled');
      assert.ok(events.findIndex((e) => e === settled[0]) < events.findIndex((e) => e.name === 'done'));
      assert.equal(auth.listPending(currentProject, chat.id).length, 0);
      assert.ok(parentObservedRunning);
      if (mode === 'steer') {
      assert.ok(steeringObserved);
      const wireIds = settled[0].data.result.toolEvents.filter((e) => e.name === 'tool_call').map((e) => e.data.id);
      assert.ok(wireIds.every((id) => /^[A-Za-z0-9_-]+$/.test(id)), 'namespaced tool IDs remain provider-compatible');
        // Default depth budget (3): a child is itself a local parent, so it
        // keeps launch/control tools for its own nested subagents.
        for (const name of ['subagent', ...PARENT_TOOLS]) assert.ok(nestedTools.includes(name), name + ' available to nested subagent by default');
        for (const name of SIBLING_TOOLS) assert.ok(nestedTools.includes(name));
        assert.deepEqual(settled[0].data.result.published, ['draft']);
        const done = events.find((e) => e.name === 'done');
        assert.ok(done.data.usage.completionTokens >= 15, 'delegated usage included');
      }
      const persisted = require('../src/messages.js').listMessages(currentProject, chat.id);
      const childResults = persisted.filter((m) => m.role === 'tool' && m.phase === 'result' && m.toolCallId === 'child');
      assert.equal(childResults.length, 1);
      assert.ok(JSON.parse(childResults[0].content).chat, 'saved nested transcript survives');
      const history = require('../src/messages.js').reconstructUpstreamHistory(persisted);
      assert.equal(history.filter((m) => m.role === 'tool' && m.name === 'subagent').length, 1, 'delayed result survives history reconstruction');
    }
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

(async () => {
  try { await unit(); await integration(); console.log('subagent orchestration: scope, bounds, role separation, handoffs, steering, stop/approval/end cleanup, billing and HTTP persistence passed'); }
  finally { settings.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
