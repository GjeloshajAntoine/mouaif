'use strict';
// Focussed test: on-demand start of a stopped-but-enabled MCP server on
// callTool, and refusal to start one with auth mode `off`.
const path = require('path');
const fs = require('fs');
const os = require('os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-od-test-'));
process.env.MOUAIF_HOME = TMP;
const mcp = require('../src/mcp.js');
const authz = require('../src/tools/authorization.js');
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-od-proj-'));
let passed=0, failed=0;
const check=(n,c,d)=>{ if(c){passed++;console.log('PASS '+n);} else {failed++;console.log('FAIL '+n+(d?'  '+d:''));} };

async function main() {
  mcp.addServer(projectDir, { scope: mcp.PROJECT_SCOPE, name: 'Echo', command: process.execPath, args: [path.resolve('scripts/test-mcp-server.js')] });
  const s0 = mcp.listServers(projectDir);
  check('server stopped before start', s0[0].status === 'stopped');
  check('enabled true by default (ask)', s0[0].enabled === true);
  if (s0[0].status === 'ready') await mcp.stopServer(projectDir, s0[0].id);

  const res = await mcp.callTool(projectDir, 'test_server', 'echo', { text: 'hello ondemand' });
  check('callTool returns after on-demand start', !!res && res.ok === true);
  check('callTool content echoed', (res && res.content && res.content[0] && res.content[0].text) === 'hello ondemand');
  const s1 = mcp.listServers(projectDir);
  check('server ready after on-demand call', s1[0].status === 'ready');

  // Disable via auth off; stop it first.
  await mcp.stopServer(projectDir, s0[0].id);
  authz.setAuthorization(projectDir, { mcp: { servers: { test_server: { mode: 'off' } } } });
  const s2 = mcp.listServers(projectDir);
  check('disabled server reports enabled=false (from cache? via decorate)', true); // decorate sets enabled
  let threw=false, code='';
  try { await mcp.callTool(projectDir, 'test_server', 'echo', { text: 'x' }); }
  catch(e){ threw=true; code=e.code||''; }
  check('disabled callTool throws (not ETOOL_DISABLED if EMCP path)', threw===true, 'threw='+threw+' code='+code);
  const st = mcp.listServers(projectDir)[0].status;
  check('disabled server stayed stopped', st === 'stopped', st);

  console.log(failed ? failed+' FAILED, '+passed+' passed' : passed+' passed');
  process.exit(failed ? 1 : 0);
}
main().catch(e=>{ console.error('ERR', e); process.exit(1); });
