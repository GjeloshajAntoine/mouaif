'use strict';

// Content registry: the generated lists must equal the hand-written constants
// they replaced (step 1 of docs/agent/plans/settings-architecture.md), and the
// declarations must be self-consistent.
//
// The expected values below are the constants as they stood before the
// registry existed. Changing one of them is a deliberate behaviour change:
// update the registry and this snapshot in the same commit.
//
// Run: node scripts/test-content-registry.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-registry-home-'));
const ROOT = path.join(__dirname, '..');
const registry = require(path.join(ROOT, 'src/content/registry.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   - ' + name); }
  catch (err) { fail++; console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]); }
}

const EXPECTED_DEFAULTS = {
  providers: [],
  models: [],
  projects: [],
  authAccounts: {},
  promptSize: 'average',
  enterForNewline: true,
  autoRetry: true,
  fileOrbButton: false,
  dictationButton: true,
  imageButton: true,
  statusBar: true,
  prompts: [],
  toolOutput: { size: 'average', structure: 'tree' },
  shellReview: { mode: 'off' },
  toolWording: { active: '', sets: {} },
  toolOverrides: {},
  toolFeedbackMaxBytes: 64 * 1024,
  notifications: { status: true, authorization: true, quickActions: true, login: true },
  flags: {}
};

const EXPECTED_CLIENT_KEYS = [
  'providers', 'models', 'projects', 'promptSize', 'enterForNewline', 'autoRetry',
  'fileOrbButton', 'dictationButton', 'imageButton', 'statusBar', 'dictation', 'prompts',
  'profileLaunchers', 'githubCopilot', 'modelPricing', 'authAccounts', 'tools',
  'toolFeedbackMaxBytes', 'toolOutput', 'notifications', 'flags'
];

const EXPECTED_RESETTABLE = [
  ...Object.keys(EXPECTED_DEFAULTS), 'modelPricing', 'githubCopilot', 'dictation', 'profileLaunchers'
];

const EXPECTED_PERMISSION_KEYS = ['tools', 'mcp', 'authAccounts', 'authPending'];

check('generated DEFAULTS deep-equal the former constant', () => {
  assert.deepStrictEqual(registry.buildDefaults(), EXPECTED_DEFAULTS);
});

check('generated client keys equal the former allowlist, in order', () => {
  assert.deepStrictEqual(registry.clientSettingsKeys(), EXPECTED_CLIENT_KEYS);
});

check('generated reset keys equal the former set', () => {
  assert.deepStrictEqual(new Set(registry.resettableAppKeys()), new Set(EXPECTED_RESETTABLE));
});

check('generated permission keys equal the former list', () => {
  assert.deepStrictEqual(new Set(registry.permissionKeys()), new Set(EXPECTED_PERMISSION_KEYS));
});

check('settings.js exports the generated DEFAULTS, frozen', () => {
  const settings = require(path.join(ROOT, 'src/settings.js'));
  assert.deepStrictEqual(settings.DEFAULTS, EXPECTED_DEFAULTS);
  assert.ok(Object.isFrozen(settings.DEFAULTS));
  assert.ok(Object.isFrozen(settings.DEFAULTS.toolOutput), 'nested defaults are frozen too');
});

check('server-shared and the mouaif tool export the generated lists', () => {
  const shared = require(path.join(ROOT, 'src/server-shared.js'));
  assert.deepStrictEqual([...shared.CLIENT_SETTINGS_KEYS], EXPECTED_CLIENT_KEYS);
  assert.deepStrictEqual(new Set(shared.RESETTABLE_APP_KEYS), new Set(EXPECTED_RESETTABLE));
  const tool = require(path.join(ROOT, 'src/tools/mouaif.js'));
  assert.deepStrictEqual(new Set(tool.PERMISSION_KEYS), new Set(EXPECTED_PERMISSION_KEYS));
});

check('ids are unique and every declaration has the required fields', () => {
  const ids = new Set();
  for (const t of registry.TYPES) {
    assert.ok(!ids.has(t.id), 'duplicate ' + t.id);
    ids.add(t.id);
    assert.ok(t.shape === 'value' || t.shape === 'collection', t.id + ' shape');
    assert.ok(Array.isArray(t.scopes) && t.scopes.length, t.id + ' scopes');
    assert.ok(t.scopes.every((s) => s === 'app' || s === 'project'), t.id + ' scope names');
    assert.ok(typeof t.doc === 'string' && typeof t.path === 'string', t.id + ' doc/path');
    assert.ok(t.writers && typeof t.writers === 'object', t.id + ' writers');
    if (t.shape === 'value') assert.ok(t.field && typeof t.field.type === 'string', t.id + ' field');
    else {
      assert.ok(t.container === 'array' || t.container === 'map', t.id + ' container');
      if (t.container === 'array') assert.ok(typeof t.itemId === 'string', t.id + ' itemId');
      assert.ok(t.fields && typeof t.fields === 'object', t.id + ' fields');
      assert.ok(['override', 'concat', 'replace'].includes(t.merge), t.id + ' merge');
    }
    if (!t.internal) assert.ok(t.label, t.id + ' label');
  }
});

check('declarations sharing a root key agree on the key-level flags', () => {
  const byRoot = new Map();
  for (const t of registry.TYPES) {
    if (t.doc !== 'settings') continue;
    const key = registry.rootKey(t);
    if (!byRoot.has(key)) byRoot.set(key, []);
    byRoot.get(key).push(t);
  }
  for (const [key, types] of byRoot) {
    for (const flag of ['clientVisible', 'approval']) {
      const values = new Set(types.map((t) => t[flag] === true));
      assert.equal(values.size, 1, key + ' disagrees on ' + flag);
    }
  }
});

check('enum defaults are among their options', () => {
  for (const t of registry.TYPES) {
    if (t.shape !== 'value' || t.field.type !== 'enum' || t.field.default === undefined) continue;
    assert.ok(t.field.options.includes(t.field.default), t.id);
  }
});

check('lookup helpers', () => {
  assert.equal(registry.getType('toolOutput.size').label, 'Tool output size');
  assert.equal(registry.typeForPath('toolOutput.size').id, 'toolOutput.size');
  assert.equal(registry.typeForPath('agents').id, 'agents');
  assert.equal(registry.typeForPath('themes.custom').id, 'themes');
  assert.equal(registry.typeForPath('unknownKey'), null);
  assert.deepStrictEqual(registry.typesForRoot('notifications').map((t) => t.id).sort(),
    ['notifications.authorization', 'notifications.login', 'notifications.quickActions', 'notifications.status']);
  assert.equal(registry.dedicatedTool(registry.getType('hooks')), 'hook_create');
  assert.equal(registry.dedicatedTool(registry.getType('agents')), null);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
