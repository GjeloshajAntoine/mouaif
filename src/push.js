'use strict';

// mouaif push notification subsystem
//
// Three layers:
//   1. VAPID key management (auto-generated, stored in SQLite)
//   2. Push subscription CRUD (per-session)
//   3. Push sending utility (tagged per-chat for updatable notifications)
//
// The ASCII status bar that rides every chat notification lives in
// src/statusBar.js: it decides the bar's cell count from the receiving
// device's screen size, notification style, and OS version. This module only
// stores the device's self-report and resolves it per target at send time.

// `web-push` pulls in asn1.js / bn.js / jws (~several MB resident). Load it on
// first use — a server with no push subscribers never needs it.
let webpushMod = null;
function webpush() { return webpushMod || (webpushMod = require('web-push')); }
const crypto = require('crypto');
const settings = require('./settings.js');
const statusBar = require('./statusBar.js');

const SUB_TABLE = 'push_subscriptions';
const VAPID_TABLE = 'push_vapid';
const VAPID_SUBJECT = 'mailto:push@mouaif.local';

// Fields a device may report about itself for status-bar sizing. Anything
// else in the subscribe body is ignored, so a malformed client cannot grow an
// unbounded blob in the subscription row.
const PROFILE_MAX_CHARS = 512;

// normalizeStatusBarProfile(value) -> JSON string | null
//
// Keep only the known sizing fields and only when they carry a usable value,
// so the stored profile is small and statusBarJs.statusBarPlan() can trust
// its types. Returns null when nothing usable was reported, so a rebind can
// preserve the previously stored profile.
function normalizeStatusBarProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  const chars = Number(value.chars);
  if (Number.isFinite(chars) && chars > 0) out.chars = Math.round(chars);
  const viewportWidth = Number(value.viewportWidth);
  if (Number.isFinite(viewportWidth) && viewportWidth > 0) out.viewportWidth = Math.round(viewportWidth);
  const os = statusBar.normalizeOs(value.os);
  if (os) out.os = os;
  const osVersion = Number(value.osVersion);
  if (Number.isFinite(osVersion) && osVersion > 0) out.osVersion = Math.round(osVersion);
  const style = String(value.style || '').trim().toLowerCase();
  if (style === 'collapsed' || style === 'expanded') out.style = style;
  if (!Object.keys(out).length) return null;
  const json = JSON.stringify(out);
  return json.length <= PROFILE_MAX_CHARS ? json : null;
}

// statusBarFromLegacyChars(value) -> integer | null
//
// The original subscribe shape sent a bare character count. Keep honoring it
// so a client that predates the richer profile still sizes its bar.
function statusBarFromLegacyChars(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

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
  // No global webpush.setVapidDetails(): sendPush() passes vapidDetails on
  // every call, so an existing key pair never needs `web-push` loaded here.
  if (existing.publicKey && existing.privateKey) return existing.publicKey;
  const keys = webpush().generateVAPIDKeys();
  const now = new Date().toISOString();
  const save = db.prepare(`INSERT INTO ${VAPID_TABLE} (key, value, created_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`);
  const saveKeys = db.transaction(() => {
    save.run('publicKey', keys.publicKey, now);
    save.run('privateKey', keys.privateKey, now);
  });
  saveKeys();
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
    status_bar INTEGER,
    status_bar_profile TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ${VAPID_TABLE} (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  // Devices subscribed before the status bar became device-sized have no
  // stored report; they keep the conservative phone plan until the page
  // rebinds its endpoint (every startup sync re-registers, so this heals).
  // `status_bar` is the original bare character count; `status_bar_profile`
  // is the current shape (measured chars, viewport, OS, OS version, style).
  const cols = db.prepare(`PRAGMA table_info('${SUB_TABLE}')`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('status_bar')) {
    db.exec(`ALTER TABLE ${SUB_TABLE} ADD COLUMN status_bar INTEGER`);
  }
  if (!names.has('status_bar_profile')) {
    db.exec(`ALTER TABLE ${SUB_TABLE} ADD COLUMN status_bar_profile TEXT`);
  }
}

function listSubscriptions(sessionId) {
if (!sessionId) return [];
const db = settings.getDb();
return db.prepare(`SELECT id, endpoint, p256dh, auth, origin, status_bar, status_bar_profile, created_at FROM ${SUB_TABLE} WHERE session_id = ? ORDER BY created_at ASC`).all(sessionId);
}
// Every subscription, across sessions — used by the sign-in alert, which
// must reach the user's other already-signed-in devices. A login mints a
// brand-new session whose own subscription list is empty until the page
// rebinds its endpoint, so a per-session send would reach nothing.
function listAllSubscriptions() {
const db = settings.getDb();
return db.prepare(`SELECT id, session_id, endpoint, p256dh, auth, origin, status_bar, status_bar_profile, created_at FROM ${SUB_TABLE} ORDER BY created_at ASC`).all();
}


function addSubscription({ sessionId, endpoint, p256dh, auth, origin, statusBarMaxChars, statusBarProfile }) {
  const db = settings.getDb();
  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT id, created_at, status_bar, status_bar_profile FROM ${SUB_TABLE} WHERE endpoint = ?`).get(endpoint);
  const id = existing ? existing.id : crypto.randomUUID();
  // The device reports how it presents notifications (measured body line,
  // viewport, OS, OS version, style). An absent report (an older page, a curl
  // client) keeps whatever this device last stored — a stale client must not
  // reset a good profile, and a rebind is the normal path that refines it.
  const profileJson = normalizeStatusBarProfile(statusBarProfile)
    || (existing && existing.status_bar_profile)
    || null;
  const legacyChars = statusBarFromLegacyChars(statusBarMaxChars);
  const statusBarValue = legacyChars != null
    ? legacyChars
    : (existing && existing.status_bar) || null;
  db.prepare(`INSERT INTO ${SUB_TABLE} (id, session_id, endpoint, p256dh, auth, origin, status_bar, status_bar_profile, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      session_id = excluded.session_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      origin = excluded.origin,
      status_bar = excluded.status_bar,
      status_bar_profile = excluded.status_bar_profile,
      updated_at = excluded.updated_at`)
    .run(id, sessionId, endpoint, p256dh, auth, origin || null, statusBarValue, profileJson, existing ? existing.created_at : now, now);
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

// sendPush({ ... , body, bodyFor }) — deliver one notification to every
// target subscription.
//
// `body` is the device-independent text; `bodyFor(sub)` is the status-bar
// escape hatch: a status push passes a function that builds its body from the
// *subscription's* own device plan, so each device gets a bar sized to its
// screen, notification style, and OS version (see src/statusBar.js). A push
// without `bodyFor` sends the same `body` everywhere, which is what
// authorization and sign-in alerts do.
function sendPush({ sessionId, subs, title, body, bodyFor, tag, data, chatId, projectDir, actions, requireInteraction }) {
const targets = Array.isArray(subs) ? subs : (sessionId ? listSubscriptions(sessionId) : []);
if (!targets.length) return;


  const keys = readVapidKeys();

  for (const sub of targets) {
    let targetBody = body;
    if (typeof bodyFor === 'function') {
      try {
        const resolved = bodyFor(sub);
        if (typeof resolved === 'string') targetBody = resolved;
      } catch { /* fall back to the shared body */ }
    }
    const payload = JSON.stringify({
      title: title || 'mouaif',
      body: targetBody || '',
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
    webpush().sendNotification(subscription, payload, options).catch((err) => {
      // 410 Gone / 404 Not Found means the subscription is dead
      if (err && (err.statusCode === 410 || err.statusCode === 404)) {
        removeSubscription(sub.endpoint);
      }
    });
  }
}

// sendPushToSession — send a push notification to a specific session.
// Called from handleChatStream for attention, completion, and error events.
function sendPushToSession(sessionId, { title, body, bodyFor, chatId, projectDir, tag, data, actions, requireInteraction }) {
sendPush({ sessionId, title, body, bodyFor, tag, chatId, projectDir, data, actions, requireInteraction });
}
// sendPushToAll — send to every subscribed endpoint regardless of session.
// Used by the sign-in alert, which must reach the user's other devices even
// though the login created a brand-new session.
function sendPushToAll({ title, body, bodyFor, chatId, projectDir, tag, data, actions, requireInteraction }) {
sendPush({ subs: listAllSubscriptions(), title, body, bodyFor, tag, chatId, projectDir, data, actions, requireInteraction });
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
  normalizeStatusBarProfile,
  // Status-bar surface re-exported so senders have one import for "build a
  // status body": `push.statusBar` is src/statusBar.js.
  statusBar,
  listSubscriptions,
listAllSubscriptions,
addSubscription,
removeSubscription,
removeAllSubscriptions,
sendPush,
sendPushToSession,
sendPushToAll,
sessionIdFromToken
};