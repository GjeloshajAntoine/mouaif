'use strict';

// Regression: an MCP server that exits while a tools/call is in flight
// must fail that call promptly with a transport error, not hang until
// the 60 s request timeout. The bug was src/mcp.js overwriting the SDK's
// transport.onclose (which rejects pending requests) instead of chaining
// it. Also checks the session is marked errored and that the next call
// transparently restarts the server.

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-crash-home-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-crash-proj-'));

const settings = require('../src/settings.js');
const mcp = require('../src/mcp.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

async function main() {
  const server = mcp.addServer(projectDir, {
    name: 'Crash',
    command: process.execPath,
    args: [path.join(__dirname, 'test-mcp-crash-server.js')]
  });
  await mcp.startServer(projectDir, server.id);
  check('server ready', mcp.getServer(projectDir, server.id).status === 'ready');

  const started = Date.now();
  let error = null;
  try {
    await mcp.callTool(projectDir, 'crash', 'die', {});
  } catch (e) {
    error = e;
  }
  const elapsed = Date.now() - started;
  check('crash mid-call rejects', !!error);
  check('crash mid-call fails fast (< 5 s)', elapsed < 5000, 'took ' + elapsed + ' ms');
  check('crash mid-call reports a closed connection, not a timeout',
    !!error && /closed/i.test(error.message) && !/timed out/i.test(error.message),
    error && error.message);

  const after = mcp.getServer(projectDir, server.id);
  check('session marked errored', after.status === 'errored', 'status: ' + after.status);
  check('session error is EMCP_TRANSPORT', after.error && after.error.code === 'EMCP_TRANSPORT');

  let out = null;
  try { out = await mcp.callTool(projectDir, 'crash', 'echo', { text: 'back' }); } catch (e) { out = { error: e }; }
  check('next call restarts the server', out && out.ok === true && out.content[0].text === 'back',
    JSON.stringify(out && (out.error ? out.error.message : out)));

  await mcp.stopAll();
  settings.close();
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(2);
});
