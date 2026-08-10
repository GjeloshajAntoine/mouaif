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

// Register a server whose id diverges from its slug so the write-path
// normalization (id-keyed overrides stored under the canonical slug) is
// exercised. addServer slugifies the name, so name "srv-display" yields
// slug "srv_display" while a caller-provided id can stay hyphenated.
const added = require('../src/mcp.js').addServer(projectDir, { name: 'srv-display', command: 'node', args: [] });
// addServer generates the id; the diverging pair is { id: added.id, slug: 'srv_display' }.
const divergingServerId = added.id;
assert.equal(added.slug, 'srv_display', 'test setup: slug is derived from the name');

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

  // The settings parent checkbox writes the family and all leaves in one
  // request. Every entry must survive the write loop so the UI cannot fall
  // into a stale mixed state after the response is re-read.
  authz.setAuthorization(projectDir, {
    tools: Object.fromEntries(['file', ...authz.FILE_TOOL_NAMES].map((name) => [name, { mode: 'off' }]))
  });
  const fileAuth = authz.getAuthorization(projectDir).tools;
  for (const tool of ['file', ...authz.FILE_TOOL_NAMES]) {
    assert.equal(fileAuth[tool].mode, 'off', tool + ' must persist in an atomic file-group update');
  }
  authz.setAuthorization(projectDir, {
    tools: Object.fromEntries(['file', ...authz.FILE_TOOL_NAMES].map((name) => [name, { mode: 'allow' }]))
  });

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

  // ---- Structured payload channel (model override for subagent) ----
  // The authorization gate is payload-agnostic: the chat UI attaches an
  // opaque `payload` object (here a per-run model override) and the
  // decision resolves the wait with the same object so the AI runner can
  // read it. Same contract the ask_user card uses for { choice, extra }.
  settings.setProject(projectDir, { tools: { subagent: { mode: 'ask' } } });
  const subAsk = await authz.authorize({
    projectDir, chatId: 'a1b2c3d4', callId: 'call_sub_model', tool: 'subagent', summary: 'review the diff'
  });
  assert.equal(subAsk.decision, 'prompt', 'subagent asks by default');
  let subPayload = null;
  subAsk.wait.then((resolved) => { subPayload = resolved; });
  authz.recordDecision(projectDir, 'a1b2c3d4', 'call_sub_model', 'allow-once', {
    modelOverride: { providerId: 'anthropic', modelId: 'claude-sonnet-4' }
  });
  await subAsk.wait;
  assert.ok(subPayload && subPayload.decision === 'allow', 'payload resolves with decision allow');
  assert.deepEqual(
    subPayload.payload && subPayload.payload.modelOverride,
    { providerId: 'anthropic', modelId: 'claude-sonnet-4' },
    'decision payload carries the model override to the runner'
  );

  settings.setProject(projectDir, { tools: { report_progress: { mode: 'allow' } } });
  const progressAllowed = await authz.authorize({
    projectDir, chatId: 'a1b2c3d4', callId: 'call_progress', tool: 'report_progress', summary: 'Build 50%'
  });
  assert.equal(progressAllowed.decision, 'allow', 'report_progress is configurable as a native tool');
  settings.setProject(projectDir, { tools: { report_progress: { mode: 'off' } } });
  await assert.rejects(
    authz.authorize({ projectDir, chatId: 'a1b2c3d4', callId: 'call_progress_off', tool: 'report_progress', summary: 'Build 50%' }),
    { code: 'ETOOL_DISABLED' },
    'report_progress can be hidden by authorization mode'
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

  // Id-keyed server override write: when a registered server's slug and
  // display id diverge, an override keyed by the id must persist (stored
  // under the canonical slug), not be deleted by the write-path cleanup.
  // The MCP registry holds { id: divergingServerId, slug: 'srv_display' }.
  authz.setAuthorization(projectDir, { mcp: { servers: { [divergingServerId]: { mode: 'off' } } } });
  const idKeyed = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'));
  assert.ok(!(divergingServerId in idKeyed.authorization.servers), 'id-keyed write stores the slug, not the id');
  assert.equal(idKeyed.authorization.servers.srv_display.mode, 'off', 'id-keyed write persists under the slug');
  const idKeyedGet = authz.getAuthorization(projectDir);
  assert.equal(idKeyedGet.mcp.servers.srv_display.mode, 'off', 'id-keyed write is visible on read');
  // A second write must not delete the first (the regression: the
  // id-keyed cleanup used to remove the just-written slug entry).
  authz.setAuthorization(projectDir, { mcp: { servers: { [divergingServerId]: { mode: 'allow' } } } });
  const idKeyedRewrite = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'));
  assert.equal(idKeyedRewrite.authorization.servers.srv_display.mode, 'allow', 'id-keyed rewrite persists under the slug');
  // Clearing by id removes the slug entry too.
  authz.setAuthorization(projectDir, { mcp: { servers: { [divergingServerId]: null } } });
  const idKeyedCleared = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'));
  assert.ok(!('srv_display' in (idKeyedCleared.authorization.servers || {})), 'clear by id removes the slug entry');
  console.log('tool authorization: ' + (35 + 4 + 5) + ' assertions passed');
}

main().finally(() => {
  settings.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});