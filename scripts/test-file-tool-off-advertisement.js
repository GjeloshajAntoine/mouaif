'use strict';

// Test: a per-leaf file-tool `off` override actually hides that operation
// from the model, not just from execution.
//
// The bug this locks down: the advertised-tool gate in src/ai-stream.js
// (and its mirror in src/server-handlers-chats.js) only inspected the
// `file` FAMILY mode. A project could set `tools.file.mode = "allow"` and
// `tools.read_file.mode = "off"`; `authorize()` then rejected read_file at
// execution time with ETOOL_DISABLED, but the spec was still sent upstream
// on every request — the model paid prompt tokens for a tool it could
// never call, and `list_files` / `search_files` / `write_file` / `edit_file`
// stayed advertised while read_file vanished from the UI's toggle row.
//
// The assertions below run the exact per-leaf loop the stream now runs, in
// both directions: a leaf `off` drops exactly that operation, and a
// family-level `off` still drops every leaf.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-file-off-home-'));
process.env.MOUAIF_HOME = HOME;

const authz = require('../src/tools/authorization.js');
const settings = require('../src/settings.js');
const files = require('../src/tools/files.js');

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-file-off-proj-'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

// The exact advertisement gate src/ai-stream.js runs over the collected
// tool specs: the family loop first, then the per-leaf file loop, then the
// MCP loop. Collecting only file + shell specs keeps the assertion focused.
function advertise(specs, dir) {
  const out = specs.slice();
  const authState = authz.getAuthorization(dir);
  for (const family of ['shell', 'subagent', 'file', 'ask_user', 'report_progress', 'task', 'webpreview', 'restart_app']) {
    const cfg = authState.tools[family];
    if (cfg && cfg.mode === 'off') {
      const hidden = family === 'file' ? authz.FILE_FAMILY_TOOLS : new Set([family]);
      for (let i = out.length - 1; i >= 0; i--) {
        const spec = out[i];
        if (spec && spec.function && hidden.has(spec.function.name)) out.splice(i, 1);
      }
    }
  }
  for (let i = out.length - 1; i >= 0; i--) {
    const spec = out[i];
    if (!spec || !spec.function || !authz.FILE_FAMILY_TOOLS.has(spec.function.name)) continue;
    const cfg = authz.effectiveConfig(dir, spec.function.name);
    if (cfg && cfg.mode === 'off') out.splice(i, 1);
  }
  return out.map((s) => s.function.name);
}

function spec(name) {
  return { type: 'function', function: { name, description: '', parameters: { type: 'object' } } };
}

const COLLECTED = [
  spec('shell'),
  ...Array.from(files.FILE_TOOL_NAMES).map(spec)
];

function writeProject(tools) {
  settings.setProject(projectDir, { tools });
}

function main() {
  // ---- 1. Family allow + one leaf off ---------------------------------
  writeProject({ file: { mode: 'allow' }, read_file: { mode: 'off' } });

  const readCfg = authz.effectiveConfig(projectDir, 'read_file');
  check('leaf off resolves to off', readCfg.mode === 'off', 'mode = ' + readCfg.mode);
  check('leaf off is sourced from the project leaf', readCfg.source === 'project-tool',
    'source = ' + readCfg.source);

  const advertised = advertise(COLLECTED, projectDir);
  check('the disabled leaf is hidden from the model', !advertised.includes('read_file'),
    'advertised: ' + advertised.join(', '));
  check('sibling file tools stay advertised', advertised.includes('write_file') && advertised.includes('search_files'),
    'advertised: ' + advertised.join(', '));
  check('shell is untouched', advertised.includes('shell'), 'advertised: ' + advertised.join(', '));
  check('exactly one spec was dropped', advertised.length === COLLECTED.length - 1,
    'dropped ' + (COLLECTED.length - advertised.length));

  // ---- 2. Every leaf off, family still allow --------------------------
  writeProject(Object.assign(
    { file: { mode: 'allow' } },
    Object.fromEntries(Array.from(files.FILE_TOOL_NAMES, (n) => [n, { mode: 'off' }]))
  ));
  const allOff = advertise(COLLECTED, projectDir);
  check('every leaf off hides every file tool',
    Array.from(files.FILE_TOOL_NAMES).every((n) => !allOff.includes(n)),
    'advertised: ' + allOff.join(', '));
  check('shell survives when only file leaves are off', allOff.includes('shell'),
    'advertised: ' + allOff.join(', '));

  // ---- 3. Family-level off still hides all leaves ---------------------
  writeProject({ file: { mode: 'off' } });
  const familyOff = advertise(COLLECTED, projectDir);
  check('family off hides every file tool',
    Array.from(files.FILE_TOOL_NAMES).every((n) => !familyOff.includes(n)),
    'advertised: ' + familyOff.join(', '));

  // ---- 4. No override keeps the whole family advertised ---------------
  // The guard against the opposite failure: the per-leaf loop must not
  // strip tools that carry no `off` at all.
  writeProject({});
  const defaults = advertise(COLLECTED, projectDir);
  check('default mode advertises every file tool',
    Array.from(files.FILE_TOOL_NAMES).every((n) => defaults.includes(n)),
    'advertised: ' + defaults.join(', '));
}

try {
  main();
} catch (error) {
  failed++;
  console.log('FAIL  unexpected error -- ' + (error && error.message ? error.message : error));
} finally {
  
console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  try { settings.close(); } catch { /* already closed */ }
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
