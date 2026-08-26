'use strict';
// Regression test: paginated chat lists must aggregate costs only for the
// chats returned on that page, not every transcript in the project.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-chat-list-cost-'));
process.env.MOUAIF_HOME = HOME;
const PROJECT = fs.mkdtempSync(path.join(HOME, 'project-'));

const chats = require('../src/chats.js');
const chatdb = require('../src/chatdb.js');
const { createServer } = require('../src/index.js');

async function main() {
  for (let i = 0; i < 35; i++) {
    const chat = chats.createChat(PROJECT, { title: 'chat ' + i });
    chats.updateChat(PROJECT, chat.id, {
      lastOpenedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString()
    });
    chatdb.appendMessage(PROJECT, chat.id, {
      role: 'assistant',
      content: 'reply',
      cost: { known: true, total: i + 0.5 }
    });
  }

  const originalProjectCostTotals = chatdb.projectCostTotals;
  let requestedIds = null;
  chatdb.projectCostTotals = (projectDir, chatIds) => {
    requestedIds = chatIds;
    return originalProjectCostTotals(projectDir, chatIds);
  };

  const server = createServer(0);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const response = await fetch(
      'http://127.0.0.1:' + port + '/api/chats?projectDir=' + encodeURIComponent(PROJECT) + '&offset=0&limit=30'
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.chats.length, 30);
    assert.equal(body.total, 35);
    assert.deepEqual(requestedIds, body.chats.map((chat) => chat.id));
    assert.equal(Object.prototype.hasOwnProperty.call(body.chats[0], 'totalCost'), true);
    assert.equal(body.chats[0].totalCost.known, true);
  } finally {
    chatdb.projectCostTotals = originalProjectCostTotals;
    await new Promise((resolve) => server.close(resolve));
  }

  const newest = chats.listChats(PROJECT)[0];
  const scoped = originalProjectCostTotals(PROJECT, [newest.id]);
  assert.deepEqual(Object.keys(scoped), [newest.id]);
  assert.equal(scoped[newest.id].known, true);
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
