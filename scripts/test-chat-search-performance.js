'use strict';

// Regression test: chat search must not scan the project's transcript.
//
// GET /api/chats/search backs the project card's magnifier. The predicate is a
// substring match, so SQLite cannot index it — every candidate row's `content`
// has to be read before LIKE can decide. The cost of the feature is therefore
// the *number of message rows the query touches*, and the query has to keep
// that bounded by the answer rather than by the size of the store:
//
//   * The recency index leads, and the LIMIT stops the walk once the page is
//     full. The retired shape folded every matching message with a
//     `GROUP BY chat_id` subquery *before* ranking, so a term like "e" had to
//     read a project's whole transcript — 850 MB and about three seconds on
//     the author's store — to return the newest twenty chats.
//
//   * A chat whose title or draft already matched is not scanned at all.
//     `match_seq` is only needed when the label is not yet decided or the
//     snippet needs a body, and that is exactly when the lookup runs.
//
// The test measures both shapes on one synthetic store and asserts the ratio,
// so it states the improvement rather than a wall-clock budget that would
// depend on the machine. The retired shape is kept here as the baseline: it is
// what a revert would restore, and the ratio is what collapses if that
// happens. The developer's real 850 MB transcript is deliberately not used.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-chat-search-perf-'));
process.env.MOUAIF_HOME = HOME;
process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
const PROJECT = fs.mkdtempSync(path.join(HOME, 'project-'));

const settings = require('../src/settings.js');
const projects = require('../src/projects.js');
const chats = require('../src/chats.js');
const messages = require('../src/messages.js');

const RECENT_CHATS = 40;
const RECENT_MSG_CHARS = 2000;
const OLD_CHATS = 30;
const OLD_MSG_CHARS = 1024 * 1024;   // ~30 MB of transcript outside the window
const LIMIT = 30;

// The retired fold-first predicate, kept only as this test's baseline. It
// reads every matching message before the LIMIT can apply.
const FOLD_FIRST_SQL = `
  SELECT chat_id, MAX(title_hit) AS title_hit, MAX(draft_hit) AS draft_hit,
         MIN(match_seq) AS match_seq FROM (
    SELECT id AS chat_id, 1 AS title_hit, 0 AS draft_hit, NULL AS match_seq FROM chat_store
      WHERE project_dir = @dir AND title LIKE @like ESCAPE '\\'
    UNION ALL
    SELECT id AS chat_id, 0 AS title_hit, 1 AS draft_hit, NULL AS match_seq FROM chat_store
      WHERE project_dir = @dir AND draft LIKE @like ESCAPE '\\'
    UNION ALL
    SELECT chat_id, 0 AS title_hit, 0 AS draft_hit, MIN(seq) AS match_seq FROM message_store
      WHERE project_dir = @dir AND content LIKE @like ESCAPE '\\'
      GROUP BY chat_id
  ) GROUP BY chat_id
`;

// An ancient timestamp, so a chat added later still sorts to the *end* of the
// recency order.
const ANCIENT = '2000-01-01T00:00:00.000Z';

function best(fn, n = 3) {
  let ms = Infinity;
  let out;
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    out = fn();
    ms = Math.min(ms, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return { ms, out };
}

function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (ch) => '\\' + ch);
}

function main() {
  settings.runMigrations();
  projects.registerProject(PROJECT);

  const recentIds = [];
  for (let i = 0; i < RECENT_CHATS; i++) {
    const chat = chats.createChat(PROJECT, { title: 'recent work ' + i });
    recentIds.push(chat.id);
    messages.appendMessage(PROJECT, chat.id, {
      role: 'user',
      content: 'recent body ' + i + ' ' + 'x'.repeat(RECENT_MSG_CHARS),
      ts: new Date().toISOString()
    });
  }
  const d = settings.getDb();

  // Old bodies, behind the recency window: reachable only by a query that
  // walks past its LIMIT. They are what the fold-first shape pays for and the
  // recency shape does not.
  const oldBody = 'old transcript body line\n'.repeat(OLD_MSG_CHARS / 24).slice(0, OLD_MSG_CHARS);
  const stamp = d.prepare('UPDATE chat_store SET created_at = ?, last_opened_at = NULL WHERE id = ?');
  for (let i = 0; i < OLD_CHATS; i++) {
    const chat = chats.createChat(PROJECT, { title: 'old work ' + i });
    messages.appendMessage(PROJECT, chat.id, { role: 'user', content: oldBody, ts: ANCIENT });
    stamp.run(ANCIENT, chat.id);
  }

  const bytes = d.prepare(
    'SELECT SUM(length(content)) AS bytes FROM message_store WHERE project_dir = ?'
  ).get(PROJECT).bytes;
  assert.ok(bytes > 20 * 1000 * 1000, 'the fixture must be large enough to be measurable');

  // A term that fills the page immediately, on a store whose bulk sits behind
  // the page. This is the common case — "the", "shell" — and the one the
  // recency shape answers without ever reaching the old bodies.
  const term = 'recent body';
  const like = '%' + escapeLike(term) + '%';

  // Warm both paths, then take the best of a few runs, so neither result is
  // decided by a cold file cache.
  const foldStmt = d.prepare(FOLD_FIRST_SQL);
  const fold = best(() => foldStmt.all({ dir: PROJECT, like }));
  const now = best(() => chats.searchChats(PROJECT, term, { limit: LIMIT }));

  assert.equal(now.out.length, LIMIT, 'the limit caps the result page');
  assert.ok(
    now.ms * 10 < fold.ms,
    'a saturated search must cost far less than folding every matching message: '
      + now.ms.toFixed(1) + ' ms vs ' + fold.ms.toFixed(1) + ' ms ('
      + (fold.ms / Math.max(now.ms, 0.001)).toFixed(0) + 'x)'
  );

  // The plan keeps the shape honest even when the timings are noisy: the
  // recency index leads, the message probe is correlated per chat, and
  // nothing folds or sorts messages before the LIMIT.
  const plan = d.prepare(`
    EXPLAIN QUERY PLAN
    SELECT c.id FROM chat_store c
    WHERE c.project_dir = 'x'
      AND (c.title LIKE '%x%' OR c.draft LIKE '%x%'
           OR EXISTS (SELECT 1 FROM message_store msg
                       WHERE msg.project_dir = c.project_dir AND msg.chat_id = c.id
                         AND msg.content LIKE '%x%'))
    ORDER BY COALESCE(c.last_opened_at, c.created_at) DESC, c.id DESC LIMIT 30
  `).all().map((r) => r.detail).join('\n');
  assert.ok(/idx_chat_store_recent/.test(plan), 'the recency index drives the scan, got:\n' + plan);
  assert.ok(!/TEMP B-TREE/.test(plan), 'nothing folds or sorts messages before the LIMIT, got:\n' + plan);

  // ---- and the answers are still right ------------------------------------
  // Old matches past the recency window are still reachable — they are simply
  // ordered after the recent ones.
  const deep = chats.searchChats(PROJECT, 'old transcript body', { limit: 5 });
  assert.equal(deep.length, 5, 'old matches are still reachable');
  assert.equal(deep[0].matchField, 'message');
  assert.ok(/old transcript body/.test(deep[0].snippet), 'the snippet carries the matching text');

  assert.deepEqual(
    now.out.map((c) => c.id).slice(0, 3),
    recentIds.slice().reverse().slice(0, 3),
    'results are the most recent matches, newest first'
  );
  assert.equal(
    chats.searchChats(PROJECT, 'RECENT BODY 33 ', { limit: 10 }).length, 1,
    'search stays case-insensitive and substring-based'
  );
  const miss = chats.searchChats(PROJECT, 'zzqqxxnomatch', { limit: LIMIT });
  assert.deepEqual(miss, [], 'a term with no match is an empty result, not an error');

  console.log('ok — saturated search ' + now.ms.toFixed(1) + ' ms vs ' + fold.ms.toFixed(1)
    + ' ms fold-first (' + (fold.ms / Math.max(now.ms, 0.001)).toFixed(0) + 'x), store '
    + (bytes / 1000 / 1000).toFixed(0) + ' MB');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}
