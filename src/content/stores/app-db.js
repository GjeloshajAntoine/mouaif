'use strict';

// App-scope document store: one JSON object in an `app_kv` row
// (`settings` for the settings document). A store has the same members as
// every other adapter in this folder:
//
//   { kind, location, read(), write(next) }

const crypto = require('crypto');
const contentDb = require('../db.js');
const cache = require('./cache.js');

const { APP_KV_TABLE } = contentDb;
// Row key prefix for an unreadable app-settings blob that was moved aside
// instead of being silently replaced by defaults. See read().
const QUARANTINE_SUFFIX = '.corrupt-';

function readRow(key) {
  return cache.readRow('app:' + key, () => loadRow(key)).value;
}

function loadRow(key) {
  const d = contentDb.db();
  const row = d.prepare(`SELECT value FROM ${APP_KV_TABLE} WHERE key = ?`).get(key);
  if (!row) return { exists: false, value: {} };
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('app settings must be a JSON object');
    }
    return { exists: true, value: parsed };
  } catch (e) {
    // A corrupt app-settings blob used to resolve to {}: every provider,
    // registered project, prompt and pricing entry vanished from the UI, and
    // the next write persisted that emptiness over the only copy. Move the
    // unreadable value aside instead — it stays in the store under a
    // quarantine key, the live row is reset, and the failure is reported.
    const quarantineKey = key + QUARANTINE_SUFFIX + new Date().toISOString().replace(/[:.]/g, '-')
      + '-' + crypto.randomBytes(3).toString('hex');
    try {
      d.transaction(() => {
        d.prepare(`INSERT OR REPLACE INTO ${APP_KV_TABLE} (key, value) VALUES (?, ?)`)
          .run(quarantineKey, row.value);
        d.prepare(`DELETE FROM ${APP_KV_TABLE} WHERE key = ?`).run(key);
      })();
      console.error('[settings] app settings were unreadable (' + e.message
        + '); the stored value was preserved as ' + quarantineKey
        + ' and settings start from defaults. See listQuarantinedAppSettings().');
    } catch (quarantineError) {
      console.error('[settings] app settings were unreadable (' + e.message
        + ') and could not be quarantined: ' + quarantineError.message);
    }
    return { exists: false, value: {} };
  }
}

function writeRow(key, next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    throw new TypeError('an app document must be an object');
  }
  contentDb.db()
    .prepare(
      `INSERT INTO ${APP_KV_TABLE} (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, JSON.stringify(next));
  cache.wroteRow('app:' + key, next);
  return next;
}

// Every unreadable value the store moved aside for `key`, oldest first.
function listQuarantined(key) {
  return contentDb.db()
    .prepare(`SELECT key, value FROM ${APP_KV_TABLE} WHERE key LIKE ? ORDER BY key`)
    .all(key + QUARANTINE_SUFFIX + '%');
}

function createAppDbStore(key) {
  return {
    kind: 'app-db',
    scope: 'app',
    location: APP_KV_TABLE + ':' + key,
    read: () => readRow(key),
    write: (next) => writeRow(key, next),
    version: () => cache.dbStamp()
  };
}

module.exports = { createAppDbStore, listQuarantined };
