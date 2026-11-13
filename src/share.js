'use strict';

// Share a project with another mouaif (docs/features/share-project.md).
//
// Two roles, one module:
//
//   sharing machine  has the folder. It dials the other mouaif at
//                    wss://<address>/api/share, so nothing is opened on its own
//                    network. Forwarded requests arrive over that socket and run
//                    through the normal route table as a "share caller".
//   adding mouaif    accepts the socket, lists the offer under "Shared with
//                    me", and once the project is added, forwards
//                    /s/<share>/<path> to the sharing machine. In phase 2 it
//                    also makes the provider calls for the shared project's
//                    chats with its own credentials ("borrowed providers").
//
// One connection per pair of mouaifs carries every project shared between
// them; the multiplexing lives in src/share-mux.js, the rules in
// src/share-gate.js and the stored state in src/share-store.js.
//
// The handshake signs fresh nonces with each side's Ed25519 key, so after the
// first-time code the two recognise each other by key, not by address.

const crypto = require('node:crypto');
const http = require('node:http');
const { duplexPair } = require('node:stream');

const store = require('./share-store.js');
const gate = require('./share-gate.js');
const { Mux, pipeReadableToStream, pipeStreamToWritable, streamToWebReadable } = require('./share-mux.js');

const PROTO = 1;
const PROTO_HEADER = 'x-mouaif-share-proto';
const HANDSHAKE_MS = 10_000;
const RPC_TIMEOUT_MS = 15_000;
const PING_MS = 25_000;
const MAX_BODY = 64 * 1024 * 1024;
const MAX_PAYLOAD = 16 * 1024 * 1024;
const MAX_UNPAIRED_CONNECTIONS = 8;
const MAX_UNPAIRED_OFFERS = 20;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000];
const BORROW_IDLE_MS = 180_000;

// Request headers the adding mouaif passes on. Cookies, Origin and
// Authorization belong to the adding mouaif's own session and never travel.
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'last-event-id', 'range', 'if-none-match', 'if-modified-since', 'cache-control'];
// Response headers that must not come back: they describe the internal
// in-memory connection or would set state on the adding mouaif's origin.
const DROP_RESPONSE_HEADERS = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'www-authenticate', 'content-length']);

let wsMod = null;
function loadWs() { return wsMod || (wsMod = require('ws')); }

const state = {
  server: null,
  serverConfig: null,
  wss: null,
  conns: new Map(),       // peerId -> Conn (authenticated, either direction)
  dialers: new Map(),     // peerId -> { stopped, timer, attempt, connecting }
  unpaired: 0,
  upgradeAttempts: new Map()
};

function typed(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

// ---- Rules ---------------------------------------------------------------------

// Sharing and adding both need app access (`--auth`) with an account set up:
// a share exposes a folder, so the mouaif doing it must not be open to anyone
// who can reach it.
function enabled() {
  const cfg = state.serverConfig;
  if (!cfg || !cfg.authEnabled) return false;
  try { return require('./access-auth.js').configured(); } catch { return false; }
}

function requireEnabled() {
  if (!enabled()) throw typed('ESHARE_AUTH_REQUIRED', 'Sharing needs app access: start mouaif with --auth and set up an account first.', 403);
}

// ---- Connection object -----------------------------------------------------------

class Conn {
  constructor({ ws, peerId, direction, machine, remotePaired }) {
    this.ws = ws;
    this.peerId = peerId;
    this.direction = direction;   // 'out' = we dialed (we share), 'in' = they dialed (they share)
    this.machine = machine || '';
    this.remotePaired = !!remotePaired;
    this.rpcs = new Map();
    this.nextRid = 1;
    this.alive = true;
    this.mux = new Mux({ send: (buf) => this._sendRaw(buf), dialer: direction === 'out' });
    this.mux.on('stream', (stream) => onStream(this, stream));
  }

  _sendRaw(data) {
    if (this.ws.readyState !== 1) throw typed('ESHARE_OFFLINE', 'share connection closed');
    this.ws.send(data);
  }

  send(msg) {
    try { this._sendRaw(JSON.stringify(msg)); return true; } catch { return false; }
  }

  rpc(msg) {
    const rid = this.nextRid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.rpcs.delete(rid); reject(typed('ESHARE_TIMEOUT', 'The other mouaif did not answer in time')); }, RPC_TIMEOUT_MS);
      this.rpcs.set(rid, { resolve, reject, timer });
      if (!this.send(Object.assign({}, msg, { rid }))) {
        clearTimeout(timer); this.rpcs.delete(rid);
        reject(typed('ESHARE_OFFLINE', 'The other mouaif is offline'));
      }
    });
  }

  close(reason) {
    this.mux.close(reason || 'share connection closed');
    for (const { reject, timer } of this.rpcs.values()) { clearTimeout(timer); reject(typed('ESHARE_OFFLINE', 'The other mouaif went offline')); }
    this.rpcs.clear();
    try { this.ws.close(1000, String(reason || '').slice(0, 100)); } catch { /* gone */ }
    setTimeout(() => { try { this.ws.terminate(); } catch { /* gone */ } }, 2000).unref();
  }
}

function registerConn(conn) {
  const old = state.conns.get(conn.peerId);
  if (old && old !== conn) old.close('replaced by a newer connection');
  state.conns.set(conn.peerId, conn);
  const ws = conn.ws;
  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary) conn.mux.handleFrame(data);
      else onControl(conn, JSON.parse(String(data)));
    } catch (e) {
      console.warn('[mouaif] share: bad frame from ' + (conn.machine || conn.peerId) + ': ' + e.message);
      conn.close('protocol error');
    }
  });
  ws.on('pong', () => { conn.alive = true; });
  const ping = setInterval(() => {
    if (!conn.alive) { try { ws.terminate(); } catch { /* gone */ } return; }
    conn.alive = false;
    try { ws.ping(); } catch { /* closing */ }
  }, PING_MS);
  ping.unref();
  ws.on('close', () => {
    clearInterval(ping);
    conn.close('share connection closed');
    if (state.conns.get(conn.peerId) === conn) state.conns.delete(conn.peerId);
    if (conn.direction === 'in' && conn.unpaired) {
      state.unpaired = Math.max(0, state.unpaired - 1);
      forgetUnpaired(conn.peerId);
    }
    if (conn.direction === 'out') scheduleRedial(conn.peerId);
  });
  ws.on('error', () => { /* 'close' follows */ });
}

// ---- Handshake: the sharing machine dials -------------------------------------------

function nonce() { return crypto.randomBytes(24).toString('base64url'); }

// One connection attempt to an outgoing peer. Resolves the Conn or rejects with
// a typed error the share sheet can show.
function dial(peer) {
  const WebSocket = loadWs().WebSocket;
  const me = store.identity();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => { if (settled) return; settled = true; try { ws.terminate(); } catch { /* gone */ } reject(e); };
    const ws = new WebSocket(store.wsUrlFor(peer.address), {
      headers: { [PROTO_HEADER]: String(PROTO) },
      perMessageDeflate: false,
      maxPayload: MAX_PAYLOAD,
      handshakeTimeout: HANDSHAKE_MS
    });
    const timer = setTimeout(() => fail(typed('ESHARE_UNREACHABLE', 'The other mouaif did not answer at ' + peer.address)), HANDSHAKE_MS + 2000);
    ws.on('unexpected-response', (req, res) => {
      let text = '';
      res.on('data', (c) => { if (text.length < 4096) text += c; });
      res.on('end', () => {
        let body = {};
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        if (res.statusCode === 404) fail(typed('ESHARE_NOT_MOUAIF', 'No mouaif that accepts shares answers at ' + peer.address + ' (it may be an older version).'));
        else fail(typed(body.code || 'ESHARE_REFUSED', body.error || ('The other mouaif refused the connection (HTTP ' + res.statusCode + ')')));
      });
    });
    ws.on('error', (e) => fail(typed('ESHARE_UNREACHABLE', 'Could not reach ' + peer.address + ': ' + (e.code || e.message))));
    ws.on('close', () => fail(typed('ESHARE_UNREACHABLE', 'The connection to ' + peer.address + ' closed during setup')));
    const myNonce = nonce();
    let step = 'hello';
    let remote = null;
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', v: PROTO, machine: store.machineName(), pub: me.publicKey, nonce: myNonce }));
    });
    ws.on('message', function onMessage(data, isBinary) {
      if (settled || isBinary) return fail(typed('EPROTO', 'Unexpected data during the share handshake'));
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return fail(typed('EPROTO', 'Bad handshake message')); }
      if (msg.t === 'error') return fail(typed(msg.code || 'ESHARE_REFUSED', msg.message || 'The other mouaif refused the connection'));
      if (step === 'hello' && msg.t === 'hello') {
        if (msg.v !== PROTO) return fail(protoError(msg.v));
        if (!store.verify(msg.pub, 'mouaif-share/b/' + myNonce + '/' + me.publicKey, msg.sig)) {
          return fail(typed('EIDENTITY', 'The other mouaif could not prove its identity'));
        }
        if (peer.paired && peer.publicKey && peer.publicKey !== msg.pub) {
          return fail(typed('EIDENTITY', 'The mouaif at ' + peer.address + ' is not the one this project was shared with (its key changed). Stop sharing and share again.'));
        }
        remote = msg;
        ws.send(JSON.stringify({ t: 'auth', sig: store.sign('mouaif-share/a/' + msg.nonce + '/' + msg.pub) }));
        step = 'ready';
        return;
      }
      if (step === 'ready' && msg.t === 'ready') {
        clearTimeout(timer);
        settled = true;
        ws.removeListener('message', onMessage);
        ws.removeAllListeners('close');
        ws.removeAllListeners('error');
        store.updatePeer(peer.id, { publicKey: remote.pub, machine: String(remote.machine || '').slice(0, 64), lastSeen: new Date().toISOString() });
        // The other side no longer knows us (its store was reset): a new code
        // is needed before anything can be added again.
        if (!msg.paired && peer.paired) store.updatePeer(peer.id, { paired: false });
        const conn = new Conn({ ws, peerId: peer.id, direction: 'out', machine: remote.machine, remotePaired: !!msg.paired });
        registerConn(conn);
        sendOffers(conn);
        return resolve(conn);
      }
      return fail(typed('EPROTO', 'Unexpected handshake message'));
    });
  });
}

function protoError(v) {
  return typed('EPROTO', 'The other mouaif speaks share protocol v' + v + ', this one v' + PROTO + '. Update both to the same mouaif version.');
}

// ---- Handshake: the adding mouaif accepts ---------------------------------------------

function rejectUpgrade(socket, status, code, message) {
  const body = JSON.stringify({ error: message, code });
  try {
    socket.write('HTTP/1.1 ' + status + ' ' + (http.STATUS_CODES[status] || 'Error') + '\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
    socket.end();
  } catch { /* gone */ }
}

function upgradeAllowed(req) {
  const key = String(req.socket && req.socket.remoteAddress || 'unknown');
  const t = Date.now();
  const recent = (state.upgradeAttempts.get(key) || []).filter((at) => t - at < 60_000);
  recent.push(t);
  state.upgradeAttempts.set(key, recent);
  if (state.upgradeAttempts.size > 1000) state.upgradeAttempts.clear();
  return recent.length <= 30;
}

// The `upgrade` router in src/http-server.js sends /api/share here.
function handleUpgrade(req, socket, head) {
  if (!enabled()) return rejectUpgrade(socket, 403, 'ESHARE_AUTH_REQUIRED', 'This mouaif does not accept shared projects: it must run with app access (--auth) and an account set up.');
  const proto = Number(req.headers[PROTO_HEADER]);
  if (proto !== PROTO) return rejectUpgrade(socket, 426, 'EPROTO', 'This mouaif speaks share protocol v' + PROTO + ', the sharing one v' + (proto || '?') + '. Update both to the same mouaif version.');
  if (!upgradeAllowed(req)) return rejectUpgrade(socket, 429, 'ERATE', 'Too many share connections, try again in a minute');
  if (!state.wss) state.wss = new (loadWs().WebSocketServer)({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD });
  state.wss.handleUpgrade(req, socket, head, (ws) => acceptSocket(ws));
}

function acceptSocket(ws) {
  const me = store.identity();
  const myNonce = nonce();
  let step = 'hello';
  let remote = null;
  const timer = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, HANDSHAKE_MS);
  const refuse = (code, message) => {
    clearTimeout(timer);
    try { ws.send(JSON.stringify({ t: 'error', code, message })); } catch { /* gone */ }
    try { ws.close(1008, code); } catch { /* gone */ }
  };
  ws.on('error', () => { /* close follows */ });
  ws.on('close', () => clearTimeout(timer));
  ws.on('message', function onMessage(data, isBinary) {
    if (isBinary) return refuse('EPROTO', 'Unexpected data during the share handshake');
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return refuse('EPROTO', 'Bad handshake message'); }
    if (step === 'hello' && msg.t === 'hello') {
      if (msg.v !== PROTO) return refuse('EPROTO', protoError(msg.v).message);
      if (typeof msg.pub !== 'string' || typeof msg.nonce !== 'string') return refuse('EPROTO', 'Bad hello');
      remote = msg;
      ws.send(JSON.stringify({
        t: 'hello', v: PROTO, machine: store.machineName(), pub: me.publicKey, nonce: myNonce,
        sig: store.sign('mouaif-share/b/' + msg.nonce + '/' + msg.pub)
      }));
      step = 'auth';
      return;
    }
    if (step === 'auth' && msg.t === 'auth') {
      if (!store.verify(remote.pub, 'mouaif-share/a/' + myNonce + '/' + me.publicKey, msg.sig)) return refuse('EIDENTITY', 'The sharing mouaif could not prove its identity');
      const peer = store.incomingPeerFor(remote.pub, String(remote.machine || '').slice(0, 64));
      if (!peer.paired && !state.conns.has(peer.id) && state.unpaired >= MAX_UNPAIRED_CONNECTIONS) {
        return refuse('ERATE', 'Too many pending shares on this mouaif');
      }
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      const conn = new Conn({ ws, peerId: peer.id, direction: 'in', machine: peer.machine });
      if (!peer.paired) { conn.unpaired = true; state.unpaired++; }
      registerConn(conn);
      conn.send({ t: 'ready', paired: peer.paired });
      return;
    }
    return refuse('EPROTO', 'Unexpected handshake message');
  });
}

// An unpaired sharer exists only while it is connected: its offers can only be
// added while it is online anyway, and anyone who can reach this mouaif can
// open such a connection, so nothing of it is kept once it leaves. A paired
// sharer's offers stay (shown offline) until it reconnects.
function forgetUnpaired(peerId) {
  if (state.conns.has(peerId)) return;
  const peer = store.getPeer(peerId);
  if (!peer || peer.paired || peer.direction !== 'in') return;
  for (const s of store.listShares({ direction: 'in', peerId, includeRemoved: true })) store.deleteShare(s.id);
  store.deletePeer(peerId);
}

function acceptOffer(conn, offer) {
  const peer = store.getPeer(conn.peerId);
  if (!peer.paired && !store.getShare(offer.id)
    && store.listShares({ direction: 'in', peerId: conn.peerId }).length >= MAX_UNPAIRED_OFFERS) return null;
  const row = store.upsertIncomingShare(Object.assign({ peerId: conn.peerId }, offer));
  if (row && row.status === 'removed') conn.send({ t: 'unshare', id: row.id });
  return row;
}

// ---- Outgoing connections: start, backoff, stop ------------------------------------------

function liveOutgoingShares(peerId) {
  return store.listShares({ direction: 'out', peerId, includeRemoved: true });
}

// Open (or reuse) the connection to an outgoing peer. Resolves the Conn.
async function connectPeer(peerId) {
  const existing = state.conns.get(peerId);
  if (existing && existing.ws.readyState === 1) return existing;
  let d = state.dialers.get(peerId);
  if (!d) { d = { stopped: false, timer: null, attempt: 0, connecting: null }; state.dialers.set(peerId, d); }
  d.stopped = false;
  if (d.timer) { clearTimeout(d.timer); d.timer = null; }
  if (!d.connecting) {
    const peer = store.getPeer(peerId);
    d.connecting = dial(peer).then((conn) => { d.attempt = 0; return conn; })
      .finally(() => { d.connecting = null; });
  }
  return d.connecting;
}

function scheduleRedial(peerId) {
  const d = state.dialers.get(peerId);
  if (!d || d.stopped || !state.server) return;
  if (!liveOutgoingShares(peerId).length) { stopPeer(peerId); return; }
  if (d.timer) return;
  const delay = BACKOFF_MS[Math.min(d.attempt, BACKOFF_MS.length - 1)];
  d.attempt++;
  d.timer = setTimeout(() => {
    d.timer = null;
    if (d.stopped) return;
    connectPeer(peerId).catch(() => scheduleRedial(peerId));
  }, delay);
  d.timer.unref();
}

function stopPeer(peerId) {
  const d = state.dialers.get(peerId);
  if (d) { d.stopped = true; if (d.timer) clearTimeout(d.timer); state.dialers.delete(peerId); }
  const conn = state.conns.get(peerId);
  if (conn && conn.direction === 'out') { state.conns.delete(peerId); conn.close('no more shared projects'); }
}

// ---- Control messages ---------------------------------------------------------------------

function offerFor(share) {
  return { id: share.id, dir: share.projectDir, name: share.projectName || '', access: share.access };
}

function sendOffers(conn) {
  const shares = liveOutgoingShares(conn.peerId);
  // Shares stopped while the other side was offline are dropped now that it
  // learns about it from the full list.
  for (const s of shares) if (s.status === 'removed') store.deleteShare(s.id);
  const live = shares.filter((s) => s.status !== 'removed');
  conn.send({ t: 'offers', shares: live.map(offerFor), paired: !!(store.getPeer(conn.peerId) || {}).paired });
  if (!live.length) stopPeer(conn.peerId);
}

function reply(conn, rid, body) {
  conn.send(Object.assign({ t: 'reply', rid }, body));
}

function onControl(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'reply') {
    const pending = conn.rpcs.get(msg.rid);
    if (!pending) return;
    conn.rpcs.delete(msg.rid);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg);
    else pending.reject(typed(msg.code || 'ESHARE_REFUSED', msg.error || 'Refused by the other mouaif', msg.status));
    return;
  }
  if (conn.direction === 'in') return onControlFromSharer(conn, msg);
  return onControlFromAdder(conn, msg);
}

// The adding mouaif hears from the sharing machine.
function onControlFromSharer(conn, msg) {
  if (msg.t === 'offers' && Array.isArray(msg.shares)) {
    const peer = store.getPeer(conn.peerId);
    const offered = new Set();
    const list = peer.paired ? msg.shares : msg.shares.slice(0, MAX_UNPAIRED_OFFERS);
    for (const raw of list) {
      const offer = cleanOffer(raw);
      if (!offer) continue;
      offered.add(offer.id);
      acceptOffer(conn, offer);
    }
    // Anything this peer no longer offers was stopped while we were apart.
    for (const s of store.listShares({ direction: 'in', peerId: conn.peerId, includeRemoved: true })) {
      if (!offered.has(s.id)) store.deleteShare(s.id);
    }
    // The sharing machine forgot the pairing: a new code is needed.
    if (peer.paired && msg.paired === false) store.updatePeer(peer.id, { paired: false });
    return;
  }
  if (msg.t === 'offer') {
    const offer = cleanOffer(msg.share);
    if (offer) acceptOffer(conn, offer);
    return;
  }
  if (msg.t === 'unshare') {
    const s = store.getShare(msg.id);
    if (s && s.direction === 'in' && s.peerId === conn.peerId) store.deleteShare(s.id);
  }
}

function cleanOffer(raw) {
  if (!raw || typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(raw.id)) return null;
  if (typeof raw.dir !== 'string' || !raw.dir || raw.dir.length > 4096) return null;
  return {
    id: raw.id,
    projectDir: raw.dir,
    projectName: String(raw.name || '').slice(0, 200),
    access: raw.access === 'full' ? 'full' : 'files'
  };
}

// The sharing machine hears from the adding mouaif.
function onControlFromAdder(conn, msg) {
  if (msg.t === 'accept') {
    const share = store.getShare(msg.id);
    if (!share || share.direction !== 'out' || share.peerId !== conn.peerId || share.status === 'removed') {
      return reply(conn, msg.rid, { ok: false, code: 'ESHARE_NOT_FOUND', error: 'This share was stopped on the sharing machine' });
    }
    const peer = store.getPeer(conn.peerId);
    if (!peer.paired) {
      const outcome = store.consumeCode(peer.id, msg.code);
      if (outcome !== 'ok') {
        const error = outcome === 'expired' ? 'The code expired. Ask for a new one on the sharing machine.'
          : outcome === 'locked' ? 'Too many wrong codes. Ask for a new one on the sharing machine.'
            : outcome === 'missing' ? 'No code is waiting. Ask for a new one on the sharing machine.'
              : 'That code is not right';
        return reply(conn, msg.rid, { ok: false, code: outcome === 'wrong' ? 'ESHARE_CODE' : 'ESHARE_CODE_' + outcome.toUpperCase(), error });
      }
      store.updatePeer(peer.id, { paired: true });
    }
    store.setShareStatus(share.id, 'active');
    reply(conn, msg.rid, { ok: true, id: share.id });
    notifyAccepted(conn, share);
    return;
  }
  if (msg.t === 'unshare') {
    const s = store.getShare(msg.id);
    if (s && s.direction === 'out' && s.peerId === conn.peerId) store.deleteShare(s.id);
    if (!liveOutgoingShares(conn.peerId).length) stopPeer(conn.peerId);
  }
}

function notifyAccepted(conn, share) {
  try {
    require('./push.js').sendPushToAll({
      title: 'Project shared',
      body: (conn.machine || 'Another mouaif') + ' added ' + (share.projectName || share.projectDir),
      tag: 'share-' + share.id,
      data: { url: '/#/projects' }
    });
  } catch { /* push is best-effort */ }
}

// ---- Streams: forwarded requests and borrowed provider calls --------------------------------

const MAX_STREAMS = 256;

function onStream(conn, stream) {
  const head = stream.head || {};
  // One peer cannot hold an unbounded number of requests open here.
  if (conn.mux.streams.size > MAX_STREAMS) { stream.abort('too many open requests'); return; }
  if (head.k === 'http' && conn.direction === 'out') return serveForwarded(conn, stream, head);
  if (head.k === 'borrow' && conn.direction === 'in') return serveBorrow(conn, stream, head);
  stream.respond({ status: 400, error: { code: 'EPROTO', message: 'Unknown stream kind' } });
  stream.end();
}

function respondJson(stream, status, body) {
  stream.respond({ status, headers: { 'content-type': 'application/json' } });
  stream.write(Buffer.from(JSON.stringify(body)));
  stream.end();
}

// Read a stream's request body into one Buffer (with a cap).
function readStreamBody(stream, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { stream.abort('request body too large'); return reject(typed('ETOOLARGE', 'Request body too large', 413)); }
      parts.push(chunk);
      stream.ack(chunk.length);
    });
    stream.once('end', () => resolve(Buffer.concat(parts)));
    stream.once('abort', (reason) => reject(typed('EABORTED', String(reason || 'aborted'))));
  });
}

function cliSessionDir(id) {
  if (!id) return null;
  try {
    const s = require('./server-handlers-tools.js').findCliSessionById(String(id));
    return s ? s.projectDir : null;
  } catch { return null; }
}

// Sharing machine: run one forwarded request through the local route table.
async function serveForwarded(conn, stream, head) {
  const share = store.getShare(head.share);
  if (!share || share.direction !== 'out' || share.peerId !== conn.peerId || share.status !== 'active') {
    return respondJson(stream, 404, { error: 'This project is no longer shared', code: 'ESHARE_NOT_FOUND' });
  }
  let body;
  try { body = await readStreamBody(stream); }
  catch (e) { if (!stream.aborted) respondJson(stream, e.status || 400, { error: e.message, code: e.code }); return; }
  const method = String(head.method || 'GET').toUpperCase();
  const target = String(head.path || '/');
  const { parseRequestTarget } = require('./util.js');
  const parsed = parseRequestTarget(target);
  let json = null;
  const ctype = String((head.headers && head.headers['content-type']) || '');
  if (body.length && /json/i.test(ctype)) {
    try { json = JSON.parse(body.toString('utf8')); } catch { json = null; }
  }
  try {
    gate.checkRequest({ share, method, urlPath: parsed.pathname, query: parsed.query, body: json, hooks: { cliSessionDir } });
  } catch (e) {
    return respondJson(stream, e.status || 403, { error: e.message, code: e.code || 'ESHARE_ROUTE' });
  }
  if (!state.server) return respondJson(stream, 503, { error: 'Server not ready', code: 'ESHARE_OFFLINE' });
  // Feed the request into the local server over an in-memory connection.
  // The server end of the pair is marked as a share caller: the route table
  // sees `req.socket.mouaifShare` and skips the browser session gates, which
  // a forwarded request has no cookie for (src/http-server.js).
  const [clientEnd, serverEnd] = duplexPair();
  serverEnd.mouaifShare = Object.freeze({
    shareId: share.id,
    peerId: conn.peerId,
    projectDir: share.projectDir,
    access: share.access,
    machine: conn.machine,
    borrow: true
  });
  serverEnd.remoteAddress = 'share:' + conn.peerId;
  state.server.emit('connection', serverEnd);
  const headers = { host: 'mouaif-share', connection: 'close' };
  for (const key of FORWARD_REQUEST_HEADERS) {
    const v = head.headers && head.headers[key];
    if (typeof v === 'string' && v) headers[key] = v;
  }
  if (body.length) headers['content-length'] = String(body.length);
  const creq = http.request({ createConnection: () => clientEnd, method, path: target, headers });
  stream.once('abort', () => { try { creq.destroy(); } catch { /* gone */ } try { clientEnd.destroy(); } catch { /* gone */ } });
  creq.on('response', (res) => {
    const out = {};
    for (const [k, v] of Object.entries(res.headers)) if (!DROP_RESPONSE_HEADERS.has(k)) out[k] = v;
    stream.respond({ status: res.statusCode, headers: out });
    pipeReadableToStream(res, stream);
  });
  creq.on('error', (e) => {
    if (stream.aborted) return;
    stream.abort('forwarded request failed: ' + (e.message || e));
  });
  creq.end(body.length ? body : undefined);
}

// Adding mouaif: forward /s/<share>/<path> to the sharing machine.
function handleForward(req, res, parsed) {
  const { sendJSON } = require('./server-shared.js');
  if (!enabled()) return sendJSON(res, 403, { error: 'Sharing needs app access (--auth)', code: 'ESHARE_AUTH_REQUIRED' });
  const m = /^\/s\/([A-Za-z0-9_-]{8,64})(\/.*)$/.exec(parsed.pathname);
  if (!m) return sendJSON(res, 404, { error: 'Not found' });
  const share = store.getShare(m[1]);
  if (!share || share.direction !== 'in' || share.status !== 'active') {
    return sendJSON(res, 404, { error: 'This shared project is not added here', code: 'ESHARE_NOT_FOUND' });
  }
  const conn = state.conns.get(share.peerId);
  if (!conn) return sendJSON(res, 503, { error: 'The sharing machine is offline', code: 'ESHARE_OFFLINE' });
  // The rest of the original URL, query included, still percent-encoded.
  const target = String(req.url || '').slice(('/s/' + m[1]).length) || '/';
  const headers = {};
  for (const key of FORWARD_REQUEST_HEADERS) {
    const v = req.headers[key];
    if (typeof v === 'string' && v) headers[key] = v;
  }
  let stream;
  try { stream = conn.mux.open({ k: 'http', share: share.id, method: req.method, path: target, headers }); }
  catch (e) { return sendJSON(res, 503, { error: 'The sharing machine is offline', code: 'ESHARE_OFFLINE' }); }
  let done = false;
  pipeReadableToStream(req, stream);
  stream.once('head', (h) => {
    const status = Number(h.status) || 502;
    const out = {};
    for (const [k, v] of Object.entries(h.headers || {})) if (!DROP_RESPONSE_HEADERS.has(String(k).toLowerCase())) out[k] = v;
    res.writeHead(status, out);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    pipeStreamToWritable(stream, res);
    stream.once('end', () => { done = true; });
  });
  stream.once('abort', (reason) => {
    done = true;
    if (!res.headersSent) sendJSON(res, 502, { error: 'The sharing machine dropped the request: ' + reason, code: 'ESHARE_DROPPED' });
    else { try { res.destroy(); } catch { /* gone */ } }
  });
  res.on('close', () => { if (!done) stream.abort('client disconnected'); });
}

// ---- Phase 2: borrowed providers -------------------------------------------------------------
// The sharing machine sends provider-neutral inputs (model id, messages, tool
// specs); the adding mouaif runs buildRequest with its own credentials, calls
// the provider, and pipes the raw response back. parseEvent runs unchanged on
// the sharing machine. The adding side only signs requests for models it
// offers, so the connection is never a general credential-signing proxy.

// Sharing machine: called from runUpstreamTurn for a model with `borrowed`.
// Resolves a fetch()-Response-like object.
function borrowFetch({ model, messages, specs, requestOpts, signal }) {
  const b = model && model.borrowed;
  const conn = b && state.conns.get(b.peerId);
  if (!conn) return Promise.reject(typed('ESHARE_OFFLINE', 'The mouaif this project was added on is offline, so its providers are unavailable. Open the project there again, or use it directly with this machine\'s own providers.'));
  const options = {};
  if (model.thinkingLevel) options.thinkingLevel = String(model.thinkingLevel);
  if (model.maxOutputTokens) options.maxOutputTokens = String(model.maxOutputTokens);
  let stream;
  try {
    stream = conn.mux.open({ k: 'borrow', share: b.shareId, providerId: model.provider, modelId: model.id, options });
  } catch (e) { return Promise.reject(typed('ESHARE_OFFLINE', e.message)); }
  stream.write(Buffer.from(JSON.stringify({
    messages,
    specs: Array.isArray(specs) ? specs : [],
    promptCacheKey: requestOpts && requestOpts.promptCacheKey || null
  })));
  stream.end();
  const onAbort = () => stream.abort((signal.reason && signal.reason.message) || 'aborted');
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return new Promise((resolve, reject) => {
    stream.once('head', (h) => {
      if (h.error) {
        if (signal) signal.removeEventListener('abort', onAbort);
        return reject(Object.assign(typed(h.error.code || 'EBORROW', h.error.message || 'The adding mouaif refused the provider call'), { borrowed: true }));
      }
      const body = streamToWebReadable(stream);
      const meta = h.meta || {};
      const status = Number(h.status) || 502;
      const readAll = async () => {
        const chunks = [];
        for await (const c of body) chunks.push(Buffer.from(c));
        return Buffer.concat(chunks).toString('utf8');
      };
      stream.once('end', () => { if (signal) signal.removeEventListener('abort', onAbort); });
      resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText: h.statusText || '',
        body,
        meta,
        text: readAll,
        json: async () => JSON.parse(await readAll())
      });
    });
    stream.once('abort', (reason, local) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      const e = new Error(String(reason || 'aborted'));
      if (local) e.name = 'AbortError';
      else { e.code = 'ESHARE_DROPPED'; e.borrowed = true; }
      reject(e);
    });
  });
}

// The model record a share caller's chat runs with on the sharing machine.
// Identity and safe selection metadata only: there is no credential here.
function borrowedModel(modelId, providerId, projectDir, caller) {
  const ai = require('./ai.js');
  const provider = typeof providerId === 'string' ? providerId.trim() : '';
  if (!provider) throw typed('EBADINPUT', 'Pick a model again: a shared project needs the provider of its model');
  if (!ai.ENDPOINTS[provider]) throw typed('EUNKNOWN_PROVIDER', 'Unknown provider: ' + provider);
  const { projectModelRecord } = require('./util.js');
  let meta = {};
  try {
    const list = require('./settings.js').getResolved(projectDir || null).models || [];
    const hit = list.find((m) => m && m.id === modelId && m.provider === provider);
    if (hit) meta = projectModelRecord(hit);
  } catch { /* metadata is optional */ }
  return Object.assign({}, meta, {
    id: modelId,
    provider,
    auth: 'borrowed',
    borrowed: { peerId: caller.peerId, shareId: caller.shareId, machine: caller.machine || '' }
  });
}

// Adding mouaif: does it offer this model? Returns the catalog row or null.
async function offeredModel(providerId, modelId) {
  const settings = require('./settings.js');
  const providers = settings.getApp().providers || [];
  if (!providers.some((p) => p && p.id === providerId)) return null;
  const configured = (settings.getResolved(null).models || []).find((m) => m && m.id === modelId && m.provider === providerId);
  if (configured) return configured;
  const modelList = require('./modelList.js');
  for (const purpose of ['chat', 'image']) {
    try {
      const out = await modelList.liveModelsFor(providerId, { purpose });
      const hit = (out.models || []).find((m) => m && m.id === modelId);
      if (hit) return hit;
    } catch { /* the provider cannot list: not offered */ }
  }
  return null;
}

async function serveBorrow(conn, stream, head) {
  const fail = (code, message, status = 403) => {
    if (stream.aborted) return;
    stream.respond({ status, error: { code, message } });
    stream.end();
  };
  const share = store.getShare(head.share);
  if (!share || share.direction !== 'in' || share.peerId !== conn.peerId || share.status !== 'active') {
    return fail('ESHARE_NOT_ADDED', 'This project is not added on the mouaif whose providers it asked for');
  }
  let input;
  try { input = JSON.parse((await readStreamBody(stream)).toString('utf8')); }
  catch (e) { return fail(e.code || 'EBADINPUT', e.message, 400); }
  const providerId = String(head.providerId || '');
  const modelId = String(head.modelId || '');
  if (!providerId || !modelId || !Array.isArray(input && input.messages)) return fail('EBADINPUT', 'Missing model or messages', 400);
  const offered = await offeredModel(providerId, modelId).catch(() => null);
  if (!offered) return fail('EMODEL_NOT_OFFERED', 'The mouaif this project was added on does not offer ' + providerId + ' / ' + modelId + '. Pick one of its models.');

  const ai = require('./ai-endpoints.js');
  const { projectModelRecord } = require('./util.js');
  let model;
  let def;
  let req;
  try {
    // resolveModel hydrates the provider connection (credentials, base URL)
    // from this mouaif's app settings; the catalog row adds only selection
    // metadata (image API, modalities). Nothing from the peer reaches the
    // transport fields.
    model = require('./server-shared.js').resolveModel(modelId, null, providerId);
    const meta = projectModelRecord(offered);
    delete meta.provider;
    delete meta.id;
    model = Object.assign({}, meta, model);
    const opts = head.options || {};
    if (typeof opts.thinkingLevel === 'string' && opts.thinkingLevel) model.thinkingLevel = opts.thinkingLevel.slice(0, 32);
    if (typeof opts.maxOutputTokens === 'string' && /^\d{1,7}$/.test(opts.maxOutputTokens)) model.maxOutputTokens = opts.maxOutputTokens;
    def = ai.endpointFor(model);
    await ai.requireApiKey(model, def);
    const specs = Array.isArray(input.specs) ? input.specs : [];
    req = require('./ai-stream.js').buildUpstreamRequest(model, input.messages, specs,
      { promptCacheKey: typeof input.promptCacheKey === 'string' ? input.promptCacheKey.slice(0, 64) : null });
  } catch (e) {
    return fail(e.code || 'EBORROW', e.message || String(e), 400);
  }
  if (stream.aborted) return;
  const ctl = new AbortController();
  let idle = null;
  const resetIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => ctl.abort(new Error('provider idle timeout')), BORROW_IDLE_MS);
  };
  resetIdle();
  stream.once('abort', () => { try { ctl.abort(new Error('aborted by the sharing machine')); } catch { /* settled */ } });
  let upstream;
  try {
    upstream = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ctl.signal });
  } catch (e) {
    clearTimeout(idle);
    return fail('ENETWORK', 'Provider unreachable from the adding mouaif: ' + (e.message || e), 502);
  }
  if (stream.aborted) { clearTimeout(idle); try { await upstream.body?.cancel(); } catch { /* gone */ } return; }
  stream.respond({
    status: upstream.status,
    statusText: upstream.statusText,
    meta: {
      responseFormat: req.responseFormat || null,
      expectsImage: !!req.expectsImage,
      streamFormat: def.streamFormat || null,
      pricing: model.pricing || null,
      machine: require('./share-store.js').machineName()
    }
  });
  if (!upstream.body) { clearTimeout(idle); stream.end(); return; }
  const [toPeer, toTally] = upstream.ok ? upstream.body.tee() : [upstream.body, null];
  if (toTally) tallyUsage({ model, def, req, body: toTally, shareId: share.id, peerId: conn.peerId }).catch(() => {});
  const reader = toPeer.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      resetIdle();
      if (stream.aborted) break;
      if (!stream.write(Buffer.from(value))) {
        await new Promise((resolve) => {
          const go = () => { stream.removeListener('abort', go); stream.removeListener('drain', go); resolve(); };
          stream.once('drain', go);
          stream.once('abort', go);
        });
      }
    }
    if (!stream.aborted) stream.end();
  } catch (e) {
    if (!stream.aborted) stream.abort('provider stream failed: ' + (e.message || e));
  } finally {
    clearTimeout(idle);
    try { reader.releaseLock(); } catch { /* released */ }
  }
}

// Read the adding side's copy of a provider response with the same parser the
// sharing machine uses, to record what the call cost on this mouaif.
async function tallyUsage({ model, def, req, body, shareId, peerId }) {
  const aiStream = require('./ai-stream.js');
  const { PARSERS } = require('./ai-endpoints.js');
  const parse = PARSERS[model.provider];
  if (!parse) return;
  const acc = model.provider === 'anthropic' ? new Map() : null;
  const round = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, providerCost: null };
  const apply = (ev) => {
    if (!ev || !ev.data) return;
    const u = ev.data.usage || (ev.name === 'usage_input' || ev.name === 'usage_output' ? ev.data : null);
    if (u) {
      const p = Number(u.promptTokens); const c = Number(u.completionTokens);
      const cr = Number(u.cacheReadTokens); const cc = Number(u.cacheCreationTokens);
      if (p > 0) round.promptTokens = p;
      if (c > 0) round.completionTokens = c;
      if (cr > 0) round.cacheReadTokens = cr;
      if (cc > 0) round.cacheCreationTokens = cc;
    }
    if (typeof ev.data.providerCost === 'number' && isFinite(ev.data.providerCost)) round.providerCost = ev.data.providerCost;
  };
  const run = (name, data) => { for (const ev of (acc ? parse(name, data, acc) : parse(name, data))) apply(ev); };
  if (req.responseFormat === 'json') {
    const text = await new Response(body).text();
    run('', text);
  } else if (def.streamFormat === 'ndjson') {
    for await (const obj of aiStream.readNDJSON(body)) run('', JSON.stringify(obj));
  } else {
    for await (const ev of aiStream.readSSE(body)) run(ev.eventName, ev.data);
  }
  let cost = round.providerCost;
  if (cost == null) {
    try {
      const usageMod = require('./usage.js');
      const u = { promptTokens: round.promptTokens, completionTokens: round.completionTokens };
      if (round.cacheReadTokens) u.cacheReadTokens = round.cacheReadTokens;
      if (round.cacheCreationTokens) u.cacheCreationTokens = round.cacheCreationTokens;
      const result = usageMod.computeCost({ model, usage: u, app: require('./settings.js').getApp() });
      if (result && result.known) cost = result.total;
    } catch { /* unknown pricing */ }
  }
  store.recordUsage({ shareId, peerId, provider: model.provider, model: model.id, promptTokens: round.promptTokens, completionTokens: round.completionTokens, cost });
}

// ---- REST API for the two UIs ----------------------------------------------------------------

function online(peerId) {
  const c = state.conns.get(peerId);
  return !!(c && c.ws.readyState === 1);
}

function stateForClient() {
  const peers = new Map(store.listPeers().map((p) => [p.id, p]));
  const outgoing = store.listShares({ direction: 'out' }).map((s) => {
    const p = peers.get(s.peerId) || {};
    return Object.assign({}, s, {
      peer: { id: p.id, address: p.address, machine: p.machine, paired: !!p.paired, online: online(s.peerId), codeExpires: p.codeExpires || null }
    });
  });
  const incoming = store.listShares({ direction: 'in' }).map((s) => {
    const p = peers.get(s.peerId) || {};
    return Object.assign({}, s, {
      machine: p.machine || 'another mouaif',
      online: online(s.peerId),
      needsCode: !p.paired,
      usage: store.usageFor(s.id)
    });
  });
  const addresses = store.listPeers('out').filter((p) => p.address).map((p) => ({ address: p.address, machine: p.machine || null, paired: !!p.paired }));
  return { enabled: enabled(), machine: store.machineName(), outgoing, incoming, addresses };
}

async function createShare({ address, projectDir, access }) {
  requireEnabled();
  const normalized = store.normalizeAddress(address);
  const projects = require('./projects.js');
  const registered = projects.listProjects().find((p) => p && p.path === projectDir);
  if (!registered) throw typed('ENOTFOUND', 'Only a registered project can be shared', 404);
  const level = access === 'full' ? 'full' : 'files';
  const peer = store.outgoingPeerFor(normalized);
  const fresh = !store.listShares({ direction: 'out', peerId: peer.id, includeRemoved: true }).length;
  const share = store.createOutgoingShare({ peerId: peer.id, projectDir: registered.path, projectName: registered.name || '', access: level });
  let conn;
  try {
    try { conn = await connectPeer(peer.id); }
    catch (e) {
      // The mouaif at this address has a new key (reinstalled, store reset).
      // With no share left between the two, sharing again starts over with a
      // new first-time code rather than refusing forever.
      if (e.code !== 'EIDENTITY' || !fresh) throw e;
      store.updatePeer(peer.id, { paired: false, publicKey: null });
      conn = await connectPeer(peer.id);
    }
  } catch (e) {
    // The first attempt failing means the address or the other side is wrong:
    // nothing useful is left behind.
    store.deleteShare(share.id);
    if (fresh) stopPeer(peer.id);
    throw Object.assign(e, { status: e.status || 502 });
  }
  conn.send({ t: 'offer', share: offerFor(share) });
  let code = null;
  const current = store.getPeer(peer.id);
  if (!current.paired) code = store.issueCode(peer.id);
  return { share: Object.assign({}, store.getShare(share.id), { peer: { id: current.id, address: current.address, machine: current.machine, paired: current.paired, online: true } }), code };
}

function stopShare(id) {
  const share = store.getShare(id);
  if (!share || share.status === 'removed') throw typed('ENOTFOUND', 'Share not found', 404);
  const conn = state.conns.get(share.peerId);
  if (share.direction === 'out') {
    if (conn && conn.send({ t: 'unshare', id: share.id })) store.deleteShare(share.id);
    else store.setShareStatus(share.id, 'removed'); // told on the next connection
    if (!store.listShares({ direction: 'out', peerId: share.peerId }).length) {
      if (conn) stopPeer(share.peerId);
      else if (!liveOutgoingShares(share.peerId).length) stopPeer(share.peerId);
      else connectPeer(share.peerId).catch(() => scheduleRedial(share.peerId));
    }
  } else {
    // Removed on the adding side: tombstone it so a later offer is refused.
    store.setShareStatus(share.id, 'removed');
    if (conn) conn.send({ t: 'unshare', id: share.id });
  }
  return { ok: true };
}

async function acceptShare(id, code) {
  requireEnabled();
  const share = store.getShare(id);
  if (!share || share.direction !== 'in' || share.status === 'removed') throw typed('ENOTFOUND', 'Share not found', 404);
  if (share.status === 'active') return { share };
  const conn = state.conns.get(share.peerId);
  if (!conn) throw typed('ESHARE_OFFLINE', 'The sharing machine is offline', 503);
  const peer = store.getPeer(share.peerId);
  const projects = require('./projects.js');
  if (projects.listProjects().some((p) => p && p.path === share.projectDir)) {
    throw typed('ESHARE_DIR_CONFLICT', 'A project at ' + share.projectDir + ' is already registered here. Unregister it first, or share the project under another path.', 409);
  }
  if (store.listShares({ direction: 'in' }).some((s) => s.id !== share.id && s.status === 'active' && s.projectDir === share.projectDir)) {
    throw typed('ESHARE_DIR_CONFLICT', 'Another shared project already uses the path ' + share.projectDir, 409);
  }
  if (!peer.paired && !store.normalizeCode(code)) throw typed('ESHARE_CODE', 'Type the code shown on the sharing machine', 400);
  await conn.rpc({ t: 'accept', id: share.id, code: peer.paired ? undefined : store.normalizeCode(code) });
  if (!peer.paired) {
    store.updatePeer(peer.id, { paired: true });
    if (conn.unpaired) { conn.unpaired = false; state.unpaired = Math.max(0, state.unpaired - 1); }
  }
  return { share: store.setShareStatus(share.id, 'active') };
}

function newCode(id) {
  requireEnabled();
  const share = store.getShare(id);
  if (!share || share.direction !== 'out') throw typed('ENOTFOUND', 'Share not found', 404);
  const peer = store.getPeer(share.peerId);
  if (peer.paired) return { code: null, paired: true };
  return { code: store.issueCode(peer.id), paired: false };
}

function setAccess(id, access) {
  requireEnabled();
  const share = store.getShare(id);
  if (!share || share.direction !== 'out' || share.status === 'removed') throw typed('ENOTFOUND', 'Share not found', 404);
  const next = store.setShareAccess(id, access === 'full' ? 'full' : 'files');
  const conn = state.conns.get(share.peerId);
  if (conn) conn.send({ t: 'offer', share: offerFor(next) });
  return { share: next };
}

async function handleShareApi(req, res, parsed) {
  const { sendJSON, readJsonOr400, checkAccessAttempts, recordAccessFailure, clearAccessFailures } = require('./server-shared.js');
  const urlPath = parsed.pathname;
  const method = req.method;
  const fail = (e) => sendJSON(res, e.status || (e.code === 'EBADADDRESS' ? 400 : 500), { error: e.message, code: e.code || 'ESHARE' });
  try {
    if (urlPath === '/api/share/state' && method === 'GET') return sendJSON(res, 200, stateForClient());
    if (urlPath === '/api/share/shares' && method === 'POST') {
      const body = await readJsonOr400(req, res);
      if (!body) return;
      const out = await createShare({ address: body.address, projectDir: body.projectDir, access: body.access });
      return sendJSON(res, 201, out);
    }
    const m = /^\/api\/share\/shares\/([A-Za-z0-9_-]{8,64})(\/[a-z]+)?$/.exec(urlPath);
    if (m && !m[2] && method === 'DELETE') return sendJSON(res, 200, stopShare(m[1]));
    if (m && !m[2] && method === 'PATCH') {
      const body = await readJsonOr400(req, res);
      if (!body) return;
      return sendJSON(res, 200, setAccess(m[1], body.access));
    }
    if (m && m[2] === '/code' && method === 'POST') return sendJSON(res, 200, newCode(m[1]));
    if (m && m[2] === '/accept' && method === 'POST') {
      const body = await readJsonOr400(req, res);
      if (!body) return;
      // Code attempts count against the same per-address budget as sign-in.
      if (!checkAccessAttempts(req)) return sendJSON(res, 429, { error: 'Too many attempts. Wait a minute and try again.', code: 'ERATE' });
      try {
        const out = await acceptShare(m[1], body.code);
        clearAccessFailures(req);
        return sendJSON(res, 200, out);
      } catch (e) {
        if (/^ESHARE_CODE/.test(e.code || '')) { recordAccessFailure(req); return sendJSON(res, 403, { error: e.message, code: e.code }); }
        throw e;
      }
    }
    return sendJSON(res, 404, { error: 'Not found' });
  } catch (e) {
    return fail(e);
  }
}

// ---- Lifecycle ----------------------------------------------------------------------------------

// Called from createServer: keep the server for dispatching forwarded
// requests, and reopen the connections for projects shared earlier.
function attach(server, serverConfig) {
  state.server = server;
  state.serverConfig = serverConfig;
  const reopen = () => {
    if (!enabled()) return;
    let peers = [];
    try { peers = store.listPeers('out'); } catch { return; }
    for (const p of peers) {
      if (!liveOutgoingShares(p.id).length) continue;
      connectPeer(p.id).catch(() => scheduleRedial(p.id));
    }
  };
  server.once('listening', () => setTimeout(reopen, 500).unref());
  server.once('close', () => detach(server));
}

function detach(server) {
  if (server && state.server !== server) return;
  for (const id of [...state.dialers.keys()]) {
    const d = state.dialers.get(id);
    d.stopped = true;
    if (d.timer) clearTimeout(d.timer);
  }
  state.dialers.clear();
  for (const conn of [...state.conns.values()]) conn.close('server stopping');
  state.conns.clear();
  state.unpaired = 0;
  if (state.wss) { try { state.wss.close(); } catch { /* closed */ } state.wss = null; }
  state.server = null;
}

module.exports = {
  PROTO,
  attach,
  detach,
  enabled,
  handleUpgrade,
  handleForward,
  handleShareApi,
  borrowFetch,
  borrowedModel,
  offeredModel,
  stateForClient,
  createShare,
  stopShare,
  acceptShare,
  online,
  // tests
  _state: state
};
