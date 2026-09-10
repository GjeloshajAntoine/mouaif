'use strict';

// Test: per-project MCP authorization actually gates the advertised tools.
//
// The bug this locks down: `effectiveConfig` and `mcpLayeredConfig` were
// defined in src/tools/authorization.js but never added to `module.exports`.
// Three call sites reach them through the module object —
// src/ai-stream.js (report_progress `off` gate and the MCP tool-hiding loop)
// and src/server-handlers-chats.js (the tools-list endpoint) — and every one
// of them threw `TypeError: authz.effectiveConfig is not a function`. Each
// call sits inside a `catch {}` that is documented as "authorization state
// unreadable; keep every tool advertised", so the failure was silent:
//
//   - a project could set `.mcp.json` →
//     `authorization.servers.<slug>.mode = "off"` and the server's tools were
//     still sent on every request, spending prompt tokens on tools the user
//     had explicitly disabled, and
//   - `report_progress` could not be disabled by its `off` gate.
//
// The assertions below cover the export itself, the layered resolution
// (per-tool over the per-server entry), and the guard against the opposite
// failure — filtering tools that carry no override at all.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-authz-home-'));
process.env.MOUAIF_HOME = HOME;

const authz = require('../src/tools/authorization.js');
const settings = require('../src/settings.js');

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-authz-proj-'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

// The exact loop src/ai-stream.js runs over the collected MCP specs.
function applyMcpOffGate(specs, dir) {
  const out = specs.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const spec = out[i];
    if (!spec || !spec.function || !String(spec.function.name).startsWith('mcp__')) continue;
    const cfg = authz.effectiveConfig(dir, spec.function.name);
    if (cfg && cfg.mode === 'off') out.splice(i, 1);
  }
  return out;
}

function spec(name) {
  return { type: 'function', function: { name, description: '', parameters: { type: 'object' } } };
}

const SPECS = [
  spec('shell'),
  spec('report_progress'),
  spec('mcp__git__git_status'),
  spec('mcp__git__git_log'),
  spec('mcp__chrome_debug__click'),
  spec('mcp__unconfigured__thing')
];

function writeMcpFile(authorization) {
  fs.writeFileSync(
    path.join(projectDir, '.mcp.json'),
    JSON.stringify({ servers: [], authorization }, null, 2)
  );
}

function main() {
  // ---- 1. The export itself ------------------------------------------
  check('effectiveConfig is exported', typeof authz.effectiveConfig === 'function',
    'typeof = ' + typeof authz.effectiveConfig);
  check('mcpLayeredConfig is exported', typeof authz.mcpLayeredConfig === 'function',
    'typeof = ' + typeof authz.mcpLayeredConfig);

  // ---- 2. A per-server `off` hides exactly that server's tools -------
  writeMcpFile({
    mode: 'ask',
    servers: { git: { mode: 'off' }, chrome_debug: { mode: 'allow' } }
  });

  const gitCfg = authz.effectiveConfig(projectDir, 'mcp__git__git_status');
  check('server off resolves to off', gitCfg.mode === 'off', 'mode = ' + gitCfg.mode);
  check('server off is sourced from the project', gitCfg.source === 'project-server',
    'source = ' + gitCfg.source);

  const chromeCfg = authz.effectiveConfig(projectDir, 'mcp__chrome_debug__click');
  check('server allow resolves to allow', chromeCfg.mode === 'allow', 'mode = ' + chromeCfg.mode);

  // No override at all must NOT resolve to `off`, or the gate would strip
  // every MCP tool the moment the export started working.
  const plainCfg = authz.effectiveConfig(projectDir, 'mcp__unconfigured__thing');
  check('unconfigured server does not resolve to off', plainCfg.mode !== 'off',
    'mode = ' + plainCfg.mode);

  const kept = applyMcpOffGate(SPECS, projectDir).map((s) => s.function.name);
  check('git tools are dropped from the advertised surface',
    !kept.includes('mcp__git__git_status') && !kept.includes('mcp__git__git_log'),
    'kept: ' + kept.join(', '));
  check('chrome_debug tools survive',
    kept.includes('mcp__chrome_debug__click'), 'kept: ' + kept.join(', '));
  check('unconfigured MCP tools survive',
    kept.includes('mcp__unconfigured__thing'), 'kept: ' + kept.join(', '));
  check('native tools are never touched by the MCP gate',
    kept.includes('shell') && kept.includes('report_progress'), 'kept: ' + kept.join(', '));
  check('exactly two specs were dropped', kept.length === SPECS.length - 2,
    'dropped ' + (SPECS.length - kept.length));

  // ---- 3. A per-tool entry outranks the per-server entry -------------
  writeMcpFile({
    mode: 'ask',
    servers: { git: { mode: 'off' }, chrome_debug: { mode: 'allow' } },
    tools: { 'mcp__git__git_log': { mode: 'allow' } }
  });

  const toolCfg = authz.effectiveConfig(projectDir, 'mcp__git__git_log');
  check('per-tool allow outranks per-server off', toolCfg.mode === 'allow',
    'mode = ' + toolCfg.mode + ', source = ' + toolCfg.source);
  check('per-tool override is sourced from the project', toolCfg.source === 'project-tool',
    'source = ' + toolCfg.source);

  const siblingCfg = authz.effectiveConfig(projectDir, 'mcp__git__git_status');
  check('sibling tools stay off under the per-server entry', siblingCfg.mode === 'off',
    'mode = ' + siblingCfg.mode);

  const kept2 = applyMcpOffGate(SPECS, projectDir).map((s) => s.function.name);
  check('the re-enabled tool is advertised again', kept2.includes('mcp__git__git_log'),
    'kept: ' + kept2.join(', '));
  check('the still-off sibling is dropped', !kept2.includes('mcp__git__git_status'),
    'kept: ' + kept2.join(', '));

  // ---- 4. An unreadable config keeps every tool advertised -----------
  // The documented fallback for the surrounding catch must still hold: a
  // genuinely broken project file must not silently disable the model's
  // whole MCP surface.
  fs.writeFileSync(path.join(projectDir, '.mcp.json'), '{ not json');
  const brokenCfg = authz.effectiveConfig(projectDir, 'mcp__git__git_status');
  check('unreadable .mcp.json does not resolve to off', brokenCfg.mode !== 'off',
    'mode = ' + brokenCfg.mode);
}

try {
  main();
} catch (error) {
  // A regression that removes the export again makes every
  // `authz.effectiveConfig(...)` call above throw. Report it as a failure
  // instead of letting the stack trace escape, so the summary line and the
  // exit code stay meaningful.
  failed++;
  console.log('FAIL  unexpected error -- ' + (error && error.message ? error.message : error));
} finally {
  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  try { settings.close(); } catch { /* already closed */ }
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
