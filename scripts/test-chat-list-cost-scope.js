'use strict';
// Regression test: cost-bearing message writes update persisted chat and
// registered-project metadata, and listing chats never aggregates messages.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-chat-cost-total-'));
process.env.MOUAIF_HOME = HOME;
process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
const PROJECT = fs.mkdtempSync(path.join(HOME, 'project-'));

const settings = require('../src/settings.js');
const projects = require('../src/projects.js');
const chats = require('../src/chats.js');
const messages = require('../src/messages.js');
const chatdb = require('../src/chatdb.js');
const { createServer } = require('../src/index.js');

function projectTotal() {
  return projects.listProjects().find((project) => project.path === PROJECT).totalCost;
}

async function main() {
  settings.runMigrations();
  projects.registerProject(PROJECT);
  const first = chats.createChat(PROJECT, { title: 'first' });
  const second = chats.createChat(PROJECT, { title: 'second' });

  messages.appendMessage(PROJECT, first.id, {
    role: 'assistant', content: 'one', cost: { known: true, total: 1.25 }
  });
  messages.appendMessage(PROJECT, first.id, {
    role: 'assistant', content: 'unknown', cost: { known: false, total: 99 }
  });
  messages.appendMessage(PROJECT, second.id, {
    role: 'assistant', content: 'two', cost: { known: true, total: 2.5 }
  });

  assert.deepEqual(chats.getChat(PROJECT, first.id).totalCost, {
    total: 1.25, known: true, currency: 'USD', knownCount: 1
  });
  assert.deepEqual(projectTotal(), {
    total: 3.75, known: true, currency: 'USD', knownCount: 2
  });

  messages.replaceMessages(PROJECT, second.id, [
    { role: 'assistant', content: 'replacement', cost: { known: true, total: 4 } }
  ]);
  assert.deepEqual(chats.getChat(PROJECT, second.id).totalCost, {
    total: 4, known: true, currency: 'USD', knownCount: 1
  });
  assert.deepEqual(projectTotal(), {
    total: 5.25, known: true, currency: 'USD', knownCount: 2
  });

  const originalProjectCostTotals = chatdb.projectCostTotals;
  chatdb.projectCostTotals = () => { throw new Error('list must not aggregate message costs'); };
  const server = createServer(0);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(
      'http://127.0.0.1:' + server.address().port + '/api/chats?projectDir=' + encodeURIComponent(PROJECT) + '&limit=30'
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.chats.length, 2);
    assert.equal(body.chats.find((chat) => chat.id === first.id).totalCost.total, 1.25);
  } finally {
    chatdb.projectCostTotals = originalProjectCostTotals;
    await new Promise((resolve) => server.close(resolve));
  }

  messages.clearMessages(PROJECT, first.id);
  assert.deepEqual(chats.getChat(PROJECT, first.id).totalCost, {
    total: 0, known: false, currency: 'USD', knownCount: 0
  });
  assert.deepEqual(projectTotal(), {
    total: 4, known: true, currency: 'USD', knownCount: 1
  });

  chats.deleteChat(PROJECT, second.id);
  assert.deepEqual(projectTotal(), {
    total: 0, known: false, currency: 'USD', knownCount: 0
  });
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
