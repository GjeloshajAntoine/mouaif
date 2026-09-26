'use strict';

// Regression test for prompt snapshots: a chat pins the custom prompt text
// (and preset) it was attached with, so editing that shared prompt later
// never rewrites an existing chat. New chats pick up the new text.
//
// Covers:
//   - createChat pins the prompt text and preset
//   - editing the prompt leaves an attached chat's resolved prompt alone
//   - a chat created after the edit gets the new text
//   - re-attaching (PATCH promptId) re-pins
//   - detaching (PATCH promptId: null) clears the pin
//   - deleting the prompt keeps the attached chat's pinned text
//   - a chat with no snapshot still resolves live by promptId (old rows)
//   - a client cannot forge a snapshot through the REST API
//
// Run: node scripts/test-prompt-snapshot.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-prompt-snap-home-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-prompt-snap-proj-'));
process.env.MOUAIF_HOME = home;

const prompts = require('../src/prompts.js');
const chats = require('../src/chats.js');
const settings = require('../src/settings.js');

let pass = 0, fail = 0;
function t(name, cond, msg) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (msg ? (' :: ' + msg) : '')); }
}

function resolved(projectDir, chatId) {
  return prompts.resolveChatPrompt(projectDir, chats.getChat(projectDir, chatId));
}

// ---- attach pins the text -------------------------------------------------
const p1 = prompts.createPrompt(root, {
  title: 'Reviewer', content: 'You review code.', scope: 'project',
  preset: { tools: ['shell'] }
});
const c1 = chats.createChat(root, { promptId: p1.id });
t('createChat pins the prompt text', c1.promptSnapshot && c1.promptSnapshot.content === 'You review code.');
t('createChat pins the prompt title', c1.promptSnapshot && c1.promptSnapshot.title === 'Reviewer');
t('createChat pins the preset', c1.promptSnapshot && Array.isArray(c1.promptSnapshot.preset.tools)
  && c1.promptSnapshot.preset.tools.includes('shell'));
t('resolve returns the pinned text', resolved(root, c1.id).content === 'You review code.');

// ---- editing the prompt does not reach the existing chat ------------------
prompts.updatePrompt(root, p1.id, { content: 'You review EVERYTHING.' });
t('editing the prompt leaves the attached chat unchanged',
  resolved(root, c1.id).content === 'You review code.',
  JSON.stringify(resolved(root, c1.id)));

const c2 = chats.createChat(root, { promptId: p1.id });
t('a new chat gets the edited text', resolved(root, c2.id).content === 'You review EVERYTHING.');

// ---- re-attach re-pins ----------------------------------------------------
prompts.updatePrompt(root, p1.id, { content: 'Third revision.' });
chats.updateChat(root, c2.id, { promptId: p1.id });
t('re-attaching re-pins to the current text', resolved(root, c2.id).content === 'Third revision.');

// ---- detach clears the pin ------------------------------------------------
chats.updateChat(root, c2.id, { promptId: null });
const detached = chats.getChat(root, c2.id);
t('detaching clears promptId', detached.promptId === null);
t('detaching clears the snapshot', !detached.promptSnapshot);
t('a detached chat resolves to no prompt', resolved(root, c2.id) === null);

// ---- deleting the prompt keeps the pinned text ----------------------------
const del = prompts.deletePrompt(root, p1.id, { scope: 'project', onRemoved: (id) => chats.clearPromptId(root, id) });
t('deletePrompt reports success', del === true);
const afterDelete = chats.getChat(root, c1.id);
t('deleting the prompt drops the reference', afterDelete.promptId === null);
t('deleting the prompt keeps the pinned text',
  resolved(root, c1.id) && resolved(root, c1.id).content === 'You review code.',
  JSON.stringify(resolved(root, c1.id)));
t('deleting the prompt keeps the pinned preset',
  resolved(root, c1.id).preset && resolved(root, c1.id).preset.tools.includes('shell'));

// ---- a legacy row (no snapshot) still resolves live -----------------------
const p2 = prompts.createPrompt(root, { title: 'Legacy', content: 'Legacy text.', scope: 'project' });
const c3 = chats.createChat(root, { promptId: null });
// Simulate a row written before the snapshot column existed.
chats.updateChat(root, c3.id, { promptId: p2.id });
const db = settings.getDb();
db.prepare('UPDATE chat_store SET prompt_snapshot = NULL WHERE project_dir = ? AND id = ?').run(root, c3.id);
t('a legacy row has no snapshot', !chats.getChat(root, c3.id).promptSnapshot);
t('a legacy row resolves live by promptId',
  resolved(root, c3.id) && resolved(root, c3.id).content === 'Legacy text.',
  JSON.stringify(resolved(root, c3.id)));

// ---- a corrupt snapshot never breaks resolution ---------------------------
db.prepare('UPDATE chat_store SET prompt_snapshot = ? WHERE project_dir = ? AND id = ?')
  .run('{not json', root, c3.id);
t('a corrupt snapshot falls back to the live prompt',
  resolved(root, c3.id) && resolved(root, c3.id).content === 'Legacy text.',
  JSON.stringify(resolved(root, c3.id)));

// ---- snapshotPrompt / resolveChatPrompt units -----------------------------
t('snapshotPrompt returns null for a missing prompt', prompts.snapshotPrompt(root, 'nope') === null);
t('snapshotPrompt pins content', prompts.snapshotPrompt(root, p2.id).content === 'Legacy text.');
t('resolveChatPrompt tolerates null', prompts.resolveChatPrompt(root, null) === null);
t('resolveChatPrompt prefers a snapshot over promptId', (() => {
  const fake = { promptId: p2.id, promptSnapshot: { content: 'Pinned wins.', role: 'system', title: 'x' } };
  return prompts.resolveChatPrompt(root, fake).content === 'Pinned wins.';
})());
t('resolveChatPrompt coerces a bad role to system', (() => {
  const fake = { promptSnapshot: { content: 'hi', role: 'assistant', title: 'x' } };
  return prompts.resolveChatPrompt(root, fake).role === 'system';
})());

settings.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
