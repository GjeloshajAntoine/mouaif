'use strict';

// Regression test for the wire shape of the project-scoped settings payloads.
//
// `GET /api/settings/project` and `GET /api/settings/resolved` used to project
// a PROJECT object through `settingsForClient`, whose allowlist exists for the
// APP store. Every project-only key (`name`, `agents`, `skills`, `agentFiles`,
// `hideFileContent`, `tags`, `customActions`, `totalCost`, ...) was dropped, so
// the Technical-details raw editor showed an incomplete object and
// project-scoped UI state (hidden-file count, agent-files / skills switches)
// was frozen at its default. Both endpoints now use `projectForClient`, which
// sends the project whole and strips only secrets and the internal
// `__dbBacked` storage marker.
//
// Run: node scripts/test-project-settings-payload.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-payload-home-'));
process.env.MOUAIF_HOME = home;
const ROOT = path.join(__dirname, '..');
const settings = require(path.join(ROOT, 'src/settings.js'));
const { settingsForClient, projectForClient } = require(path.join(ROOT, 'src/server-shared.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   - ' + name);
  } catch (err) {
    fail++;
    console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]);
  }
}

const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-payload-project-'));
const PROJECT = {
  name: 'payload-test',
  skills: true,
  agentFiles: false,
  agents: [{ name: 'Search', content: 'find things' }],
  customActions: [{ id: 'test', label: 'test' }],
  hideFileContent: [{ path: '.mcp.json' }, { path: 'src/a.js' }],
  tags: ['t'],
  totalCost: { total: 1 },
  tools: { shell: { mode: 'allow' } }
};
fs.writeFileSync(
  path.join(projDir, '.mouaif.json'),
  JSON.stringify(PROJECT, null, 2) + '\n'
);

// ---- file-backed project --------------------------------------------------

const fileWire = projectForClient(settings.getProject(projDir));
check('file-backed project sends every project key', () => {
  for (const key of Object.keys(PROJECT)) {
    assert.ok(Object.prototype.hasOwnProperty.call(fileWire, key), 'missing ' + key);
  }
});
check('project-only keys survive (they used to be filtered out)', () => {
  assert.equal(fileWire.name, 'payload-test');
  assert.equal(fileWire.agentFiles, false);
  assert.equal(fileWire.hideFileContent.length, 2);
  assert.deepEqual(fileWire.tags, ['t']);
  assert.deepEqual(fileWire.agents, [{ name: 'Search', content: 'find things' }]);
  assert.equal(fileWire.totalCost.total, 1);
});
check('no __dbBacked marker on a file-backed project', () => {
  assert.equal('__dbBacked' in fileWire, false);
});

// ---- DB-backed project ----------------------------------------------------

settings.setDbProject(projDir, { ...PROJECT, __dbBacked: true });
const dbWire = projectForClient(settings.getProject(projDir));
check('DB-backed project still sends the full object', () => {
  assert.equal(dbWire.name, 'payload-test');
  assert.equal(dbWire.hideFileContent.length, 2);
  assert.equal(dbWire.agentFiles, false);
});
check('DB-backed marker is never exposed to the client', () => {
  assert.equal('__dbBacked' in dbWire, false);
  assert.equal(JSON.stringify(dbWire).includes('__dbBacked'), false);
});
check('server-side code still sees the marker', () => {
  assert.equal(settings.isDbBacked(projDir), true);
  assert.equal(settings.getProject(projDir).__dbBacked, true);
});

// ---- secrets --------------------------------------------------------------

check('projectForClient redacts provider/model apiKeys', () => {
  const wire = projectForClient({
    providers: [{ id: 'openai-compatible', baseUrl: 'https://x', apiKey: 'sk-secret' }],
    models: [{ id: 'm', provider: 'openai-compatible', apiKey: 'sk-other' }]
  });
  const json = JSON.stringify(wire);
  assert.equal(json.includes('sk-secret'), false);
  assert.equal(json.includes('sk-other'), false);
  assert.equal(wire.providers[0].hasApiKey, true);
  assert.equal(wire.models[0].hasApiKey, true);
  assert.equal(wire.providers[0].baseUrl, 'https://x');
});

// ---- resolved view --------------------------------------------------------

const resolved = settings.getResolved(projDir);
const resolvedWire = projectForClient(resolved);
check('resolved view keeps defaults, app and project keys', () => {
  assert.equal(resolvedWire.promptSize, settings.DEFAULTS.promptSize);
  assert.equal(resolvedWire.name, 'payload-test');
  assert.equal('__dbBacked' in resolvedWire, false);
  assert.notEqual(resolvedWire.toolOutput, undefined, 'defaults still resolve');
});
check('projectForClient copies instead of mutating its input', () => {
  const input = { name: 'x', __dbBacked: true };
  projectForClient(input);
  assert.equal(input.__dbBacked, true);
});
check('non-objects pass through unchanged', () => {
  assert.equal(projectForClient(null), null);
  assert.equal(projectForClient(undefined), undefined);
  assert.deepEqual(projectForClient([1, 2]), [1, 2]);
});

// ---- app scope is unchanged ----------------------------------------------

check('settingsForClient still allowlists the app store (no secret leak)', () => {
  const app = settingsForClient({
    providers: [{ id: 'openai-compatible', apiKey: 'sk-app' }],
    authPending: { codeVerifier: 'v', state: 's' },
    cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/x',
    projects: [{ id: 'a', path: '/tmp/a' }]
  });
  assert.equal(JSON.stringify(app).includes('sk-app'), false);
  assert.equal('authPending' in app, false);
  assert.equal('cdpUrl' in app, false);
  assert.equal(app.projects.length, 1);
});

settings.close();
fs.rmSync(projDir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
