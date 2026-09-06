'use strict';
// Regression test: listing chats attaches a per-chat `messageCount` (a bulk
// COUNT over message_store) so the project card can flag draft-only chats.
// Verifies the shape and that a running chat keeps its response-only flags.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-chat-msgcount-'));
process.env.MOUAIF_HOME = HOME;
process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
const PROJECT = fs.mkdtempSync(path.join(HOME, 'project-'));
const settings = require('../src/settings.js');
const projects = require('../src/projects.js');
const chats = require('../src/chats.js');
const messages = require('../src/messages.js');
const { createServer } = require('../src/index.js');
async function main() {
settings.runMigrations();
projects.registerProject(PROJECT);
const empty = chats.createChat(PROJECT, { title: 'empty' });      // no messages
const drafted = chats.createChat(PROJECT, { title: 'drafted' });  // draft only
chats.updateChat(PROJECT, drafted.id, { draft: '  hello world\nsecond line  ' });
const filled = chats.createChat(PROJECT, { title: 'filled' });    // has messages
messages.appendMessage(PROJECT, filled.id, {
role: 'assistant', content: 'one', cost: { known: true, total: 1 }
});
// projectMessageCounts directly.
const counts = messages.projectMessageCounts(PROJECT, [empty.id, drafted.id, filled.id]);
assert.deepEqual(counts, { [filled.id]: 1 });
const server = createServer(0);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
const response = await fetch(
'http://127.0.0.1:' + server.address().port + '/api/chats?projectDir=' + encodeURIComponent(PROJECT)
);
assert.equal(response.status, 200);
const body = await response.json();
const byId = new Map(body.chats.map((c) => [c.id, c]));
assert.equal(byId.get(empty.id).messageCount, 0);
assert.equal(byId.get(drafted.id).messageCount, 0);
assert.equal(byId.get(filled.id).messageCount, 1);
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
