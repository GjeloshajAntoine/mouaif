'use strict';

// Stream multiplexing for a share connection (docs/features/share-project.md).
//
// One WebSocket links two mouaifs and carries every project shared between
// them. Each HTTP request forwarded from the adding mouaif, and each provider
// call borrowed by the sharing machine, is one *stream* on that socket. A
// stream has two halves, like an HTTP exchange:
//
//   opener   -> REQ (JSON head), DATA*, END
//   receiver -> RES (JSON head), DATA*, END
//
// ABORT from either side ends both halves at once. WINDOW returns flow-control
// credit: a sender may have at most WINDOW_BYTES unacknowledged on one stream,
// so a slow download cannot fill memory on the other side and an SSE chat
// stream keeps flowing beside it.
//
// Binary frame layout (one WebSocket binary message per frame):
//
//   byte 0      frame type (REQ=1 RES=2 DATA=3 END=4 ABORT=5 WINDOW=6)
//   bytes 1-4   stream id, unsigned big-endian
//   bytes 5-    payload: JSON for REQ/RES/ABORT, raw bytes for DATA,
//               a 4-byte big-endian credit for WINDOW, empty for END
//
// Control messages (handshake, offers, accept, unshare) are WebSocket *text*
// messages and never reach this module. The dialing side opens odd stream
// ids and the accepting side even ones, so the two never collide.
//
// This module has no network code: `send` is any function that ships a Buffer,
// which keeps it testable without a socket (scripts/test-share-unit.js).

const { EventEmitter } = require('events');

const T = Object.freeze({ REQ: 1, RES: 2, DATA: 3, END: 4, ABORT: 5, WINDOW: 6 });
const WINDOW_BYTES = 1024 * 1024;
// Large chunks (a whole file read) are split so one stream cannot hold the
// socket for long and the receiver's credit is returned in useful steps.
const MAX_CHUNK = 256 * 1024;
// Credit is returned in batches rather than per frame.
const ACK_BATCH = 64 * 1024;

function encodeFrame(type, id, payload) {
  const body = payload == null ? Buffer.alloc(0)
    : Buffer.isBuffer(payload) ? payload
      : payload instanceof Uint8Array ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
        : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  const out = Buffer.allocUnsafe(5 + body.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(id >>> 0, 1);
  body.copy(out, 5);
  return out;
}

function decodeFrame(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 5) throw Object.assign(new Error('frame too short'), { code: 'EFRAME' });
  const type = buf.readUInt8(0);
  if (type < T.REQ || type > T.WINDOW) throw Object.assign(new Error('unknown frame type ' + type), { code: 'EFRAME' });
  return { type, id: buf.readUInt32BE(1), payload: buf.subarray(5) };
}

function parseJsonPayload(payload) {
  try { return JSON.parse(payload.toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('bad JSON frame'), { code: 'EFRAME' }); }
}

// One stream. Events:
//   'head'  (obj)     the other side's head (RES for an opened stream)
//   'data'  (Buffer)  a body chunk; call ack(n) once it has been consumed
//   'end'             the other side finished its half
//   'abort' (reason)  the stream was aborted (by either side or a closed socket)
//   'drain'           credit came back after write() returned false
class MuxStream extends EventEmitter {
  constructor(mux, id, head) {
    super();
    this.mux = mux;
    this.id = id;
    this.head = head || null;
    this.credit = WINDOW_BYTES;
    this.unacked = 0;
    this.localEnded = false;
    this.remoteEnded = false;
    this.aborted = false;
    this.abortReason = null;
  }

  // Send this side's head (RES on a received stream).
  respond(head) {
    if (this.aborted) return;
    this.mux._send(encodeFrame(T.RES, this.id, head || {}));
  }

  // Send body bytes. Returns false when the credit is used up; wait for
  // 'drain' before writing more (writes are still accepted, just not wise).
  write(chunk) {
    if (this.aborted || this.localEnded) return false;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    for (let at = 0; at < buf.length; at += MAX_CHUNK) {
      const part = buf.subarray(at, Math.min(buf.length, at + MAX_CHUNK));
      this.mux._send(encodeFrame(T.DATA, this.id, part));
      this.credit -= part.length;
    }
    return this.credit > 0;
  }

  end() {
    if (this.aborted || this.localEnded) return;
    this.localEnded = true;
    this.mux._send(encodeFrame(T.END, this.id));
    this._maybeDone();
  }

  abort(reason) {
    if (this.aborted) return;
    this._abortLocal(reason || 'aborted', true);
  }

  // Return credit for `n` consumed bytes. Batched: small acks accumulate.
  ack(n) {
    if (this.aborted || !(n > 0)) return;
    this.unacked += n;
    if (this.unacked >= ACK_BATCH || this.remoteEnded) this.flushAck();
  }

  flushAck() {
    if (this.aborted || !this.unacked) return;
    const credit = Buffer.allocUnsafe(4);
    credit.writeUInt32BE(Math.min(this.unacked, 0xffffffff), 0);
    this.unacked = 0;
    this.mux._send(encodeFrame(T.WINDOW, this.id, credit));
  }

  _abortLocal(reason, notifyPeer) {
    this.aborted = true;
    this.abortReason = reason;
    if (notifyPeer) {
      try { this.mux._send(encodeFrame(T.ABORT, this.id, { reason: String(reason).slice(0, 500) })); } catch { /* socket gone */ }
    }
    this.mux.streams.delete(this.id);
    // `local` is true when this side aborted (its own signal), false when the
    // other side or a closed socket ended the stream.
    this.emit('abort', reason, !!notifyPeer);
  }

  _maybeDone() {
    if (this.localEnded && this.remoteEnded) this.mux.streams.delete(this.id);
  }
}

class Mux extends EventEmitter {
  // opts.send(buf)   ship one binary frame
  // opts.dialer      true on the side that opened the WebSocket (odd ids)
  constructor({ send, dialer }) {
    super();
    this.sendFn = send;
    this.nextId = dialer ? 1 : 2;
    this.streams = new Map();
    this.closed = false;
  }

  _send(buf) {
    if (this.closed) throw Object.assign(new Error('share connection closed'), { code: 'ESHARE_OFFLINE' });
    this.sendFn(buf);
  }

  // Open a stream with a REQ head. Returns the MuxStream.
  open(head) {
    if (this.closed) throw Object.assign(new Error('share connection closed'), { code: 'ESHARE_OFFLINE' });
    const id = this.nextId;
    this.nextId += 2;
    if (this.nextId > 0xfffffff0) this.nextId = (id % 2) ? 1 : 2;
    const stream = new MuxStream(this, id, null);
    this.streams.set(id, stream);
    this._send(encodeFrame(T.REQ, id, head || {}));
    return stream;
  }

  // Feed one received binary frame. A stream opened by the other side is
  // announced with the 'stream' event (stream.head is its REQ head).
  handleFrame(buf) {
    const { type, id, payload } = decodeFrame(buf);
    if (type === T.REQ) {
      if (this.streams.has(id)) throw Object.assign(new Error('duplicate stream id ' + id), { code: 'EFRAME' });
      const stream = new MuxStream(this, id, parseJsonPayload(payload));
      this.streams.set(id, stream);
      this.emit('stream', stream);
      return;
    }
    const stream = this.streams.get(id);
    // Frames for a stream that was already aborted locally are normal (they
    // were in flight); drop them.
    if (!stream) return;
    if (type === T.RES) stream.emit('head', parseJsonPayload(payload));
    else if (type === T.DATA) stream.emit('data', Buffer.from(payload));
    else if (type === T.END) { stream.remoteEnded = true; stream.emit('end'); stream._maybeDone(); }
    else if (type === T.ABORT) {
      const reason = (() => { try { return parseJsonPayload(payload).reason || 'aborted'; } catch { return 'aborted'; } })();
      stream._abortLocal(reason, false);
    } else if (type === T.WINDOW) {
      const before = stream.credit;
      stream.credit += payload.length >= 4 ? payload.readUInt32BE(0) : 0;
      if (before <= 0 && stream.credit > 0) stream.emit('drain');
    }
  }

  // The socket is gone: abort every stream.
  close(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const stream of [...this.streams.values()]) stream._abortLocal(reason || 'share connection closed', false);
    this.streams.clear();
  }
}

// Pipe a Node Readable into a stream's body, honouring credit.
function pipeReadableToStream(readable, stream) {
  const onDrain = () => readable.resume();
  stream.on('drain', onDrain);
  stream.once('abort', () => { try { readable.destroy(); } catch { /* gone */ } });
  readable.on('data', (chunk) => { if (!stream.write(chunk)) readable.pause(); });
  readable.on('end', () => stream.end());
  readable.on('error', (e) => stream.abort((e && e.message) || 'read error'));
}

// Pipe a stream's body into a Node Writable, returning credit as it drains.
// Resolves when the other side ends its half; `end` controls whether the
// writable is ended too.
function pipeStreamToWritable(stream, writable, { end = true } = {}) {
  let pending = 0;
  writable.on('drain', () => { if (pending) { stream.ack(pending); pending = 0; stream.flushAck(); } });
  stream.on('data', (chunk) => {
    const ok = writable.write(chunk);
    if (ok) stream.ack(chunk.length);
    else pending += chunk.length;
  });
  stream.once('end', () => { if (end) writable.end(); });
}

// A WHATWG ReadableStream fed by a stream's body (for code that expects a
// fetch() Response body). Credit is returned as the consumer pulls.
function streamToWebReadable(stream) {
  let controller;
  // Bytes handed to the consumer's queue but not yet credited back. They are
  // credited when the consumer asks for more (pull), so a consumer that stops
  // reading stops the sender after one window.
  let queued = 0;
  const rs = new ReadableStream({
    start(c) { controller = c; },
    pull() { if (queued) { stream.ack(queued); queued = 0; } stream.flushAck(); },
    cancel(reason) { stream.abort((reason && reason.message) || 'cancelled'); }
  }, { highWaterMark: 0 });
  stream.on('data', (chunk) => {
    try { controller.enqueue(new Uint8Array(chunk)); queued += chunk.length; } catch { /* closed */ }
  });
  stream.once('end', () => { try { controller.close(); } catch { /* closed */ } });
  stream.once('abort', (reason, local) => {
    const e = new Error(String(reason || 'aborted'));
    // An abort that came from our own side's signal surfaces as AbortError,
    // which is what fetch() bodies throw, so callers keep one error path.
    e.name = local ? 'AbortError' : 'Error';
    try { controller.error(e); } catch { /* closed */ }
  });
  return rs;
}

module.exports = {
  T,
  WINDOW_BYTES,
  MAX_CHUNK,
  encodeFrame,
  decodeFrame,
  Mux,
  MuxStream,
  pipeReadableToStream,
  pipeStreamToWritable,
  streamToWebReadable
};
