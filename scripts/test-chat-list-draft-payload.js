'use strict';
// Regression test: the chat list must stay small when a chat's draft holds an
// image. `GET /api/chats` returns summaries — `draftSnippet` (a bounded head of
// the text draft) plus `hasDraftImage` — and never the `draft` body or the
// `draftAttachments` JSON (up to 8 base64 images, ~12 MB each). The single-chat
// read still returns both, and the internal writers that iterate the list must
// not lose them.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-chat-list-draft-'));
process.env.MOUAIF_HOME = HOME;
process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
const PROJECT = fs.mkdtempSync(path.join(HOME, 'project-'));

const settings = require('../src/settings.js');
const projects = require('../src/projects.js');
const chats = require('../src/chats.js');
const { createServer } = require('../src/index.js');

// One picture in the composer draft: the shape that made the Chats tab slow.
const IMAGE = 'data:image/png;base64,' + 'A'.repeat(1_500_000);
const LONG_DRAFT = 'first line of a long draft\n' + 'x'.repeat(1200);

async function main() {
  settings.runMigrations();
  projects.registerProject(PROJECT);

  const pictured = chats.createChat(PROJECT, { title: 'pictured' });
  chats.updateChat(PROJECT, pictured.id, {
    draft: LONG_DRAFT,
    draftAttachments: [{ type: 'image', mimeType: 'image/png', dataUrl: IMAGE, name: 'shot.png' }]
  });
  const textOnly = chats.createChat(PROJECT, { title: 'text only' });
  chats.updateChat(PROJECT, textOnly.id, { draft: '  hello world\nsecond line  ' });

  // ---- listChats(): summaries, never the two unbounded columns -----------
  const rows = chats.listChats(PROJECT);
  assert.equal(rows.length, 2, 'the unlimited list still returns every chat');
  const byId = new Map(rows.map((c) => [c.id, c]));
  const picturedRow = byId.get(pictured.id);
  assert.equal(picturedRow.draft, undefined, 'the list row must not carry the draft body');
  assert.equal(picturedRow.draftAttachments, undefined, 'the list row must not carry the image draft');
  assert.equal(picturedRow.hasDraftImage, true);
  assert.equal(picturedRow.draftSnippet.length, 400, 'the snippet is bounded');
  assert.ok(LONG_DRAFT.startsWith(picturedRow.draftSnippet), 'the snippet is the head of the draft');
  assert.equal(byId.get(textOnly.id).hasDraftImage, false, 'a text-only draft has no image flag');
  assert.equal(byId.get(textOnly.id).draftSnippet, '  hello world\nsecond line  ');

  // The summary must carry every other field of the full record, or a chat
  // card would silently lose (say) its cost, trace flag or prompt icon when
  // LIST_COLUMNS drifts from the row mapper.
  const full = chats.getChat(PROJECT, pictured.id);
  const summary = Object.assign({}, picturedRow);
  delete summary.draftSnippet;
  delete summary.hasDraftImage;
  const expected = Object.assign({}, full);
  delete expected.draft;
  delete expected.draftAttachments;
  assert.deepEqual(summary, expected, 'a list row carries every field of the full chat record');

  const server = createServer(0);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;

    // ---- the HTTP list page ---------------------------------------------
    const listed = await fetch(base + '/api/chats?projectDir=' + encodeURIComponent(PROJECT));
    assert.equal(listed.status, 200);
    const raw = await listed.text();
    // Two rows of metadata. 64 KB is generous for that and still two orders of
    // magnitude below the single attachment the old payload shipped.
    assert.ok(raw.length < 64 * 1024, 'the list payload is bounded, got ' + raw.length + ' bytes');
    assert.equal(raw.includes(IMAGE.slice(0, 2048)), false, 'the list payload must not contain image data');
    const page = JSON.parse(raw);
    const listedPictured = page.chats.find((c) => c.id === pictured.id);
    assert.equal(listedPictured.hasDraftImage, true);
    assert.equal(listedPictured.draft, undefined, 'the list response must not carry the draft body');
    assert.equal(listedPictured.draftAttachments, undefined, 'the list response must not carry the image draft');
    assert.equal(listedPictured.draftSnippet.length, 400);
    assert.equal(listedPictured.messageCount, 0, 'a draft-only chat still reports zero persisted messages');

    // ---- the single-chat read keeps the bodies ---------------------------
    const single = await fetch(base + '/api/chats/' + pictured.id + '?projectDir=' + encodeURIComponent(PROJECT));
    assert.equal(single.status, 200);
    const chat = (await single.json()).chat;
    assert.equal(chat.draft, LONG_DRAFT);
    assert.equal(chat.draftAttachments.length, 1);
    assert.equal(chat.draftAttachments[0].dataUrl, IMAGE);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // ---- internal writers that iterate the list keep the draft -------------
  chats.recomputeProjectTotalCost(PROJECT);
  const after = chats.getChat(PROJECT, pictured.id);
  assert.equal(after.draft, LONG_DRAFT, 'a cost recompute over the summary list keeps the draft');
  assert.equal(after.draftAttachments.length, 1, 'a cost recompute keeps the image draft');

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
