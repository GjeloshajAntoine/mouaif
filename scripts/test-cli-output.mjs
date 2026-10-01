// Output catch-up must survive an unavailable/buffered SSE connection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../frontend/src/components/chat/cliOutput.js', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '').replace('export function subscribeCliOutput', 'function subscribeCliOutput');
const flush = () => new Promise(setImmediate);
function mount() {
  let eventSource, responder;
  const requests = [], writes = [], timers = new Map();
  let ended = 0, dropped = 0;
  const context = vm.createContext({
    fetchJson: (url) => { requests.push(url); return responder(url); },
    setTimeout: (fn, delay) => { timers.set(fn, delay); return fn; },
    clearTimeout: (fn) => timers.delete(fn),
    EventSource: class {
      constructor() { this.listeners = {}; eventSource = this; }
      addEventListener(type, fn) { this.listeners[type] = fn; }
      close() { this.closed = true; }
    }
  });
  vm.runInContext(source + '\nthis.subscribeCliOutput = subscribeCliOutput;', context);
  return {
    start(response) {
      responder = response;
      return context.subscribeCliOutput({ id: 'cli_test', onOutput: (text) => writes.push(text),
        onEnded: () => ended++, onDropped: () => dropped++ });
    },
    response: (fn) => { responder = fn; },
    emit: (type, data) => eventSource.listeners[type]?.({ data: JSON.stringify(data) }),
    tick() { const fn = timers.keys().next().value; assert.ok(fn); timers.delete(fn); return fn(); },
    requests, writes, timers,
    get ended() { return ended; }, get dropped() { return dropped; },
    get closed() { return eventSource.closed; }
  };
}
const chunk = (seq, data) => ({ seq, stream: 'stdout', data });
let resolve;
let ui = mount();
const subscription = ui.start(() => new Promise((r) => { resolve = r; }));
ui.emit('cli_output', { id: 'cli_test', ...chunk(3, 'three') });
ui.emit('cli_output', { id: 'cli_test', ...chunk(2, 'two') });
ui.emit('cli_output', { id: 'another', ...chunk(10, 'wrong session') });
resolve({ status: 200, body: { running: true, chunks: [chunk(1, 'one'), chunk(2, 'two')] } });
await subscription.ready;
assert.deepEqual(ui.writes, ['one', 'two', 'three']);
ui.emit('cli_output', { id: 'cli_test', ...chunk(3, 'duplicate') });
assert.equal(ui.writes.length, 3);
ui.response(async () => ({ status: 200, body: { running: true, chunks: [chunk(4, 'missed while offline')] } }));
ui.emit('open');
await flush();
assert.match(ui.requests.at(-1), /since=3$/);
assert.equal(ui.writes.at(-1), 'missed while offline');
ui.response(async () => ({ status: 200, body: { running: true, chunks: [chunk(5, 'buffered by proxy')] } }));
assert.equal([...ui.timers.values()][0], 1500);
await ui.tick();
assert.equal(ui.writes.at(-1), 'buffered by proxy', 'poll catches output with no SSE frames or errors');
ui.response(async () => { throw new Error('offline'); });
ui.emit('error');
await flush();
assert.equal(ui.timers.size, 1, 'network errors retry rather than permanently losing output');
ui.response(async () => ({ status: 200, body: { running: true, dropped: true, chunks: [chunk(8, 'retained tail')] } }));
await ui.tick();
assert.equal(ui.dropped, 1);
assert.equal(ui.writes.at(-1), 'retained tail');
ui.response(async () => ({ status: 404 }));
await ui.tick();
assert.equal(ui.ended, 1);
assert.equal(ui.timers.size, 0);
subscription.close();
assert.equal(ui.closed, true);
console.log('PASS ordered replay, duplicate suppression, reconnect, buffered SSE fallback, errors and ended sessions');

ui = mount();
const pending = ui.start(() => new Promise((r) => { resolve = r; }));
pending.close();
resolve({ status: 200, body: { running: false, chunks: [chunk(1, 'late output')] } });
await pending.ready;
ui.emit('cli_output', { id: 'cli_test', ...chunk(2, 'later') });
assert.deepEqual(ui.writes, []);
assert.equal(ui.ended, 0);
assert.equal(ui.timers.size, 0);
console.log('PASS closing cancels catch-up timers and ignores in-flight output');

ui = mount();
let calls = 0;
const serial = ui.start(() => { calls++; return new Promise((r) => { resolve = r; }); });
ui.emit('open');
ui.emit('error');
assert.equal(calls, 1, 'one catch-up request at a time');
ui.response(async () => { calls++; return { status: 200, body: { running: false, chunks: [] } }; });
resolve({ status: 200, body: { running: true, chunks: [] } });
await serial.ready;
assert.equal(calls, 2, 'connection event during a request schedules one follow-up catch-up');
assert.equal(ui.ended, 1);
serial.close();
console.log('PASS catch-up requests serialize without losing reconnect events');
