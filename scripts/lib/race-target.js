'use strict';

// Content-addressed write target for the cross-process race test.
//
// Every racing writer PUTs a full body of N bytes to the SAME project file.
// Each writer pads with a distinct byte, so the file the race leaves behind
// can be read back and the winning writer identified by its byte:
//
//   bytes 0..N-1 all equal c (c = 1 + writer index)  -> writer c-1's body
//   anything else                                    -> interleaved/corrupt
//
// A byte that never appears in the real bodies is added to every body's
// prefix so a torn body is unambiguous.

// Bytes 1..31 are control characters that never occur in the bodies below,
// which keeps a torn write easy to spot while the body stays a valid UTF-8
// file the file API will happily read and write.
const FIRST_PAD = 0x61; // 'a'
const LAST_PAD = 0x7a;  // 'z'

// bodyFor(writer, size) -> string of exactly `size` bytes.
//
// Writer 0 uses 'a', writer 1 'b', ... Writers beyond the alphabet wrap, so a
// caller keeps the writer count small. The first 8 bytes spell the writer tag
// so a truncated file still names its author.
function bodyFor(writer, size) {
  const pad = String.fromCharCode(FIRST_PAD + (writer % (LAST_PAD - FIRST_PAD + 1)));
  const head = ('w' + writer + '_______').slice(0, 8);
  return (head + pad.repeat(Math.max(0, size - head.length))).slice(0, size);
}

// judgeBody(text, size, writers) -> { ok, winner, reason }
//
// `ok` is true only when `text` is exactly one writer's complete body. The
// test accepts ANY winner: the file API documents last-writer-wins, so the
// race's outcome is a choice between whole bodies, never a torn one.
function judgeBody(text, size, writers) {
  if (typeof text !== 'string') return { ok: false, winner: null, reason: 'body missing' };
  if (text.length !== size) return { ok: false, winner: null, reason: 'length ' + text.length + ' != ' + size };
  for (let w = 0; w < writers; w += 1) {
    if (text === bodyFor(w, size)) return { ok: true, winner: w, reason: 'whole body from writer ' + w };
  }
  // Name the corruption precisely: the byte that disagrees with writer 0's
  // body is where the tear starts.
  const expected = bodyFor(0, size);
  for (let i = 0; i < size; i += 1) {
    if (text[i] !== expected[i]) {
      return { ok: false, winner: null, reason: 'torn at byte ' + i + ': 0x' + text.charCodeAt(i).toString(16) };
    }
  }
  return { ok: false, winner: null, reason: 'body does not match any writer' };
}

module.exports = { bodyFor, judgeBody, FIRST_PAD, LAST_PAD };