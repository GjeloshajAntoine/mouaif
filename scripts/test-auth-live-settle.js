'use strict';
// Approval prompts follow permission changes made while a run is parked on
// them (src/tools/authorization.js → settleAnsweredPrompts):
//  - Session on one card answers the other prompts up for the same tool, in
//    the same scope (main agent, or the same subagent);
//  - switching a tool to Allow during a run answers its subagents' prompts
//    and later subagent calls, though they started while it was Ask;
//  - switching it to Off refuses the prompts that are up;
//  - ask_user and forcePrompt calls still wait for the user.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-auth-settle-home-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-auth-settle-project-'));
const settings = require('../src/settings.js');
const authz = require('../src/tools/authorization.js');

const tick = () => new Promise((r) => setImmediate(() => setImmediate(r)));
const pendingIds = (chatId) => authz.listPending(projectDir, chatId).map((p) => p.callId).sort();
const state = (promise) => Promise.race([
  promise.then(() => 'allowed', (e) => 'rejected:' + e.code),
  tick().then(() => tick()).then(() => 'waiting')
]);

async function main() {
  settings.setProject(projectDir, { tools: { shell: { mode: 'ask' } } });
  const ask = (chatId, callId, extra) => authz.authorize({ projectDir, chatId, tool: 'shell', callId, cmd: 'ls', ...extra });

  // Session on one subagent card answers that subagent's other prompt, not a sibling's.
  const a1 = await ask('c1', 'a1', { grantScopes: ['runA'], inheritAsk: true });
  const a2 = await ask('c1', 'a2', { grantScopes: ['runA'], inheritAsk: true });
  const b1 = await ask('c1', 'b1', { grantScopes: ['runB'], inheritAsk: true });
  const m1 = await ask('c1', 'm1');
  authz.recordDecision(projectDir, 'c1', 'a1', 'allow-session');
  await a1.wait;
  assert.equal(await state(a2.wait), 'allowed', 'the same subagent\'s parallel prompt is answered');
  assert.equal(await state(b1.wait), 'waiting', 'a sibling subagent still asks');
  assert.equal(await state(m1.wait), 'waiting', 'the main agent still asks');

  // Session on a main-agent card answers the main agent's other prompt only.
  const m2 = await ask('c1', 'm2');
  authz.recordDecision(projectDir, 'c1', 'm1', 'allow-session');
  await m1.wait;
  assert.equal(await state(m2.wait), 'allowed', 'the main agent\'s parallel prompt is answered');
  assert.equal(await state(b1.wait), 'waiting', 'a subagent under an Ask permission still asks');
  assert.deepEqual(pendingIds('c1'), ['b1']);

  // ask_user and forcePrompt calls are never answered by a change.
  const q = await authz.authorize({ projectDir, chatId: 'c1', tool: 'ask_user', callId: 'q1', args: { question: 'x' } });
  const forced = await ask('c1', 'f1', { forcePrompt: true });

  // The user switches shell to Allow while the subagent is parked.
  authz.setAuthorization(projectDir, { tools: { shell: { mode: 'allow' } } });
  assert.equal(await state(b1.wait), 'allowed', 'a parked subagent prompt follows the switch to Allow');
  assert.equal(await state(forced.wait), 'waiting', 'forcePrompt still waits');
  assert.equal((await ask('c1', 'b2', { grantScopes: ['runB'], inheritAsk: true })).decision, 'allow',
    'a subagent started under Ask follows the switch to Allow');

  // Back to Ask, then Off: the prompts up are refused.
  authz.setAuthorization(projectDir, { tools: { shell: { mode: 'ask' } } });
  const c2 = await ask('c2', 'x1', { grantScopes: ['runX'], inheritAsk: true });
  assert.equal(c2.decision, 'prompt', 'Ask is back for a new subagent call');
  authz.setAuthorization(projectDir, { tools: { shell: { mode: 'off' } } });
  assert.equal(await state(c2.wait), 'rejected:ETOOL_DISABLED', 'switching to Off refuses the parked prompt');
  assert.equal(await state(forced.wait), 'rejected:ETOOL_DISABLED', 'Off refuses a forced prompt too');
  assert.equal(await state(q.wait), 'waiting', 'ask_user is untouched');
  assert.deepEqual(pendingIds('c1'), ['q1']);
  authz.recordDecision(projectDir, 'c1', 'q1', 'deny');
  await q.wait.catch(() => {});

  console.log('auth live settle: parallel prompts, mid-run Allow/Off for subagents, ask_user untouched passed');
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
