'use strict';

// Persistent state for shared projects (docs/features/share-project.md), in
// the app SQLite store:
//
//   share_identity  this mouaif's long-lived Ed25519 key pair (one row)
//   share_peers     the other mouaifs: for a peer we dial (we share to it) the
//                   row is keyed by its address; for a peer that dials us (it
//                   shares to us) the row is keyed by its key fingerprint.
//                   `paired` turns on once a first-time code was accepted.
//   share_shares    one row per shared project, on both machines, with the
//                   same id: direction `out` on the sharing machine, `in` on
//                   the adding one. `removed` rows are tombstones on the
//                   adding side so a share removed while the other machine
//                   was off is not offered again.
//   share_usage     provider calls this mouaif made for a shared project it
//                   added (phase 2 "borrowed providers").

const crypto = require('node:crypto');
const os = require('node:os');
const settings = require('./settings.js');

const CODE_TTL_MS = require('./access-auth.js').SETUP_TTL_MS; // 15 minutes, like setup codes
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';     // same alphabet as setup codes
const MAX_CODE_ATTEMPTS = 5;

let tablesReady = false;
function db() { return settings.getDb(); }

function ensureTables() {
  if (tablesReady) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS share_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS share_peers (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      address TEXT,
      public_key TEXT,
      machine TEXT,
      paired INTEGER NOT NULL DEFAULT 0,
      code_hash TEXT,
      code_expires INTEGER,
      code_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_seen TEXT
    );
    CREATE TABLE IF NOT EXISTS share_shares (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      project_name TEXT,
      access TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      accepted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS share_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      share_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL,
      at TEXT NOT NULL
    );
  `);
  tablesReady = true;
}

function now() { return new Date().toISOString(); }
function digest(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

// ---- Identity -------------------------------------------------------------

function identity() {
  ensureTables();
  let row = db().prepare('SELECT public_key, private_key FROM share_identity WHERE id = 1').get();
  if (!row) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    row = {
      public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      private_key: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
    };
    db().prepare('INSERT OR IGNORE INTO share_identity (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)')
      .run(row.public_key, row.private_key, now());
    row = db().prepare('SELECT public_key, private_key FROM share_identity WHERE id = 1').get();
  }
  return { publicKey: row.public_key, privateKey: row.private_key };
}

function fingerprint(publicKeyB64) {
  return crypto.createHash('sha256').update(Buffer.from(String(publicKeyB64 || ''), 'base64')).digest('base64url').slice(0, 22);
}

function sign(text) {
  const key = crypto.createPrivateKey({ key: Buffer.from(identity().privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(text, 'utf8'), key).toString('base64');
}

function verify(publicKeyB64, text, signatureB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(String(publicKeyB64 || ''), 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return crypto.verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(String(signatureB64 || ''), 'base64'));
  } catch { return false; }
}

// The name shown on the other side ("shared from <machine>").
function machineName() {
  const configured = process.env.MOUAIF_MACHINE_NAME;
  return String(configured || os.hostname() || 'mouaif').slice(0, 64);
}

// ---- Addresses ---------------------------------------------------------------

// normalizeAddress('example.com') -> 'https://example.com'
// A bare host gets https, except localhost, an IP address or a *.local name,
// which are usually plain HTTP on a LAN. Paths, credentials and queries are
// refused: the address names a mouaif, not a page.
function normalizeAddress(value) {
  let raw = String(value || '').trim();
  if (!raw) throw Object.assign(new Error('Enter the address of the other mouaif'), { code: 'EBADADDRESS' });
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const host = raw.split('/')[0].replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const local = host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':') || host.endsWith('.local');
    raw = (local ? 'http://' : 'https://') + raw;
  }
  let parsed;
  try { parsed = new URL(raw); } catch { throw Object.assign(new Error('That address is not valid'), { code: 'EBADADDRESS' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw Object.assign(new Error('Use an http or https address'), { code: 'EBADADDRESS' });
  if (parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw Object.assign(new Error('Enter only the address of the other mouaif, without a path'), { code: 'EBADADDRESS' });
  }
  return parsed.origin;
}

function wsUrlFor(address) {
  const u = new URL(address);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/api/share';
  return u.toString();
}

// ---- Peers -------------------------------------------------------------------

function peerRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    direction: row.direction,
    address: row.address || null,
    publicKey: row.public_key || null,
    machine: row.machine || null,
    paired: !!row.paired,
    codeExpires: row.code_expires || null,
    lastSeen: row.last_seen || null
  };
}

function getPeer(id) {
  ensureTables();
  return peerRow(db().prepare('SELECT * FROM share_peers WHERE id = ?').get(String(id || '')));
}

function listPeers(direction) {
  ensureTables();
  const rows = direction
    ? db().prepare('SELECT * FROM share_peers WHERE direction = ? ORDER BY created_at').all(direction)
    : db().prepare('SELECT * FROM share_peers ORDER BY created_at').all();
  return rows.map(peerRow);
}

// The peer we dial at `address` (created on first use).
function outgoingPeerFor(address) {
  ensureTables();
  const id = 'out_' + digest(address).slice(0, 20);
  db().prepare('INSERT OR IGNORE INTO share_peers (id, direction, address, created_at) VALUES (?, ?, ?, ?)')
    .run(id, 'out', address, now());
  return getPeer(id);
}

// The peer that dials us with `publicKey` (created on first contact).
function incomingPeerFor(publicKey, machine) {
  ensureTables();
  const id = 'in_' + fingerprint(publicKey);
  db().prepare('INSERT OR IGNORE INTO share_peers (id, direction, public_key, machine, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'in', publicKey, machine || null, now());
  db().prepare('UPDATE share_peers SET machine = COALESCE(?, machine), last_seen = ? WHERE id = ?').run(machine || null, now(), id);
  return getPeer(id);
}

function deletePeer(id) {
  ensureTables();
  db().prepare('DELETE FROM share_peers WHERE id = ?').run(id);
}

function updatePeer(id, fields) {
  ensureTables();
  const map = { publicKey: 'public_key', machine: 'machine', paired: 'paired', lastSeen: 'last_seen' };
  for (const [key, column] of Object.entries(map)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    let value = fields[key];
    if (key === 'paired') value = value ? 1 : 0;
    db().prepare('UPDATE share_peers SET ' + column + ' = ? WHERE id = ?').run(value, id);
  }
  return getPeer(id);
}

// ---- First-time codes ----------------------------------------------------------
// Shown on the sharing machine, typed on the adding one, checked by the sharing
// machine. Stored hashed, single use, 15 minutes, and voided after
// MAX_CODE_ATTEMPTS wrong answers so it cannot be guessed over the connection.

function randomCode() {
  let value = '';
  for (const byte of crypto.randomBytes(8)) value += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return value.slice(0, 4) + '-' + value.slice(4, 8);
}

function normalizeCode(code) {
  const raw = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? raw.slice(0, 4) + '-' + raw.slice(4) : '';
}

function issueCode(peerId, ttlMs = CODE_TTL_MS) {
  ensureTables();
  const code = randomCode();
  const expiresAt = Date.now() + ttlMs;
  db().prepare('UPDATE share_peers SET code_hash = ?, code_expires = ?, code_attempts = 0 WHERE id = ?')
    .run(digest(code), expiresAt, peerId);
  return { code, expiresAt };
}

// -> 'ok' | 'missing' | 'expired' | 'wrong' | 'locked'
function consumeCode(peerId, code) {
  ensureTables();
  const tx = db().transaction(() => {
    const row = db().prepare('SELECT code_hash, code_expires, code_attempts FROM share_peers WHERE id = ?').get(peerId);
    if (!row || !row.code_hash) return 'missing';
    if (row.code_expires <= Date.now()) {
      db().prepare('UPDATE share_peers SET code_hash = NULL, code_expires = NULL WHERE id = ?').run(peerId);
      return 'expired';
    }
    const normalized = normalizeCode(code);
    const given = Buffer.from(normalized ? digest(normalized) : '');
    const expected = Buffer.from(row.code_hash);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
      db().prepare('UPDATE share_peers SET code_hash = NULL, code_expires = NULL, code_attempts = 0 WHERE id = ?').run(peerId);
      return 'ok';
    }
    const attempts = (row.code_attempts || 0) + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      db().prepare('UPDATE share_peers SET code_hash = NULL, code_expires = NULL, code_attempts = 0 WHERE id = ?').run(peerId);
      return 'locked';
    }
    db().prepare('UPDATE share_peers SET code_attempts = ? WHERE id = ?').run(attempts, peerId);
    return 'wrong';
  });
  return tx();
}

// ---- Shares ---------------------------------------------------------------------

function shareRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    direction: row.direction,
    peerId: row.peer_id,
    projectDir: row.project_dir,
    projectName: row.project_name || null,
    access: row.access === 'full' ? 'full' : 'files',
    status: row.status,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at || null
  };
}

function getShare(id) {
  ensureTables();
  return shareRow(db().prepare('SELECT * FROM share_shares WHERE id = ?').get(String(id || '')));
}

function listShares({ direction, peerId, includeRemoved = false } = {}) {
  ensureTables();
  const where = [];
  const args = [];
  if (direction) { where.push('direction = ?'); args.push(direction); }
  if (peerId) { where.push('peer_id = ?'); args.push(peerId); }
  if (!includeRemoved) where.push("status != 'removed'");
  const sql = 'SELECT * FROM share_shares' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at';
  return db().prepare(sql).all(...args).map(shareRow);
}

function newShareId() { return crypto.randomBytes(12).toString('base64url'); }

function createOutgoingShare({ peerId, projectDir, projectName, access }) {
  ensureTables();
  const existing = db().prepare("SELECT * FROM share_shares WHERE direction = 'out' AND peer_id = ? AND project_dir = ? AND status != 'removed'").get(peerId, projectDir);
  if (existing) {
    db().prepare('UPDATE share_shares SET access = ?, project_name = ? WHERE id = ?').run(access, projectName || null, existing.id);
    return getShare(existing.id);
  }
  const id = newShareId();
  db().prepare('INSERT INTO share_shares (id, direction, peer_id, project_dir, project_name, access, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'out', peerId, projectDir, projectName || null, access, 'pending', now());
  return getShare(id);
}

// Record an offer received from a peer. A tombstoned id stays removed.
function upsertIncomingShare({ id, peerId, projectDir, projectName, access }) {
  ensureTables();
  const existing = getShare(id);
  if (existing && (existing.direction !== 'in' || existing.peerId !== peerId)) return null;
  if (existing && existing.status === 'removed') return existing;
  if (existing) {
    db().prepare('UPDATE share_shares SET project_dir = ?, project_name = ?, access = ? WHERE id = ?')
      .run(projectDir, projectName || null, access, id);
    return getShare(id);
  }
  db().prepare('INSERT INTO share_shares (id, direction, peer_id, project_dir, project_name, access, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'in', peerId, projectDir, projectName || null, access, 'pending', now());
  return getShare(id);
}

function setShareStatus(id, status) {
  ensureTables();
  db().prepare('UPDATE share_shares SET status = ?, accepted_at = CASE WHEN ? = \'active\' THEN ? ELSE accepted_at END WHERE id = ?')
    .run(status, status, now(), id);
  return getShare(id);
}

function setShareAccess(id, access) {
  ensureTables();
  db().prepare('UPDATE share_shares SET access = ? WHERE id = ?').run(access, id);
  return getShare(id);
}

function deleteShare(id) {
  ensureTables();
  db().prepare('DELETE FROM share_shares WHERE id = ?').run(id);
}

// ---- Borrowed provider usage (adding side) --------------------------------------

function recordUsage({ shareId, peerId, provider, model, promptTokens, completionTokens, cost }) {
  ensureTables();
  db().prepare('INSERT INTO share_usage (share_id, peer_id, provider, model, prompt_tokens, completion_tokens, cost, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(shareId, peerId, provider || null, model || null, Math.max(0, Math.round(promptTokens || 0)),
      Math.max(0, Math.round(completionTokens || 0)), Number.isFinite(cost) ? cost : null, now());
}

function usageFor(shareId) {
  ensureTables();
  const row = db().prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens), 0) AS prompt,
    COALESCE(SUM(completion_tokens), 0) AS completion, SUM(cost) AS cost,
    SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unknown FROM share_usage WHERE share_id = ?`).get(shareId);
  return {
    calls: row.calls || 0,
    promptTokens: row.prompt || 0,
    completionTokens: row.completion || 0,
    cost: typeof row.cost === 'number' ? row.cost : 0,
    known: (row.calls || 0) > 0 && !row.unknown
  };
}

// The share sheets and the projects page show this state: a write tells open
// pages (an `app_changed` notice; src/app-events.js). A peer's last-seen time
// is not shown, so it alone sends nothing.
function shareChanged() {
  require('./app-events.js').appChanged('share');
}
function notifying(fn) {
  return function shareWrite(...args) {
    const out = fn(...args);
    shareChanged();
    return out;
  };
}

module.exports = {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  ensureTables,
  shareChanged,
  identity,
  fingerprint,
  sign,
  verify,
  machineName,
  normalizeAddress,
  wsUrlFor,
  getPeer,
  listPeers,
  outgoingPeerFor: notifying(outgoingPeerFor),
  incomingPeerFor: notifying(incomingPeerFor),
  updatePeer(id, fields) {
    const out = updatePeer(id, fields);
    if (fields && Object.keys(fields).some((k) => k !== 'lastSeen')) shareChanged();
    return out;
  },
  deletePeer: notifying(deletePeer),
  issueCode: notifying(issueCode),
  consumeCode: notifying(consumeCode),
  normalizeCode,
  getShare,
  listShares,
  createOutgoingShare: notifying(createOutgoingShare),
  upsertIncomingShare: notifying(upsertIncomingShare),
  setShareStatus: notifying(setShareStatus),
  setShareAccess: notifying(setShareAccess),
  deleteShare: notifying(deleteShare),
  recordUsage: notifying(recordUsage),
  usageFor
};
