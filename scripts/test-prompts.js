'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const mouaifHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-prompts-home-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-proj-'));
process.env.MOUAIF_HOME = mouaifHome;

const http = require('http');
const { spawn } = require('child_process');
const prompts = require('../src/prompts.js');
const settings = require('../src/settings.js');

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
  // 1. Direct module tests
  const appPrompt = prompts.createPrompt('', { title: 'Global Helper', icon: 'code', showOnProjectCard: true, content: 'You are global.', scope: 'app' });
t('create app prompt has scope app', appPrompt.scope === 'app');
t('create app prompt has content', appPrompt.content === 'You are global.');
t('create app prompt keeps icon', appPrompt.icon === 'code');
t('create app prompt keeps project-card option', appPrompt.showOnProjectCard === true);

  const projPrompt = prompts.createPrompt(root, { title: 'Project Helper', icon: '<svg>', showOnProjectCard: 'yes', content: 'You are project.', scope: 'project' });
t('create project prompt has scope project', projPrompt.scope === 'project');
t('invalid prompt icon falls back safely', projPrompt.icon === 'sparkles');
t('project-card option only accepts true', projPrompt.showOnProjectCard === false);

  const appOnlyList = prompts.listPrompts('', { scope: 'app' });
  t('listPrompts with scope app has 1 prompt', appOnlyList.length === 1 && appOnlyList[0].id === appPrompt.id);

  const projMergedList = prompts.listPrompts(root);
  t('listPrompts for project merges both app and project prompts', projMergedList.length === 2);

  // Preset check
  const preset = prompts.getPromptPreset(root, appPrompt.id);
  t('getPromptPreset finds app prompt in project scope', preset === null);

  // Close direct settings connection before spawning server
  settings.close();

  // 2. HTTP API tests
  port = await pickFreePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'mouaif.js'), 'serve', '--port', String(port), '--host', '127.0.0.1'], {
    env: Object.assign({}, process.env, {
      MOUAIF_HOME: mouaifHome,
      MOUAIF_ALLOW_ANY_ROOT: '1'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const up = await waitForServer();
  if (!up) { child.kill(); process.exit(1); }

  try {
    // GET /api/prompts (app scope)
    const getApp = await request('GET', '/api/prompts');
    t('GET /api/prompts without projectDir returns app prompts', getApp.status === 200 && getApp.body.prompts.length === 1, JSON.stringify(getApp));

    // GET /api/prompts?projectDir=...
    const getProj = await request('GET', '/api/prompts?projectDir=' + encodeURIComponent(root));
    t('GET /api/prompts?projectDir=... returns merged prompts', getProj.status === 200 && getProj.body.prompts.length === 2, JSON.stringify(getProj));

    // POST /api/prompts (app scope)
    const postApp = await request('POST', '/api/prompts', { scope: 'app', title: 'Second App Prompt', content: 'App 2' });
    t('POST /api/prompts with scope app creates 201', postApp.status === 201 && postApp.body.prompt.scope === 'app', JSON.stringify(postApp));

    // PATCH /api/prompts/:id (app scope)
    const patchApp = await request('PATCH', '/api/prompts/' + encodeURIComponent(appPrompt.id), { title: 'Global Helper v2', icon: 'search', showOnProjectCard: false });
t('PATCH /api/prompts/:id updates app prompt', patchApp.status === 200 && patchApp.body.prompt.title === 'Global Helper v2', JSON.stringify(patchApp));
t('PATCH /api/prompts/:id updates icon and project-card option', patchApp.body.prompt.icon === 'search' && patchApp.body.prompt.showOnProjectCard === false, JSON.stringify(patchApp));
const createChat = await request('POST', '/api/chats', { projectDir: root, promptId: projPrompt.id });
t('POST /api/chats persists promptId', createChat.status === 201 && createChat.body.chat.promptId === projPrompt.id, JSON.stringify(createChat));
const invalidChat = await request('POST', '/api/chats', { projectDir: root, promptId: 'missing-prompt' });
t('POST /api/chats rejects unknown promptId', invalidChat.status === 400, JSON.stringify(invalidChat));
const invalidPromptType = await request('POST', '/api/chats', { projectDir: root, promptId: 123 });
t('POST /api/chats rejects non-string promptId', invalidPromptType.status === 400, JSON.stringify(invalidPromptType));
const invalidPatch = await request('PATCH', '/api/chats/' + encodeURIComponent(createChat.body.chat.id), { projectDir: root, promptId: 'missing-prompt' });
t('PATCH /api/chats rejects unknown promptId', invalidPatch.status === 400, JSON.stringify(invalidPatch));
// DELETE /api/prompts/:id
    const delApp = await request('DELETE', '/api/prompts/' + encodeURIComponent(appPrompt.id) + '?scope=app');
    t('DELETE /api/prompts/:id?scope=app removes prompt', delApp.status === 200 && delApp.body.ok === true, JSON.stringify(delApp));

    const afterDel = await request('GET', '/api/prompts');
    t('app prompts count after delete is 1', afterDel.body.prompts.length === 1, JSON.stringify(afterDel));

    // DELETE project prompt
    const delProj = await request('DELETE', '/api/prompts/' + encodeURIComponent(projPrompt.id) + '?projectDir=' + encodeURIComponent(root));
    t('DELETE /api/prompts/:id?projectDir=... removes project prompt', delProj.status === 200 && delProj.body.ok === true, JSON.stringify(delProj));
  } finally {
    child.kill('SIGTERM');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
