// Regression test: CLI modal output split inside a multi-byte UTF-8 character.
//
// The PTY and the piped fallback hand the server output in arbitrary byte
// chunks. attachCliStream used to decode each chunk on its own
// (`buf.toString('utf8')`), so a character whose bytes straddled two chunks —
// `é`, `✓`, an emoji, a box-drawing border from a TUI — rendered as U+FFFD
// replacement characters. The stream now keeps a StringDecoder per channel.
//
// No shell is spawned: a fake child feeds the exact byte splits, which makes
// the check deterministic.

'use strict';

const { EventEmitter } = require('node:events');
const { attachCliStream } = require('../src/server-handlers-tools.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

const TEXT = 'h\u00e9llo \u2713 \u{1F389} \u2500\u2502';

function ptyChild() {
  const child = new EventEmitter();
  child.onData = (fn) => child.on('data', fn);
  child.onExit = (fn) => child.on('pexit', fn);
  return child;
}

function pipedChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function capture(session) {
  const frames = [];
  attachCliStream(session, (event, payload) => { if (event === 'cli_output') frames.push(payload); });
  return frames;
}

const text = (frames, stream) => frames.filter((f) => f.stream === stream).map((f) => f.data).join('');

// 1. PTY path, one byte per chunk — the worst case.
{
  const child = ptyChild();
  const frames = capture({ id: 's1', pty: true, child });
  const bytes = Buffer.from(TEXT);
  for (let k = 0; k < bytes.length; k++) child.emit('data', bytes.subarray(k, k + 1));
  child.emit('pexit', { exitCode: 0 });
  const out = text(frames, 'stdout');
  check('PTY: bytes split one per chunk reassemble', out === TEXT, JSON.stringify(out));
  check('PTY: no replacement character', !out.includes('\uFFFD'));
  check('PTY: no empty frames broadcast while a character is incomplete', frames.every((f) => f.data !== ''));
  check('PTY: the exit frame still follows', frames[frames.length - 1].stream === 'exit');
}

// 2. PTY path, every two-chunk split point.
{
  const bytes = Buffer.from(TEXT);
  let firstBad = null;
  for (let k = 1; k < bytes.length && !firstBad; k++) {
    const child = ptyChild();
    const frames = capture({ id: 's2', pty: true, child });
    child.emit('data', bytes.subarray(0, k));
    child.emit('data', bytes.subarray(k));
    const out = text(frames, 'stdout');
    if (out !== TEXT) firstBad = { split: k, out };
  }
  check('PTY: identical at every byte split point', !firstBad, JSON.stringify(firstBad));
}

// 3. Piped fallback: stdout and stderr decode independently, so a split
//    character on one channel is not corrupted by bytes on the other.
{
  const child = pipedChild();
  const frames = capture({ id: 's3', pty: false, child });
  const a = Buffer.from('\u2713 ok');
  const b = Buffer.from('\u{1F389} err');
  child.stdout.emit('data', a.subarray(0, 1));
  child.stderr.emit('data', b.subarray(0, 2));
  child.stdout.emit('data', a.subarray(1));
  child.stderr.emit('data', b.subarray(2));
  child.emit('exit', 0);
  check('piped: stdout reassembles across chunks', text(frames, 'stdout') === '\u2713 ok', JSON.stringify(text(frames, 'stdout')));
  check('piped: stderr reassembles independently', text(frames, 'stderr') === '\u{1F389} err', JSON.stringify(text(frames, 'stderr')));
}

// 4. A truncated character at exit is flushed (as U+FFFD) before the exit
//    frame rather than silently dropped.
{
  const child = ptyChild();
  const frames = capture({ id: 's4', pty: true, child });
  child.emit('data', Buffer.from('ok ').subarray(0));
  child.emit('data', Buffer.from('\u2713').subarray(0, 1));
  child.emit('pexit', { exitCode: 3 });
  const streams = frames.map((f) => f.stream);
  check('exit flushes a dangling partial character before the exit frame',
    text(frames, 'stdout') === 'ok \uFFFD' && streams[streams.length - 1] === 'exit',
    JSON.stringify(frames));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
