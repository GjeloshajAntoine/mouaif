'use strict';

// The content write path (src/content/service.js) and its policy table
// (src/content/policy.js): one case per cell of the table, plus the change
// list, dry runs, secret carry-over and the content_changed event.
//
// Run: node scripts/test-content-service.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-service-home-'));
const ROOT = path.join(__dirname, '..');
const settings = require(path.join(ROOT, 'src/settings.js'));
const service = require(path.join(ROOT, 'src/content/service.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   - ' + name); }
  catch (err) { fail++; console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]); }
}

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-service-project-'));
const app = (patch, actor, extra = {}) => service.applyPatch({ scope: 'app', patch, actor, ...extra });
const project = (patch, actor, extra = {}) => service.applyPatch({ scope: 'project', projectDir: proj, patch, actor, ...extra });
const refused = (fn, re) => assert.throws(fn, (e) => (re ? re.test(e.message) : true) && !!e.code);

// ---- Policy cells --------------------------------------------------------

check('app, clientVisible: ui writes', () => {
  app({ promptSize: 'chat' }, 'ui');
  assert.equal(settings.getApp().promptSize, 'chat');
});
check('app, clientVisible: tool writes', () => {
  app({ autoRetry: false }, 'tool');
  assert.equal(settings.getApp().autoRetry, false);
});
check('app, clientVisible: share is refused', () => {
  refused(() => app({ promptSize: 'average' }, 'share'), /shared project/);
  refused(() => app({ promptSize: 'average' }, 'tool', { remote: true }), /shared project/);
  assert.equal(settings.getApp().promptSize, 'chat');
});
check('app, not clientVisible: refused for every actor', () => {
  for (const actor of ['ui', 'tool', 'share']) {
    refused(() => app({ themes: { active: 'x' } }, actor));
    refused(() => app({ somethingNew: 1 }, actor));
    refused(() => app({ authPending: [] }, actor));
  }
  assert.equal(settings.getApp().themes, undefined);
  assert.equal(settings.getApp().somethingNew, undefined);
});
check('app, not clientVisible: the refusal lists the writable keys', () => {
  refused(() => app({ somethingNew: 1 }, 'ui'), /not a writable app setting: somethingNew — writable keys: providers, /);
});
check('project, registered: ui, tool and share write', () => {
  project({ promptSize: 'chat' }, 'ui');
  project({ name: 'P' }, 'tool');
  project({ agentFiles: true }, 'share');
  assert.deepStrictEqual(settings.getProject(proj), { promptSize: 'chat', name: 'P', agentFiles: true });
});
check('project, unregistered key passes through', () => {
  for (const actor of ['ui', 'tool', 'share']) project({ ['custom' + actor]: { any: 'thing' } }, actor);
  assert.deepStrictEqual(settings.getProject(proj).customtool, { any: 'thing' });
});
check('secret field: ui writes, tool and share are refused', () => {
  app({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://a', apiKey: 'sk-1' }] }, 'ui');
  assert.equal(settings.getApp().providers[0].apiKey, 'sk-1');
  refused(() => app({ providers: [{ id: 'openai-compatible', apiKey: 'sk-2' }] }, 'tool'), /apiKey is not writable/);
  refused(() => project({ models: [{ id: 'm', provider: 'p', apiKey: 'x' }] }, 'share'), /apiKey is not writable/);
  refused(() => project({ apiKey: 'x' }, 'tool'), /apiKey is not writable/);
});
check('approval: reported for the tool on permission keys only', () => {
  assert.equal(project({ tools: { shell: { mode: 'ask' } } }, 'tool', { dryRun: true }).approval, true);
  assert.equal(project({ tools: { shell: { mode: 'ask' } } }, 'ui', { dryRun: true }).approval, false);
  assert.equal(project({ promptSize: 'average' }, 'tool', { dryRun: true }).approval, false);
});
check('content written by its own tool: hooks refused here, naming the way in', () => {
  refused(() => project({ hooks: [] }, 'tool'), /use hook_create/);
  refused(() => project({ hooks: [] }, 'ui'), /Settings → Extensions → Hooks/);
  refused(() => project({ hooks: [] }, 'share'));
  refused(() => service.applyPatch({ scope: 'project', projectDir: proj, unset: ['hooks'], actor: 'ui' }), /hooks/);
  refused(() => app({ hooks: [] }, 'ui'), /hooks/);
});
check('the storage marker is not writable', () => {
  refused(() => project({ __dbBacked: true }, 'ui'), /internal/);
});

// ---- Secrets carried over ------------------------------------------------

check('an entry re-sent without its key keeps it; hasApiKey is dropped', () => {
  app({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://a', name: 'A', hasApiKey: true }] }, 'tool');
  const stored = settings.getApp().providers[0];
  assert.equal(stored.apiKey, 'sk-1');
  assert.equal(stored.name, 'A');
  assert.equal('hasApiKey' in stored, false);
});
check('the key is dropped when the URL it is sent to changed', () => {
  app({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://evil', hasApiKey: true }] }, 'tool');
  assert.equal(settings.getApp().providers[0].apiKey, undefined);
});
check('the UI loses the stored key too when the URL changed, and keeps it otherwise', () => {
  app({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://a', apiKey: 'sk-ui' }] }, 'ui');
  app({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: ' http://a ', name: 'Same', hasApiKey: true }] }, 'ui');
  assert.equal(settings.getApp().providers[0].apiKey, 'sk-ui', 'same URL (trimmed): kept');
  app({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://b', hasApiKey: true }] }, 'ui');
  assert.equal(settings.getApp().providers[0].apiKey, undefined, 'new URL: dropped');
  // The raw project editor re-sending a model with a new baseUrl.
  project({ models: [{ id: 'm', provider: 'p', baseUrl: 'http://a', apiKey: 'sk-m' }] }, 'ui');
  project({ models: [{ id: 'm', provider: 'p', baseUrl: 'http://b', hasApiKey: true }] }, 'ui');
  assert.equal(settings.getProject(proj).models[0].apiKey, undefined);
});

// ---- Field checks --------------------------------------------------------

check('declared values are checked on write', () => {
  refused(() => project({ promptSize: 'huge' }, 'ui'), /promptSize must be one of very-small, average, extensive, chat/);
  refused(() => project({ toolOutput: { size: 'x' } }, 'tool'), /toolOutput.size must be one of/);
  refused(() => project({ notifications: { status: 'yes' } }, 'ui'), /notifications.status must be true or false/);
  refused(() => project({ toolOutput: 'big' }, 'ui'), /toolOutput must be an object/);
  refused(() => project({ agents: {} }, 'ui'), /agents must be a list/);
  assert.equal(settings.getProject(proj).promptSize, 'chat', 'nothing written');
});
check('subagentLimits: out-of-range and non-integer budgets are refused on write, at both scopes', () => {
  const bad = [
    [{ maxDepth: '3' }, /subagentLimits.maxDepth must be a whole number of at least 1/],
    [{ maxDepth: 0 }, /subagentLimits.maxDepth must be a whole number of at least 1/],
    [{ maxDepth: 2.5 }, /subagentLimits.maxDepth must be a whole number of at least 1/],
    [{ maxRuns: 0 }, /subagentLimits.maxRuns must be a whole number of at least 1/],
    [{ maxDepth: 2, maxRuns: -1 }, /subagentLimits.maxRuns must be a whole number of at least 1/]
  ];
  for (const actor of ['ui', 'tool']) {
    for (const [value, re] of bad) {
      refused(() => project({ subagentLimits: value }, actor), re);
      refused(() => app({ subagentLimits: value }, actor), re);
    }
    refused(() => project({ subagentLimits: 3 }, actor), /subagentLimits must be an object/);
  }
  assert.equal('subagentLimits' in settings.getProject(proj), false, 'nothing written to the project');
  assert.equal(settings.getApp().subagentLimits, undefined, 'nothing written to the app');
});
check('subagentLimits: a valid write is accepted at app and project scope and resolves field by field', () => {
  const a = app({ subagentLimits: { maxRuns: 64 } }, 'ui');
  assert.deepStrictEqual(a.changes.map((c) => [c.type, c.after, c.page]), [['subagentLimits.maxRuns', 64, 'settings/agents']]);
  app({ subagentLimits: { maxRuns: 256 } }, 'tool');
  const p = project({ subagentLimits: { maxDepth: 1 } }, 'tool');
  assert.equal(p.approval, false);
  assert.deepStrictEqual(settings.getResolved(proj).subagentLimits, { maxDepth: 1, maxRuns: 256 });
  project({ subagentLimits: { maxDepth: 8, maxRuns: 1 } }, 'ui');
  refused(() => app({ subagentLimits: { maxDepth: 2 } }, 'share'), /shared project/);
  service.applyPatch({ scope: 'project', projectDir: proj, unset: ['subagentLimits'], actor: 'ui' });
  service.applyPatch({ scope: 'app', unset: ['subagentLimits'], actor: 'ui' });
  assert.deepStrictEqual(settings.getResolved(proj).subagentLimits, { maxDepth: 3, maxRuns: 32 });
});
check('a stored invalid value re-sent unchanged does not block the save', () => {
  fs.writeFileSync(path.join(proj, '.mouaif.json'), JSON.stringify({ ...settings.getProject(proj), promptSize: 'legacy' }));
  project({ promptSize: 'legacy', name: 'Q' }, 'ui');
  assert.equal(settings.getProject(proj).name, 'Q');
  project({ promptSize: 'chat' }, 'ui');
});
check('null clears a value and is accepted', () => {
  project({ promptSize: null }, 'ui');
  assert.equal(settings.getProject(proj).promptSize, null);
});
check('read warnings name stored values that fail the checks', () => {
  const warnings = service.warningsFor({ promptSize: 'huge', toolOutput: { size: 'full' }, extra: 1 }, 'project');
  assert.deepStrictEqual(warnings.map((w) => w.key), ['promptSize']);
});

// ---- Change lists --------------------------------------------------------

check('a value change carries label, before, after and page', () => {
  const { changes } = project({ promptSize: 'extensive' }, 'ui');
  assert.deepStrictEqual(changes, [{
    type: 'promptSize', scope: 'project', op: 'set', key: 'promptSize', label: 'Prompt style',
    page: 'settings/project', before: null, after: 'extensive'
  }]);
});
check('a split key reports each declared part that changed', () => {
  project({ toolOutput: { size: 'average', structure: 'tree' } }, 'ui');
  const { changes } = project({ toolOutput: { size: 'full', structure: 'tree' } }, 'ui');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'toolOutput.size');
  assert.equal(changes[0].before, 'average');
  assert.equal(changes[0].after, 'full');
});
check('unset reports op unset', () => {
  const { changes } = service.applyPatch({ scope: 'project', projectDir: proj, unset: ['toolOutput'], actor: 'ui' });
  assert.deepStrictEqual(changes.map((c) => [c.type, c.op]), [['toolOutput.size', 'unset'], ['toolOutput.structure', 'unset']]);
  assert.equal('toolOutput' in settings.getProject(proj), false);
});
check('a whole-array write is diffed into added, changed and removed items', () => {
  project({ agents: [{ name: 'reviewer', content: 'a'.repeat(100), modelId: 'model-a' }, { name: 'old', content: 'x' }] }, 'ui');
  const { changes } = project({ agents: [{ name: 'reviewer', content: 'b'.repeat(120), modelId: 'model-b' }, { name: 'new', content: 'y' }] }, 'tool');
  const byOp = Object.fromEntries(changes.map((c) => [c.op + ':' + c.id, c]));
  assert.deepStrictEqual(Object.keys(byOp).sort(), ['added:new', 'changed:reviewer', 'removed:old']);
  const changed = byOp['changed:reviewer'];
  assert.equal(changed.label, 'Agent “reviewer”');
  assert.equal(changed.page, 'settings/agents/reviewer');
  assert.deepStrictEqual(changed.fields, [
    { key: 'content', label: 'Instructions', large: true, beforeSize: 100, afterSize: 120 },
    { key: 'modelId', label: 'Model', before: 'model-a', after: 'model-b' }
  ]);
  assert.equal(JSON.stringify(changes).includes('bbbb'), false, 'large text is not copied into the change list');
});
check('a secret field shows set / not set, never its value', () => {
  app({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://evil' }] }, 'ui');
  const { changes } = app({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://evil', apiKey: 'sk-secret' }] }, 'ui');
  assert.deepStrictEqual(changes[0].fields, [{ key: 'apiKey', label: 'API key', secret: true, before: 'not set', after: 'set' }]);
  assert.equal(JSON.stringify(changes).includes('sk-secret'), false);
});
check('an unregistered key is shown raw under its own name', () => {
  const { changes } = project({ myKey: { a: 1 } }, 'ui');
  assert.deepStrictEqual(changes, [{ type: 'myKey', scope: 'project', op: 'set', key: 'myKey', label: 'myKey', page: null, before: undefined, after: { a: 1 }, raw: true }]);
});
check('a map collection (tags) is diffed by key', () => {
  const { changes } = project({ tags: { 'src/a.js': { tags: ['api'] } } }, 'ui');
  assert.deepStrictEqual(changes.map((c) => [c.op, c.id, c.label]), [['added', 'src/a.js', 'Tagged file “src/a.js”']]);
});
check('writing the same value reports no change', () => {
  assert.deepStrictEqual(project({ promptSize: 'extensive' }, 'ui').changes, []);
});

// ---- Dry run and events --------------------------------------------------

check('a dry run computes the changes and writes nothing', () => {
  const before = settings.getProject(proj);
  const r = project({ promptSize: 'very-small' }, 'tool', { dryRun: true });
  assert.equal(r.changes[0].after, 'very-small');
  assert.deepStrictEqual(settings.getProject(proj), before);
});
check('a write publishes content_changed; a dry run does not', () => {
  const seen = [];
  const on = (e) => seen.push(e);
  service.events.on('content_changed', on);
  project({ promptSize: 'average' }, 'tool', { dryRun: true });
  project({ promptSize: 'average' }, 'tool');
  service.events.off('content_changed', on);
  assert.equal(seen.length, 1);
  assert.deepStrictEqual(seen[0], { scope: 'project', projectDir: proj, keys: ['promptSize'], types: ['promptSize'], actor: 'tool' });
});
check('DB-backed projects go through the same path', () => {
  settings.setDbBacked(proj, true);
  const { changes, document } = project({ promptSize: 'chat' }, 'ui');
  assert.equal(changes[0].after, 'chat');
  assert.equal(document.__dbBacked, true);
  assert.equal(settings.getProject(proj).promptSize, 'chat');
  settings.setDbBacked(proj, false);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
