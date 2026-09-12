'use strict';

// Route-table test: every hash the app can be handed maps to a known route.
//
// `frontend/src/routes.js` is the whole hash → route mapping as one table;
// `router.js` is only the browser wiring (the hashchange listener and
// `nav()`). This test pins the table so a refactor cannot quietly change a
// deep link, an old bookmark, or the `?projectDir=`/`?from=` plumbing that
// the project-scoped settings pages depend on.
//
// The refactor that introduced the table was checked against the previous
// `router.js` by fuzzing 4 400 hashes through both implementations. Two
// differences were intentional and are asserted below:
//   1. a malformed percent-escape no longer throws (it used to take the
//      router down with a URIError, leaving the app on a dead hash);
//   2. `#/settings/providers/<id>?query` no longer swallows the query into
//      the id (the old handler decoded the whole remainder).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

(async () => {
  // Browser ESM in a CJS package: load the source through a data: URL so
  // this runs on any supported Node, the same way test-agent-page-flow.mjs
  // loads the settings modules.
  const source = fs.readFileSync(path.join(__dirname, '../frontend/src/routes.js'), 'utf8');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const { parseHash, fromParam } = mod;

  const eq = (hash, expected) => assert.deepEqual(parseHash(hash), expected);

  // ---- Defaults and unknown hashes ------------------------------------

  check('no hash is the chat list', () => {
    for (const h of ['', '#', '#/', null, undefined]) eq(h, { name: 'chats' });
  });

  check('an unknown hash falls back to the chat list', () => {
    for (const h of ['#/nope', '#/x/y/z', '#/settings/nope']) eq(h, { name: 'chats' });
  });

  check('a hash works with or without the leading #/', () => {
    eq('settings', { name: 'settings' });
    eq('#settings', { name: 'settings' });
    eq('#/settings', { name: 'settings' });
  });

  // ---- Legacy aliases -------------------------------------------------

  check('legacy #/projects is the chat list', () => eq('#/projects', { name: 'chats' }));
  check('legacy #/auth is the settings root', () => eq('#/auth', { name: 'settings' }));
  check('legacy #/settings/copilot is the Copilot provider form', () =>
    eq('#/settings/copilot', { name: 'settingsProviderEdit', id: 'github-copilot' }));
  check('legacy #/settings/project/agents/<name> still resolves', () => {
    eq('#/settings/project/agents/reviewer?projectDir=%2Fp&chatId=c1&from=projects', {
      name: 'settingsAgentEdit', id: 'reviewer', projectDir: '/p', from: 'projects',
      chatId: 'c1', returnTo: 'project', isNew: false
    });
  });

  // ---- Fixed pages ----------------------------------------------------

  check('the fixed pages have no query plumbing', () => {
    const cases = [
      ['#/settings', 'settings'],
      ['#/settings/access', 'settingsAccess'],
      ['#/inspector', 'inspector'],
      ['#/settings/projects', 'settingsProjects'],
      ['#/settings/defaults', 'settingsDefaults'],
      ['#/settings/notifications', 'settingsNotifications'],
      ['#/settings/pricing', 'settingsPricing'],
      ['#/settings/about', 'settingsAbout']
    ];
    for (const [hash, name] of cases) eq(hash, { name });
  });

  // ---- Providers ------------------------------------------------------

  check('providers list, new form and editor', () => {
    eq('#/settings/providers', { name: 'settingsProviders' });
    eq('#/settings/providers/new', { name: 'settingsProviderNew' });
    eq('#/settings/providers/openai', { name: 'settingsProviderEdit', id: 'openai' });
  });

  check('a provider id is decoded', () =>
    eq('#/settings/providers/' + encodeURIComponent('my provider'), { name: 'settingsProviderEdit', id: 'my provider' }));

  check('an empty or reserved provider id falls through to the chat list', () => {
    eq('#/settings/providers/', { name: 'chats' });
    eq('#/settings/providers/new', { name: 'settingsProviderNew' });
  });

  check('a provider id does not swallow its query string (#2 above)', () =>
    eq('#/settings/providers/openai?from=projects', { name: 'settingsProviderEdit', id: 'openai' }));

  // ---- Project settings -----------------------------------------------

  check('project settings root', () =>
    eq('#/settings/project?projectDir=%2Fp&chatId=c1&from=projects', {
      name: 'settingsProject', projectDir: '/p', chatId: 'c1', from: 'projects'
    }));

  check('project sub-pages win over the root', () => {
    eq('#/settings/project/technical?projectDir=%2Fp&chatId=c1&from=projects', {
      name: 'settingsProjectTechnical', projectDir: '/p', chatId: 'c1', from: 'projects'
    });
    eq('#/settings/project/output?projectDir=%2Fp&from=projects', {
      name: 'settingsProjectOutput', projectDir: '/p', from: 'projects'
    });
    eq('#/settings/project/preview?projectDir=%2Fp&from=projects', {
      name: 'settingsProjectPreview', projectDir: '/p', from: 'projects'
    });
    eq('#/settings/project/hide?projectDir=%2Fp&from=projects&file=src%2Fa.js', {
      name: 'settingsProjectHide', projectDir: '/p', from: 'projects', filePath: 'src/a.js'
    });
  });

  check('an unrecognised from value is dropped, not passed through', () => {
    eq('#/settings/project?from=elsewhere', { name: 'settingsProject', projectDir: '', chatId: '', from: '' });
    eq('#/settings/project?from=projects', { name: 'settingsProject', projectDir: '', chatId: '', from: 'projects' });
    eq('#/settings/project?from=settings%2Fprojects', { name: 'settingsProject', projectDir: '', chatId: '', from: 'settings/projects' });
    assert.equal(fromParam(new URLSearchParams('from=projects')), 'projects');
    assert.equal(fromParam(new URLSearchParams('')), '');
  });

  // ---- Agents ---------------------------------------------------------

  check('agents list', () =>
    eq('#/settings/agents?projectDir=%2Fp&chatId=c1&from=projects', {
      name: 'settingsAgents', projectDir: '/p', chatId: 'c1', from: 'projects'
    }));

  check('agent editor', () =>
    eq('#/settings/agents/reviewer?projectDir=%2Fp&chatId=c1&from=projects&returnTo=project', {
      name: 'settingsAgentEdit', id: 'reviewer', projectDir: '/p', from: 'projects',
      chatId: 'c1', returnTo: 'project', isNew: false
    }));

  check('agent editor: new is a draft unless ?edit=1', () => {
    assert.equal(parseHash('#/settings/agents/new').isNew, true);
    assert.equal(parseHash('#/settings/agents/new?edit=1').isNew, false);
    assert.equal(parseHash('#/settings/agents/new?edit=1').id, 'new');
  });

  check('an encoded agent id is decoded', () =>
    assert.equal(parseHash('#/settings/agents/%72eviewer').id, 'reviewer'));

  // ---- Actions, prompts, MCP, tags ------------------------------------

  check('custom actions list and editor', () => {
    eq('#/settings/actions?projectDir=%2Fp&from=projects', { name: 'settingsActions', projectDir: '/p', from: 'projects' });
    eq('#/settings/actions/lint?projectDir=%2Fp&from=projects', { name: 'settingsActionEdit', id: 'lint', projectDir: '/p', from: 'projects' });
  });

  check('prompts: both scopes and the editor', () => {
    eq('#/settings/prompts', { name: 'settingsPrompts', id: '', projectDir: '', scope: '', from: '' });
    eq('#/settings/prompts?scope=app', { name: 'settingsPrompts', id: '', projectDir: '', scope: 'app', from: '' });
    eq('#/settings/prompts?projectDir=%2Fp&from=projects', { name: 'settingsPrompts', id: '', projectDir: '/p', scope: '', from: 'projects' });
    eq('#/settings/prompts/pr1?projectDir=%2Fp&scope=project', { name: 'settingsPrompts', id: 'pr1', projectDir: '/p', scope: 'project', from: '' });
  });

  check('mcp: registry, list, new and editor are distinct', () => {
    eq('#/settings/mcp/registry?projectDir=%2Fp&from=projects', { name: 'settingsMcpRegistry', projectDir: '/p', from: 'projects' });
    eq('#/settings/mcp?projectDir=%2Fp&from=projects', { name: 'settingsMcp', projectDir: '/p', from: 'projects' });
    eq('#/settings/mcp/new?scope=app', { name: 'settingsMcpEdit', id: '', projectDir: '', scope: 'app', from: '' });
    eq('#/settings/mcp/new', { name: 'settingsMcpEdit', id: '', projectDir: '', scope: '', from: '' });
    eq('#/settings/mcp/server-1?scope=project', { name: 'settingsMcpEdit', id: 'server-1', projectDir: '', scope: 'project', from: '' });
    eq('#/settings/mcp/server-1?scope=weird', { name: 'settingsMcpEdit', id: 'server-1', projectDir: '', scope: '', from: '' });
  });

  check('tags carry projectId and projectDir', () =>
    eq('#/settings/tags?projectId=p1&projectDir=%2Fp', { name: 'settingsTags', projectId: 'p1', projectDir: '/p' }));

  // ---- Chat and the folder picker -------------------------------------

  check('chat view carries the chat id and projectDir', () => {
    eq('#/chat/a150c01b?projectDir=%2Fhome%2Fu%2Fp', { name: 'chat', chatId: 'a150c01b', projectDir: '/home/u/p' });
    eq('#/chat/a150c01b', { name: 'chat', chatId: 'a150c01b', projectDir: '' });
  });

  check('the folder picker carries ?dir', () => {
    eq('#/projects/new?dir=%2Ftmp', { name: 'picker', dir: '/tmp' });
    eq('#/projects/new', { name: 'picker', dir: '' });
  });

  // ---- Robustness ------------------------------------------------------

  check('a malformed escape does not throw (#1 above)', () => {
    for (const bad of ['%zz', '%e0%a4', '%', '%2']) {
      const r = parseHash('#/settings/agents/' + bad);
      assert.equal(r.name, 'settingsAgentEdit');
      assert.equal(r.id, bad);
    }
    assert.equal(parseHash('#/settings/providers/%zz').id, '%zz');
    assert.equal(parseHash('#/settings/actions/%zz').id, '%zz');
  });

  check('a route never throws for arbitrary input', () => {
    const shapes = ['#/%', '#/?', '#/settings/project/agents/', '#/chat/%zz?x=%', '#/settings//mcp'];
    for (const h of shapes) assert.ok(parseHash(h) && typeof parseHash(h).name === 'string', h);
  });

  // ---- Table invariants ------------------------------------------------

  check('the route table has one entry per route group', () => {
    const names = new Set();
    for (const h of ['#/settings', '#/settings/access', '#/inspector', '#/settings/providers', '#/settings/providers/new',
      '#/settings/providers/p', '#/settings/project', '#/settings/project/technical', '#/settings/project/output',
      '#/settings/project/preview', '#/settings/project/hide', '#/settings/agents', '#/settings/agents/a',
      '#/settings/actions', '#/settings/actions/a', '#/settings/projects', '#/settings/defaults',
      '#/settings/notifications', '#/settings/pricing', '#/settings/prompts', '#/settings/prompts/p',
      '#/settings/mcp', '#/settings/mcp/registry', '#/settings/mcp/new', '#/settings/mcp/s', '#/settings/tags',
      '#/settings/about', '#/dictation', '#/chat/c', '#/projects/new']) {
      names.add(parseHash(h).name);
    }
    assert.equal(names.size, 28, Array.from(names).sort().join(','));
    assert.ok(mod.ROUTE_PATHS >= names.size, 'the table is not smaller than its distinct routes');
  });

  console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---');
  if (fail) process.exit(1);
})();
