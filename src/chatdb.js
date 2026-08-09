'use strict';

// Chat DB — SQLite-backed chat and message storage.
//
// Implements the "store chats in DB by default" design:
//   - chat metadata in `chat_store` table
//   - messages in `message_store` table
//   - both in the same ~/.mouaif/store.sqlite used by settings.js
//
// This module exposes the DB helpers. The public API surface remains
// src/chats.js and src/messages.js, which route through this module
// when the app setting `chatStorage` is 'db' (default).

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
    tools         TEXT,
    agent_id      TEXT,
    agent_files   INTEGER,
    skills        INTEGER,
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
  CREATE INDEX IF NOT EXISTS idx_message_store_lookup
    ON message_store (project_dir, chat_id, seq)
`;

function ensureTables() {
  const settings = require('./settings.js');
  const d = settings.getDb();
  d.exec(CREATE_CHAT_TABLE);
  d.exec(CREATE_MESSAGE_TABLE);
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
    skills: row.skills === null ? undefined : (row.skills === 1)
  };
  // tools: null/undefined -> all tools; [] -> advertise none; [names] -> filter
  if (row.tools !== null) {
    try { chat.tools = JSON.parse(row.tools); } catch { /* keep undefined */ }
  }
  // Drop undefined tools so the caller can distinguish "not set" from "empty array"
  if (chat.tools === undefined) delete chat.tools;
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
    tools: chat.tools === undefined ? null : JSON.stringify(chat.tools),
    // agent_id is a legacy column from the removed chat-persona design.
    // It stays in the schema for old DBs but is always written as null.
    agent_id: null,
    agent_files: chat.agentFiles === undefined ? null : (chat.agentFiles ? 1 : 0),
    skills: chat.skills === undefined ? null : (chat.skills ? 1 : 0)
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

function listChats(projectDir) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const rows = d.prepare(
    `SELECT * FROM chat_store WHERE project_dir = ? ORDER BY
      CASE WHEN last_opened_at IS NOT NULL THEN last_opened_at ELSE created_at END DESC`
  ).all(projectDir);
  return rows.map(rowToChat);
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
      trace, prompt_size, prompt_id, provider_id, model_id, thinking_level, max_output_tokens, draft, tools,
      agent_id, agent_files, skills)
    VALUES (@project_dir, @id, @title, @created_at, @last_opened_at,
      @trace, @prompt_size, @prompt_id, @provider_id, @model_id, @thinking_level, @max_output_tokens, @draft, @tools,
      @agent_id, @agent_files, @skills)
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
      draft = @draft, tools = @tools,
      agent_id = @agent_id, agent_files = @agent_files,
      skills = @skills
    WHERE project_dir = @project_dir AND id = @id
  `).run(row);
  return rowToChat(d.prepare(
    'SELECT * FROM chat_store WHERE project_dir = ? AND id = ?'
  ).get(projectDir, chatId));
}

function deleteChat(projectDir, chatId) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const info = d.prepare(
    'DELETE FROM chat_store WHERE project_dir = ? AND id = ?'
  ).run(projectDir, chatId);
  d.prepare(
    'DELETE FROM message_store WHERE project_dir = ? AND chat_id = ?'
  ).run(projectDir, chatId);
  return info.changes > 0;
}

// ---- Message CRUD ---------------------------------------------------------

function listMessages(projectDir, chatId) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const rows = d.prepare(
    'SELECT * FROM message_store WHERE project_dir = ? AND chat_id = ? ORDER BY seq ASC'
  ).all(projectDir, chatId);
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
  d.prepare(`
    INSERT INTO message_store (project_dir, chat_id, seq, role, content, ts,
      reasoning, usage, cost, streaming_ms, model_id, attachments,
      tool_call_id, name, args, ok, phase)
    VALUES (@project_dir, @chat_id, @seq, @role, @content, @ts,
      @reasoning, @usage, @cost, @streaming_ms, @model_id, @attachments,
      @tool_call_id, @name, @args, @ok, @phase)
  `).run(row);
  return rowToMessage(row);
}

function replaceMessages(projectDir, chatId, list) {
  ensureTables();
  const d = require('./settings.js').getDb();
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
  });
  tx();
  return list.map((m, i) => rowToMessage(
    d.prepare('SELECT * FROM message_store WHERE project_dir = ? AND chat_id = ? AND seq = ?').get(projectDir, chatId, i)
  ));
}

function clearMessages(projectDir, chatId) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const info = d.prepare(
    'DELETE FROM message_store WHERE project_dir = ? AND chat_id = ?'
  ).run(projectDir, chatId);
  return info.changes;
}

function getMessageCount(projectDir, chatId) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const row = d.prepare(
    'SELECT COUNT(*) AS count FROM message_store WHERE project_dir = ? AND chat_id = ?'
  ).get(projectDir, chatId);
  return row ? row.count : 0;
}

// messageRevisionDb(projectDir, chatId) -> { count, ts }
//
// Cheap change marker: COUNT + MAX(ts) in one indexed scan (no row
// data). The 1 s reconcile poll compares this instead of re-fetching
// and JSON-stringifying the whole transcript.
function messageRevisionDb(projectDir, chatId) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const row = d.prepare(
    'SELECT COUNT(*) AS count, MAX(ts) AS ts FROM message_store WHERE project_dir = ? AND chat_id = ?'
  ).get(projectDir, chatId);
  return { count: row ? row.count : 0, ts: row && row.ts ? row.ts : null };
}

// ---- Cost aggregation (SQL, no full-transcript reads) ---------------------

// One aggregate row per chat of a project: the known assistant-turn cost
// total and whether any known cost exists. Matches the JS loop in
// chats.chatTotalCost exactly (cost.known === true && total >= 0), but in
// a single indexed scan instead of one full listMessages per chat.
// json_extract is a SQLite JSON1 builtin — present in every Node.js
// better-sqlite3 build (verified).
const PROJECT_COST_SQL = `
  SELECT chat_id,
         SUM(CASE WHEN role = 'assistant'
                   AND cost IS NOT NULL
                   AND json_extract(cost, '$.known') = 1
                   AND CAST(json_extract(cost, '$.total') AS REAL) >= 0
                  THEN CAST(json_extract(cost, '$.total') AS REAL) ELSE 0 END) AS total,
         MAX(CASE WHEN role = 'assistant'
                   AND cost IS NOT NULL
                   AND json_extract(cost, '$.known') = 1
                   AND CAST(json_extract(cost, '$.total') AS REAL) >= 0
                  THEN 1 ELSE 0 END) AS known
  FROM message_store
  WHERE project_dir = ?
  GROUP BY chat_id
`;

function projectCostTotals(projectDir) {
  ensureTables();
  const d = require('./settings.js').getDb();
  const rows = d.prepare(PROJECT_COST_SQL).all(projectDir);
  const out = {};
  for (const r of rows) {
    out[r.chat_id] = {
      total: typeof r.total === 'number' ? r.total : 0,
      known: r.known === 1
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
// Scans <projectDir> for .mouaif.messages.*.json files and imports them
// into the DB. Also imports chat metadata from .mouaif.json.

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
  getChat,
  createChat,
  updateChat,
  deleteChat,
  // Message CRUD
  listMessages,
  appendMessage,
  replaceMessages,
  clearMessages,
  getMessageCount,
  messageRevisionDb,
  // Cost aggregation
  projectCostTotals,
  chatTotalCostDb,
  // Import
  importFromJson
};