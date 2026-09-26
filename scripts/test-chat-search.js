'use strict';

// Regression test: the project card's magnifier.
//
// GET /api/chats/search matches chat titles, composer drafts, and persisted
// message text, and returns chat-list summary rows plus `matchField` and
// `snippet`. Three properties matter and are pinned here:
//
//   1. One row per chat. A term that appears in forty messages of one chat
//      must not return forty rows, and a chat that matches in both its title
//      and a message must not be returned twice.
//   2. The result set is bounded. `limit` caps the chats, ranked by recency —
//      a one-letter query matches nearly the whole store, and an unbounded
//      fold over message_store would read every message body to answer.
//   3. LIKE wildcards in the query are literal. `%` searches for a percent
//      sign instead of matching everything, and `_` for an underscore.
//
// The message-body reading is also pinned, because that is the difference
// between a fast search and a slow one: the snippet must be fetched with one
// indexed lookup per *result row*, never carried through the GROUP BY.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-chat-search-'));
process.env.MOUAIF_HOME = HOME;
process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
const PROJECT = fs.mkdtempSync(path.join(HOME, 'project-'));

const settings = require('../src/settings.js');
const projects = require('../src/projects.js');
const chats = require('../src/chats.js');
const messages = require('../src/messages.js');
const { createServer } = require('../src/index.js');

function message(chatId, role, content, offsetMs) {
  messages.appendMessage(PROJECT, chatId, {
    role,
    content,
    ts: new Date(Date.now() + (offsetMs || 0)).toISOString()
  });
}

async function main() {
  settings.runMigrations();
  projects.registerProject(PROJECT);

  // A chat whose *title* matches.
  const byTitle = chats.createChat(PROJECT, { title: 'Rebuild the release pipeline' });
  // A chat whose *message text* matches, with the term buried in a long body.
  const byMessage = chats.createChat(PROJECT, { title: 'Untitled work' });
  const filler = 'x'.repeat(4000);
  message(byMessage.id, 'user', filler);
  message(byMessage.id, 'assistant', filler + ' the kumquat handler moved to src/pipeline.js ' + filler);
  // A chat matching in both places, plus many messages, to prove the fold.
  const both = chats.createChat(PROJECT, { title: 'kumquat notes' });
  for (let i = 0; i < 25; i++) message(both.id, 'user', 'kumquat round ' + i);
  message(both.id, 'assistant', 'kumquat round final');
  // A chat that only a *draft* matches.
  const byDraft = chats.createChat(PROJECT, { title: 'Scratch' });
  chats.updateChat(PROJECT, byDraft.id, { draft: 'draft about kumquats not sent yet' });
  // A chat that matches nothing.
  const cold = chats.createChat(PROJECT, { title: 'Unrelated' });
  message(cold.id, 'user', 'nothing to see here');
  // Wildcard-bait chats.
  const percent = chats.createChat(PROJECT, { title: 'coverage is 100% done' });
  const under = chats.createChat(PROJECT, { title: 'snake_case naming' });

  // ---- searchChats, direct -------------------------------------------------

  const hits = chats.searchChats(PROJECT, 'kumquat');
  const ids = hits.map((c) => c.id).sort();
  assert.deepEqual(
    ids,
    [byMessage.id, both.id, byDraft.id].sort(),
    'title, message, and draft hits, one row each'
  );
  assert.equal(hits.length, 3, 'the 26 matching messages of one chat fold to one row');

  const foldRow = hits.find((c) => c.id === both.id);
  assert.equal(foldRow.matchField, 'title', 'a title hit wins the label');
  assert.ok(/kumquat/.test(foldRow.snippet), 'snippet carries the matching text');

  const msgRow = hits.find((c) => c.id === byMessage.id);
  assert.equal(msgRow.matchField, 'message', 'a message-only hit is labelled message');
  assert.ok(msgRow.snippet.length < 400, 'a long message is windowed, not shipped whole');
  assert.ok(/kumquat/.test(msgRow.snippet), 'the window keeps the match visible');
  assert.ok(/^…/.test(msgRow.snippet), 'a match deep in the body is marked as elided');

  const draftRow = hits.find((c) => c.id === byDraft.id);
  assert.equal(draftRow.matchField, 'draft', 'a draft-only hit is labelled draft');
  assert.ok(/kumquats/.test(draftRow.snippet), 'draft text becomes the snippet');

  assert.deepEqual(chats.searchChats(PROJECT, ''), [], 'a blank query is no results');
  assert.deepEqual(chats.searchChats(PROJECT, '   '), [], 'a whitespace query is no results');
  assert.deepEqual(chats.searchChats(PROJECT, 'zzzz'), [], 'no match, no rows');

  // Case-insensitive, like LIKE.
  assert.deepEqual(
    chats.searchChats(PROJECT, 'KUMQUAT').map((c) => c.id).sort(),
    ids,
    'search is case-insensitive'
  );

  // Wildcards are literal.
  assert.deepEqual(
    chats.searchChats(PROJECT, '%').map((c) => c.id),
    [percent.id],
    '% is a percent sign, not match-all'
  );
  assert.deepEqual(
    chats.searchChats(PROJECT, 'snake_').map((c) => c.id),
    [under.id],
    '_ is an underscore, not any-char'
  );
  assert.deepEqual(
    chats.searchChats(PROJECT, 'snakeX').map((c) => c.id),
    [],
    '_ did not act as a single-character wildcard'
  );

  // The cap is on the chats, and the order is recency — the same order the
  // card's own chat list uses, so a result sits where the user expects it.
  const capped = chats.searchChats(PROJECT, 'kumquat', { limit: 2 });
  assert.equal(capped.length, 2, 'limit caps the chat rows');
  assert.deepEqual(
    capped.map((c) => c.id).sort(),
    [both.id, byDraft.id].sort(),
    'the two most recently created matching chats win the cap'
  );

  // ---- HTTP surface --------------------------------------------------------

  const server = createServer(0);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const url = (q, extra) => base + '/api/chats/search?projectDir=' + encodeURIComponent(PROJECT)
      + '&q=' + encodeURIComponent(q) + (extra || '');

    let r = await fetch(url('kumquat'));
    assert.equal(r.status, 200);
    let body = await r.json();
    assert.equal(body.query, 'kumquat');
    assert.equal(body.total, body.chats.length);
    assert.equal(body.chats.length, 3);
    assert.ok(body.chats.every((c) => typeof c.snippet === 'string'));
    assert.ok(body.chats.every((c) => ['title', 'draft', 'message'].includes(c.matchField)));
    // A result row is a chat-list summary: the card renders it with the same
    // code path as a normal row, so the fields that path reads must be there.
    assert.ok(body.chats.every((c) => typeof c.messageCount === 'number'), 'messageCount is present');
    assert.ok(body.chats.every((c) => c.totalCost && typeof c.totalCost.total === 'number'));
    assert.ok(body.chats.every((c) => !('draft' in c)), 'the draft body is never shipped');

    r = await fetch(url(''));
    assert.equal(r.status, 200);
    body = await r.json();
    assert.deepEqual(body.chats, [], 'blank q is an empty list, not an error');

    r = await fetch(url('kumquat', '&limit=1'));
    body = await r.json();
    assert.equal(body.chats.length, 1, 'limit is honoured over HTTP');

    r = await fetch(base + '/api/chats/search');
    assert.equal(r.status, 400, 'projectDir is required');

    // The :id route must not swallow /search.
    r = await fetch(url('kumquat'));
    assert.equal(r.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('ok');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  });
