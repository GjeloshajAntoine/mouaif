'use strict';

// Credentials share the app SQLite connection, but never the settings JSON
// exposed by REST/native tools. Null values are sign-out tombstones: preserved
// legacy keychain entries must not resurrect a disconnected account.
const settings = require('./settings.js');
let legacyKeyring;

function storageError(cause) {
  return Object.assign(new Error('Could not access credentials in the app database.'), {
    code: 'ECREDENTIALS', cause
  });
}

function write(service, account, value) {
  try {
    settings.getDb().prepare(`INSERT INTO credentials (service, account, value)
      VALUES (?, ?, ?) ON CONFLICT(service, account) DO UPDATE SET value = excluded.value`)
      .run(service, account, value);
  } catch (e) { throw storageError(e); }
}

function read(service, account) {
  let row;
  try {
    row = settings.getDb().prepare('SELECT value FROM credentials WHERE service = ? AND account = ?')
      .get(service, account);
  } catch (e) { throw storageError(e); }
  if (row) return row.value;
  // Best-effort, copy-on-read migration. Never require a working keychain for
  // new sign-ins; never delete the old entry. An unavailable legacy credential
  // is treated as absent so the user can sign in again using SQLite.
  let value;
  try {
    const { Entry } = legacyKeyring || (legacyKeyring = require('@napi-rs/keyring'));
    value = new Entry(service, account).getPassword();
  } catch { return null; }
  if (typeof value !== 'string') return null;
  try {
    // Another process may have signed in or out during the legacy read.
    // Never overwrite its newer DB value or sign-out tombstone.
    const db = settings.getDb();
    db.prepare('INSERT OR IGNORE INTO credentials (service, account, value) VALUES (?, ?, ?)')
      .run(service, account, value);
    return db.prepare('SELECT value FROM credentials WHERE service = ? AND account = ?')
      .get(service, account).value;
  } catch (e) { throw storageError(e); }
}

function remove(service, account) {
  write(service, account, null);
}

function accounts(service) {
  try {
    return settings.getDb().prepare('SELECT account FROM credentials WHERE service = ? AND value IS NOT NULL ORDER BY account')
      .all(service).map(row => row.account);
  } catch (e) { throw storageError(e); }
}

module.exports = { read, write, remove, accounts };
