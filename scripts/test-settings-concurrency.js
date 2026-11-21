'use strict';

// Two processes, one app DB, no HTTP listeners. Run: node scripts/test-settings-concurrency.js
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROUNDS = 30;

function worker(root, workerId) {
  const settings = require('../src/settings.js');
  const projects = require('../src/projects.js');
  const content = require('../src/content/service.js');
  const collections = require('../src/content/collection.js');
  settings.getDb();
  process.once('message', () => {
    for (let i = 0; i < ROUNDS; i++) {
      const key = `patch_${workerId}_${i}`;
      for (const name of ['file', 'db']) {
        content.applyPatch({ scope: 'project', projectDir: path.join(root, name), patch: { [key]: i } });
      }
      if (workerId === 'a') {
        projects.registerProject(path.join(root, 'registry', String(i)));
        projects.registerProject(path.join(root, 'shared'));
      } else {
        // Use the settings route's collection write path, concurrently with
        // registration and with edits to the registry itself.
        collections.put('providers', 'app', undefined, { id: `provider-${i}`, type: 'openai-compatible' });
        projects.registerProject(path.join(root, 'shared'));
        projects.renameProject(projects.listProjects().find(p => p.path === path.join(root, 'shared')).id, 'Shared');
      }
    }
    settings.close();
    process.disconnect();
  });
  process.send('ready');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-settings-concurrency-'));
  process.env.MOUAIF_HOME = path.join(root, 'home');
  process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
  const settings = require('../src/settings.js');
  const children = [];
  try {
    for (const name of ['file', 'db', 'shared']) fs.mkdirSync(path.join(root, name));
    for (let i = 0; i < ROUNDS; i++) fs.mkdirSync(path.join(root, 'registry', String(i)), { recursive: true });
    settings.setProject(path.join(root, 'file'), { existing: true });
    settings.setDbBacked(path.join(root, 'db'), true);
    settings.setProject(path.join(root, 'db'), { existing: true });
    let ready = 0;
    const exits = ['a', 'b'].map((id) => new Promise((resolve, reject) => {
      const child = fork(__filename, [root, id]);
      children.push(child);
      child.on('error', reject);
      child.once('message', () => {
        if (++ready === 2) for (const worker of children) worker.send('go');
      });
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`worker ${id} exited: ${signal || code}`));
      });
    }));
    await Promise.all(exits);
    for (const name of ['file', 'db']) {
      const project = settings.getProject(path.join(root, name));
      assert.equal(project.existing, true);
      for (const id of ['a', 'b']) {
        for (let i = 0; i < ROUNDS; i++) assert.equal(project[`patch_${id}_${i}`], i, `${name}: ${id} patch ${i} was lost`);
      }
    }
    const app = settings.getApp();
    assert.equal(app.providers.length, ROUNDS);
    assert.equal(app.projects.filter(p => p.path.startsWith(path.join(root, 'registry') + path.sep)).length, ROUNDS);
    const shared = app.projects.filter(p => p.path === path.join(root, 'shared'));
    assert.equal(shared.length, 1, 'duplicate registrations should coalesce');
    assert.equal(shared[0].name, 'Shared');
    console.log('Concurrent settings patches, providers and project registrations survived');
  } finally {
    await Promise.all(children.map((child) => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      return new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    }));
    settings.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.send) worker(process.argv[2], process.argv[3]);
else main().catch((error) => { console.error(error); process.exitCode = 1; });
