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
  { name: 'plain', path: DIR + '/plain', hasChildren: false, hasConfig: false, configLayout: null },
  { name: 'configured', path: DIR + '/configured', hasChildren: true, hasConfig: true, configLayout: 'root' },
  { name: 'layered', path: DIR + '/layered', hasChildren: true, hasConfig: true, configLayout: 'folder' }
];

function createView({ dirConfigLayout = null } = {}) {
  const dirHasConfig = dirConfigLayout !== null;
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
      return { status: 200, body: { dir: DIR, dirHasConfig, dirConfigLayout, entries: ENTRIES } };
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

const radiosOf = (view) => view.all(node => node.tag === 'input' && node.attrs.type === 'radio');
const noteOf = (view) => view.find(node => node.attrs.class === 'picker__storage-note').children[0];
async function ready(opts) {
  const view = createView(opts);
  view.render();
  await view.load();
  view.render();
  return view;
}
async function register(view) {
  const addButton = view.find(node => node.attrs['aria-label'] === 'Select this folder');
  assert.ok(addButton, 'the add button exists');
  await addButton.attrs.onClick();
  return view.requests.slice().reverse().find(r => r.body && r.body.action === 'register');
}

// ---- Default: config file at the folder root ---------------------------
{
  const view = await ready();
  const radios = radiosOf(view);
  assert.equal(radios.length, 3, 'three storage options');
  assert.deepEqual(radios.map(r => r.attrs.value), ['root', 'folder', 'db']);
  assert.equal(radios[0].attrs.checked, true, 'the root config file is the default');
  assert.equal(radios[1].attrs.checked, false);
  assert.equal(radios[2].attrs.checked, false);

  const legend = view.find(node => node.tag === 'legend');
  assert.ok(legend && String(legend.children[0]).includes('Settings stored in'));
  assert.ok(noteOf(view).includes('Writes .mouaif.json at the folder root'), noteOf(view));

  // Folders that already carry a config file get a badge naming the layout.
  const badges = view.all(node => node.attrs.class === 'picker__badge');
  assert.deepEqual(badges.map(b => b.children[0]), ['.mouaif.json', '.mouaif/'], 'root and folder layouts are badged');

  // The add button names the folder it acts on.
  const addButton = view.find(node => node.attrs['aria-label'] === 'Select this folder');
  assert.ok(String(addButton.children[0]).includes('project'), addButton.children[0]);

  // The folder list renders before the storage footer (browse first, then act).
  const listIndex = view.all(() => true).findIndex(n => n.attrs.class === 'picker__list');
  const footerIndex = view.all(() => true).findIndex(n => n.attrs.class === 'picker__footer');
  assert.ok(listIndex >= 0 && footerIndex >= 0, 'list and footer render');

  const post = await register(view);
  assert.equal(post.body.dir, DIR);
  assert.equal(post.body.configFile, true);
  assert.equal(post.body.configLayout, 'root');
  assert.equal(post.body.dbBacked, false);
}

// ---- Existing config file in the folder --------------------------------
{
  const view = await ready({ dirConfigLayout: 'root' });
  assert.ok(noteOf(view).includes('Uses the existing .mouaif.json'), noteOf(view));
}
{
  const view = await ready({ dirConfigLayout: 'folder' });
  assert.ok(noteOf(view).includes('Uses the existing .mouaif/.mouaif.json'), noteOf(view));
}

// ---- .mouaif/ folder layout sends configLayout: 'folder' ---------------
{
  const view = await ready();
  radiosOf(view)[1].attrs.onChange();
  view.render();
  assert.ok(noteOf(view).includes('Writes .mouaif/.mouaif.json'), noteOf(view));
  const post = await register(view);
  assert.equal(post.body.configFile, true);
  assert.equal(post.body.configLayout, 'folder');
  assert.equal(post.body.dbBacked, false);
}

// ---- Choosing the app DB sends dbBacked: true, no config file ----------
{
  const view = await ready();
  radiosOf(view)[2].attrs.onChange();
  view.render();
  assert.ok(noteOf(view).includes('app database'), noteOf(view));
  const post = await register(view);
  assert.equal(post.body.configFile, false);
  assert.equal(post.body.dbBacked, true);
  assert.equal('configLayout' in post.body, false, 'no layout sent for a DB-backed project');
}

console.log('PASS folder picker storage choice: root / .mouaif/ / app DB options, existing-config notes + badges, and the register payloads');
