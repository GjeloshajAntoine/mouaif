'use strict';

// Offline tests for src/agents.js — the subagent-persona store.
// Covers: name validation, create/read/update/remove, immutability of
// the name, tool-allowlist normalization, the 64 KiB cap, and the
// legacy `agentPresets` -> `agents` migration read.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agents = require('../src/agents.js');

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-agents-'));
  return dir;
}

function readProject(dir) {
  const p = path.join(dir, '.mouaif.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

let passed = 0;
function ok(cond, msg) { assert(cond, msg); passed++; }

// ---- Name validation ----------------------------------------------------
ok(agents.isValidName('reviewer'), 'plain name valid');
ok(agents.isValidName('a.b_c-d'), 'dotted/dashed name valid');
ok(!agents.isValidName(''), 'empty name invalid');
ok(!agents.isValidName('.hidden'), 'leading dot invalid');
ok(!agents.isValidName('-x'), 'leading dash invalid');
ok(!agents.isValidName('a b'), 'space invalid');
ok(!agents.isValidName('x'.repeat(65)), 'too long invalid');

// ---- Create + read --------------------------------------------------------
{
  const dir = tmpProject();
  const a = agents.create(dir, { name: 'reviewer', content: 'Review carefully.', tools: ['read_file', 'search_files'] });
  ok(a && a.name === 'reviewer', 'create returns the agent');
  ok(a.content === 'Review carefully.', 'create stores content');
  ok(Array.isArray(a.tools) && a.tools.length === 2, 'create stores tools');
  const list = agents.list(dir);
  ok(list.length === 1 && list[0].name === 'reviewer', 'list returns created agent');
  const one = agents.get(dir, 'reviewer');
  ok(one && one.content === 'Review carefully.', 'get returns the agent');
  ok(agents.get(dir, 'nope') === null, 'get unknown returns null');
}

// ---- Duplicate / invalid create -----------------------------------------
{
  const dir = tmpProject();
  agents.create(dir, { name: 'reviewer', content: 'x' });
  assert.throws(() => agents.create(dir, { name: 'reviewer', content: 'y' }), /already exists/);
  passed++;
  assert.throws(() => agents.create(dir, { name: 'bad name', content: 'y' }), /name is required|must match/);
  passed++;
}

// ---- Update: name immutable, content + tools patchable -------------------
{
  const dir = tmpProject();
  agents.create(dir, { name: 'reviewer', content: 'v1', tools: ['read_file'] });
  const updated = agents.update(dir, 'reviewer', { content: 'v2', name: 'hacked' });
  ok(updated && updated.name === 'reviewer', 'update keeps the name immutable');
  ok(updated.content === 'v2', 'update patches content');
  ok(Array.isArray(updated.tools) && updated.tools[0] === 'read_file', 'update keeps tools when not patched');
  const cleared = agents.update(dir, 'reviewer', { tools: [] });
  ok(cleared.tools === undefined, 'empty tools array collapses to inherit (undefined)');
  ok(agents.update(dir, 'ghost', { content: 'x' }) === null, 'update unknown returns null');
}

// ---- Tool allowlist normalization ----------------------------------------
{
  const dir = tmpProject();
  const a = agents.create(dir, { name: 'toolsy', content: 'x', tools: [' read_file ', '', 'shell'] });
  ok(a.tools.length === 2 && a.tools[0] === 'read_file' && a.tools[1] === 'shell', 'tools trimmed and empties dropped');
}

// ---- 64 KiB cap ------------------------------------------------------------
{
  const dir = tmpProject();
  const big = 'a'.repeat(70 * 1024);
  const a = agents.create(dir, { name: 'big', content: big });
  ok(Buffer.byteLength(a.content, 'utf8') <= agents.MAX_BYTES + 64, 'content capped near 64 KiB');
  ok(/truncated/.test(a.content), 'truncation note appended');
}

// ---- Remove -----------------------------------------------------------------
{
  const dir = tmpProject();
  agents.create(dir, { name: 'reviewer', content: 'x' });
  ok(agents.remove(dir, 'reviewer') === true, 'remove returns true');
  ok(agents.list(dir).length === 0, 'list empty after remove');
  ok(agents.remove(dir, 'reviewer') === false, 'remove unknown returns false');
}

// ---- Legacy migration: agentPresets -> agents ------------------------------
{
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, '.mouaif.json'), JSON.stringify({
    agentPresets: [
      { id: 'reviewer', title: 'Reviewer', content: 'Review.', tools: ['read_file'], modelId: 'gpt-x', promptSize: 'average', agentFiles: true }
    ]
  }), 'utf8');
  const list = agents.list(dir);
  ok(list.length === 1, 'legacy list read');
  ok(list[0].name === 'reviewer', 'legacy id becomes name');
  ok(list[0].content === 'Review.', 'legacy content preserved');
  ok(list[0].modelId === undefined && list[0].promptSize === undefined && list[0].agentFiles === undefined && list[0].title === undefined, 'legacy extra fields dropped');
  // First write drops the legacy key.
  agents.update(dir, 'reviewer', { content: 'v2' });
  const raw = readProject(dir);
  ok(Array.isArray(raw.agents), 'write stores under agents');
  ok(raw.agentPresets === undefined, 'legacy key dropped on write');
}

console.log('test-agents: ' + passed + ' assertions passed');
