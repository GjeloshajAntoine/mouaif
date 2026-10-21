// Deterministic long-chat fixtures for the performance profiler
// (scripts/perf-profile.mjs).
//
// Profiling a chat view needs transcripts of known size: the interesting
// numbers are "how does open time, layout cost and heap grow with rows and
// bytes", so the same transcript must produce the same bytes on every run or
// two reports cannot be compared. Everything here is generated from a fixed
// seed, written straight into `message_store` in one transaction per chat, and
// removed again through the ids recorded in the run manifest.
//
// The rows mimic what a real agentic chat contains, because that is what the
// renderer actually spends time on: markdown headings, lists, inline code,
// fenced code blocks, tables, long prose, reasoning blocks, and tool
// call/result pairs (which become collapsible tool cards, not bubbles).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Marks a chat this profiler created. The title prefix is the last-resort
// cleanup key when a manifest is lost; the manifest is the precise one.
export const FIXTURE_TITLE_PREFIX = '[perf] ';

// Profile sizes, in rows. A "row" is one message row in message_store, which
// is what the transcript has to build, so it is the unit that predicts cost.
export const PROFILES = {
  tiny: { rows: 30, label: 'tiny (30 rows)', tools: 0.1, code: 0.2, bytes: 220 },
  medium: { rows: 500, label: 'medium (500 rows)', tools: 0.2, code: 0.35, bytes: 400 },
  long: { rows: 2000, label: 'long (2,000 rows)', tools: 0.35, code: 0.45, bytes: 650 },
  huge: { rows: 10000, label: 'huge (10,000 rows)', tools: 0.2, code: 0.2, bytes: 260 }
};

// mulberry32 — a tiny seeded PRNG, so fixture bytes never drift between runs.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ('transcript renderer windowed pagination settle cursor revision sqlite store'
  + ' project chat message stream tool card approval shell review provider model token'
  + ' budget cache layout paint frame scroll anchor backfill virtual list bounded memory').split(' ');

function sentence(next, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(WORDS[Math.floor(next() * WORDS.length)]);
  const s = out.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

function codeBlock(next, lines = 8) {
  const body = [];
  for (let i = 0; i < lines; i++) {
    body.push('  const ' + WORDS[Math.floor(next() * WORDS.length)] + WORDS[Math.floor(next() * WORDS.length)]
      + ' = ' + Math.floor(next() * 1000) + '; // ' + sentence(next, 4));
  }
  return '```js\n' + body.join('\n') + '\n```';
}

function prose(next, plainBytes, { code = false } = {}) {
  const parts = [];
  let size = 0;
  let n = 0;
  while (size < plainBytes) {
    n++;
    // A mix that exercises the markdown fast paths as well as the slow ones.
    const pick = next();
    let chunk;
    if (n === 1 && pick < 0.4) chunk = '### ' + sentence(next, 5).replace(/\.$/, '');
    else if (pick < 0.2) chunk = '- ' + sentence(next, 6) + '\n- ' + sentence(next, 6) + '\n- ' + sentence(next, 5);
    else if (pick < 0.32) chunk = '`' + WORDS[Math.floor(next() * WORDS.length)] + '` ' + sentence(next, 9)
      + ' `' + WORDS[Math.floor(next() * WORDS.length)] + '` ' + sentence(next, 4);
    else if (pick < 0.44 && code) chunk = codeBlock(next, 6 + Math.floor(next() * 8));
    else if (pick < 0.5) chunk = '| Field | Meaning |\n| --- | --- |\n| `seq` | ' + sentence(next, 4)
      + ' |\n| `ts` | ' + sentence(next, 4) + ' |';
    else if (pick < 0.56) chunk = '> ' + sentence(next, 12);
    else chunk = sentence(next, 10 + Math.floor(next() * 12));
    parts.push(chunk);
    size += chunk.length;
  }
  return parts.join('\n\n');
}

// buildTranscript(profileName) -> [{ role, content, reasoning? , tool… }]
//
// Roles alternate user/assistant, with tool call/result pairs sprinkled in at
// the configured rate so the transcript contains the collapsible cards a real
// agentic chat has.
export function buildTranscript(profileName) {
  const profile = PROFILES[profileName];
  if (!profile) throw new Error('unknown perf profile: ' + profileName);
  const next = rng(0x5eed + profile.rows);
  const rows = [];
  let turn = 0;
  while (rows.length < profile.rows) {
    const userText = prose(next, Math.round(profile.bytes * 0.35));
    rows.push({ role: 'user', content: userText });
    if (rows.length >= profile.rows) break;
    if (next() < profile.tools) {
      const callId = 'call_' + (turn++) + '_' + rows.length;
      const name = ['read_file', 'search_files', 'shell', 'group_read', 'list_files'][Math.floor(next() * 5)];
      // Tool rows are shaped like the ones this project's own store holds: the
      // payload lives in `content` as a JSON string (`{ name, args }` for the
      // call, the result object for the result), not in a separate `args`
      // column. Getting that wrong makes the fixtures optimistic: the renderer
      // collapses call/result pairs into one card per tool, so a transcript of
      // 2,924 tool rows draws only a couple of top-level cards.
      rows.push({
        role: 'tool',
        phase: 'call',
        name,
        toolCallId: callId,
        ok: true,
        content: JSON.stringify({
          name,
          args: { path: 'src/' + WORDS[Math.floor(next() * WORDS.length)] + '.js', limit: 200 }
        })
      });
      if (rows.length >= profile.rows) break;
      rows.push({
        role: 'tool',
        phase: 'result',
        name,
        toolCallId: callId,
        ok: next() > 0.15,
        // Tool bodies are the bulky rows in a real transcript (file dumps).
        content: prose(next, Math.round(profile.bytes * 2.2), { code: true }).slice(0, 4000)
      });
      if (rows.length >= profile.rows) break;
    }
    const reasoning = next() < 0.5 ? prose(next, Math.round(profile.bytes * 0.5)) : undefined;
    rows.push({
      role: 'assistant',
      content: prose(next, Math.round(profile.bytes * (1 + next() * 1.4)), { code: next() < profile.code }),
      reasoning,
      modelId: 'perf/fixture',
      streamingMs: 900 + Math.floor(next() * 4000)
    });
  }
  return rows.slice(0, profile.rows);
}

// openStore(home) — the app modules, opened against `home`. Kept in one place
// because MOUAIF_HOME has to be set before src/settings.js is first required.
export function openStore(home) {
  if (home) process.env.MOUAIF_HOME = home;
  const settings = require('../../src/settings.js');
  const chatdb = require('../../src/chatdb.js');
  const messages = require('../../src/messages.js');
  const db = settings.getDb();
  // chatdb creates its tables lazily, on the first chat operation. Seeding
  // prepares an INSERT against message_store up front, so create them here.
  chatdb.ensureChatTables();
  // The live server shares this file; wait rather than fail on a write lock.
  try { db.pragma('busy_timeout = 8000'); } catch { /* read-only handle */ }
  return { settings, chatdb, messages, db };
}

// seedChats({ home, projectDir, profiles, stamp }) -> manifest
//
// One chat per profile. Each chat is inserted under a random 8-hex id (the id
// format the app enforces) and recorded in the manifest so a run can delete
// exactly what it created.
export function seedChats({ home, projectDir, profiles = ['medium', 'long', 'huge'], stamp }) {
  const store = openStore(home);
  const { chatdb, db } = store;
  const now = Date.now();
  const created = [];
  const insert = db.prepare(`INSERT INTO message_store
    (project_dir, chat_id, seq, role, content, ts, reasoning, streaming_ms, model_id,
     tool_call_id, name, args, ok, phase)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const crypto = require('node:crypto');
  for (const name of profiles) {
    const profile = PROFILES[name];
    if (!profile) throw new Error('unknown perf profile: ' + name);
    const rows = buildTranscript(name);
    const id = crypto.randomBytes(4).toString('hex');
    const created_at = new Date(now).toISOString();
    chatdb.createChat(projectDir, {
      id,
      title: FIXTURE_TITLE_PREFIX + profile.label,
      createdAt: created_at,
      lastOpenedAt: created_at
    });
    const bytes = rows.reduce((n, r) => n + r.content.length + (r.reasoning ? r.reasoning.length : 0), 0);
    // One transaction per chat: 10k single-row inserts would dominate the run.
    db.exec('BEGIN');
    try {
      rows.forEach((row, seq) => {
        insert.run(
          projectDir, id, seq, row.role, row.content,
          new Date(now - (rows.length - seq) * 45000).toISOString(),
          row.reasoning || null,
          row.streamingMs != null ? row.streamingMs : null,
          row.modelId || null,
          row.toolCallId || null,
          row.name || null,
          row.args ? JSON.stringify(row.args) : null,
          row.ok == null ? null : (row.ok ? 1 : 0),
          row.phase || null
        );
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    created.push({ id, profile: name, label: profile.label, rows: rows.length, bytes, projectDir });
  }
  return { stamp, home, projectDir, chats: created, createdAt: new Date().toISOString() };
}

// removeSeeded(manifest, home) -> { removed, missing }
export function removeSeeded(manifest, home) {
  const store = openStore(home);
  const { chatdb } = store;
  let removed = 0;
  const missing = [];
  for (const chat of (manifest && manifest.chats) || []) {
    try {
      if (chatdb.getChat(chat.projectDir || manifest.projectDir, chat.id)) {
        chatdb.deleteChat(chat.projectDir || manifest.projectDir, chat.id);
        removed++;
      } else {
        missing.push(chat.id);
      }
    } catch {
      missing.push(chat.id);
    }
  }
  return { removed, missing };
}

// removeStrays(home, projectDir) — delete fixture chats left by an interrupted
// run (a Ctrl-C between seeding and cleanup). Only touches chats whose title
// carries the fixture prefix or that the caller passes in.
export function removeStrays(home, projectDir) {
  const store = openStore(home);
  const { chatdb, db } = store;
  const rows = db.prepare('SELECT id FROM chat_store WHERE project_dir = ? AND title LIKE ?')
    .all(projectDir, FIXTURE_TITLE_PREFIX + '%');
  let removed = 0;
  for (const row of rows) {
    chatdb.deleteChat(projectDir, row.id);
    removed++;
  }
  return removed;
}

// longestRealChats(home, projectDir, limit) — the project's own biggest chats.
//
// The profile has to include the user's real history, not only synthetic rows:
// a real chat mixes attachment-bearing user turns, subagent cards, errors and
// tool bodies of every size. Counted straight off the store so the pick does
// not depend on the chat list's recency ordering.
export function longestRealChats(home, projectDir, limit = 3) {
  const store = openStore(home);
  const { db } = store;
  return db.prepare(`
    SELECT c.id, c.title, COUNT(m.seq) AS rows,
           COALESCE(SUM(LENGTH(m.content)), 0) AS bytes
    FROM chat_store c
    LEFT JOIN message_store m ON m.project_dir = c.project_dir AND m.chat_id = c.id
    WHERE c.project_dir = ? AND c.title NOT LIKE ?
    GROUP BY c.id
    ORDER BY rows DESC
    LIMIT ?
  `).all(projectDir, FIXTURE_TITLE_PREFIX + '%', limit);
}

// projectStoreSize(home) — on-disk size of the app store, so a report states
// which store it measured.
export function projectStoreSize(home) {
  const homeDir = home || process.env.MOUAIF_HOME || path.join(require('node:os').homedir(), '.mouaif');
  const file = path.join(homeDir, 'store.sqlite');
  try {
    const stat = fs.statSync(file);
    let wal = 0;
    try { wal = fs.statSync(file + '-wal').size; } catch { /* no wal */ }
    return { path: file, bytes: stat.size, walBytes: wal };
  } catch {
    return { path: file, bytes: 0, walBytes: 0 };
  }
}
