#!/usr/bin/env node
'use strict';

// Regression: a stdio MCP server that dies before the MCP handshake must
// report the child's own stderr, not just "Connection closed".
//
// The bug was that src/mcp.js buffered stderr on the session (with a comment
// promising it was "visible from /api/mcp/servers/:id for debugging") and then
// dropped it: startServer untracked the session on failure, so decorate() saw
// nothing, and the JSON-RPC error carried no child output. A `docker run`
// against a private or missing image — the documented OCI install path in
// docs/features/mcp-registry-browser.md — fails exactly this way, and the user
// saw `EMCP_START: ... Connection closed` with no mention of the pull failure.

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-stderr-home-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-stderr-proj-'));

const mcp = require('../src/mcp.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

// A minimal MCP server on stdio. `opts.mcpServer` answers initialize +
// tools/list so the start can succeed; otherwise the child just fails.
function writeFixture(name, lines, opts = {}) {
  const body = [];
  body.push("'use strict';");
  if (opts.log) body.push('process.stderr.write(' + JSON.stringify(opts.log) + ');');
  if (opts.mcpServer) {
    body.push("const readline = require('readline');");
    body.push("const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });");
    body.push("rl.on('line', (line) => {");
    body.push("  if (!line.trim()) return;");
    body.push("  let msg; try { msg = JSON.parse(line); } catch { return; }");
    body.push("  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');");
    body.push("  if (msg.method === 'initialize') reply({ protocolVersion: '2024-11-05', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } });");
    body.push("  else if (msg.method === 'tools/list') reply({ tools: [] });");
    body.push("  else if (msg.method === 'ping') reply({});");
    body.push("});");
  }
  for (const line of lines) body.push(line);
  const file = path.join(projectDir, name);
  fs.writeFileSync(file, body.join('\n') + '\n');
  return file;
}

async function main() {
  // 1) A failing start rejects and carries the child's stderr.
  const fixture = writeFixture('noisy-failure.js', [
    'process.stderr.write("docker: Error response from daemon: pull access denied for ghost/repo, repository does not exist\\n");',
    'process.stderr.write("See \'docker run --help\'.\\n");',
    'process.exit(1);'
  ]);
  const server = mcp.addServer(projectDir, {
    name: 'Noisy failure',
    command: process.execPath,
    args: [fixture]
  });

  let error = null;
  try {
    await mcp.startServer(projectDir, server.id);
  } catch (e) {
    error = e;
  }
  check('failed start rejects', !!error);
  check('failed start is EMCP_START', !!error && error.code === 'EMCP_START', error && error.code);
  check('failed start exposes stderr', !!(error && error.stderr && typeof error.stderr.text === 'string'),
    error ? JSON.stringify(error.stderr) : 'no error');
  check('stderr carries the child\'s own message',
    !!(error && error.stderr && /pull access denied/.test(error.stderr.text)),
    error && error.stderr && error.stderr.text);
  check('short stderr is not marked truncated',
    !!(error && error.stderr && error.stderr.truncated === false));

  // 2) The typed message alone must not be the whole story — the old
  //    behaviour was exactly "Connection closed" with no cause.
  check('error message does not pretend to know the cause',
    !!error && !/pull access denied/.test(error.message),
    error && error.message);

  // 3) A silent failure reports no stderr rather than an empty block, so the
  //    modal does not grow an empty "Server output" section.
  const quiet = writeFixture('quiet-failure.js', ['process.exit(1);']);
  const quietServer = mcp.addServer(projectDir, { name: 'Quiet failure', command: process.execPath, args: [quiet] });
  let quietError = null;
  try { await mcp.startServer(projectDir, quietServer.id); } catch (e) { quietError = e; }
  check('silent failure still rejects', !!quietError);
  check('silent failure carries no stderr field', !!(quietError && !quietError.stderr),
    quietError ? JSON.stringify(quietError.stderr) : 'no error');

  // 4) A healthy server shows no stderr on its decorated row either.
  const healthy = writeFixture('healthy.js', [], { mcpServer: true });
  const healthyServer = mcp.addServer(projectDir, { name: 'Healthy', command: process.execPath, args: [healthy] });
  await mcp.startServer(projectDir, healthyServer.id);
  const row = mcp.getServer(projectDir, healthyServer.id);
  check('healthy server is ready', !!row && row.status === 'ready', row && row.status);
  check('healthy server has no stderr field', !!(row && !row.stderr), row && JSON.stringify(row.stderr));

  // 5) A server that logs to stderr while running exposes it on the row, so a
  //    long-running complaint (an auth warning) is readable in Settings.
  const chatty = writeFixture('chatty.js', [], { mcpServer: true, log: 'warning: token expires soon\n' });
  const chattyServer = mcp.addServer(projectDir, { name: 'Chatty', command: process.execPath, args: [chatty] });
  await mcp.startServer(projectDir, chattyServer.id);
  const chattyRow = mcp.getServer(projectDir, chattyServer.id);
  check('running server exposes its stderr on the row',
    !!(chattyRow && chattyRow.stderr && /token expires soon/.test(chattyRow.stderr.text)),
    chattyRow && JSON.stringify(chattyRow.stderr));

  // 6) The cap is measured in characters and truncation is reported.
  const flood = writeFixture('flood.js', [
    'for (let i = 0; i < 4000; i++) process.stderr.write("x".repeat(64) + "\\n");',
    'process.exit(1);'
  ]);
  const floodServer = mcp.addServer(projectDir, { name: 'Flood', command: process.execPath, args: [flood] });
  let floodError = null;
  try { await mcp.startServer(projectDir, floodServer.id); } catch (e) { floodError = e; }
  const buffered = floodError && floodError.stderr && floodError.stderr.text ? floodError.stderr.text.length : 0;
  check('stderr buffer is capped at 16 KB', buffered > 0 && buffered <= 16 * 1024, 'buffered ' + buffered + ' chars');
  check('truncation is reported', !!(floodError && floodError.stderr && floodError.stderr.truncated === true),
    floodError && JSON.stringify(floodError.stderr && floodError.stderr.truncated));

  await mcp.stopAll();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  fs.rmSync(projectDir, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(2);
});