// listAgentRows: the agent network dock's rows below the loaded page.
//
// A chat opens on its newest page only; an idle chat whose delegations are
// older than that page used to show no agent network at all. The dock now
// fetches the subagent rows (and user-row markers) below the page. Checks:
// only subagent tool rows and reduced user rows come back, only below
// `beforeSeq`, in seq order, and nothing at all when there was no delegation.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-agent-rows-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const messages = require('../src/messages.js');
const chats = require('../src/chats.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

const dir = path.join(tmp, 'proj');
fs.mkdirSync(dir);
const chat = chats.createChat(dir, {});
const id = chat.id;
const add = (m) => messages.appendMessage(dir, id, m);
add({ role: 'user', content: 'start' });                                                   // 0
add({ role: 'tool', phase: 'call', toolCallId: 'c1', name: 'subagent', args: { task: 'x' }, content: '{}' }); // 1
add({ role: 'tool', phase: 'call', toolCallId: 'c2', name: 'read_file', args: {}, content: '{}' });           // 2
add({ role: 'tool', phase: 'result', toolCallId: 'c1', name: 'subagent', ok: true, content: '{"ok":true}' }); // 3
add({ role: 'assistant', content: 'done' });                                               // 4
add({ role: 'user', content: 'later' });                                                   // 5
add({ role: 'tool', phase: 'call', toolCallId: 'c3', name: 'subagent', args: {}, content: '{}' });            // 6

const all = messages.listAgentRows(dir, id);
check('subagent rows and user markers, in order', JSON.stringify(all.map((m) => m.seq)) === '[0,1,3,5,6]', JSON.stringify(all.map((m) => m.seq)));
check('user rows are reduced to role and seq', all[0].role === 'user' && all[0].content === undefined);
check('subagent call keeps its id and phase', all[1].toolCallId === 'c1' && all[1].phase === 'call');
const below = messages.listAgentRows(dir, id, 5);
check('only rows below beforeSeq', JSON.stringify(below.map((m) => m.seq)) === '[0,1,3]', JSON.stringify(below.map((m) => m.seq)));

const other = chats.createChat(dir, {});
messages.appendMessage(dir, other.id, { role: 'user', content: 'hi' });
check('no delegation, no rows', messages.listAgentRows(dir, other.id).length === 0);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
