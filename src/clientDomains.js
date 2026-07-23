'use strict';

// Client domains — CRUD for allowed origins and their API keys.
// Stored in the app SQLite store (~/.mouaif/store.sqlite).
//
// Each domain has:
//   - id: UUID
//   - origin_pattern: URL origin pattern (e.g. "https://*.example.com")
//   - api_key_hash: SHA-256 of the generated API key (never stored plaintext)
//   - api_key_prefix: first 8 chars of the API key (for UI display)
//   - created_at, updated_at: ISO timestamps

const crypto = require('crypto');
const settings = require('./settings.js');

const TABLE = 'client_domains';

function ensureTable() {
  const db = settings.getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id            TEXT PRIMARY KEY,
    origin_pattern TEXT NOT NULL,
    api_key_hash  TEXT NOT NULL,
    api_key_prefix TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )`);
}

function list() {
  const db = settings.getDb();
  return db.prepare(`SELECT id, origin_pattern, api_key_prefix, created_at, updated_at FROM ${TABLE} ORDER BY created_at ASC`).all();
}

function getById(id) {
  if (!id || typeof id !== 'string') return null;
  const db = settings.getDb();
  return db.prepare(`SELECT id, origin_pattern, api_key_prefix, created_at, updated_at FROM ${TABLE} WHERE id = ?`).get(id);
}

function create({ originPattern }) {
  if (!originPattern || typeof originPattern !== 'string') throw typedError('EBADINPUT', 'originPattern is required');
  const db = settings.getDb();
  const id = crypto.randomUUID();
  const apiKey = crypto.randomBytes(32).toString('hex');
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const apiKeyPrefix = apiKey.slice(0, 8);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ${TABLE} (id, origin_pattern, api_key_hash, api_key_prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, originPattern.trim(), apiKeyHash, apiKeyPrefix, now, now);
  return { id, originPattern: originPattern.trim(), apiKey, apiKeyPrefix, createdAt: now };
}

function update(id, { originPattern }) {
  if (!id || typeof id !== 'string') throw typedError('EBADINPUT', 'id is required');
  if (!originPattern || typeof originPattern !== 'string') throw typedError('EBADINPUT', 'originPattern is required');
  const db = settings.getDb();
  const now = new Date().toISOString();
  const info = db.prepare(`UPDATE ${TABLE} SET origin_pattern = ?, updated_at = ? WHERE id = ?`).run(originPattern.trim(), now, id);
  if (info.changes === 0) throw typedError('ENOTFOUND', 'client domain not found');
}

function regenerateKey(id) {
  if (!id || typeof id !== 'string') throw typedError('EBADINPUT', 'id is required');
  const db = settings.getDb();
  const apiKey = crypto.randomBytes(32).toString('hex');
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const apiKeyPrefix = apiKey.slice(0, 8);
  const now = new Date().toISOString();
  const info = db.prepare(`UPDATE ${TABLE} SET api_key_hash = ?, api_key_prefix = ?, updated_at = ? WHERE id = ?`).run(apiKeyHash, apiKeyPrefix, now, id);
  if (info.changes === 0) throw typedError('ENOTFOUND', 'client domain not found');
  return { apiKey, apiKeyPrefix };
}

function remove(id) {
  if (!id || typeof id !== 'string') throw typedError('EBADINPUT', 'id is required');
  const db = settings.getDb();
  const info = db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run(id);
  if (info.changes === 0) throw typedError('ENOTFOUND', 'client domain not found');
}

function verifyApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return null;
  const db = settings.getDb();
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  return db.prepare(`SELECT id, origin_pattern FROM ${TABLE} WHERE api_key_hash = ?`).get(hash) || null;
}

function typedError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = { ensureTable, list, getById, create, update, regenerateKey, remove, verifyApiKey };