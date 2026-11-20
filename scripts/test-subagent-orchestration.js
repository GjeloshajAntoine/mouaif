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
const { liveChat, runningKey } = require('../src/server-shared.js');
const auth = require('../src/tools/authorization.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const result = (text = 'done') => ({ ok: true, result: { text, model: { id: 'mock' } } });

async function unit() {
  // A turn-local root: it carries the turn's abort signal.
  const scope = new Scope('/p', 'chat', new AbortController().signal);
  let resolve;
  const a = scope.start('a', 'Review', () => new Promise((r) => { resolve = r; }), () => {});
  await tick();
  for (let i = 0; i < 150; i++) scope.event(a, 'message', { delta: String(i) + '\n' });
  scope.event(a, 'message', { delta: 'stream ' });
  scope.event(a, 'message', { delta: 'coalesced' });
  scope.event(a, 'reasoning', { delta: 'secret reasoning' });
  scope.event(a, 'tool_result', { result: { body: 'hidden file' } });
  const lines = scope.dispatch('subagent_messages', { callId: 'a', limit: 50 });
  assert.equal(lines.lines.length, 50);
  assert.equal(lines.truncated, true);
  assert.equal(a.lines.length, 128);
  assert.equal(scope.status(a).lastLine, 'stream coalesced');
  assert.ok(!JSON.stringify(lines).includes('secret'));
  // Coalesced first line must not report truncated=true on since=0, and
  // overflow beyond 2048 chars must not spawn synthetic extra lines.
  const c = scope.start('c', 'Review', () => new Promise(() => {}), () => {});
  await tick();
  scope.event(c, 'message', { delta: 'hel' });
  scope.event(c, 'message', { delta: 'lo' });
  const cMsg = scope.dispatch('subagent_messages', { callId: 'c', since: 0 });
  assert.equal(cMsg.truncated, false);
  assert.equal(cMsg.lines.length, 1);
  assert.equal(cMsg.lines[0].text, 'hello');
  scope.event(c, 'message', { delta: 'x'.repeat(2100) });
  scope.event(c, 'message', { delta: 'ignored-overflow' });
  assert.equal(c.lines.length, 1);
  assert.equal(c.lines[0].text.length, 2048);
  scope.dispatch('subagent_send', { callId: 'a', message: 'focus on tests' });
  assert.deepEqual(scope.drain(a.author), ['focus on tests']);
  assert.deepEqual(scope.drain(a.author), []);
  for (const name of PARENT_TOOLS) assert.throws(() => scope.dispatch(name, { callId: 'a' }, a.author), { code: 'EPARENT_ONLY' });
  assert.throws(() => scope.get('alien'), { code: 'EUNKNOWN_CALL' });
  // A chat-scoped root via persistentScope() is persistent: it is not
  // finished by a turn and keeps accepting controls after "turn end".
  const isolated = require('../src/tools/subagent-orchestration.js').persistentScope('/p', 'chat-isolated', {});
  assert.equal(isolated.persistent, true);
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
  await scope.finish();
  // A persistent root survives its "turn": controls still work, and only an
  // explicit finish() closes it.
  assert.equal(isolated.closed, false);
  assert.throws(() => isolated.dispatch('subagent_read', { name: 'missing' }), { code: 'EUNKNOWN_PUBLICATION' });
  await isolated.finish();
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
  let signalChildReady, signalNextTurnReady;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const nested = body.messages.some((m) => m.role === 'user' && (m.content === 'child task' || m.content?.[0]?.text === 'child task'));
      const send = (name, args, id) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const delta = name ? { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } : { content: nested ? 'child final' : 'parent final' };
        res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
      };
      if (nested) {
        nestedTools = body.tools.map((s) => s.function.name);
        childRound++;
        if (mode === 'steer' && childRound === 1) {
          childPending = () => send('subagent_publish', { name: 'draft', summary: 'sibling handoff' }, 'duplicate');
          return;
        }
        if (mode === 'cancel') return; // provider interrupted by child abort
        if (mode === 'end') return signalChildReady(send);
        if (mode === 'approval') return send('shell', { cmd: 'echo must-not-run' }, 'approval');
        if (childRound === 2) {
          steeringObserved = body.messages.some((m) => m.content === 'Parent steering: revise scope');
          return send('subagent_read', { name: 'draft' }, 'duplicate');
        }
        return send();
      }
      parentRound++;
      if (mode === 'end' && parentRound === 3) return signalNextTurnReady(send);
      parentToolResults = body.messages.filter((m) => m.role === 'tool').map((m) => ({ name: m.name, result: JSON.parse(m.content) }));
      if (parentRound === 1) return send('subagent', { task: 'child task', background: true }, 'child');
      assert.equal(parentToolResults[0].result.callId, 'child');
      assert.equal(parentToolResults[0].result.background, true);
      if (parentRound === 2) {
      parentObservedRunning = true;
      if (mode === 'steer') return send('subagent_send', { callId: 'child', message: 'revise scope' }, 'steer');
      if (mode === 'end') {
      // The parent ends its turn here with no further tool call; the
      // background child keeps running on the chat's persistent scope.
      // Its final result is persisted when it settles, even though the
      // SSE stream is gone by then.
      send();
      return;
      }
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
      assert.equal(parentToolResults.at(-1).result.state, mode === 'steer' || mode === 'end' ? 'completed' : 'cancelled');
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
      const childReady = new Promise((resolve) => { signalChildReady = resolve; });
      const nextTurnReady = new Promise((resolve) => { signalNextTurnReady = resolve; });
      const request = (content) => ({ method: 'POST', headers: {}, on(event, cb) {
      if (event === 'data') process.nextTick(() => cb(Buffer.from(JSON.stringify({ projectDir: currentProject, modelId: 'mock', content }))));
      if (event === 'end') process.nextTick(cb);
      } });
      const response = () => ({
      body: '', writableEnded: false, destroyed: false, writesAfterClose: 0,
      writeHead() {}, setHeader() {}, getHeader() {}, on() {}, off() {},
      write(chunk) {
      // A dead socket can reject a write without throwing synchronously.
      if (this.writableEnded || this.destroyed) { this.writesAfterClose++; return false; }
      this.body += chunk;
      return true;
      },
      end() { this.writableEnded = true; }
      });
      const res = response();
      await handleChatStream(request('parent task'), res, chat.id, null);
      const events = res.body.split('\n\n').map((frame) => {
        const match = /event: (.*)\ndata: (.*)/.exec(frame);
        return match ? { name: match[1], data: JSON.parse(match[2]) } : null;
      }).filter(Boolean);
      const settled = events.filter((e) => e.name === 'tool_result' && e.data.id === 'child');
      if (mode === 'end') {
      // Turn end no longer cancels the background child (persistent chat
      // scope): its final result is not on this turn's stream, but it is
      // persisted once the run settles.
      assert.equal(settled.length, 0, 'end: no result on the ended turn\'s stream');
      } else {
      assert.equal(settled.length, 1, mode + ': one persisted final result, not a receipt/result duplicate');
      assert.equal(settled[0].data.result.state, mode === 'steer' ? 'completed' : 'cancelled');
      assert.ok(events.findIndex((e) => e === settled[0]) < events.findIndex((e) => e.name === 'done'));
      }
      assert.equal(auth.listPending(currentProject, chat.id).length, 0);
      assert.ok(parentObservedRunning);
      if (mode === 'steer') {
      assert.ok(steeringObserved);
      const wireIds = settled.length ? settled[0].data.result.toolEvents.filter((e) => e.name === 'tool_call').map((e) => e.data.id) : [];
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
      if (mode !== 'end') {
      assert.equal(childResults.length, 1);
      assert.ok(JSON.parse(childResults[0].content).chat, 'saved nested transcript survives');
      }
      const history = require('../src/messages.js').reconstructUpstreamHistory(persisted);
      assert.equal(history.filter((m) => m.role === 'tool' && m.name === 'subagent').length, mode === 'end' ? 0 : 1, 'delayed result survives history reconstruction');
      // The chat's scope is persistent: after the turn ended, the background
      // child of mode 'end' is still observable on the chat's long-lived
      // scope, and can still be controlled from a later turn.
      const orch = require('../src/tools/subagent-orchestration.js');
      if (mode === 'end') {
      const scope = orch.persistentScope(currentProject, chat.id);
      assert.equal(scope.dispatch('subagent_status', { callId: 'child' }).state, 'running');
      const nextResponse = response();
      const nextTurn = handleChatStream(request('next task'), nextResponse, chat.id, null);
      const [finishChild, finishNextTurn] = await Promise.all([childReady, nextTurnReady]);
      const follower = response();
      liveChat.addSubscriber(runningKey(currentProject, chat.id), null, follower);
      nextResponse.destroyed = true; // The follower stays connected.
      const chatCost = () => require('../src/chats.js').getChat(currentProject, chat.id).totalCost.total;
      const costAtTurnEnd = chatCost();
      try {
      finishChild();
      await scope.get('child').promise;
      // The child's rounds after its turn ended are billed to the chat too.
      assert.ok(chatCost() > costAtTurnEnd + 0.0005, 'late background rounds reach the chat total: ' + costAtTurnEnd + ' -> ' + chatCost());
      const results = require('../src/messages.js').listMessages(currentProject, chat.id)
        .filter((m) => m.role === 'tool' && m.phase === 'result' && m.toolCallId === 'child');
      assert.equal(results.length, 1, 'late background result is persisted once');
      assert.equal(JSON.parse(results[0].content).state, 'completed');
      assert.equal(scope.dispatch('subagent_status', { callId: 'child' }).lastLine, 'child final');
      assert.equal(res.writesAfterClose, 0, 'no writes to the ended turn response');
      assert.doesNotMatch(follower.body, /event: subagent_event/, 'no stale subagent frames in the next turn');
      } finally {
      finishNextTurn();
      await nextTurn;
      }
      assert.equal(nextResponse.writesAfterClose, 0, 'no writes to the disconnected owner');
      assert.match(follower.body, /event: message\ndata: .*parent final/, 'followers still receive their own turn');
      }
      await orch.dropPersistentScope(currentProject, chat.id);
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
