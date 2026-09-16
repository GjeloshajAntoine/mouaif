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

// ---- ASCII status bar ---------------------------------------------------
//
// Every chat status notification (progress, completion, error) carries one
// ASCII bar. The bar has to fit the *device* that receives it, not the
// server: a 430 px phone lock screen gives a plain-text body roughly 32
// characters per line, a tablet-held PWA about 44, and a desktop toast —
// which lays the bar out with a proportional font on a much wider surface —
// comfortably more. One fixed cell count cannot be right for all three, so
// the receiving browser reports its own body budget at subscribe time, that
// budget is stored on the subscription row, and each send picks the cell
// count from the size the bar will actually be shown at.
//
// Three sizes, matched to the surfaces the app is actually used on:
//   narrow (a phone, incl. an installed iOS/Android PWA)  -> 6 cells
//   wide   (a phone in landscape, a small tablet)         -> 10 cells
//   huge   (a tablet, a desktop browser toast)            -> 20 cells
// A wider bar is strictly more informative, but a row that wraps to a
// second line pushes the status text out of the collapsed preview a phone
// lock screen shows, so the cell count only grows with the room the body
// actually has. The thresholds are deliberately below the raw character
// capacity of each surface: the bar shares the line with the notification's
// own gutter, and the info line under it reads better when it is the
// longest row in the notice.
const BAR_CELLS = Object.freeze({ narrow: 6, wide: 10, huge: 20 });
const BAR_NARROW_MAX_CHARS = 45;
const BAR_WIDE_MAX_CHARS = 90;
// An unmeasured device (a headless browser, a worker-only context, an older
// page) gets the phone bar: the conservative choice, since too few cells
// only loses resolution while too many wraps the row.
const DEFAULT_STATUS_BAR_SIZE = 'narrow';

// statusBarSizeForMaxChars(maxChars) -> 'narrow' | 'wide' | 'huge'
//
// The cell count is chosen from the body width the device reported. A body
// line under 45 characters is a phone (6 cells), under 90 a landscape phone
// or small tablet (10 cells), and beyond that a tablet or desktop toast
// (20 cells). An unknown/absent budget falls back to the phone default.
function statusBarSizeForMaxChars(maxChars) {
  const max = Number(maxChars);
  if (!Number.isFinite(max) || max <= 0) return DEFAULT_STATUS_BAR_SIZE;
  if (max < BAR_NARROW_MAX_CHARS) return 'narrow';
  if (max < BAR_WIDE_MAX_CHARS) return 'wide';
  return 'huge';
}

function statusBarCells(size) {
  return BAR_CELLS[size] || BAR_CELLS[DEFAULT_STATUS_BAR_SIZE];
}

// asciiStatusBar(percent, size) -> '[####--] 40%'
//
// One bar for every chat status notification, so progress, completion, and
// errors share a single visual format. `percent == null` (an error with no
// measurable progress) renders an empty bar without a percentage. Pure
// ASCII: no Unicode block glyphs, which render inconsistently across
// Android, iOS, and desktop notification fonts.
function asciiStatusBar(percent, size) {
  const width = statusBarCells(size);
  const normalized = percent == null ? null : Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  // Round the fill so any non-zero progress lights at least one cell: at
  // 20 cells a plain round() would show 4% as a completely empty bar.
  const filled = normalized == null ? 0
    : (normalized > 0 ? Math.max(1, Math.round((normalized / 100) * width)) : 0);
  return '[' + '#'.repeat(filled) + '-'.repeat(width - filled) + ']'
    + (normalized == null ? '' : ' ' + normalized + '%');
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
    status_bar INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ${VAPID_TABLE} (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  // Devices subscribed before the status bar became device-sized have no
  // stored budget; they keep the phone default until the page rebinds its
  // endpoint (every startup sync re-registers, so this is self-healing).
  const cols = db.prepare(`PRAGMA table_info('${SUB_TABLE}')`).all();
  if (!cols.some((c) => c.name === 'status_bar')) {
    db.exec(`ALTER TABLE ${SUB_TABLE} ADD COLUMN status_bar INTEGER`);
  }
}

function listSubscriptions(sessionId) {
if (!sessionId) return [];
const db = settings.getDb();
return db.prepare(`SELECT id, endpoint, p256dh, auth, origin, status_bar, created_at FROM ${SUB_TABLE} WHERE session_id = ? ORDER BY created_at ASC`).all(sessionId);
}
// Every subscription, across sessions — used by the sign-in alert, which
// must reach the user's other already-signed-in devices. A login mints a
// brand-new session whose own subscription list is empty until the page
// rebinds its endpoint, so a per-session send would reach nothing.
function listAllSubscriptions() {
const db = settings.getDb();
return db.prepare(`SELECT id, session_id, endpoint, p256dh, auth, origin, status_bar, created_at FROM ${SUB_TABLE} ORDER BY created_at ASC`).all();
}


function addSubscription({ sessionId, endpoint, p256dh, auth, origin, statusBarMaxChars }) {
  const db = settings.getDb();
  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT id, created_at, status_bar FROM ${SUB_TABLE} WHERE endpoint = ?`).get(endpoint);
  const id = existing ? existing.id : crypto.randomUUID();
  // The device reports how many characters one notification body line
  // holds. Absent (an older page, a curl client) keeps whatever this
  // device last reported so a stale client cannot reset a good budget.
  const reported = Number(statusBarMaxChars);
  const statusBar = Number.isFinite(reported) && reported > 0
    ? Math.round(reported)
    : (existing && existing.status_bar) || null;
  db.prepare(`INSERT INTO ${SUB_TABLE} (id, session_id, endpoint, p256dh, auth, origin, status_bar, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      session_id = excluded.session_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      origin = excluded.origin,
      status_bar = excluded.status_bar,
      updated_at = excluded.updated_at`)
    .run(id, sessionId, endpoint, p256dh, auth, origin || null, statusBar, existing ? existing.created_at : now, now);
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
// escape hatch: a status push passes a function that builds its body from
// the *subscription's* own reported line budget, so each device gets a bar
// sized to the surface the OS will actually show it on (see BAR_CELLS). A
// push without `bodyFor` sends the same `body` everywhere, which is what
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
  asciiStatusBar,
  statusBarSizeForMaxChars,
  statusBarCells,
  BAR_CELLS,
  DEFAULT_STATUS_BAR_SIZE,
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