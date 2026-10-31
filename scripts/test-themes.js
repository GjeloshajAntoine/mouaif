'use strict';

// Custom themes: the store (src/themes.js) and the REST handlers
// (src/server-handlers-themes.js), including the script endpoint the page
// imports under `script-src 'self'`. See docs/features/themes.md.
//
// Run: node scripts/test-themes.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-themes-home-'));
process.env.MOUAIF_HOME = home;
const ROOT = path.join(__dirname, '..');
const themes = require(path.join(ROOT, 'src/themes.js'));
const settings = require(path.join(ROOT, 'src/settings.js'));
const { handleThemes } = require(path.join(ROOT, 'src/server-handlers-themes.js'));

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok   - ' + name);
  } catch (err) {
    fail++;
    console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]);
  }
}

// call(method, url, body) — drive the handler with a minimal req/res pair.
function call(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = {};
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      writeHead(status, headers) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(headers || {})) this.headers[k.toLowerCase()] = v;
      },
      end(data) {
        const text = data ? String(data) : '';
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: this.statusCode, headers: this.headers, text, json });
      }
    };
    handleThemes(req, res, { pathname: url.split('?')[0], query: {} });
  });
}

(async () => {
  await check('an empty store lists no themes and no active id', () => {
    assert.deepEqual(themes.list(), { active: '', themes: [] });
  });

  let id;
  await check('create stores a sanitized theme and returns its script', async () => {
    const r = await call('POST', '/api/themes', {
      name: '  Neon  ', base: 'light', extra: 'dropped',
      vars: { '--accent': ' #ff00aa ', '--empty': '' },
      css: 'body { color: red; }',
      js: 'export default function setup(ctx) {}'
    });
    assert.equal(r.status, 200);
    const t = r.json.theme;
    id = t.id;
    assert.match(id, /^custom-neon-[0-9a-f]{6}$/);
    assert.equal(t.name, 'Neon');
    assert.equal(t.base, 'light');
    assert.deepEqual(t.vars, { '--accent': '#ff00aa' });
    assert.equal(t.hasJs, true);
    assert.equal(t.extra, undefined);
    assert.match(t.version, /^[0-9a-f]{12}$/);
  });

  await check('the list carries css but not the script body', async () => {
    const r = await call('GET', '/api/themes');
    assert.equal(r.json.themes.length, 1);
    assert.equal(r.json.themes[0].css, 'body { color: red; }');
    assert.equal(r.json.themes[0].js, undefined);
    assert.ok(r.json.themes[0].jsBytes > 0);
  });

  await check('script.js serves the module as JavaScript, uncached', async () => {
    const r = await call('GET', '/api/themes/' + id + '/script.js');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/javascript/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.text, 'export default function setup(ctx) {}');
  });

  await check('an edit changes the version so the client re-imports', async () => {
    const before = themes.get(id).version;
    const r = await call('PUT', '/api/themes/' + id, { name: 'Neon', base: 'dark', vars: {}, css: '', js: 'export default () => {}' });
    assert.equal(r.status, 200);
    assert.notEqual(r.json.theme.version, before);
    assert.equal(r.json.theme.base, 'dark');
  });

  await check('bad input is refused with 400', async () => {
    for (const body of [
      { name: '' },
      { name: 'x', vars: { accent: 'red' } },
      { name: 'x', vars: { '--a': 'red; } body { display: none' } },
      { name: 'x', vars: { '--a': 5 } },
      { name: 'x', js: 42 },
      { name: 'x', js: 'x'.repeat(themes.MAX_JS_BYTES + 1) },
      { name: 'x', css: 'x'.repeat(themes.MAX_CSS_BYTES + 1) }
    ]) {
      const r = await call('POST', '/api/themes', body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    }
  });

  await check('active accepts built-in and custom ids, refuses junk', async () => {
    assert.equal((await call('PUT', '/api/themes/active', { id: 'paper' })).json.active, 'paper');
    assert.equal((await call('PUT', '/api/themes/active', { id })).json.active, id);
    assert.equal((await call('PUT', '/api/themes/active', { id: '../x' })).status, 400);
    assert.equal(themes.list().active, id);
  });

  await check('themes stay out of GET /api/settings', () => {
    const { settingsForClient } = require(path.join(ROOT, 'src/server-shared.js'));
    assert.ok(settings.getApp().themes);
    assert.equal(settingsForClient(settings.getApp()).themes, undefined);
  });

  await check('deleting the active theme resets to the default', async () => {
    const r = await call('DELETE', '/api/themes/' + id);
    assert.equal(r.status, 200);
    assert.equal(r.json.active, '');
    assert.equal((await call('GET', '/api/themes/' + id)).status, 404);
    assert.equal((await call('GET', '/api/themes/' + id + '/script.js')).status, 404);
  });

  fs.rmSync(home, { recursive: true, force: true });
  console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---');
  process.exit(fail ? 1 : 0);
})();
