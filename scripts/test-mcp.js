'use strict';

// End-to-end smoke test for src/mcp.js. Spawns the test server at
// scripts/test-mcp-server.js, exercises add / list / start / call /
// stop, and prints a pass/fail summary. Exits non-zero on any failure.

const path = require('path');
const fs = require('fs');
const os = require('os');

const mcp = require('../src/mcp.js');
// Use a temp MOUAIF_HOME so the test never touches a real project file.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-test-'));
process.env.MOUAIF_HOME = TMP;

// Use a temp project directory; the test never writes to it other
// than what the mcp module writes to .mcp.json.
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-proj-'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

async function main() {
  const serverScript = path.join(__dirname, 'test-mcp-server.js');
  if (!fs.existsSync(serverScript)) {
    console.error('Missing test server script at ' + serverScript);
    process.exit(2);
  }

  // 1) Add a server entry. It should appear in the list with status
  //    'stopped'.
  let server;
  try {
    server = mcp.addServer(projectDir, {
      name: 'Test Server',
      command: process.execPath,
      args: [serverScript],
      env: {},
      enabled: true
    });
    check('addServer returns record', !!server && server.id && server.slug);
    check('addServer slug is "test_server"', server && server.slug === 'test_server', 'got: ' + (server && server.slug));
    check('addServer status is "stopped"', server && server.status === 'stopped');
  } catch (e) {
    check('addServer returns record', false, e.message);
    return;
  }

  // 2) listServers should include the new one.
  const listed = mcp.listServers(projectDir);
  check('listServers contains new server', listed.some(s => s.id === server.id));

  // 3) Start the server. It should transition to 'ready' and expose
  //    the test tool list.
  let started;
  try {
    started = await mcp.startServer(projectDir, server.id);
    check('startServer returns record', !!started && started.id === server.id);
    check('startServer status is "ready"', started && started.status === 'ready', 'got: ' + (started && started.status));
    check('startServer discovered 2 tools', started && Array.isArray(started.tools) && started.tools.length === 2, 'got: ' + (started && started.tools && started.tools.length));
    const echoTool = started && started.tools.find(t => t.name === 'echo');
    check('startServer discovered echo tool', !!echoTool);
  } catch (e) {
    check('startServer returns record', false, e.message);
    return;
  }

  // 4) listComposedToolSpecs should expose the mcp__<slug>__<name>
  //    names.
  const specs = mcp.listComposedToolSpecs(projectDir);
  check('listComposedToolSpecs has 2 entries', specs.length === 2, 'got: ' + specs.length);
  check('listComposedToolSpecs uses mcp__ prefix', specs.every(s => s.name.startsWith('mcp__')));
  check('listComposedToolSpecs carries serverSlug', specs.every(s => s.serverSlug === 'test_server'));
  const echoSpec = specs.find(s => s.toolName === 'echo');
  check('listComposedToolSpecs carries description', echoSpec && typeof echoSpec.description === 'string' && echoSpec.description.length > 0);

  // 5) callTool('echo') should return ok + content.
  let out;
  try {
    out = await mcp.callTool(projectDir, 'test_server', 'echo', { text: 'hello mcp' });
    check('callTool echo ok', out && out.ok === true);
    check('callTool echo content', out && Array.isArray(out.content) && out.content[0] && out.content[0].text === 'hello mcp');
  } catch (e) {
    check('callTool echo ok', false, e.message);
  }

  // 6) callTool('add', {a:2, b:40}) -> 42.
  try {
    out = await mcp.callTool(projectDir, 'test_server', 'add', { a: 2, b: 40 });
    check('callTool add ok', out && out.ok === true && out.content[0].text === '42', 'got: ' + (out && out.content[0].text));
  } catch (e) {
    check('callTool add ok', false, e.message);
  }

  // 7) callTool on a missing tool should throw EMCP_NOTFOUND.
  try {
    out = await mcp.callTool(projectDir, 'test_server', 'no_such_tool', {});
    check('callTool missing tool throws', false, 'expected throw, got: ' + JSON.stringify(out));
  } catch (e) {
    check('callTool missing tool throws', e && e.code === 'EMCP_NOTFOUND', 'got: ' + (e && e.code));
  }

  // 8) Update server: rename and disable.
  const updated = mcp.updateServer(projectDir, server.id, { name: 'Renamed' });
  check('updateServer renames', updated && updated.name === 'Renamed');
  check('updateServer stops running session', !mcp._sessions.has(projectDir + '::' + server.id));

  // 9) Remove server.
  const removed = mcp.removeServer(projectDir, server.id);
  check('removeServer returns true', removed === true);
  const after = mcp.listServers(projectDir);
  check('removeServer clears from list', !after.some(s => s.id === server.id));

  // 10) stopAll is a no-op when nothing is running.
  await mcp.stopAll();
  check('stopAll is idempotent', true);

  // 11) Settings persistence: re-reading the MCP project file should
  //     show servers = [] (we removed the only entry).
  const projectMcp = JSON.parse(fs.readFileSync(mcp.getMcpPath(projectDir), 'utf8'));
  check('settings mcp servers empty', Array.isArray(projectMcp.servers) && projectMcp.servers.length === 0);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  // Best-effort cleanup of the project dir; the temp MOUAIF_HOME is
  // also left behind for forensic value if a test failed.
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(2);
});
