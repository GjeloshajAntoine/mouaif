'use strict';

// mouaif push notification subsystem
//
// Three layers:
//   1. VAPID key management (auto-generated, stored in SQLite)
//   2. Push subscription CRUD (per-session)
//   3. Push sending utility (tagged per-chat for updatable notifications)

const webpush = require('web-push');
const crypto = require('crypto');
const settings = require('./settings.js');

const SUB_TABLE = 'push_subscriptions';
const VAPID_TABLE = 'push_vapid';
const VAPID_SUBJECT = 'mailto:push@mouaif.local';

// ---- VAPID keys ---------------------------------------------------------

function ensureVapidKeys() {
  const db = settings.getDb();
  const existing = db.prepare(`SELECT value FROM ${VAPID_TABLE} WHERE key = 'publicKey'`).pluck().get();
  if (existing) {
    const privateKey = db.prepare(`SELECT value FROM ${VAPID_TABLE} WHERE key = 'privateKey'`).pluck().get();
    webpush.setVapidDetails(VAPID_SUBJECT, existing, privateKey);
    return existing;
  }
  const keys = webpush.generateVAPIDKeys();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ${VAPID_TABLE} (key, value, created_at) VALUES ('publicKey', ?, ?)`).run(keys.publicKey, now);
  db.prepare(`INSERT INTO ${VAPID_TABLE} (key, value, created_at) VALUES ('privateKey', ?, ?)`).run(keys.privateKey, now);
  webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
  return keys.publicKey;
}

function getVapidPublicKey() {
  const db = settings.getDb();
  return db.prepare(`SELECT value FROM ${VAPID_TABLE} WHERE key = 'publicKey'`).pluck().get() || null;
}

// ---- Subscription CRUD --------------------------------------------------

function ensureTable() {
  const db = settings.getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS ${SUB_TABLE} (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    origin     TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ${VAPID_TABLE} (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
}

function listSubscriptions(sessionId) {
  if (!sessionId) return [];
  const db = settings.getDb();
  return db.prepare(`SELECT id, endpoint, p256dh, auth, origin, created_at FROM ${SUB_TABLE} WHERE session_id = ? ORDER BY created_at ASC`).all(sessionId);
}

function addSubscription({ sessionId, endpoint, p256dh, auth, origin }) {
  const db = settings.getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO ${SUB_TABLE} (id, session_id, endpoint, p256dh, auth, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, sessionId, endpoint, p256dh, auth, origin || null, now, now);
  return { id, endpoint, origin };
}

function removeSubscription(endpoint) {
  const db = settings.getDb();
  const info = db.prepare(`DELETE FROM ${SUB_TABLE} WHERE endpoint = ?`).run(endpoint);
  return info.changes > 0;
}

function removeAllSubscriptions(sessionId) {
  const db = settings.getDb();
  db.prepare(`DELETE FROM ${SUB_TABLE} WHERE session_id = ?`).run(sessionId);
}

// ---- Push sending -------------------------------------------------------

function sendPush({ sessionId, title, body, tag, data, chatId, projectDir }) {
  const subs = sessionId ? listSubscriptions(sessionId) : [];
  if (!subs.length) return;

  const payload = JSON.stringify({
    title: title || 'mouaif',
    body: body || '',
    tag: tag || (chatId ? `chat-${chatId}` : undefined),
    renotify: true,
    icon: '/web/icons/icon-192.png',
    badge: '/web/icons/favicon-32.png',
    data: data || { chatId, projectDir, url: chatId && projectDir ? `/web/#/chat/${chatId}?projectDir=${encodeURIComponent(projectDir)}` : '/web/' },
    actions: [
      { action: 'open', title: 'Open chat' }
    ]
  });

  for (const sub of subs) {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    };
    webpush.sendNotification(subscription, payload).catch((err) => {
      // 410 Gone / 404 Not Found means the subscription is dead
      if (err && (err.statusCode === 410 || err.statusCode === 404)) {
        removeSubscription(sub.endpoint);
      }
    });
  }
}

// sendPushToSession — send a push notification to a specific session.
// Called from handleChatStream when events like progress_update, done, or error fire.
function sendPushToSession(sessionId, { title, body, chatId, projectDir, tag, data }) {
  sendPush({ sessionId, title, body, tag, chatId, projectDir, data });
}

// ---- Session ID helpers -------------------------------------------------

// Derive a stable session id from the session token. One-way hash so the
// token itself is never stored alongside subscriptions.
function sessionIdFromToken(token) {
  if (!token) return null;
  return crypto.createHash('sha256').update('push:' + token).digest('hex').slice(0, 16);
}

module.exports = {
  ensureTable,
  ensureVapidKeys,
  getVapidPublicKey,
  listSubscriptions,
  addSubscription,
  removeSubscription,
  removeAllSubscriptions,
  sendPush,
  sendPushToSession,
  sessionIdFromToken
};