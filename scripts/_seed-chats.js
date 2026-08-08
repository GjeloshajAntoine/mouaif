'use strict';
// Dev helper: seed a temp project with N chats so pagination of the
// chat switcher and project-card chat list can be tested manually.
// Usage: node scripts/seed-chats.js <absProjectDir> [count]
const path = require('path');
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');

const projectDir = process.argv[2];
const count = parseInt(process.argv[3], 10) || 120;
if (!projectDir) { console.error('usage: node scripts/seed-chats.js <absProjectDir> [count]'); process.exit(1); }
if (!path.isAbsolute(projectDir)) { console.error('projectDir must be absolute'); process.exit(1); }

// Force DB backend so chats go into store.sqlite (like the default).
const key = 'chatStorage';
process.env._seed = '1';
for (let i = 0; i < count; i++) {
  const c = chats.createChat(projectDir, { title: 'Seed chat ' + (i + 1) });
  // Stagger lastOpenedAt so ordering is deterministic.
  const opened = new Date(Date.now() - (count - i) * 60000).toISOString();
  chats.updateChat(projectDir, c.id, { lastOpenedAt: opened });
}
const total = chats.listChats(projectDir).length;
console.log('seeded ' + count + ' chats; list now has ' + total);