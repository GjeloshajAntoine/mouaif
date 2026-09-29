'use strict';
// Exercise the actual browser subscription with deferred fetch/read callbacks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../frontend/src/components/chat/live.js'), 'utf8');
const code = source.slice(source.indexOf('const liveByChat'), source.indexOf('// isCurrentChat('))
  .replaceAll('export function ', 'function ');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const requests = [];
  const events = [];
  const context = vm.createContext({
    Map, AbortController, TextDecoder,
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    parseSSEFrame: (frame) => ({ eventName: frame.split('\n')[0].slice(7), data: '{}' }),
    dispatchLiveEvent: (event) => events.push(event.eventName),
    handleLiveRunEnd: (event) => events.push(event.eventName)
  });
  vm.runInContext(code + '; this.subscribe = subscribeLive; this.close = closeLive; this.registry = liveByChat;', context);
  return { context, requests, events };
}
function state() { return { props: { projectDir: '/test', chatId: 'a' } }; }
function reader() {
  let resolve;
  let released = false;
  return {
    read: () => new Promise((done) => { resolve = done; }),
    push: (frame) => resolve({ value: Buffer.from(frame), done: false }),
    finish: () => resolve({ done: true }),
    releaseLock: () => { released = true; },
    get released() { return released; }
  };
}

(async () => {
  for (const rejected of [false, true]) {
    const { context, requests } = harness();
    const oldState = state();
    context.subscribe(oldState, {});
    assert.equal(context.close(oldState, '/test', 'a'), true);
    assert.equal(requests[0].options.signal.aborted, true);
    const replacement = state();
    context.subscribe(replacement, {});
    const entry = context.registry.get('/test::a');
    if (rejected) requests[0].reject(new Error('aborted'));
    else requests[0].resolve({ ok: false });
    await flush();
    assert.equal(context.registry.get('/test::a'), entry);
    assert.equal(replacement.liveRun.active, true);
    context.subscribe(replacement, {});
    assert.equal(requests.length, 2, 'old finalizer must not allow a duplicate follower');
    assert.equal(context.close(oldState, '/test', 'a'), false, 'old view cannot close replacement');
    assert.equal(requests[1].options.signal.aborted, false);
    context.close(replacement, '/test', 'a');
    requests[1].reject(new Error('aborted'));
    await flush();
    console.log('PASS old ' + (rejected ? 'rejection' : 'response') + ' leaves the replacement subscription registered');
  }

  {
    const { context, requests, events } = harness();
    const s = state();
    const oldReader = reader();
    context.subscribe(s, {});
    requests[0].resolve({ ok: true, body: { getReader: () => oldReader } });
    await flush();
    context.close(s, '/test', 'a');
    context.subscribe(s, {});
    const entry = context.registry.get('/test::a');
    oldReader.push('event: message\ndata: {}\n\n');
    await flush();
    assert.deepEqual(events, [], 'a late read must not dispatch after replacement');
    assert.equal(oldReader.released, true);
    assert.equal(context.registry.get('/test::a'), entry);
    assert.equal(s.liveRun.active, true, 'old cleanup cannot reset the new transport state');
    context.close(s, '/test', 'a');
    requests[1].resolve({ ok: false });
    await flush();
    console.log('PASS late reader output is ignored and its lock is released without clearing replacement state');
  }

  for (const ending of ['eof', 'run_end', 'http', 'network']) {
    const { context, requests, events } = harness();
    const s = state();
    context.subscribe(s, {});
    if (ending === 'network') requests[0].reject(new Error('offline'));
    else if (ending === 'http') requests[0].resolve({ ok: false });
    else {
      const stream = reader();
      requests[0].resolve({ ok: true, body: { getReader: () => stream } });
      await flush();
      if (ending === 'eof') stream.finish();
      else stream.push('event: run_end\ndata: {}\n\n');
      await flush();
      assert.equal(stream.released, true);
      assert.equal(requests[0].options.signal.aborted, true);
    }
    await flush();
    assert.equal(context.registry.size, 0);
    assert.equal(s.liveRun.active, false);
    if (ending === 'network' || ending === 'http') assert.equal(s.liveRun.failed, true);
    if (ending === 'run_end') assert.deepEqual(events, ['run_end']);
    context.subscribe(s, {});
    assert.equal(requests.length, 2, 'finished transport permits reconnection');
    context.close(s, '/test', 'a');
    requests[1].resolve({ ok: false });
    await flush();
    console.log('PASS ' + ending + ' releases the subscription and permits a fresh follower');
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
