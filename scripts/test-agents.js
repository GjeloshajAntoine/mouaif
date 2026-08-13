'use strict';

// Offline tests for src/agents.js — the subagent-persona store.
// Covers: name validation, create/read/update/remove, rename via update,
// tool-allowlist normalization, the 64 KiB cap, and the legacy
// `agentPresets` -> `agents` migration read.

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

// ---- Update: rename, content + tools patchable ---------------------------
{
  const dir = tmpProject();
  agents.create(dir, { name: 'reviewer', content: 'v1', tools: ['read_file'] });
  const updated = agents.update(dir, 'reviewer', { content: 'v2', name: 'auditor' });
  ok(updated && updated.name === 'auditor', 'update renames the agent');
  ok(updated.content === 'v2', 'update patches content');
  ok(Array.isArray(updated.tools) && updated.tools[0] === 'read_file', 'update keeps tools when not patched');
  ok(agents.get(dir, 'reviewer') === null, 'old name no longer resolves');
  ok(agents.get(dir, 'auditor') && agents.get(dir, 'auditor').content === 'v2', 'new name resolves');
  const cleared = agents.update(dir, 'auditor', { tools: [] });
  ok(cleared.tools === undefined, 'empty tools array collapses to inherit (undefined)');
  ok(agents.update(dir, 'ghost', { content: 'x' }) === null, 'update unknown returns null');
  // Rename validation: empty, invalid, and duplicate names are rejected.
  agents.create(dir, { name: 'other', content: 'x' });
  assert.throws(() => agents.update(dir, 'auditor', { name: '' }), /must match/);
  passed++;
  assert.throws(() => agents.update(dir, 'auditor', { name: 'bad name' }), /must match/);
  passed++;
  assert.throws(() => agents.update(dir, 'auditor', { name: 'other' }), /already exists/);
  passed++;
  // Renaming to the same name is a no-op, not a duplicate error.
  const same = agents.update(dir, 'auditor', { name: 'auditor' });
  ok(same && same.name === 'auditor', 'rename to self is a no-op');
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
  ok(list[0].modelId === 'gpt-x', 'legacy modelId survives as the model pin');
  ok(list[0].promptSize === undefined && list[0].agentFiles === undefined && list[0].title === undefined, 'legacy extra fields dropped');
  // First write drops the legacy key.
  agents.update(dir, 'reviewer', { content: 'v2' });
  const raw = readProject(dir);
  ok(Array.isArray(raw.agents), 'write stores under agents');
  ok(raw.agentPresets === undefined, 'legacy key dropped on write');
}

// ---- modelId: create, patch, clear, resolve --------------------------------
{
  const dir = tmpProject();
  // Seed two project models in .mouaif.json so resolveModel can find one.
  fs.writeFileSync(path.join(dir, '.mouaif.json'), JSON.stringify({
    models: [
      { id: 'small', provider: 'openai-compatible', label: 'Small' },
      { id: 'big', provider: 'anthropic', label: 'Big' }
    ]
  }), 'utf8');
  const a = agents.create(dir, { name: 'pinned', content: 'x', modelId: 'small', providerId: 'openai-compatible' });
  ok(a.modelId === 'small' && a.providerId === 'openai-compatible', 'create stores the provider-qualified model pin');
  const b = agents.create(dir, { name: 'plain', content: 'x' });
  ok(b.modelId === undefined, 'create without modelId leaves it unset');
  const patched = agents.update(dir, 'pinned', { modelId: 'big', providerId: 'anthropic' });
  ok(patched.modelId === 'big' && patched.providerId === 'anthropic', 'update patches the provider-qualified model pin');
  const cleared = agents.update(dir, 'pinned', { modelId: '' });
  ok(cleared.modelId === undefined && cleared.providerId === undefined, 'empty modelId clears the provider-qualified pin');
  // resolveModel: null when unpinned, record when pinned, throw on unknown.
  ok(agents.resolveModel(dir, agents.get(dir, 'plain')) === null, 'resolveModel returns null when unpinned');
  agents.update(dir, 'pinned', { modelId: 'big', providerId: 'anthropic' });
  const rec = agents.resolveModel(dir, agents.get(dir, 'pinned'));
  ok(rec && rec.id === 'big' && rec.provider === 'anthropic', 'resolveModel returns the project model record');
  agents.update(dir, 'pinned', { modelId: 'ghost', providerId: '' });
  assert.throws(() => agents.resolveModel(dir, agents.get(dir, 'pinned')), /unknown model/i);
  agents.update(dir, 'pinned', { modelId: 'live/model', providerId: 'openrouter' });
  const liveRec = agents.resolveModel(dir, agents.get(dir, 'pinned'));
  ok(liveRec.id === 'live/model' && liveRec.provider === 'openrouter', 'provider-qualified live model resolves without a project record');
  passed++;
}

console.log('test-agents: ' + passed + ' assertions passed');
