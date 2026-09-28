// End-to-end smoke test for the add-project "config file in the folder"
// option on POST /api/projects { action: 'register' }. Spawns a real server,
// registers folders with and without `configFile`, and checks the file on
// disk, the response payload, and the picker's `hasConfig` reporting.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const mouaifHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-cfg-home-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-cfg-proj-'));

let pass = 0, fail = 0;
function t(name, cond, msg) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (msg ? (' :: ' + msg) : '')); }
}

let port = 0;

function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      method, host: '127.0.0.1', port, path: p,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let json; try { json = JSON.parse(b); } catch { json = b; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await request('GET', '/');
      if (typeof r.status === 'number') return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function pickFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function run() {
  port = await pickFreePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'mouaif.js'), 'serve', '--port', String(port), '--host', '127.0.0.1'], {
    env: Object.assign({}, process.env, {
      MOUAIF_HOME: mouaifHome,
      MOUAIF_ALLOW_ANY_ROOT: '1'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });
  const up = await waitForServer();
  if (!up) { console.error('server failed to start:\n' + serverLog); child.kill(); process.exit(1); }

  try {
    // A folder that has a hand-written config file we must adopt untouched.
    const adopted = path.join(root, 'adopted');
    fs.mkdirSync(adopted);
    const adoptedFile = path.join(adopted, '.mouaif.json');
    fs.writeFileSync(adoptedFile, JSON.stringify({ name: 'hand-written', promptSize: 'chat' }, null, 2) + '\n', 'utf8');
    const adoptedBefore = fs.readFileSync(adoptedFile, 'utf8');

    // A folder registered with no config option must not gain a file.
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);

    // A folder registered with configFile + dbBacked must not gain a file.
    const dbOnly = path.join(root, 'db-only');
    fs.mkdirSync(dbOnly);

    // A folder that will get a config file created for it.
    const created = path.join(root, 'created');
    fs.mkdirSync(created);

    const fileCreated = await request('POST', '/api/projects', { action: 'register', dir: created, configFile: true });
    t('register { configFile: true } 200', fileCreated.status === 200, JSON.stringify(fileCreated));
    t('response reports the file was created', fileCreated.body && fileCreated.body.config
      && fileCreated.body.config.created === true && fileCreated.body.config.adopted === false,
      JSON.stringify(fileCreated.body && fileCreated.body.config));
    t('the file lands at the folder root', fs.existsSync(path.join(created, '.mouaif.json')));
    t('the file names the project after the folder',
      JSON.parse(fs.readFileSync(path.join(created, '.mouaif.json'), 'utf8')).name === 'created');

    const fileAdopted = await request('POST', '/api/projects', { action: 'register', dir: adopted, configFile: true });
    t('register { configFile: true } adopts an existing file', fileAdopted.status === 200
      && fileAdopted.body.config && fileAdopted.body.config.adopted === true
      && fileAdopted.body.config.created === false, JSON.stringify(fileAdopted.body && fileAdopted.body.config));
    t('adopted file is untouched', fs.readFileSync(adoptedFile, 'utf8') === adoptedBefore);

    const plainRes = await request('POST', '/api/projects', { action: 'register', dir: plain });
    t('register without configFile 200', plainRes.status === 200, JSON.stringify(plainRes));
    t('register without configFile writes no file', !fs.existsSync(path.join(plain, '.mouaif.json')));
    t('register without configFile reports no config payload', plainRes.body && plainRes.body.config === null);

    const dbRes = await request('POST', '/api/projects', { action: 'register', dir: dbOnly, configFile: true, dbBacked: true });
    t('register { configFile + dbBacked } 200', dbRes.status === 200, JSON.stringify(dbRes));
    t('a DB-backed project is not given a file', !fs.existsSync(path.join(dbOnly, '.mouaif.json')));

    // The picker listing flags which subfolders already carry a config file.
    const list = await request('GET', '/api/projects?dir=' + encodeURIComponent(root));
    t('GET /api/projects 200', list.status === 200, JSON.stringify(list));
    const byName = new Map((list.body.entries || []).map((e) => [e.name, e]));
    t('listing flags the created folder', byName.get('created') && byName.get('created').hasConfig === true);
    t('listing flags the adopted folder', byName.get('adopted') && byName.get('adopted').hasConfig === true);
    t('listing leaves the plain folder unflagged', byName.get('plain') && byName.get('plain').hasConfig === false);
    t('listing reports the browsed folder itself', list.body.dirHasConfig === false);
  } finally {
    child.kill('SIGTERM');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(mouaifHome, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
