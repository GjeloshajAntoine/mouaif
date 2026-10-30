'use strict';

// Project card order: projects.reorderProjects() and
// PUT /api/projects/registered/order. The order of the registered-projects
// array is the order the cards are shown in, so this is the whole feature on
// the server side.
//
// Run: node scripts/test-project-reorder.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-reorder-home-'));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-reorder-proj-'));
process.env.MOUAIF_HOME = HOME;
process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
const projects = require('../src/projects.js');

let pass = 0, fail = 0;
function t(name, cond, msg) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (msg ? (' :: ' + msg) : '')); }
}
const names = (list) => list.map(p => p.name).join(',');

function mkdir(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir);
  return dir;
}

// ---- Unit: reorderProjects ----------------------------------------------
const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(n => projects.registerProject(mkdir(n)));
t('registered in order', names(projects.listProjects()) === 'a,b,c,d');

let out = projects.reorderProjects([d.id, b.id, a.id, c.id]);
t('a full order is applied', names(out) === 'd,b,a,c', names(out));
t('the order is persisted', names(projects.listProjects()) === 'd,b,a,c', names(projects.listProjects()));

out = projects.reorderProjects([c.id]);
t('a partial list puts the listed ids first, the rest keep their order',
  names(out) === 'c,d,b,a', names(out));

out = projects.reorderProjects(['nope', a.id, 'also-nope']);
t('unknown ids are ignored', names(out) === 'a,c,d,b', names(out));

out = projects.reorderProjects([b.id, b.id, d.id, b.id]);
t('duplicate ids count once', names(out) === 'b,d,a,c', names(out));

const settings = require('../src/settings.js');
const realSetApp = settings.setApp;
let writes = 0;
settings.setApp = (...args) => { writes++; return realSetApp.apply(settings, args); };
projects.reorderProjects([b.id, d.id, a.id, c.id]);
t('an unchanged order writes nothing', writes === 0, 'writes: ' + writes);
projects.reorderProjects([d.id, b.id]);
t('a changed order writes once', writes === 1, 'writes: ' + writes);
projects.reorderProjects([b.id, d.id, a.id, c.id]);
settings.setApp = realSetApp;

out = projects.reorderProjects([]);
t('an empty list changes nothing', names(out) === 'b,d,a,c', names(out));

for (const bad of [null, undefined, 'a,b', { 0: a.id }, [a.id, 7], [null]]) {
  t('a bad body is rejected: ' + JSON.stringify(bad), projects.reorderProjects(bad) === null);
}
t('a rejected body leaves the order alone', names(projects.listProjects()) === 'b,d,a,c');

// A cost recorded by a chat survives a reorder (the rows are moved, not rebuilt).
projects.adjustProjectTotalCost(a.path, 1.5, 1);
out = projects.reorderProjects([a.id]);
t('rows keep their cost when moved', out[0].id === a.id && out[0].totalCost.total === 1.5 && out[0].totalCost.known === true,
  JSON.stringify(out[0].totalCost));

// ---- HTTP ---------------------------------------------------------------
let port = 0;
function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      method, host: '127.0.0.1', port, path: p,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let buf = '';
      res.on('data', (x) => { buf += x; });
      res.on('end', () => {
        let json; try { json = JSON.parse(buf); } catch { json = buf; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
function pickFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

async function runHttp() {
  port = await pickFreePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'mouaif.js'), 'serve', '--port', String(port), '--host', '127.0.0.1'], {
    env: Object.assign({}, process.env, { MOUAIF_HOME: HOME, MOUAIF_ALLOW_ANY_ROOT: '1' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (x) => { log += x; });
  child.stderr.on('data', (x) => { log += x; });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = typeof (await request('GET', '/')).status === 'number'; } catch {}
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    if (!up) { t('server started', false, log); return; }

    const list = async () => (await request('GET', '/api/projects/registered')).body.projects;
    const ids = (await list()).map(p => p.id);
    const reversed = ids.slice().reverse();

    let r = await request('PUT', '/api/projects/registered/order', { ids: reversed });
    t('PUT order 200', r.status === 200, JSON.stringify(r));
    t('PUT order answers with the new list', r.body.projects.map(p => p.id).join() === reversed.join());
    t('GET shows the new order', (await list()).map(p => p.id).join() === reversed.join());

    r = await request('PUT', '/api/projects/registered/order', { ids: 'nope' });
    t('PUT order with a bad body is a 400', r.status === 400, JSON.stringify(r));
    r = await request('PUT', '/api/projects/registered/order', '{not json');
    t('PUT order with invalid JSON is a 400', r.status === 400, JSON.stringify(r));
    t('a rejected PUT leaves the order alone', (await list()).map(p => p.id).join() === reversed.join());

    // `order` must not be read as a project id by the :id routes.
    r = await request('DELETE', '/api/projects/registered/order');
    t('DELETE .../order is a plain 404, not a project removal', r.status === 404, JSON.stringify(r));
    t('no project was removed', (await list()).length === ids.length);
  } finally {
    child.kill();
  }
}

(async () => {
  try {
    await runHttp();
  } catch (e) {
    t('http part ran', false, e && e.stack);
  }
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
