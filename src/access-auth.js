'use strict';

// Local app access authentication: one account, password sessions, one-time
// setup codes, and WebAuthn credentials. Provider OAuth remains in auth.js.

const crypto = require('node:crypto');
const settings = require('./settings.js');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SETUP_TTL_MS = 15 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const challenges = new Map();

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromB64url(value) {
  return Buffer.from(String(value || ''), 'base64url');
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(a || '');
  const right = Buffer.from(b || '');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function ensureTables() {
  settings.getDb().exec(`
    CREATE TABLE IF NOT EXISTS access_users (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS access_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS access_setup_codes (
      code_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS access_passkeys (
      credential_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      algorithm INTEGER NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
  `);
}

function user() {
  ensureTables();
  return settings.getDb().prepare('SELECT id, username, created_at, updated_at FROM access_users WHERE id = 1').get() || null;
}

function configured() {
  return !!user();
}

function validateCredentials(username, password) {
  const cleanUser = String(username || '').trim();
  const cleanPassword = String(password || '');
  if (cleanUser.length < 1 || cleanUser.length > 128) throw Object.assign(new Error('User must be 1–128 characters'), { code: 'EBADUSER' });
  if (cleanPassword.length < 8 || cleanPassword.length > 1024) throw Object.assign(new Error('Password must be at least 8 characters'), { code: 'EBADPASSWORD' });
  return { username: cleanUser, password: cleanPassword };
}

function setPassword(username, password) {
  ensureTables();
  const clean = validateCredentials(username, password);
  // Repeating the same --user/--password on a normal or watch-mode restart
  // must not log out every browser or discard passkeys.
  if (verifyPassword(clean.username, clean.password)) return user();
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(clean.password, salt, 32);
  const now = new Date().toISOString();
  settings.getDb().prepare(`
    INSERT INTO access_users (id, username, password_salt, password_hash, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      password_salt = excluded.password_salt,
      password_hash = excluded.password_hash,
      updated_at = excluded.updated_at
  `).run(clean.username, salt.toString('base64'), hash.toString('base64'), now, now);
  // A password reset is a security boundary: invalidate every old browser.
  settings.getDb().prepare('DELETE FROM access_sessions').run();
  settings.getDb().prepare('DELETE FROM access_passkeys').run();
  return user();
}

function verifyPassword(username, password) {
  ensureTables();
  const row = settings.getDb().prepare('SELECT * FROM access_users WHERE id = 1').get();
  if (!row) return false;
  const actual = crypto.scryptSync(String(password || ''), Buffer.from(row.password_salt, 'base64'), 32);
  const expected = Buffer.from(row.password_hash, 'base64');
  return safeEqual(String(username || '').trim(), row.username) && safeEqual(actual, expected);
}

// Password change from an authenticated session. Verifies the current
// password, validates and stores the new one, then revokes every other
// session and discards passkeys — the caller keeps the session token
// passed here so the current browser stays signed in. Rejects if the new
// password matches the current one (a no-op that would still invalidate
// other sessions and passkeys otherwise).
function changePassword(username, currentPassword, newPassword, keepToken) {
  ensureTables();
  const clean = validateCredentials(username, newPassword);
  if (!verifyPassword(clean.username, currentPassword)) {
    throw Object.assign(new Error('Current password is incorrect'), { code: 'EBADCREDENTIALS' });
  }
  if (verifyPassword(clean.username, newPassword)) {
    throw Object.assign(new Error('New password must be different from the current one'), { code: 'EBADPASSWORD' });
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(clean.password, salt, 32);
  const now = new Date().toISOString();
  settings.getDb().prepare(`
    UPDATE access_users SET
      username = ?, password_salt = ?, password_hash = ?, updated_at = ?
    WHERE id = 1
  `).run(clean.username, salt.toString('base64'), hash.toString('base64'), now);
  // A password change is a security boundary like a reset: invalidate
  // every old browser and discard passkeys. The current session is
  // re-issued below so this browser stays signed in.
  settings.getDb().prepare('DELETE FROM access_sessions').run();
  settings.getDb().prepare('DELETE FROM access_passkeys').run();
  if (keepToken) {
    const expiresAt = Date.now() + SESSION_TTL_MS;
    settings.getDb().prepare('INSERT INTO access_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, 1, ?, ?)')
      .run(digest(keepToken), expiresAt, new Date().toISOString());
  }
  return { user: user(), expiresAt: keepToken ? Date.now() + SESSION_TTL_MS : null };
}

function issueSession() {
  ensureTables();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  settings.getDb().prepare('DELETE FROM access_sessions WHERE expires_at <= ?').run(Date.now());
  settings.getDb().prepare('INSERT INTO access_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, 1, ?, ?)')
    .run(digest(token), expiresAt, new Date().toISOString());
  return { token, expiresAt };
}

function session(token) {
  ensureTables();
  if (!token) return null;
  return settings.getDb().prepare(`
    SELECT s.expires_at, u.id, u.username
    FROM access_sessions s JOIN access_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(digest(token), Date.now()) || null;
}

function revokeSession(token) {
  ensureTables();
  if (!token) return false;
  return settings.getDb().prepare('DELETE FROM access_sessions WHERE token_hash = ?').run(digest(token)).changes > 0;
}

function randomCode() {
  let value = '';
  for (const byte of crypto.randomBytes(8)) value += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return value.slice(0, 4) + '-' + value.slice(4, 8);
}

function normalizeCode(code) {
  const raw = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? raw.slice(0, 4) + '-' + raw.slice(4) : '';
}

function createSetupCode(ttlMs = SETUP_TTL_MS) {
  ensureTables();
  const code = randomCode();
  const expiresAt = Date.now() + Math.max(60_000, Number(ttlMs) || SETUP_TTL_MS);
  settings.getDb().prepare('DELETE FROM access_setup_codes WHERE expires_at <= ?').run(Date.now());
  settings.getDb().prepare('INSERT INTO access_setup_codes (code_hash, expires_at, created_at) VALUES (?, ?, ?)')
    .run(digest(code), expiresAt, new Date().toISOString());
  return { code, expiresAt };
}

function setupCodeValid(code) {
  ensureTables();
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  return !!settings.getDb().prepare('SELECT 1 FROM access_setup_codes WHERE code_hash = ? AND expires_at > ?')
    .get(digest(normalized), Date.now());
}

function consumeSetupCode(code) {
  ensureTables();
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  const hash = digest(normalized);
  const transaction = settings.getDb().transaction(() => {
    const valid = settings.getDb().prepare('SELECT 1 FROM access_setup_codes WHERE code_hash = ? AND expires_at > ?').get(hash, Date.now());
    if (!valid) return false;
    settings.getDb().prepare('DELETE FROM access_setup_codes WHERE code_hash = ?').run(hash);
    return true;
  });
  return transaction();
}

function passkeys() {
  ensureTables();
  return settings.getDb().prepare('SELECT credential_id AS id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM access_passkeys ORDER BY created_at').all();
}

function challengeKey(id) {
  return digest(id);
}

function putChallenge(type, data) {
  const id = crypto.randomBytes(18).toString('base64url');
  const challenge = crypto.randomBytes(32).toString('base64url');
  challenges.set(challengeKey(id), { type, challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS, ...data });
  return { id, challenge };
}

function takeChallenge(id, type) {
  const key = challengeKey(id);
  const value = challenges.get(key);
  challenges.delete(key);
  if (!value || value.type !== type || value.expiresAt <= Date.now()) throw Object.assign(new Error('Challenge is missing or expired'), { code: 'ECHALLENGE' });
  return value;
}

function rpDetails(origin) {
  const parsed = new URL(origin);
  return { origin: parsed.origin, rpId: parsed.hostname, rpName: 'mouaif' };
}

function beginRegistration({ origin, username, authorizedBy }) {
  const rp = rpDetails(origin);
  const pending = putChallenge('register', { ...rp, username, authorizedBy });
  return {
    challengeId: pending.id,
    publicKey: {
      challenge: pending.challenge,
      rp: { id: rp.rpId, name: rp.rpName },
      user: { id: b64url(Buffer.from('mouaif-user-1')), name: username, displayName: username },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      timeout: CHALLENGE_TTL_MS,
      attestation: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      excludeCredentials: passkeys().map((entry) => ({ type: 'public-key', id: entry.id }))
    }
  };
}

function readCbor(buffer, offset = 0) {
  const first = buffer[offset++];
  if (first === undefined) throw new Error('Invalid CBOR');
  const major = first >> 5;
  const info = first & 31;
  if (major === 7 && info === 20) return { value: false, offset };
  if (major === 7 && info === 21) return { value: true, offset };
  if (major === 7 && (info === 22 || info === 23)) return { value: null, offset };
  let length;
  if (info < 24) length = info;
  else if (info === 24) length = buffer[offset++];
  else if (info === 25) { length = buffer.readUInt16BE(offset); offset += 2; }
  else if (info === 26) { length = buffer.readUInt32BE(offset); offset += 4; }
  else throw new Error('Unsupported CBOR length');
  if (major === 0) return { value: length, offset };
  if (major === 1) return { value: -1 - length, offset };
  if (major === 2) return { value: buffer.subarray(offset, offset + length), offset: offset + length };
  if (major === 3) return { value: buffer.toString('utf8', offset, offset + length), offset: offset + length };
  if (major === 4) {
    const value = [];
    for (let i = 0; i < length; i++) { const item = readCbor(buffer, offset); value.push(item.value); offset = item.offset; }
    return { value, offset };
  }
  if (major === 5) {
    const value = new Map();
    for (let i = 0; i < length; i++) {
      const key = readCbor(buffer, offset); offset = key.offset;
      const item = readCbor(buffer, offset); offset = item.offset;
      value.set(key.value, item.value);
    }
    return { value, offset };
  }
  throw new Error('Unsupported CBOR type');
}

function parseClientData(encoded, expectedType, pending) {
  let client;
  try { client = JSON.parse(fromB64url(encoded).toString('utf8')); } catch { throw Object.assign(new Error('Invalid WebAuthn client data'), { code: 'EWEBAUTHN' }); }
  if (client.type !== expectedType || client.challenge !== pending.challenge || client.origin !== pending.origin) {
    throw Object.assign(new Error('WebAuthn challenge or origin did not match'), { code: 'EWEBAUTHN' });
  }
  return fromB64url(encoded);
}

function parseAuthData(buffer, rpId) {
  if (buffer.length < 37) throw new Error('Invalid authenticator data');
  const expectedRp = crypto.createHash('sha256').update(rpId).digest();
  if (!safeEqual(buffer.subarray(0, 32), expectedRp)) throw new Error('WebAuthn RP ID did not match');
  const flags = buffer[32];
  if (!(flags & 0x01)) throw new Error('WebAuthn user presence is required');
  return { flags, counter: buffer.readUInt32BE(33), rest: buffer.subarray(37) };
}

function coseToPem(cose) {
  const alg = cose.get(3);
  const type = cose.get(1);
  if (type === 2 && alg === -7) {
    const x = cose.get(-2); const y = cose.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y)) throw new Error('Invalid EC passkey');
    return { algorithm: alg, pem: crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) }, format: 'jwk' }).export({ type: 'spki', format: 'pem' }) };
  }
  if (type === 3 && alg === -257) {
    const n = cose.get(-1); const e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new Error('Invalid RSA passkey');
    return { algorithm: alg, pem: crypto.createPublicKey({ key: { kty: 'RSA', n: b64url(n), e: b64url(e), alg: 'RS256' }, format: 'jwk' }).export({ type: 'spki', format: 'pem' }) };
  }
  throw new Error('Unsupported passkey algorithm');
}

function finishRegistration({ challengeId, credential, name }) {
  ensureTables();
  const pending = takeChallenge(challengeId, 'register');
  const response = credential && credential.response;
  if (!credential || credential.type !== 'public-key' || !credential.id || !response) throw new Error('Invalid passkey credential');
  parseClientData(response.clientDataJSON, 'webauthn.create', pending);
  const attestation = readCbor(fromB64url(response.attestationObject)).value;
  const authData = attestation instanceof Map ? attestation.get('authData') : null;
  if (!Buffer.isBuffer(authData)) throw new Error('Passkey attestation has no authenticator data');
  const parsed = parseAuthData(authData, pending.rpId);
  if (!(parsed.flags & 0x40) || parsed.rest.length < 18) throw new Error('Passkey attestation has no credential data');
  const idLength = parsed.rest.readUInt16BE(16);
  const id = parsed.rest.subarray(18, 18 + idLength);
  const cose = readCbor(parsed.rest, 18 + idLength).value;
  if (!(cose instanceof Map)) throw new Error('Invalid passkey public key');
  const submittedId = fromB64url(credential.rawId || credential.id);
  if (!safeEqual(id, submittedId)) throw new Error('Passkey credential ID did not match');
  const key = coseToPem(cose);
  if (pending.authorizedBy !== 'session' && !consumeSetupCode(pending.authorizedBy)) {
    throw Object.assign(new Error('Setup code was already used or expired'), { code: 'ESETUP_CODE' });
  }
  settings.getDb().prepare(`
    INSERT INTO access_passkeys (credential_id, user_id, name, public_key, algorithm, counter, created_at)
    VALUES (?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(credential_id) DO UPDATE SET name = excluded.name, public_key = excluded.public_key, algorithm = excluded.algorithm
  `).run(b64url(id), String(name || 'Passkey').slice(0, 80), key.pem, key.algorithm, parsed.counter, new Date().toISOString());
  return { passkeys: passkeys() };
}

function beginAuthentication({ origin }) {
  const rp = rpDetails(origin);
  const keys = passkeys();
  if (!keys.length) throw Object.assign(new Error('No passkeys are registered'), { code: 'ENOPASSKEY' });
  const pending = putChallenge('authenticate', rp);
  return {
    challengeId: pending.id,
    publicKey: {
      challenge: pending.challenge,
      rpId: rp.rpId,
      timeout: CHALLENGE_TTL_MS,
      userVerification: 'preferred',
      allowCredentials: keys.map((entry) => ({ type: 'public-key', id: entry.id }))
    }
  };
}

function finishAuthentication({ challengeId, credential }) {
  ensureTables();
  const pending = takeChallenge(challengeId, 'authenticate');
  const response = credential && credential.response;
  if (!credential || credential.type !== 'public-key' || !credential.id || !response) throw new Error('Invalid passkey credential');
  const row = settings.getDb().prepare('SELECT * FROM access_passkeys WHERE credential_id = ?').get(String(credential.id));
  if (!row) throw new Error('Passkey is not registered');
  const clientData = parseClientData(response.clientDataJSON, 'webauthn.get', pending);
  const authData = fromB64url(response.authenticatorData);
  const parsed = parseAuthData(authData, pending.rpId);
  const signed = Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]);
  const algorithm = row.algorithm === -7 ? 'sha256' : 'RSA-SHA256';
  if (!crypto.verify(algorithm, signed, row.public_key, fromB64url(response.signature))) throw new Error('Passkey signature was invalid');
  if (row.counter > 0 && parsed.counter > 0 && parsed.counter <= row.counter) throw new Error('Passkey counter did not advance');
  settings.getDb().prepare('UPDATE access_passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?')
    .run(parsed.counter, new Date().toISOString(), row.credential_id);
  return user();
}

function deletePasskey(id) {
  ensureTables();
  return settings.getDb().prepare('DELETE FROM access_passkeys WHERE credential_id = ?').run(String(id || '')).changes > 0;
}

module.exports = {
  SESSION_TTL_MS,
  SETUP_TTL_MS,
  ensureTables,
  configured,
  user,
  setPassword,
  verifyPassword,
  changePassword,
  issueSession,
  session,
  revokeSession,
  createSetupCode,
  normalizeCode,
  setupCodeValid,
  consumeSetupCode,
  passkeys,
  beginRegistration,
  finishRegistration,
  beginAuthentication,
  finishAuthentication,
  deletePasskey
};
