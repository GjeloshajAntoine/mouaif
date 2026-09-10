'use strict';

// Regression test: revoking a chat's session grants must not orphan a
// tool call that is already parked on a user decision.
//
// POST /api/chats/:id/touch runs authorization.clearGrants(), which used
// to delete the whole session object — including its `pending` map. The
// tool loop was at that moment awaiting `authResult.wait`, a promise that
// only the deleted entry could settle:
//
//   * the user's answer now hit recordDecision(), which throws ENOTFOUND
//     because the session is gone, and
//   * the loop stayed parked forever. The upstream-abort signal does not
//     fire while the loop waits on a decision rather than a fetch, so the
//     chat kept its running marker and every retry bounced off
//     409 EALREADY_RUNNING (the "chat looks frozen" failure that
//     cancelSession() already guards against for a dropped SSE client).
//
// The wait must be settled (EDENIED) as part of the revoke, so the loop
// unwinds through its normal error path.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-cleargrants-home-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-cleargrants-project-'));
process.env.MOUAIF_HOME = home;

const settings = require('../src/settings.js');
const authz = require('../src/tools/authorization.js');

const CHAT = 'a1b2c3d4';

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// settled(promise, ms) — 'resolved' | 'rejected' | 'pending'. A forever-
// parked promise reports 'pending' instead of hanging the test.
function settled(promise, ms = 250) {
  return Promise.race([
    promise.then(() => 'resolved', () => 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), ms))
  ]);
}

async function main() {
  settings.setProject(projectDir, {
    chats: [{ id: CHAT, title: 'Clear grants', trace: false }],
    tools: { shell: { enabled: true, mode: 'ask', allowlist: [] } }
  });

  // 1. A parked wait is settled, not orphaned.
  const asked = await authz.authorize({
    projectDir, chatId: CHAT, callId: 'call_parked', tool: 'shell', cmd: 'echo hi'
  });
  assert.equal(asked.decision, 'prompt', 'test setup: ask mode must prompt');
  let rejection = null;
  asked.wait.catch((e) => { rejection = e; });

  let seen = await settled(asked.wait);
  check('a pending decision really does block the loop before the revoke', seen === 'pending', seen);

  const rejected = authz.clearGrants(projectDir, CHAT);
  check('clearGrants reports the rejected wait', rejected === 1, 'rejected=' + rejected);

  seen = await settled(asked.wait);
  check('the parked wait is rejected by the revoke', seen === 'rejected', seen);
  check('the rejection is a typed EDENIED', rejection && rejection.code === 'EDENIED',
    rejection && rejection.code);
  check('the pending list is empty after the revoke',
    authz.listPending(projectDir, CHAT).length === 0,
    JSON.stringify(authz.listPending(projectDir, CHAT)));

  // 2. The session (and therefore its grants) is gone: the next call asks
  //    again rather than inheriting the previous session's state.
  const after = await authz.authorize({
    projectDir, chatId: CHAT, callId: 'call_after_revoke', tool: 'shell', cmd: 'echo again'
  });
  check('the next call prompts again after the revoke', after.decision === 'prompt', after.decision);
  // Every parked wait needs a handler: leaving one unattended turns the
  // revoke's (correct) rejection into an unhandled rejection.
  after.wait.catch(() => {});
  authz.clearGrants(projectDir, CHAT);

  // 3. A grant earned after the revoke still works for the session.
  const first = await authz.authorize({
    projectDir, chatId: CHAT, callId: 'call_grant', tool: 'shell', cmd: 'echo granted'
  });
  authz.recordDecision(projectDir, CHAT, 'call_grant', 'allow-session');
  await first.wait;
  const granted = await authz.authorize({
    projectDir, chatId: CHAT, callId: 'call_granted', tool: 'shell', cmd: 'echo granted too'
  });
  check('allow-session still applies within one session', granted.decision === 'allow', granted.decision);

  // 4. cancelSession keeps its existing contract: it rejects every parked
  //    wait and reports the count. A second chat is used because the
  //    session above now auto-allows and would never prompt again.
  const CANCEL_CHAT = 'e5f6a7b8';
  settings.setProject(projectDir, {
    chats: [
      { id: CHAT, title: 'Clear grants', trace: false },
      { id: CANCEL_CHAT, title: 'Cancel session', trace: false }
    ],
    tools: { shell: { enabled: true, mode: 'ask', allowlist: [] } }
  });
  const parked = await authz.authorize({
    projectDir, chatId: CANCEL_CHAT, callId: 'call_cancel', tool: 'shell', cmd: 'echo cancel'
  });
  assert.equal(parked.decision, 'prompt', 'test setup: cancel-session chat must prompt');
  parked.wait.catch(() => {});
  const cancelled = authz.cancelSession(projectDir, CANCEL_CHAT);
  check('cancelSession still reports the rejected waits', cancelled === 1, 'cancelled=' + cancelled);
  seen = await settled(parked.wait);
  check('cancelSession still rejects the parked wait', seen === 'rejected', seen);

  // 5. Both revoke helpers are no-ops without a session, and never throw.
  check('clearGrants tolerates a missing session', authz.clearGrants(projectDir, CANCEL_CHAT) === 0);
  authz.clearGrants(projectDir, CHAT);
  check('cancelSession tolerates a missing session', authz.cancelSession(projectDir, CHAT) === 0);
  check('clearGrants ignores a missing chat id', authz.clearGrants(projectDir, '') === 0);

  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    try { settings.close(); } catch { /* already closed */ }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
