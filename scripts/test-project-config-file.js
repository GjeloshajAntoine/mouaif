'use strict';
// Add-project "config file in the folder" — src/projects.js config helpers and
// their directory-listing reporting. Runs in-process with a temp MOUAIF_HOME;
// test folders live under the real home so the folder-picker allowlist applies.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-config-file-home-'));
process.env.MOUAIF_HOME = HOME;
const projects = require('../src/projects.js');

let pass = 0, fail = 0;
function t(name, cond, msg) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (msg ? (' :: ' + msg) : '')); }
}

const root = fs.mkdtempSync(path.join(os.homedir(), '.mouaif-test-config-'));

// ---- create -------------------------------------------------------------
const empty = path.join(root, 'empty-project');
fs.mkdirSync(empty);
t('hasConfig false for a fresh folder', projects.hasConfig(empty) === false);
const made = projects.ensureProjectConfig(empty);
t('ensureProjectConfig reports created', made.created === true && made.adopted === false, JSON.stringify(made));
t('ensureProjectConfig writes .mouaif.json at the folder root',
  made.path === path.join(empty, '.mouaif.json') && fs.existsSync(made.path));
const createdBody = JSON.parse(fs.readFileSync(made.path, 'utf8'));
t('the written file names the project after the folder', createdBody.name === 'empty-project', JSON.stringify(createdBody));
t('the written file ends with a newline (hand-editable)', fs.readFileSync(made.path, 'utf8').endsWith('\n'));
t('hasConfig true after creating', projects.hasConfig(empty) === true);

// A custom name wins over the basename.
const named = projects.ensureProjectConfig(empty, { name: '  Custom Name  ' });
t('ensureProjectConfig adopts instead of overwriting an existing file',
  named.created === false && named.adopted === true, JSON.stringify(named));
t('the existing file is left byte-for-byte untouched',
  fs.readFileSync(made.path, 'utf8') === JSON.stringify(createdBody, null, 2) + '\n');
t('ensureProjectConfig reads the name from the existing file', named.name === 'empty-project');

// ---- adopt --------------------------------------------------------------
const existing = path.join(root, 'existing-project');
fs.mkdirSync(existing);
const existingFile = path.join(existing, '.mouaif.json');
fs.writeFileSync(existingFile, JSON.stringify({ name: 'hand-written', promptSize: 'chat' }, null, 2) + '\n', 'utf8');
const before = fs.readFileSync(existingFile, 'utf8');
const adopted = projects.ensureProjectConfig(existing);
t('an existing config file is adopted', adopted.adopted === true && adopted.created === false);
t('adoption keeps the file content', fs.readFileSync(existingFile, 'utf8') === before);
t('adoption reports the file name it carries', adopted.name === 'hand-written');
t('a config file with no name adopts with name null',
  (() => {
    const f = path.join(existing, '.mouaif.json');
    fs.writeFileSync(f, JSON.stringify({ promptSize: 'chat' }) + '\n', 'utf8');
    const r = projects.ensureProjectConfig(existing);
    return r.adopted === true && r.name === null;
  })());

// ---- corrupt existing file ---------------------------------------------
// Adopting a corrupt file must fail loudly rather than silently overwrite the
// user's bytes (a truncated file is repairable; a clobbered one is gone).
const broken = path.join(root, 'broken-project');
fs.mkdirSync(broken);
const brokenFile = path.join(broken, '.mouaif.json');
fs.writeFileSync(brokenFile, '{ not json', 'utf8');
let brokenErr = null;
try { projects.ensureProjectConfig(broken); } catch (e) { brokenErr = e; }
t('a corrupt config file is reported, not overwritten',
  brokenErr && brokenErr.code === 'MOUAIF_PROJECT_PARSE_ERROR', brokenErr && brokenErr.message);
t('the corrupt file is still on disk unchanged', fs.readFileSync(brokenFile, 'utf8') === '{ not json');

// ---- directory listing reports config presence --------------------------
const list = projects.listDir(root);
t('the listing reports the current folder has no config by default',
  projects.listDir(empty).dirHasConfig === true);
t('the listing flags a subfolder that has a config file',
  list.entries.find((e) => e.name === 'existing-project').hasConfig === true);
t('the listing leaves a subfolder without one unflagged',
  list.entries.find((e) => e.name === 'empty-project').hasConfig === true); // empty-project got one above
const noneDir = path.join(root, 'plain');
fs.mkdirSync(noneDir);
t('a plain subfolder is flagged false',
  projects.listDir(root).entries.find((e) => e.name === 'plain').hasConfig === false);

// ---- guard rails --------------------------------------------------------
t('hasConfig refuses a relative path', projects.hasConfig('relative/dir') === false);
let outsideErr = null;
try { projects.ensureProjectConfig('/etc'); } catch (e) { outsideErr = e; }
t('ensureProjectConfig applies the home allowlist',
  outsideErr && outsideErr.code === 'EOUTSIDE_HOME', outsideErr && outsideErr.code);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
