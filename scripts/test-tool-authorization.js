'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-authz-home-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-authz-project-'));
process.env.MOUAIF_HOME = home;

const settings = require('../src/settings.js');
const authz = require('../src/tools/authorization.js');

async function main() {
  settings.setProject(projectDir, {
    chats: [{ id: 'a1b2c3d4', title: 'Auth test', trace: false }],
    tools: { shell: { enabled: true, mode: 'ask', allowlist: [] } }
  });

  const asked = await authz.authorize({
    projectDir, chatId: 'a1b2c3d4', callId: 'call_once', tool: 'shell', cmd: 'echo ok'
  });
  assert.equal(asked.decision, 'prompt');
  let resumed = false;
  asked.wait.then(() => { resumed = true; });
  await Promise.resolve();
  assert.equal(resumed, false, 'runner must remain blocked before a decision');
  authz.recordDecision(projectDir, 'a1b2c3d4', 'call_once', 'allow-once');
  await asked.wait;
  assert.equal(resumed, true);

  const denied = await authz.authorize({
    projectDir, chatId: 'a1b2c3d4', callId: 'call_deny', tool: 'shell', cmd: 'echo no'
  });
  authz.recordDecision(projectDir, 'a1b2c3d4', 'call_deny', 'deny');
  await assert.rejects(denied.wait, { code: 'EDENIED' });
  await assert.rejects(
    authz.authorize({ projectDir, chatId: 'a1b2c3d4', callId: 'call_deny', tool: 'shell', cmd: 'echo no' }),
    { code: 'EDENIED' }
  );

  const sessionAsk = await authz.authorize({
    projectDir, chatId: 'a1b2c3d4', callId: 'call_session', tool: 'shell', cmd: 'echo yes'
  });
  authz.recordDecision(projectDir, 'a1b2c3d4', 'call_session', 'allow-session');
  await sessionAsk.wait;
  const sessionAllowed = await authz.authorize({
    projectDir, chatId: 'a1b2c3d4', callId: 'call_after', tool: 'shell', cmd: 'echo still yes'
  });
  assert.equal(sessionAllowed.decision, 'allow');

  authz.clearGrants(projectDir, 'a1b2c3d4');
  const reasked = await authz.authorize({
    projectDir, chatId: 'a1b2c3d4', callId: 'call_reopen', tool: 'shell', cmd: 'echo ask again'
  });
  assert.equal(reasked.decision, 'prompt');
  authz.recordDecision(projectDir, 'a1b2c3d4', 'call_reopen', 'deny');
  await assert.rejects(reasked.wait, { code: 'EDENIED' });

  settings.setProject(projectDir, {
    tools: { shell: { enabled: true, mode: 'allowlist', allowlist: ['npm test'] } }
  });
  const allowlisted = await authz.authorize({
    projectDir, chatId: 'a1b2c3d4', callId: 'call_list', tool: 'shell', cmd: 'npm test'
  });
  assert.equal(allowlisted.decision, 'allow');
  const partial = await authz.authorize({
    projectDir, chatId: 'a1b2c3d4', callId: 'call_partial', tool: 'shell', cmd: 'npm test -- --watch'
  });
  assert.equal(partial.decision, 'prompt', 'allowlist is a full-string match');
  authz.recordDecision(projectDir, 'a1b2c3d4', 'call_partial', 'deny');
  await assert.rejects(partial.wait, { code: 'EDENIED' });

  assert.equal(await authz.regexMatch('(a+)+$', 'a'.repeat(50000) + '!', 1), false);

  settings.setProject(projectDir, {
    tools: { file: { enabled: true, mode: 'allow' } }
  });
  for (const tool of ['read_file', 'list_files', 'search_files', 'write_file', 'edit_file']) {
    const allowed = await authz.authorize({
      projectDir, chatId: 'a1b2c3d4', callId: 'call_' + tool, tool, summary: 'README.md'
    });
    assert.equal(allowed.decision, 'allow', tool + ' must use the tools.file authorization gate');
  }

  settings.setProject(projectDir, { tools: { shell: { enabled: false, mode: 'ask', allowlist: ['^echo safe$'] } } });
  const legacyDisabled = await authz.authorize({
    projectDir, chatId: 'a1b2c3d4', callId: 'call_legacy_disabled', tool: 'shell', cmd: 'echo available'
  });
  assert.equal(legacyDisabled.decision, 'prompt', 'legacy enabled=false must not hide a base tool');
  authz.recordDecision(projectDir, 'a1b2c3d4', 'call_legacy_disabled', 'allow-always');
  await legacyDisabled.wait;
  const persisted = settings.getProject(projectDir).tools.shell;
  assert.equal(persisted.mode, 'allow', 'allow-always persists mode=allow');
  assert.deepEqual(persisted.allowlist, ['^echo safe$'], 'allow-always preserves the allowlist');
  const alwaysAllowed = await authz.authorize({
    projectDir, chatId: 'another1', callId: 'call_always', tool: 'shell', cmd: 'echo no prompt'
  });
  assert.equal(alwaysAllowed.decision, 'allow', 'persisted allow applies to another chat session');

  settings.setProject(projectDir, { tools: { shell: { mode: 'off' } } });
  await assert.rejects(
    authz.authorize({ projectDir, chatId: 'a1b2c3d4', callId: 'call_off', tool: 'shell', cmd: 'echo no' }),
    { code: 'ETOOL_DISABLED' }
  );

  console.log('tool authorization: 21 assertions passed');
}

main().finally(() => {
  settings.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});