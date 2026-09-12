'use strict';

// Chat DB — SQLite-backed chat and message storage.
//
// Implements the "store chats in DB by default" design:
//   - chat metadata in `chat_store` table
//   - messages in `message_store` table
//   - both in the same ~/.mouaif/store.sqlite used by settings.js
//
// This module exposes the DB helpers. The public API surface remains
// src/chats.js and src/messages.js, which route through this module.
// It is the only chat/message storage backend.

const path = require('path');
const { assertChatId, CHAT_ID_RE, normalizeMessage } = require('./messages.js');

// ---- Schema DDL – created lazily via IF NOT EXISTS ------------------------

const CREATE_CHAT_TABLE = `
  CREATE TABLE IF NOT EXISTS chat_store (
    project_dir   TEXT NOT NULL,
    id            TEXT NOT NULL,
    title         TEXT NOT NULL DEFAULT 'New chat',
    created_at    TEXT NOT NULL,
    last_opened_at TEXT,
    trace         INTEGER NOT NULL DEFAULT 0,
    prompt_size   TEXT NOT NULL DEFAULT 'average',
    prompt_id     TEXT,
    provider_id   TEXT,
    model_id      TEXT,
    thinking_level TEXT DEFAULT '',
    max_output_tokens TEXT DEFAULT '',
    draft         TEXT NOT NULL DEFAULT '',
    draft_attachments TEXT,
    tools         TEXT,
agent_id      TEXT,
agent_files   INTEGER,
skills        INTEGER,
auto_retry    INTEGER NOT NULL DEFAULT 1,
total_cost    REAL NOT NULL DEFAULT 0,
cost_known_count INTEGER NOT NULL DEFAULT 0,
PRIMARY KEY (project_dir, id)
)
`;

const CREATE_MESSAGE_TABLE = `
  CREATE TABLE IF NOT EXISTS message_store (
    project_dir   TEXT NOT NULL,
    chat_id       TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    role          TEXT NOT NULL,
    content       TEXT NOT NULL,
    ts            TEXT NOT NULL,
    reasoning     TEXT,
    usage         TEXT,
    cost          TEXT,
    streaming_ms  INTEGER,
    model_id      TEXT,
    attachments   TEXT,
    tool_call_id  TEXT,
    name          TEXT,
    args          TEXT,
    ok            INTEGER,
    phase         TEXT,
    PRIMARY KEY (project_dir, chat_id, seq)
  )
`;

// ---- Lazy DB init (reuses settings.js connection) -------------------------

const INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_chat_store_recent
    ON chat_store (project_dir, COALESCE(last_opened_at, created_at) DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_message_store_lookup
    ON message_store (project_dir, chat_id, seq);
  CREATE INDEX IF NOT EXISTS idx_message_store_cost
    ON message_store (project_dir, chat_id)
    WHERE role = 'assistant' AND cost IS NOT NULL
`;

function ensureTables() {
  const settings = require('./settings.js');
  const d = settings.getDb();
  d.exec(CREATE_CHAT_TABLE);
d.exec(CREATE_MESSAGE_TABLE);
const chatColumns = d.prepare("PRAGMA table_info('chat_store')").all();
if (!chatColumns.some((column) => column.name === 'total_cost')) {
d.exec('ALTER TABLE chat_store ADD COLUMN total_cost REAL NOT NULL DEFAULT 0');
}
if (!chatColumns.some((column) => column.name === 'cost_known_count')) {
d.exec('ALTER TABLE chat_store ADD COLUMN cost_known_count INTEGER NOT NULL DEFAULT 0');
}
if (!chatColumns.some((column) => column.name === 'auto_retry')) {
d.exec('ALTER TABLE chat_store ADD COLUMN auto_retry INTEGER NOT NULL DEFAULT 1');
}
d.exec(INDEX_SQL);
}

// ---- Row <-> object mappers -----------------------------------------------

function rowToChat(row) {
  if (!row) return null;
  const chat = {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at || null,
    trace: row.trace === 1,
    promptSize: row.prompt_size,
    promptId: row.prompt_id || null,
    providerId: row.provider_id || null,
    modelId: row.model_id || null,
    thinkingLevel: row.thinking_level || '',
    maxOutputTokens: row.max_output_tokens || '',
    draft: row.draft || '',
    agentFiles: row.agent_files === null ? undefined : (row.agent_files === 1),
skills: row.skills === null ? undefined : (row.skills === 1),
autoRetry: row.auto_retry !== 0,
totalCost: {
      total: typeof row.total_cost === 'number' ? row.total_cost : 0,
      known: typeof row.cost_known_count === 'number' && row.cost_known_count > 0,
      currency: 'USD',
      knownCount: typeof row.cost_known_count === 'number' ? row.cost_known_count : 0
    }
  };
  // draftAttachments: null/'' -> undefined (no image draft); otherwise the
// JSON array of pending image attachments for the composer.
  if (row.draft_attachments) {
  try {
    const parsed = JSON.parse(row.draft_attachments);
    if (Array.isArray(parsed)) chat.draftAttachments = parsed;
  } catch { /* keep undefined */ }
}
// tools: null/undefined -> all tools; [] -> advertise none; [names] -> filter
if (row.tools !== null) {
    try { chat.tools = JSON.parse(row.tools); } catch { /* keep undefined */ }
  }
  // Drop undefined tools so the caller can distinguish "not set" from "empty array"
  if (chat.tools === undefined) delete chat.tools;
  return chat;
}

// ---- Chat list projection -------------------------------------------------
//
// `chat_store` has two unbounded TEXT columns: `draft` (whatever the composer
// holds) and `draft_attachments` (the pending image draft — up to 8 base64
// data URLs, each bounded at 12 MB by frontend/src/components/chat/annotation.js).
// A `SELECT *` list therefore reads those bodies out of SQLite, JSON-parses
// them, and ships them for every row of the page, although the chat list only
// needs a one-line preview of the draft. With an image in a draft that is
// megabytes per row — the difference between an instant Chats tab and a
// multi-second one.
//
// The list query therefore never touches the attachment body. It reads:
//   - `draft_snippet` — a bounded head of the text draft, for the card preview;
//   - `has_draft_image` — whether `draft_attachments` is non-NULL. SQLite
//     answers `IS NOT NULL` from the record header (OPFLAG_TYPEOFARG), so the
//     JSON body is never materialized.
// The full `draft` / `draftAttachments` pair still comes back from getChat() /
// GET /api/chats/:id, which is what the composer restores from.
const DRAFT_SNIPPET_CHARS = 400;

const LIST_COLUMNS = `
  project_dir, id, title, created_at, last_opened_at, trace, prompt_size,
  prompt_id, provider_id, model_id, thinking_level, max_output_tokens,
  substr(draft, 1, ${DRAFT_SNIPPET_CHARS}) AS draft_snippet,
  (draft_attachments IS NOT NULL) AS has_draft_image,
  tools, agent_id, agent_files, skills, auto_retry,
  total_cost, cost_known_count
`;

// rowToChatSummary(row) -> chat list entry.
//
// Same shape as rowToChat() minus the two unbounded columns: `draft` is
// replaced by `draftSnippet` and `hasDraftImage` reports whether an image
// draft exists without transferring it. Anything that needs the whole draft
// must call getChat().
function rowToChatSummary(row) {
  if (!row) return null;
  const chat = rowToChat(Object.assign({}, row, { draft: '', draft_attachments: null }));
  delete chat.draft;
  chat.draftSnippet = typeof row.draft_snippet === 'string' ? row.draft_snippet : '';
  chat.hasDraftImage = row.has_draft_image === 1;
  return chat;
}

function chatToRow(projectDir, chat) {
  return {
    project_dir: projectDir,
    id: chat.id,
    title: chat.title || 'New chat',
    created_at: chat.createdAt || new Date().toISOString(),
    last_opened_at: chat.lastOpenedAt || null,
    trace: chat.trace ? 1 : 0,
    prompt_size: chat.promptSize || 'average',
    prompt_id: chat.promptId || null,
    provider_id: chat.providerId || null,
    model_id: chat.modelId || null,
    thinking_level: chat.thinkingLevel || '',
    max_output_tokens: chat.maxOutputTokens || '',
    draft: chat.draft || '',
    draft_attachments: (chat.draftAttachments === undefined || chat.draftAttachments === null) ? null : JSON.stringify(chat.draftAttachments),
    tools: chat.tools === undefined ? null : JSON.stringify(chat.tools),
    // agent_id is a legacy column from the removed chat-persona design.
    // It stays in the schema for old DBs but is always written as null.
    agent_id: null,
agent_files: chat.agentFiles === undefined ? null : (chat.agentFiles ? 1 : 0),
skills: chat.skills === undefined ? null : (chat.skills ? 1 : 0),
auto_retry: chat.autoRetry === undefined ? 1 : (chat.autoRetry ? 1 : 0),
total_cost: chat.totalCost && typeof chat.totalCost.total === 'number' ? chat.totalCost.total : 0,
    cost_known_count: chat.totalCost && chat.totalCost.known
      ? (Number.isInteger(chat.totalCost.knownCount) ? chat.totalCost.knownCount : 1)
      : 0
  };
}

function rowToMessage(row) {
  if (!row) return null;
  // seq is the row's stable, monotonically increasing position within
  // this (project_dir, chat_id). It is the ONLY identity the client
  // can reliably dedup on: the SQLite backend assigns it at insert
  // (append-only), so a row kept its seq forever. The client merges
  // by seq and never re-adds a row it already holds.
  const msg = { role: row.role, content: row.content, ts: row.ts, seq: row.seq };
  if (row.role === 'user' && row.attachments) {
    try { msg.attachments = JSON.parse(row.attachments); } catch { /* ignore */ }
  }
  if (row.role === 'assistant') {
    if (row.reasoning) msg.reasoning = row.reasoning;
    if (row.usage) try { msg.usage = JSON.parse(row.usage); } catch { /* ignore */ }
    if (row.cost) try { msg.cost = JSON.parse(row.cost); } catch { /* ignore */ }
    if (row.streaming_ms != null) msg.streamingMs = row.streaming_ms;
    if (row.model_id) msg.modelId = row.model_id;
  }
  if (row.role === 'tool') {
    if (row.tool_call_id) msg.toolCallId = row.tool_call_id;
    if (row.name) msg.name = row.name;
    if (row.args) try { msg.args = JSON.parse(row.args); } catch { /* ignore */ }
    if (row.ok != null) msg.ok = row.ok === 1;
    if (row.phase) msg.phase = row.phase;
  }
  return msg;
}

function messageToRow(projectDir, chatId, seq, msg) {
  return {
    project_dir: projectDir,
    chat_id: chatId,
    seq,
    role: msg.role,
    content: msg.content,
    ts: msg.ts || new Date().toISOString(),
    reasoning: msg.role === 'assistant' ? (msg.reasoning || null) : null,
    usage: msg.role === 'assistant' && msg.usage ? JSON.stringify(msg.usage) : null,
    cost: msg.role === 'assistant' && msg.cost ? JSON.stringify(msg.cost) : null,
    streaming_ms: msg.role === 'assistant' && msg.streamingMs != null ? msg.streamingMs : null,
    model_id: msg.role === 'assistant' && msg.modelId ? msg.modelId : null,
    attachments: msg.role === 'user' && msg.attachments ? JSON.stringify(msg.attachments) : null,
    tool_call_id: msg.role === 'tool' && msg.toolCallId ? msg.toolCallId : null,
    name: msg.role === 'tool' && msg.name ? msg.name : null,
    args: msg.role === 'tool' && msg.args ? JSON.stringify(msg.args) : null,
    ok: msg.role === 'tool' && msg.ok != null ? (msg.ok ? 1 : 0) : null,
    phase: msg.role === 'tool' && msg.phase ? msg.phase : null
  };
}

// ---- Chat CRUD ------------------------------------------------------------

function listChats(projectDir, options = {}) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const offset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 0;
  const order = 'ORDER BY COALESCE(last_opened_at, created_at) DESC, id DESC';
  // List rows are summaries, never the draft bodies: see LIST_COLUMNS.
  const rows = limit > 0
    ? d.prepare(`SELECT ${LIST_COLUMNS} FROM chat_store WHERE project_dir = ? ${order} LIMIT ? OFFSET ?`)
      .all(projectDir, limit, offset)
    : d.prepare(`SELECT ${LIST_COLUMNS} FROM chat_store WHERE project_dir = ? ${order}`).all(projectDir);
  return rows.map(rowToChatSummary);
}

function countChats(projectDir) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const row = d.prepare('SELECT COUNT(*) AS total FROM chat_store WHERE project_dir = ?').get(projectDir);
  return row ? row.total : 0;
}

function getChat(projectDir, chatId) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const row = d.prepare(
    'SELECT * FROM chat_store WHERE project_dir = ? AND id = ?'
  ).get(projectDir, chatId);
  return rowToChat(row);
}

function createChat(projectDir, chat) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const row = chatToRow(projectDir, chat);
  d.prepare(`
INSERT INTO chat_store (project_dir, id, title, created_at, last_opened_at,
trace, prompt_size, prompt_id, provider_id, model_id, thinking_level, max_output_tokens, draft, draft_attachments, tools,
agent_id, agent_files, skills, auto_retry, total_cost, cost_known_count)
VALUES (@project_dir, @id, @title, @created_at, @last_opened_at,
@trace, @prompt_size, @prompt_id, @provider_id, @model_id, @thinking_level, @max_output_tokens, @draft, @draft_attachments, @tools,
@agent_id, @agent_files, @skills, @auto_retry, @total_cost, @cost_known_count)
`).run(row);
  return rowToChat(d.prepare(
    'SELECT * FROM chat_store WHERE project_dir = ? AND id = ?'
  ).get(projectDir, chat.id));
}

function updateChat(projectDir, chatId, patch) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const existing = d.prepare(
    'SELECT * FROM chat_store WHERE project_dir = ? AND id = ?'
  ).get(projectDir, chatId);
  if (!existing) return null;

  const merged = Object.assign({}, rowToChat(existing), patch);
  const row = chatToRow(projectDir, merged);
d.prepare(`
UPDATE chat_store SET
title = @title, last_opened_at = @last_opened_at,
trace = @trace, prompt_size = @prompt_size,
prompt_id = @prompt_id, provider_id = @provider_id,
model_id = @model_id, thinking_level = @thinking_level,
max_output_tokens = @max_output_tokens,
draft = @draft, draft_attachments = @draft_attachments, tools = @tools,
agent_id = @agent_id, agent_files = @agent_files,
skills = @skills, auto_retry = @auto_retry, total_cost = @total_cost,
cost_known_count = @cost_known_count
WHERE project_dir = @project_dir AND id = @id
`).run(row);
  return rowToChat(d.prepare(
    'SELECT * FROM chat_store WHERE project_dir = ? AND id = ?'
  ).get(projectDir, chatId));
}

function deleteChat(projectDir, chatId) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const previous = readChatCostRow(d, projectDir, chatId);
  const tx = d.transaction(() => {
    const info = d.prepare(
      'DELETE FROM chat_store WHERE project_dir = ? AND id = ?'
    ).run(projectDir, chatId);
    d.prepare(
      'DELETE FROM message_store WHERE project_dir = ? AND chat_id = ?'
    ).run(projectDir, chatId);
    if (info.changes > 0 && (previous.total || previous.knownCount)) {
      require('./projects.js').adjustProjectTotalCost(projectDir, -previous.total, -previous.knownCount);
    }
    return info.changes > 0;
  });
  return tx();
}

// ---- Message CRUD ---------------------------------------------------------

function knownCostDelta(msg) {
  if (!msg || msg.role !== 'assistant' || !msg.cost || msg.cost.known !== true) return null;
  const total = msg.cost.total;
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return null;
  return total;
}

function readChatCostRow(d, projectDir, chatId) {
  const row = d.prepare(
    'SELECT total_cost, cost_known_count FROM chat_store WHERE project_dir = ? AND id = ?'
  ).get(projectDir, chatId);
  return {
    total: row && typeof row.total_cost === 'number' ? row.total_cost : 0,
    knownCount: row && typeof row.cost_known_count === 'number' ? row.cost_known_count : 0
  };
}

function listMessages(projectDir, chatId) {
ensureTables();
const d = require('./settings.js').getDb();
const rows = d.prepare(
'SELECT * FROM message_store WHERE project_dir = ? AND chat_id = ? ORDER BY seq ASC'
).all(projectDir, chatId);
return rows.map(rowToMessage);
}
// listMessagesWindow(projectDir, chatId, opts) -> Array<Message>
//
// Windowed backward fetch for chat pagination. Returns the `limit`
// messages at or just BELOW `beforeSeq` in chronological order. Used
// by the transcript's scroll-up loader so opening a long chat only
// transfers the newest page; older pages are fetched on demand as the
// user scrolls up. The `seq` is the stable, monotonic per-chat row id —
// the same identity the tail sync uses — so the window and the
// append-only tail never disagree.
//
// opts = { limit, beforeSeq }  (limit defaults to 100; beforeSeq is the
// exclusive upper bound, defaulting to "everything")
function listMessagesWindow(projectDir, chatId, opts) {
ensureTables();
const d = require('./settings.js').getDb();
const limitRaw = Number.isInteger(opts && opts.limit) && (opts.limit > 0) ? opts.limit : 100;
const beforeSeq = Number.isInteger(opts && opts.beforeSeq) && opts.beforeSeq >= 0 ? opts.beforeSeq : Infinity;
// Fetch `limit` rows strictly below beforeSeq, ordered newest-last in
// SQL then reversed so the returned array runs oldest -> newest within
// the window. Without a beforeSeq (the first page) we want the newest
// rows overall: ORDER BY seq DESC LIMIT n.
const rows = d.prepare(
'SELECT * FROM message_store WHERE project_dir = ? AND chat_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'
).all(projectDir, chatId, beforeSeq, limitRaw);
rows.reverse();
return rows.map(rowToMessage);
}

function appendMessage(projectDir, chatId, msg) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const maxSeq = d.prepare(
    'SELECT COALESCE(MAX(seq), -1) AS max_seq FROM message_store WHERE project_dir = ? AND chat_id = ?'
  ).get(projectDir, chatId);
  const seq = (maxSeq ? maxSeq.max_seq : -1) + 1;
  const row = messageToRow(projectDir, chatId, seq, msg);
  const costDelta = knownCostDelta(msg);
  const tx = d.transaction(() => {
    d.prepare(`
      INSERT INTO message_store (project_dir, chat_id, seq, role, content, ts,
        reasoning, usage, cost, streaming_ms, model_id, attachments,
        tool_call_id, name, args, ok, phase)
      VALUES (@project_dir, @chat_id, @seq, @role, @content, @ts,
        @reasoning, @usage, @cost, @streaming_ms, @model_id, @attachments,
        @tool_call_id, @name, @args, @ok, @phase)
    `).run(row);
    if (costDelta !== null) {
      const updated = d.prepare(`
        UPDATE chat_store
        SET total_cost = total_cost + ?, cost_known_count = cost_known_count + 1
        WHERE project_dir = ? AND id = ?
      `).run(costDelta, projectDir, chatId);
      if (updated.changes !== 1) throw new Error('Chat not found while adding message cost');
      require('./projects.js').adjustProjectTotalCost(projectDir, costDelta, 1);
    }
  });
  tx();
  return rowToMessage(row);
}

function replaceMessages(projectDir, chatId, list) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const previous = readChatCostRow(d, projectDir, chatId);
  let nextTotal = 0;
  let nextKnownCount = 0;
  for (const msg of list) {
    const cost = knownCostDelta(msg);
    if (cost !== null) {
      nextTotal += cost;
      nextKnownCount++;
    }
  }
  const totalDelta = nextTotal - previous.total;
  const knownCountDelta = nextKnownCount - previous.knownCount;
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM message_store WHERE project_dir = ? AND chat_id = ?').run(projectDir, chatId);
    const insert = d.prepare(`
      INSERT INTO message_store (project_dir, chat_id, seq, role, content, ts,
        reasoning, usage, cost, streaming_ms, model_id, attachments,
        tool_call_id, name, args, ok, phase)
      VALUES (@project_dir, @chat_id, @seq, @role, @content, @ts,
        @reasoning, @usage, @cost, @streaming_ms, @model_id, @attachments,
        @tool_call_id, @name, @args, @ok, @phase)
    `);
    for (let i = 0; i < list.length; i++) {
      insert.run(messageToRow(projectDir, chatId, i, list[i]));
    }
    d.prepare(`
      UPDATE chat_store SET total_cost = ?, cost_known_count = ?
      WHERE project_dir = ? AND id = ?
    `).run(nextTotal, nextKnownCount, projectDir, chatId);
    if (totalDelta || knownCountDelta) {
      require('./projects.js').adjustProjectTotalCost(projectDir, totalDelta, knownCountDelta);
    }
  });
  tx();
  return list.map((m, i) => rowToMessage(
    d.prepare('SELECT * FROM message_store WHERE project_dir = ? AND chat_id = ? AND seq = ?').get(projectDir, chatId, i)
  ));
}

function clearMessages(projectDir, chatId) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const previous = readChatCostRow(d, projectDir, chatId);
  const tx = d.transaction(() => {
    const info = d.prepare(
      'DELETE FROM message_store WHERE project_dir = ? AND chat_id = ?'
    ).run(projectDir, chatId);
    d.prepare(`
      UPDATE chat_store SET total_cost = 0, cost_known_count = 0
      WHERE project_dir = ? AND id = ?
    `).run(projectDir, chatId);
    if (previous.total || previous.knownCount) {
      require('./projects.js').adjustProjectTotalCost(projectDir, -previous.total, -previous.knownCount);
    }
    return info.changes;
  });
  return tx();
}

function getMessageCount(projectDir, chatId) {
ensureTables();
const d = require('./settings.js').getDb();
const row = d.prepare(
'SELECT COUNT(*) AS count FROM message_store WHERE project_dir = ? AND chat_id = ?'
).get(projectDir, chatId);
return row ? row.count : 0;
}
// projectMessageCounts(projectDir, chatIds) -> { [chatId]: count }
//
// Bulk row count for a set of chats in one indexed GROUP BY (the chat list
// renders 30–100 rows at a time, so a per-chat COUNT would be too many
// queries). The count is what the project card uses to flag "draft-only"
// chats — those with zero persisted messages. Rides the
// (project_dir, chat_id, seq) index, so it never scans a transcript.
function projectMessageCounts(projectDir, chatIds) {
ensureTables();
const d = require('./settings.js').getDb();
const ids = Array.isArray(chatIds)
? [...new Set(chatIds.filter((id) => typeof id === 'string' && id))]
: null;
if (ids && ids.length === 0) return {};
const idFilter = ids ? ' AND chat_id IN (' + ids.map(() => '?').join(',') + ')' : '';
const rows = d.prepare(
'SELECT chat_id, COUNT(*) AS count FROM message_store WHERE project_dir = ?' + idFilter + ' GROUP BY chat_id'
).all(projectDir, ...(ids || []));
const out = {};
for (const r of rows) out[r.chat_id] = r.count;
return out;
}

// messageCursorDb(projectDir, chatId) -> { nextSeq }
//
// Cheap append-only recovery cursor: the next persisted seq for this
// chat. Derive it from MAX(seq)+1 rather than COUNT(*) so the cursor
// stays monotonic even if seq ever becomes non-contiguous (e.g. a
// future delete/reinsert path); the client treats `nextSeq` as a seq
// cursor, not a row count.
function messageCursorDb(projectDir, chatId) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const row = d.prepare(
    'SELECT COALESCE(MAX(seq), -1) + 1 AS nextSeq FROM message_store WHERE project_dir = ? AND chat_id = ?'
  ).get(projectDir, chatId);
  return { nextSeq: row && typeof row.nextSeq === 'number' ? row.nextSeq : 0 };
}

// ---- Cost aggregation (SQL, no full-transcript reads) ---------------------

// One aggregate row per selected chat (or every project chat when no IDs
// are supplied): the known assistant-turn cost total and whether any known
// cost exists. Matches the JS loop in chats.chatTotalCost exactly
// (cost.known === true && total >= 0), but uses one indexed aggregate instead
// of one full listMessages call per chat.
// json_extract is a SQLite JSON1 builtin — present in every Node.js
// better-sqlite3 build (verified).
function projectCostTotals(projectDir, chatIds) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const ids = Array.isArray(chatIds)
    ? [...new Set(chatIds.filter((id) => typeof id === 'string' && id))]
    : null;
  if (ids && ids.length === 0) return {};
  const idFilter = ids ? ` AND chat_id IN (${ids.map(() => '?').join(',')})` : '';
  const rows = d.prepare(`
    SELECT chat_id,
           SUM(CASE WHEN json_extract(cost, '$.known') = 1
                     AND CAST(json_extract(cost, '$.total') AS REAL) >= 0
                    THEN CAST(json_extract(cost, '$.total') AS REAL) ELSE 0 END) AS total,
MAX(CASE WHEN json_extract(cost, '$.known') = 1
AND CAST(json_extract(cost, '$.total') AS REAL) >= 0
THEN 1 ELSE 0 END) AS known,
SUM(CASE WHEN json_extract(cost, '$.known') = 1
AND CAST(json_extract(cost, '$.total') AS REAL) >= 0
THEN 1 ELSE 0 END) AS known_count
    FROM message_store
    WHERE project_dir = ?
      AND role = 'assistant'
      AND cost IS NOT NULL${idFilter}
    GROUP BY chat_id
  `).all(projectDir, ...(ids || []));
  const out = {};
  for (const r of rows) {
    out[r.chat_id] = {
      total: typeof r.total === 'number' ? r.total : 0,
      known: r.known === 1,
      knownCount: typeof r.known_count === 'number' ? r.known_count : 0
    };
  }
  return out;
}

function chatTotalCostDb(projectDir, chatId) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const row = d.prepare(`
    SELECT COALESCE(SUM(CASE WHEN role = 'assistant'
                   AND cost IS NOT NULL
                   AND json_extract(cost, '$.known') = 1
                   AND CAST(json_extract(cost, '$.total') AS REAL) >= 0
                  THEN CAST(json_extract(cost, '$.total') AS REAL) ELSE 0 END), 0) AS total,
           MAX(CASE WHEN role = 'assistant'
                   AND cost IS NOT NULL
                   AND json_extract(cost, '$.known') = 1
                   AND CAST(json_extract(cost, '$.total') AS REAL) >= 0
                  THEN 1 ELSE 0 END) AS known
    FROM message_store
    WHERE project_dir = ? AND chat_id = ?
  `).get(projectDir, chatId);
  return {
    total: typeof row.total === 'number' ? row.total : 0,
    known: row.known === 1
  };
}

// ---- Import from JSON files ------------------------------------------------
//
// Legacy one-shot import from `.mouaif.messages.*.json` transcripts and the
// old `<projectDir>/.mouaif.json` `chats` array. Kept so users who ran the
// earlier file-based storage can migrate that history into the DB; it is
// no longer an active backend and the import migration is retired.

function importFromJson(projectDir, opts) {
  ensureTables();
  const fs = require('fs');
  const settings = require('./settings.js');
  const chatsFile = settings.getProjectPath(projectDir);
  const imported = { chats: 0, messages: 0, errors: [] };

  let project;
  try {
    project = settings.readProjectJson(chatsFile);
  } catch (e) {
    imported.errors.push('Failed to read ' + chatsFile + ': ' + e.message);
    return imported;
  }

  const rawChats = Array.isArray(project.chats) ? project.chats : [];
  for (const chat of rawChats) {
    if (!chat || !chat.id || !CHAT_ID_RE.test(chat.id)) continue;
    try {
      const skipExisting = opts && opts.skipExisting;
      if (skipExisting && getChat(projectDir, chat.id)) {
        // Chat already in DB; still import messages if missing.
        if (getMessageCount(projectDir, chat.id) === 0) {
          importMessagesFromJson(projectDir, chat.id, imported);
        }
        imported.chats++;
        continue;
      }
      createChat(projectDir, chat);
      imported.chats++;
      importMessagesFromJson(projectDir, chat.id, imported);
    } catch (e) {
      imported.errors.push('Chat ' + chat.id + ': ' + e.message);
    }
  }

  return imported;
}

function importMessagesFromJson(projectDir, chatId, imported) {
  const fs = require('fs');
  const settings = require('./settings.js');
  const messagesPath = path.join(projectDir, '.mouaif.messages.' + chatId + '.json');
  if (!fs.existsSync(messagesPath)) return;
  try {
    const raw = settings.readProjectJson(messagesPath);
    const list = Array.isArray(raw.messages) ? raw.messages : [];
    const normalized = [];
    for (const m of list) {
      const n = normalizeMessage(m);
      if (n) normalized.push(n);
    }
    if (normalized.length === 0) return;
    if (getMessageCount(projectDir, chatId) >= normalized.length) {
      imported.messages += normalized.length;
      return;
    }
    replaceMessages(projectDir, chatId, normalized);
    imported.messages += normalized.length;
  } catch (e) {
    imported.errors.push('Messages ' + chatId + ': ' + e.message);
  }
}

module.exports = {
  // Chat CRUD
  listChats,
  countChats,
  getChat,
  createChat,
  updateChat,
  deleteChat,
  // Message CRUD
listMessages,
listMessagesWindow,
appendMessage,
replaceMessages,
clearMessages,
getMessageCount,
projectMessageCounts,
messageCursorDb,
// Cost aggregation
projectCostTotals,
chatTotalCostDb,
  // Legacy import
  importFromJson,
  // Exported so settings migrations can create the tables before their ALTERs.
  ensureChatTables: ensureTables
};