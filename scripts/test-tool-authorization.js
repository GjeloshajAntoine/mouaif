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

  // ---- Layered MCP authorization (per-tool > per-server > shared) ----
  // A dedicated chat session keeps the MCP assertions hermetic —
  // earlier shell grants must not leak into MCP decisions.
  const mcpChat = 'mcp00001';
  settings.setProject(projectDir, {
    chats: [
      { id: 'a1b2c3d4', title: 'Auth test', trace: false },
      { id: mcpChat, title: 'MCP auth test', trace: false }
    ],
    tools: { shell: { mode: 'off' } }
  });

  // Shared fallback: ask.
  authz.setAuthorization(projectDir, { mcp: { mode: 'ask', allowlist: [] } });
  const mcpAsk = await authz.authorize({
    projectDir, chatId: mcpChat, callId: 'call_mcp_ask', tool: 'mcp__fs__read_file', summary: 'mcp__fs__read_file README.md'
  });
  assert.equal(mcpAsk.decision, 'prompt', 'shared MCP gate asks by default');
  authz.recordDecision(projectDir, mcpChat, 'call_mcp_ask', 'deny');
  await assert.rejects(mcpAsk.wait, { code: 'EDENIED' });

  // Per-server override: allow for one server, other servers still ask.
  authz.setAuthorization(projectDir, { mcp: { servers: { fs: { mode: 'allow' } } } });
  const mcpServerAllow = await authz.authorize({
    projectDir, chatId: mcpChat, callId: 'call_mcp_srv', tool: 'mcp__fs__read_file', summary: 'mcp__fs__read_file README.md'
  });
  assert.equal(mcpServerAllow.decision, 'allow', 'server override wins over the shared gate');
  const mcpOtherServer = await authz.authorize({
    projectDir, chatId: mcpChat, callId: 'call_mcp_other', tool: 'mcp__db__query', summary: 'mcp__db__query select 1'
  });
  assert.equal(mcpOtherServer.decision, 'prompt', 'other servers still use the shared gate');
  authz.recordDecision(projectDir, mcpChat, 'call_mcp_other', 'deny');
  await assert.rejects(mcpOtherServer.wait, { code: 'EDENIED' });

  // Per-tool override: off for one tool on an allowed server.
  authz.setAuthorization(projectDir, { mcp: { tools: { mcp__fs__write_file: { mode: 'off' } } } });
  await assert.rejects(
    authz.authorize({ projectDir, chatId: mcpChat, callId: 'call_mcp_tool_off', tool: 'mcp__fs__write_file', summary: 'mcp__fs__write_file a.txt' }),
    { code: 'ETOOL_DISABLED' },
    'tool override off beats the server allow'
  );
  // Removing the override (null) falls back to the server allow.
  authz.setAuthorization(projectDir, { mcp: { tools: { mcp__fs__write_file: null } } });
  const mcpToolInherit = await authz.authorize({
    projectDir, chatId: mcpChat, callId: 'call_mcp_tool_inh', tool: 'mcp__fs__write_file', summary: 'mcp__fs__write_file a.txt'
  });
  assert.equal(mcpToolInherit.decision, 'allow', 'cleared tool override falls back to the server gate');

  // "Always allow" on an MCP call pins THAT tool, not the shared gate.
  // Use a server with no override so the only way the call resolves is
  // through the shared ask gate.
  const mcpAlways = await authz.authorize({
    projectDir, chatId: mcpChat, callId: 'call_mcp_always', tool: 'mcp__db__query', summary: 'mcp__db__query delete from t'
  });
  assert.equal(mcpAlways.decision, 'prompt');
  authz.recordDecision(projectDir, mcpChat, 'call_mcp_always', 'allow-always');
  await mcpAlways.wait;
  const mcpCfg = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'));
  assert.equal(mcpCfg.authorization.tools.mcp__db__query.mode, 'allow', 'allow-always pins the called tool');
  assert.equal(mcpCfg.authorization.mode, 'ask', 'allow-always does NOT flip the shared gate');
  assert.equal(mcpCfg.authorization.servers.fs.mode, 'allow', 'server override preserved');

  // Shared off rejects everything MCP at the gate (defense-in-depth).
  // Use a tool with no per-tool override (allow-always pinned
  // mcp__db__query above, and the per-tool layer must win over off).
  authz.setAuthorization(projectDir, { mcp: { mode: 'off' } });
  await assert.rejects(
    authz.authorize({ projectDir, chatId: mcpChat, callId: 'call_mcp_off', tool: 'mcp__db__list_tables', summary: 'mcp__db__list_tables' }),
    { code: 'ETOOL_DISABLED' },
    'shared off rejects every MCP call'
  );
  // A per-tool allow beats the shared off.
  authz.setAuthorization(projectDir, { mcp: { tools: { mcp__db__list_tables: { mode: 'allow' } } } });
  const mcpToolBeatsOff = await authz.authorize({
    projectDir, chatId: mcpChat, callId: 'call_mcp_beat', tool: 'mcp__db__list_tables', summary: 'mcp__db__list_tables'
  });
  assert.equal(mcpToolBeatsOff.decision, 'allow', 'per-tool allow overrides the shared off');
  console.log('tool authorization: 32 assertions passed');
}

main().finally(() => {
  settings.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});