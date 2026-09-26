'use strict';

// Provider-safe MCP tool names. OpenAI-shaped APIs reject any function
// name outside ^[a-zA-Z0-9_-]{1,64}$ and fail the whole request, so
// composedToolName must sanitize raw MCP names (dots, slashes, length)
// while leaving already-valid names untouched, and callTool must map the
// sanitized name back to the raw one the server advertised.

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-names-home-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-names-proj-'));

const settings = require('../src/settings.js');
const mcp = require('../src/mcp.js');

const VALID = /^[a-zA-Z0-9_-]{1,64}$/;
const LONG = 'some.dotted/tool_with_a_rather_long_name_that_keeps_going_and_going';
const SLUG_48 = 'a'.repeat(48);

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

async function main() {
  // Pure naming rules.
  check('valid name passes through unchanged', mcp.composedToolName('fs', 'read_file') === 'mcp__fs__read_file');
  const dotted = mcp.composedToolName('probe', 'a.b');
  check('dotted name is provider-valid', VALID.test(dotted), dotted);
  check('dotted name keeps its prefix', dotted.startsWith('mcp__probe__'), dotted);
  check('a.b and a_b do not collide', dotted !== mcp.composedToolName('probe', 'a_b'));
  const long = mcp.composedToolName('probe', LONG);
  check('long name fits 64 chars', VALID.test(long), long + ' (' + long.length + ')');
  const maxSlug = mcp.composedToolName(SLUG_48, LONG);
  check('48-char slug + long name still valid', VALID.test(maxSlug), maxSlug + ' (' + maxSlug.length + ')');
  check('sanitizing is deterministic', mcp.composedToolName('probe', LONG) === long);
  check('sanitizing is idempotent',
    mcp.composedToolName('probe', long.slice('mcp__probe__'.length)) === long);
  check('parse round-trips the sanitized name',
    (mcp.parseServerSlugAndToolName(long) || {}).serverSlug === 'probe');

  // End to end: a server whose tool names need sanitizing.
  const server = mcp.addServer(projectDir, {
    name: 'Probe',
    command: process.execPath,
    args: [path.join(__dirname, 'test-mcp-names-server.js')]
  });
  const started = await mcp.startServer(projectDir, server.id);
  const specs = mcp.listComposedToolSpecs(projectDir);
  check('every advertised spec is provider-valid', specs.length === 3 && specs.every(s => VALID.test(s.name)),
    specs.map(s => s.name).join(', '));
  check('specs keep the raw MCP name in toolName', specs.some(s => s.toolName === LONG));
  check('server tools expose composedName',
    started.tools.every(t => t.composedName === mcp.composedToolName('probe', t.name)));

  // Dispatch the way src/ai-stream.js does: parse the model-facing name.
  for (const spec of specs) {
    const parsed = mcp.parseServerSlugAndToolName(spec.name);
    let out;
    try { out = await mcp.callTool(projectDir, parsed.serverSlug, parsed.toolName, {}); }
    catch (e) { out = { error: e }; }
    check('model-facing name reaches raw tool ' + spec.toolName,
      out && out.ok === true && out.content[0].text === 'called:' + spec.toolName,
      JSON.stringify(out && (out.error ? out.error.message : out.content)));
  }
  // Direct REST / custom actions pass the raw name.
  const direct = await mcp.callTool(projectDir, 'probe', LONG, {});
  check('raw name still dispatches', direct.ok && direct.content[0].text === 'called:' + LONG);

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
