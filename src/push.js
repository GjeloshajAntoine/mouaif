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

function vapidSubjectForOrigin(origin) {
  if (!origin) return VAPID_SUBJECT;
  try {
    const parsed = new URL(origin);
    // web-push accepts mailto: or HTTPS VAPID subjects. Public iOS Web Push
    // origins are HTTPS, so using the served origin gives Apple a stable,
    // deployment-specific contact without requiring APNs credentials.
    if (parsed.protocol === 'https:') return parsed.origin;
  } catch { /* use the local fallback */ }
  return VAPID_SUBJECT;
}

function readVapidKeys() {
  const db = settings.getDb();
  const publicKey = db.prepare(`SELECT value FROM ${VAPID_TABLE} WHERE key = 'publicKey'`).pluck().get() || null;
  const privateKey = db.prepare(`SELECT value FROM ${VAPID_TABLE} WHERE key = 'privateKey'`).pluck().get() || null;
  return { publicKey, privateKey };
}

function ensureVapidKeys(origin) {
  const db = settings.getDb();
  const existing = readVapidKeys();
  const subject = vapidSubjectForOrigin(origin);
  if (existing.publicKey && existing.privateKey) {
    webpush.setVapidDetails(subject, existing.publicKey, existing.privateKey);
    return existing.publicKey;
  }
  const keys = webpush.generateVAPIDKeys();
  const now = new Date().toISOString();
  const save = db.prepare(`INSERT INTO ${VAPID_TABLE} (key, value, created_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`);
  const saveKeys = db.transaction(() => {
    save.run('publicKey', keys.publicKey, now);
    save.run('privateKey', keys.privateKey, now);
  });
  saveKeys();
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  return keys.publicKey;
}

function getVapidPublicKey() {
  const db = settings.getDb();
  return db.prepare(`SELECT value FROM ${VAPID_TABLE} WHERE key = 'publicKey'`).pluck().get() || null;
}

function getPushConfig(origin) {
  const publicKey = ensureVapidKeys(origin);
  const keys = readVapidKeys();
  return {
    origin: origin || null,
    subject: vapidSubjectForOrigin(origin),
    publicKey,
    privateKeyConfigured: !!keys.privateKey
  };
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
  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT id, created_at FROM ${SUB_TABLE} WHERE endpoint = ?`).get(endpoint);
  const id = existing ? existing.id : crypto.randomUUID();
  db.prepare(`INSERT INTO ${SUB_TABLE} (id, session_id, endpoint, p256dh, auth, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      session_id = excluded.session_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      origin = excluded.origin,
      updated_at = excluded.updated_at`)
    .run(id, sessionId, endpoint, p256dh, auth, origin || null, existing ? existing.created_at : now, now);
  return { id, endpoint, origin };
}

function removeSubscription(endpoint, sessionId) {
  const db = settings.getDb();
  const info = sessionId
    ? db.prepare(`DELETE FROM ${SUB_TABLE} WHERE endpoint = ? AND session_id = ?`).run(endpoint, sessionId)
    : db.prepare(`DELETE FROM ${SUB_TABLE} WHERE endpoint = ?`).run(endpoint);
  return info.changes > 0;
}

function removeAllSubscriptions(sessionId) {
  const db = settings.getDb();
  db.prepare(`DELETE FROM ${SUB_TABLE} WHERE session_id = ?`).run(sessionId);
}

// ---- Push sending -------------------------------------------------------

function sendPush({ sessionId, title, body, tag, data, chatId, projectDir, actions, requireInteraction }) {
  const subs = sessionId ? listSubscriptions(sessionId) : [];
  if (!subs.length) return;

  const keys = readVapidKeys();

  const payload = JSON.stringify({
    title: title || 'mouaif',
    body: body || '',
    tag: tag || (chatId ? `chat-${chatId}` : undefined),
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/favicon-32.png',
    data: data || { chatId, projectDir, url: chatId && projectDir ? `/#/chat/${chatId}?projectDir=${encodeURIComponent(projectDir)}` : '/' },
    actions: Array.isArray(actions) && actions.length
      ? actions
      : [{ action: 'open', title: 'Open chat' }],
    requireInteraction: requireInteraction === true
  });

  for (const sub of subs) {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    };
    const options = keys.publicKey && keys.privateKey ? {
      vapidDetails: {
        subject: vapidSubjectForOrigin(sub.origin),
        publicKey: keys.publicKey,
        privateKey: keys.privateKey
      }
    } : undefined;
    webpush.sendNotification(subscription, payload, options).catch((err) => {
      // 410 Gone / 404 Not Found means the subscription is dead
      if (err && (err.statusCode === 410 || err.statusCode === 404)) {
        removeSubscription(sub.endpoint);
      }
    });
  }
}

// sendPushToSession — send a push notification to a specific session.
// Called from handleChatStream for attention, completion, and error events.
function sendPushToSession(sessionId, { title, body, chatId, projectDir, tag, data, actions, requireInteraction }) {
  sendPush({ sessionId, title, body, tag, chatId, projectDir, data, actions, requireInteraction });
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
  getPushConfig,
  vapidSubjectForOrigin,
  listSubscriptions,
  addSubscription,
  removeSubscription,
  removeAllSubscriptions,
  sendPush,
  sendPushToSession,
  sessionIdFromToken
};