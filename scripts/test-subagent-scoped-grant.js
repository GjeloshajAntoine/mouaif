'use strict';
// A subagent's approval card changes only that subagent: Session/Always grant
// the tool to that run and the runs below it, never to the main agent, a
// sibling subagent, or the project settings (src/tools/authorization.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-scoped-grant-home-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-scoped-grant-project-'));
const settings = require('../src/settings.js');
const authz = require('../src/tools/authorization.js');

async function main() {
  settings.setProject(projectDir, { tools: { shell: { mode: 'ask' } } });
  const chatId = 'c1';
  const ask = (callId, extra) => authz.authorize({ projectDir, chatId, tool: 'shell', callId, cmd: 'ls', ...extra });

  // Subagent A asks; the card names it; the user picks Always.
  const a = await ask('a1', { grantScopes: ['runA'], subagent: { callId: 'callA', agent: 'Reviewer', depth: 1 } });
  assert.equal(a.decision, 'prompt');
  const pending = authz.listPending(projectDir, chatId).find((p) => p.callId === 'a1');
  assert.deepEqual(pending.subagent, { callId: 'callA', agent: 'Reviewer', depth: 1 }, 'the request names the subagent');
  authz.recordDecision(projectDir, chatId, 'a1', 'allow-always');
  await a.wait;
  assert.equal(authz.effectiveConfig(projectDir, 'shell', chatId).mode, 'ask', 'Always on a subagent card writes no project setting');

  assert.equal((await ask('a2', { grantScopes: ['runA'] })).decision, 'allow', 'the same subagent is not asked again');
  assert.equal((await ask('a3', { grantScopes: ['runChildOfA', 'runA'] })).decision, 'allow', 'its own subagents are covered');
  assert.equal((await ask('a4', { grantScopes: ['runA'], inheritAsk: true })).decision, 'allow', 'an inherited ask is answered by the subagent grant');
  assert.equal((await ask('b1', { grantScopes: ['runB'] })).decision, 'prompt', 'a sibling subagent still asks');
  assert.equal((await ask('m1')).decision, 'prompt', 'the main agent still asks');
  assert.equal((await ask('a5', { grantScopes: ['runA'], forcePrompt: true })).decision, 'prompt', 'forcePrompt still reaches the user');

  // A chat-wide Session grant from the main agent's card does not answer a
  // subagent whose parent permission was ask.
  authz.recordDecision(projectDir, chatId, 'm1', 'allow-session');
  assert.equal((await ask('m2')).decision, 'allow');
  assert.equal((await ask('c1', { grantScopes: ['runC'], inheritAsk: true })).decision, 'prompt');
  authz.clearGrants(projectDir, chatId);
  console.log('subagent scoped grant: card names the subagent, grant stays in its subtree, no project write passed');
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
