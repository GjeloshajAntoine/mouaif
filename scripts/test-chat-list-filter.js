'use strict';
// The project card's filter: chats.listChats / countChats with `only: 'draft'`
// (a composer draft and no persisted message) and `only: 'ids'` (the chats with
// a recurring task, from schedules recurringChatIds).
//
// Run: node scripts/test-chat-list-filter.js
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-chat-list-filter-'));
process.env.MOUAIF_HOME = HOME;
process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
const PROJECT = fs.mkdtempSync(path.join(HOME, 'project-'));

const settings = require('../src/settings.js');
const projects = require('../src/projects.js');
const chats = require('../src/chats.js');
const messages = require('../src/messages.js');
const schedules = require('../src/schedules.js');

settings.runMigrations();
projects.registerProject(PROJECT);

const plain = chats.createChat(PROJECT, { title: 'plain' });
const draft = chats.createChat(PROJECT, { title: 'draft' });
chats.updateChat(PROJECT, draft.id, { draft: 'half-written' });
const blank = chats.createChat(PROJECT, { title: 'blank draft' });
chats.updateChat(PROJECT, blank.id, { draft: '   ' });
const used = chats.createChat(PROJECT, { title: 'used' });
chats.updateChat(PROJECT, used.id, { draft: 'follow-up' });
messages.appendMessage(PROJECT, used.id, { role: 'user', content: 'hi' });
const repeat = chats.createChat(PROJECT, { title: 'repeat' });

const store = schedules.createScheduleStore();
const base = { projectDir: PROJECT, message: 'go', dueAt: Date.now() + 60000 };
store.create(Object.assign({ chatId: repeat.id, everyMs: 3600000 }, base));
store.create(Object.assign({ chatId: plain.id }, base)); // one-off: does not repeat

const ids = (list) => list.map((c) => c.title).sort().join(',');

assert.equal(chats.listChats(PROJECT).length, 5);
assert.equal(ids(chats.listChats(PROJECT, { only: 'draft' })), 'draft', 'only a draft-only chat');
assert.equal(chats.countChats(PROJECT, { only: 'draft' }), 1);

const rec = store.recurringChatIds(PROJECT);
assert.deepEqual(rec, [repeat.id], 'a one-off wake is not a recurring chat');
assert.equal(ids(chats.listChats(PROJECT, { only: 'ids', ids: rec })), 'repeat');
assert.equal(chats.countChats(PROJECT, { only: 'ids', ids: rec }), 1);
assert.equal(chats.listChats(PROJECT, { only: 'ids', ids: [] }).length, 0, 'no recurring chats -> empty, not everything');
assert.equal(chats.countChats(PROJECT), 5, 'unfiltered count unchanged');
assert.equal(chats.listChats(PROJECT, { only: 'draft', limit: 1, offset: 1 }).length, 0, 'paging follows the filter');

console.log('ok');
