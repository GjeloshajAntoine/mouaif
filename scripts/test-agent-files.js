'use strict';
// Regression coverage for agent-file state shared by Chat and Settings.
// The chat system-prompt endpoint must report discovered files even when
// injection is disabled, so the chat Agent files card and Settings →
// Project file-name picker describe the same files.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-af-home-'));
process.env.MOUAIF_HOME = TMP_HOME;

const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const agentFiles = require('../src/agentFiles.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}
function getJson(urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 5732, path: urlPath }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, body: buf, parseError: e.message }); }
      });
    }).on('error', reject);
  });
}
async function waitForServer(child, projectDir, chatId) {
  const urlPath = '/api/chats/' + encodeURIComponent(chatId) + '/system-prompt?projectDir=' + encodeURIComponent(projectDir);
  let lastErr = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await getJson(urlPath);
      if (r.status === 200) return r;
      lastErr = new Error('HTTP ' + r.status);
    } catch (e) { lastErr = e; }
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (child.exitCode !== null) break;
  }
  throw lastErr || new Error('server not ready');
}
async function main() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-af-proj-'));
  fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Agent instructions\n\nUse project rules.\n', 'utf8');

  settings.setProject(projectDir, { agentFiles: true });
  const chat = chats.createChat(projectDir, { title: 'Agent files test' });

  check('project-on chat can disable agent files', agentFiles.resolveEnabled({ chat: Object.assign({}, chat, { agentFiles: false }), projectDir }) === false);
  settings.setProject(projectDir, { agentFiles: false });
  check('project-off locks out chat true', agentFiles.resolveEnabled({ chat: Object.assign({}, chat, { agentFiles: true }), projectDir }) === false);
  check('discover still finds files while disabled', agentFiles.discover(projectDir).some((f) => f.name === 'AGENTS.md'));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'mouaif.js'), 'serve'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { MOUAIF_HOME: TMP_HOME }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  try {
    const r = await waitForServer(child, projectDir, chat.id);
    check('system-prompt endpoint returns disabled state', r.body.agentFilesEnabled === false, 'got ' + JSON.stringify(r.body.agentFilesEnabled));
    check('system-prompt endpoint lists available agent files while disabled', Array.isArray(r.body.agentFilesAvailable) && r.body.agentFilesAvailable.some((f) => f.name === 'AGENTS.md'), JSON.stringify(r.body.agentFilesAvailable));
    check('system-prompt endpoint does not inject disabled agent files', r.body.agentFiles === null, JSON.stringify(r.body.agentFiles));
    check('system-prompt endpoint reports project lock', r.body.projectAgentFiles === false, JSON.stringify(r.body.projectAgentFiles));
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));
  }

  try { settings.close(); } catch {}
  console.log('agent-files tests: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('server stdout:\n' + stdout);
    console.log('server stderr:\n' + stderr);
    process.exit(1);
  }
}
main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
