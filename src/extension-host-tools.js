'use strict';

// Host tools for extension views (docs/features/extensions.md, spec §5.4).
//
// An extension's view calls these with an ordinary MCP `tools/call` whose
// name starts with `mouaif/` (not a valid tool name on any MCP server, so
// nothing is shadowed). Only extension views can call them, never a tool
// result's app, and each checks the extension's permissions:
//
//   mouaif/chat.recent       chat.read        the chat's last messages, text only (≤ 32 KB)
//   mouaif/composer.insert   composer.insert  put text in the message box (never sends)
//   mouaif/chat.badge        —                the dock chip's badge (≤ 8 chars) and tone
//   mouaif/chat.open_sheet   —                open one of the same extension's sheets
//   mouaif/settings.get      storage          the extension's own key-value store
//   mouaif/settings.set      storage          (64 KB per extension, not mouaif settings)
//
// Tools that change the page (insert, badge, sheet) return a `clientAction`
// the page performs; the server is the one that checks the permission.

const PREFIX = 'mouaif/';
const MAX_RECENT_BYTES = 32 * 1024;
const MAX_INSERT = 8 * 1024;
const MAX_STORE = 64 * 1024;
const BADGE_TONES = Object.freeze(['info', 'ok', 'warn', 'error']);

const TOOLS = Object.freeze({
  'chat.recent': { permission: 'chat.read', chat: true, description: 'The chat’s last messages (role and text), newest last.' },
  'composer.insert': { permission: 'composer.insert', chat: true, description: 'Insert text into the message box; the user sends it.' },
  'chat.badge': { permission: null, chat: false, description: 'Set the dock chip’s badge (up to 8 characters, empty to clear) and tone.' },
  'chat.open_sheet': { permission: null, chat: true, description: 'Open one of this extension’s sheets by surface id.' },
  'settings.get': { permission: 'storage', chat: false, description: 'Read this extension’s stored values (one key, or all).' },
  'settings.set': { permission: 'storage', chat: false, description: 'Store a JSON value under a key (null deletes it); 64 KB per extension.' }
});

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// ---- The per-extension store -------------------------------------------------

const CREATE = `
  CREATE TABLE IF NOT EXISTS extension_store (
    extension_id TEXT NOT NULL,
    key          TEXT NOT NULL,
    value        TEXT NOT NULL,
    PRIMARY KEY (extension_id, key)
  )
`;
let db = null;
function store() {
  if (db) return db;
  const d = require('./settings.js').getDb();
  d.exec(CREATE);
  db = d;
  return d;
}

function storeGet(extensionId, key) {
  if (key !== undefined) {
    const row = store().prepare('SELECT value FROM extension_store WHERE extension_id = ? AND key = ?').get(extensionId, key);
    return row ? JSON.parse(row.value) : null;
  }
  const out = {};
  for (const row of store().prepare('SELECT key, value FROM extension_store WHERE extension_id = ? ORDER BY key').all(extensionId)) {
    out[row.key] = JSON.parse(row.value);
  }
  return out;
}

function storeSet(extensionId, key, value) {
  if (value === null) {
    store().prepare('DELETE FROM extension_store WHERE extension_id = ? AND key = ?').run(extensionId, key);
    return;
  }
  const text = JSON.stringify(value);
  const used = store().prepare('SELECT COALESCE(SUM(LENGTH(key) + LENGTH(value)), 0) AS n FROM extension_store WHERE extension_id = ? AND key != ?')
    .get(extensionId, key).n;
  if (used + key.length + Buffer.byteLength(text) > MAX_STORE) throw fail('EMCP_APP_LIMIT', 'This extension’s storage is full (64 KB)');
  store().prepare(`INSERT INTO extension_store (extension_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(extension_id, key) DO UPDATE SET value = excluded.value`).run(extensionId, key, text);
}

function removeExtensionStore(extensionId) {
  try { store().prepare('DELETE FROM extension_store WHERE extension_id = ?').run(extensionId); } catch { /* store down */ }
}

// ---- Running -------------------------------------------------------------------

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
  return '';
}

function result(data, clientAction) {
  const out = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  if (clientAction) out.clientAction = clientAction;
  return out;
}

// runHostTool(mount, name, args) -> CallToolResult (+ clientAction)
// mount: a surface mount { kind: 'surface', projectDir, chatId, extensionId, permissions }
function runHostTool(mount, name, args) {
  if (!mount || mount.kind !== 'surface') throw fail('EMCP_VISIBILITY', 'mouaif/ tools are only for extension views');
  if (typeof name !== 'string' || !name.startsWith(PREFIX)) throw fail('EBADINPUT', 'not a mouaif/ tool');
  const tool = name.slice(PREFIX.length);
  const spec = TOOLS[tool];
  if (!spec) throw fail('EBADINPUT', 'unknown host tool ' + name + ' (known: ' + Object.keys(TOOLS).map((t) => PREFIX + t).join(', ') + ')');
  if (spec.permission && !mount.permissions.includes(spec.permission)) {
    throw fail('EMCP_VISIBILITY', name + ' needs the "' + spec.permission + '" permission, which this extension does not have');
  }
  if (spec.chat && !mount.chatId) throw fail('EBADINPUT', name + ' works only in a chat');
  const a = isObject(args) ? args : {};
  if (tool === 'chat.recent') {
    const limit = Math.max(1, Math.min(50, Number(a.limit) || 20));
    const rows = require('./messages.js').listMessages(mount.projectDir, mount.chatId)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, text: textOf(m.content).slice(0, 4000), ts: m.ts }))
      .filter((m) => m.text.trim())
      .slice(-limit);
    while (rows.length > 1 && Buffer.byteLength(JSON.stringify(rows)) > MAX_RECENT_BYTES) rows.shift();
    return result({ messages: rows });
  }
  if (tool === 'composer.insert') {
    if (typeof a.text !== 'string' || !a.text) throw fail('EBADINPUT', 'text is required');
    if (Buffer.byteLength(a.text) > MAX_INSERT) throw fail('EBADINPUT', 'text is at most 8 KB');
    return result({ inserted: true }, { type: 'composer.insert', text: a.text });
  }
  if (tool === 'chat.badge') {
    const text = a.text === undefined || a.text === null ? '' : String(a.text);
    if ([...text].length > 8) throw fail('EBADINPUT', 'a badge is at most 8 characters');
    const tone = a.tone === undefined ? 'info' : a.tone;
    if (!BADGE_TONES.includes(tone)) throw fail('EBADINPUT', 'tone must be one of ' + BADGE_TONES.join(', '));
    return result({ ok: true }, { type: 'badge', text, tone });
  }
  if (tool === 'chat.open_sheet') {
    const surfaceId = typeof a.surfaceId === 'string' ? a.surfaceId : '';
    const found = require('./extensions.js').surface(mount.projectDir, mount.extensionId, surfaceId);
    if (!found || found.ui.slot !== 'chat.sheet') throw fail('EBADINPUT', 'this extension has no sheet "' + surfaceId + '"');
    return result({ ok: true }, { type: 'open_sheet', extensionId: mount.extensionId, surfaceId });
  }
  if (tool === 'settings.get') {
    if (a.key !== undefined && typeof a.key !== 'string') throw fail('EBADINPUT', 'key must be a string');
    return result({ value: storeGet(mount.extensionId, a.key) });
  }
  // settings.set
  if (typeof a.key !== 'string' || !a.key || a.key.length > 128) throw fail('EBADINPUT', 'key (1–128 characters) is required');
  if (a.value === undefined) throw fail('EBADINPUT', 'value is required (null deletes the key)');
  storeSet(mount.extensionId, a.key, a.value);
  return result({ ok: true });
}

// hostEventsWanted(projectDir) -> Set of event names some active extension
// view declared (`events` on a ui entry); empty when none.
function hostEventsWanted(projectDir) {
  const out = new Set();
  try {
    for (const { ext } of require('./extensions.js').active(projectDir)) {
      for (const ui of ext.ui) for (const e of ui.events || []) out.add(e);
    }
  } catch { /* registry unavailable */ }
  return out;
}

module.exports = { PREFIX, TOOLS, runHostTool, hostEventsWanted, removeExtensionStore, _storeGet: storeGet };
