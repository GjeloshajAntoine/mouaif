// Render the real folder-picker component (frontend/src/components/ProjectPicker.jsx)
// and assert the add-project storage choice. A Vite build cannot catch a
// render expression that references deleted state, and the config-file option
// is exactly the kind of thing that would silently stop being sent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = (file) => fs.readFileSync(new URL('../frontend/src/components/' + file, import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');

const DIR = '/fixture/project';
const ENTRIES = [
  { name: 'plain', path: DIR + '/plain', hasChildren: false, hasConfig: false },
  { name: 'configured', path: DIR + '/configured', hasChildren: true, hasConfig: true }
];

function createView({ dirHasConfig = false } = {}) {
  const states = [];
  let cursor = 0, first = true, nodes = [], effects = [];
  const requests = [];
  const navigations = [];
  const context = vm.createContext({
    URLSearchParams, TextEncoder, setTimeout, clearTimeout,
    Fragment: 'fragment',
    projectsReload: { value: 0 },
    nav: (to) => navigations.push(to),
    back: (to) => navigations.push('back:' + to),
    useState: (initial) => {
      const i = cursor++;
      if (first) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
    useEffect: (effect) => { effects.push(effect); },
    h: (tag, attrs, ...children) => { const node = { tag, attrs: attrs || {}, children }; nodes.push(node); return node; },
    fetchJson: async (url, init) => {
      if (init && init.method === 'POST') {
        requests.push({ url, body: JSON.parse(init.body) });
        return { status: 200, body: { project: { id: 'p1', path: DIR, name: 'project' }, dbBacked: false, config: null } };
      }
      requests.push({ url, body: null });
      return { status: 200, body: { dir: DIR, dirHasConfig, entries: ENTRIES } };
    }
  });
  vm.runInContext(source('ProjectPicker.jsx'), context);
  function render() {
    cursor = 0; nodes = []; effects = [];
    context.ProjectPickerView({ dir: DIR });
    first = false;
    return nodes;
  }
  async function load() {
    effects.forEach(effect => effect());
    for (let i = 0; i < 30; i++) {
      if (states.some(state => typeof state === 'string' && state.endsWith('folders'))) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error('picker failed to load');
  }
  function find(predicate) { return nodes.find(predicate); }
  function all(predicate) { return nodes.filter(predicate); }
  return { render, load, requests, navigations, states, find, all };
}

// ---- Default: config file in the folder --------------------------------
{
  const view = createView({ dirHasConfig: false });
  view.render();
  await view.load();
  view.render();

  const radios = view.all(node => node.tag === 'input' && node.attrs.type === 'radio');
  assert.equal(radios.length, 2, 'two storage options');
  assert.equal(radios[0].attrs.value, 'configFile');
  assert.equal(radios[1].attrs.value, 'db');
  assert.equal(radios[0].attrs.checked, true, 'the config file option is the default');
  assert.equal(radios[1].attrs.checked, false);

  const legend = view.find(node => node.tag === 'legend');
  assert.ok(legend && String(legend.children[0]).includes('settings live'));

  const note = view.find(node => node.attrs.class === 'picker__storage-note');
  assert.ok(note, 'the live storage note is rendered');
  assert.ok(note.children[0].includes('.mouaif.json is written into the folder'), note.children[0]);

  // Folders that already carry a config file get a badge.
  const badges = view.all(node => node.attrs.class === 'picker__badge');
  assert.equal(badges.length, 1, 'only the configured folder is badged');
  assert.equal(badges[0].children[0], '.mouaif.json');
}

// ---- Existing config file in the folder --------------------------------
{
  const view = createView({ dirHasConfig: true });
  view.render();
  await view.load();
  view.render();
  const note = view.find(node => node.attrs.class === 'picker__storage-note');
  assert.ok(note.children[0].includes('already has a .mouaif.json'), note.children[0]);
}

// ---- Selecting sends configFile: true ----------------------------------
{
  const view = createView();
  view.render();
  await view.load();
  view.render();
  const selectButton = view.find(node => node.attrs['aria-label'] === 'Select this folder');
  assert.ok(selectButton, 'the select button exists');
  await selectButton.attrs.onClick();
  const post = view.requests.find(r => r.body && r.body.action === 'register');
  assert.ok(post, 'register request sent');
  assert.equal(post.body.dir, DIR);
  assert.equal(post.body.configFile, true);
  assert.equal(post.body.dbBacked, false);
}

// ---- Choosing the app DB sends dbBacked: true, no config file ----------
{
  const view = createView();
  view.render();
  await view.load();
  view.render();
  const dbRadio = view.all(node => node.tag === 'input' && node.attrs.type === 'radio')[1];
  dbRadio.attrs.onChange();
  view.render();
  const note = view.find(node => node.attrs.class === 'picker__storage-note');
  assert.ok(note.children[0].includes('app SQLite store'), note.children[0]);
  const selectButton = view.find(node => node.attrs['aria-label'] === 'Select this folder');
  await selectButton.attrs.onClick();
  const post = view.requests.reverse().find(r => r.body && r.body.action === 'register');
  assert.equal(post.body.configFile, false);
  assert.equal(post.body.dbBacked, true);
}

console.log('PASS folder picker storage choice: default config file, existing-config note + badge, and the two register payloads');
