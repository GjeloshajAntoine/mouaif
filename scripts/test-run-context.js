'use strict';
// A recurring task's run starts a fresh model context at its own prompt; the
// earlier runs stay in the chat but are not sent upstream.
const assert = require('node:assert/strict');
const messages = require('../src/messages.js');

const run = (n) => ({ role: 'user', content: 'daily report', origin: { kind: 'schedule', scheduleId: 'wake-1', run: n } });
const reply = (text) => ({ role: 'assistant', content: text });
const history = [
  { role: 'user', content: 'set it up' }, reply('ok'),
  run(1), reply('run 1 done'),
  run(2), reply('run 2 done'),
  { role: 'user', content: 'thanks, now tweak it' }
];

let out = messages.contextFromLastRun(history);
assert.deepEqual(out.map((m) => m.content), ['daily report', 'run 2 done', 'thanks, now tweak it'], 'context starts at the latest run prompt');
assert.equal(out[0].origin.run, 2);

const plain = [{ role: 'user', content: 'hi' }, reply('hello'), { role: 'user', content: 'again' }];
assert.equal(messages.contextFromLastRun(plain), plain, 'a chat with no scheduled run is untouched');
assert.deepEqual(messages.contextFromLastRun(null), []);

out = messages.contextFromLastRun([...history, run(3)]);
assert.deepEqual(out.map((m) => m.origin && m.origin.run), [3], 'the new run sees only its prompt');
assert.equal(history.length, 7, 'the stored transcript is not changed');

console.log('run context: a recurring run starts at its own prompt passed');
