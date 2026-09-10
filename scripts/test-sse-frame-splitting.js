'use strict';

// Regression test for SSE frame splitting.
//
// Per the Server-Sent Events spec a line ending is CRLF, LF, or a bare CR,
// and a frame ends at a blank line. readSSE() only recognised LF and CRLF
// (`(?:\r?\n){2}`), so a CR-only stream — old-style proxies, some
// gateways — stayed in the buffer as a single enormous frame whose "data"
// line contained literal CRs and multiple JSON objects. parseSSEFrame()
// then handed back one unparseable string, the server emitted it as a
// `passthrough` event, and the chat showed no text at all.
//
// The test drives the real byte-stream reader with each line-ending form,
// split across chunk boundaries so the buffering path is exercised too.

const assert = require('node:assert/strict');
const { readSSE } = require('../src/ai-stream.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// A byte stream that yields the given chunks in order.
async function* chunks(...parts) {
  for (const part of parts) yield Buffer.from(part, 'utf8');
}

async function collect(stream) {
  const out = [];
  for await (const ev of readSSE(stream)) out.push(ev);
  return out;
}

const PAYLOAD_A = '{"choices":[{"delta":{"content":"one"}}]}';
const PAYLOAD_B = '{"choices":[{"delta":{"content":"two"}}]}';

async function main() {
  const forms = [
    ['LF', '\n\n', `data: ${PAYLOAD_A}\n\ndata: ${PAYLOAD_B}\n\n`],
    ['CRLF', '\r\n\r\n', `data: ${PAYLOAD_A}\r\n\r\ndata: ${PAYLOAD_B}\r\n\r\n`],
    ['CR only', '\r\r', `data: ${PAYLOAD_A}\r\rdata: ${PAYLOAD_B}\r\r`]
  ];

  for (const [label, , wire] of forms) {
    const events = await collect(chunks(wire));
    check(`${label} frames are split into two events`, events.length === 2, 'got ' + events.length);
    check(`${label} payloads parse`, (() => {
      try {
        return JSON.parse(events[0].data).choices[0].delta.content === 'one'
          && JSON.parse(events[1].data).choices[0].delta.content === 'two';
      } catch { return false; }
    })(), JSON.stringify(events.map((e) => e.data)));
    check(`${label} frames carry no stray carriage return`,
      events.every((e) => !e.data.includes('\r')), JSON.stringify(events.map((e) => e.data)));
  }

  // Mixed line endings in one stream, and a named event.
  {
    const events = await collect(chunks(`event: message\ndata: ${PAYLOAD_A}\r\n\r\nevent: message\rdata: ${PAYLOAD_B}\r\r`));
    check('mixed endings in one stream produce one event each',
      events.length === 2 && events.every((e) => e.eventName === 'message'),
      JSON.stringify(events.map((e) => e.eventName)));
    check('the mixed stream keeps both payloads', (() => {
      try {
        return JSON.parse(events[0].data).choices[0].delta.content === 'one'
          && JSON.parse(events[1].data).choices[0].delta.content === 'two';
      } catch { return false; }
    })());
  }

  // A frame split across chunk boundaries must still be reassembled, for
  // every ending form.
  for (const [label, sep, wire] of forms) {
    const cut = Math.floor(wire.length / 2);
    const events = await collect(chunks(wire.slice(0, cut), wire.slice(cut)));
    check(`${label} frames reassemble across chunks`, events.length === 2, 'got ' + events.length);
  }

  // A frame whose separator is itself split across chunks.
  {
    const events = await collect(chunks(`data: ${PAYLOAD_A}\r`, `\rdata: ${PAYLOAD_B}\r\r`));
    check('a separator split across chunks is still consumed', events.length === 2, 'got ' + events.length);
    check('no leading carriage return survives the split', events.every((e) => !e.data.startsWith('\r')),
      JSON.stringify(events.map((e) => e.data)));
  }

  // Heartbeats are comments and must not become events.
  {
    const events = await collect(chunks(': heartbeat\n\n', `data: ${PAYLOAD_A}\n\n`));
    check('comment-only frames are skipped', events.length === 1, 'got ' + events.length);
  }

  // A trailing frame without a blank line is flushed at end of stream.
  {
    const events = await collect(chunks(`data: ${PAYLOAD_A}`));
    check('a trailing frame without a blank line is flushed', events.length === 1, 'got ' + events.length);
  }

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
