// Ad-hoc smoke test for the per-chat `tools` toggle plumbing.
// Mirrors the round-trip the chat UI exercises when a user clicks
// a tool chip on a brand-new chat.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolate the app store BEFORE requiring any src module: with the default
// chatStorage the chats createChat/updateChat round-trip through the app
// SQLite store, which is rooted at MOUAIF_HOME captured when settings.js
// loads. Without isolation this test writes test chats into the real
// ~/.mouaif/store.sqlite.
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-tools-'));
process.env.MOUAIF_HOME = path.join(d, 'home');

const c = require('../src/chats.js');
try {
  const created = c.createChat(d, { title: 'T1' });
  console.log('create no tools ->', JSON.stringify(created));

  const a = c.updateChat(d, created.id, { tools: ['shell', 'read_file'] });
  console.log('update with array ->', JSON.stringify(a));

  const b = c.updateChat(d, created.id, { tools: [] });
  console.log('update with empty ->', JSON.stringify(b));

  const e = c.updateChat(d, created.id, { tools: null });
  console.log('update with null ->', JSON.stringify(e));

  const all = ['shell', 'read_file', 'list_files', 'search_files', 'write_file', 'edit_file'];
  const f = c.updateChat(d, created.id, { tools: all });
  console.log('update with all ->', JSON.stringify(f));

  const after = c.getChat(d, created.id);
  console.log('get back ->', JSON.stringify(after));

  // Bad shape must be rejected (the previous value stays).
  const before = c.getChat(d, created.id);
  const g = c.updateChat(d, created.id, { tools: 'shell' });
  console.log('update with bad shape ->', JSON.stringify(g));
  const afterBad = c.getChat(d, created.id);
  console.log('get back after bad ->', JSON.stringify(afterBad));
  if (JSON.stringify(afterBad.tools) !== JSON.stringify(before.tools)) {
    console.error('FAIL: bad shape should preserve previous tools');
    process.exit(1);
  }

  // Sanity: filter is null -> undefined in normalize, but updateChat
  // round-trips an explicit null as []. Both should be accepted.
  const h = c.updateChat(d, created.id, { tools: ['shell'] });
  console.log('update with subset ->', JSON.stringify(h));

  console.log('OK');
} finally {
  fs.rmSync(d, { recursive: true, force: true });
}
