// mouaif web — ProjectPickerView
import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { fetchJson, projectsReload } from '../api.js';
import { nav, back } from '../router.js';

// The per-project settings file. Kept next to the labels so the strings a
// user reads (the option labels / the file name) never drift.
const CONFIG_FILE = '.mouaif.json';
const CONFIG_DIR = '.mouaif/';

// Where a new project's settings live. Same file name in both file layouts;
// `folder` keeps it (and traces etc.) under one `.mouaif/` dir for complex
// projects. `db` writes nothing to the folder.
const STORAGE_OPTIONS = [
  { value: 'root', label: CONFIG_FILE, hint: 'File at the folder root' },
  { value: 'folder', label: CONFIG_DIR, hint: 'File inside a .mouaif/ folder' },
  { value: 'db', label: 'App DB', hint: 'Nothing written to the folder' }
];

// Last path segment, for the "Add <name>" button.
function baseName(dir) {
  const norm = String(dir || '').replace(/[\\/]+$/, '');
  const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  return (idx >= 0 ? norm.slice(idx + 1) : norm) || norm || 'home';
}

export function ProjectPickerView(props) {
  const [currentDir, setCurrentDir] = useState(typeof props.dir === 'string' ? props.dir : '');
  const [entries, setEntries] = useState([]);
  const [status, setStatus] = useState('loading…');
  const [newName, setNewName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  // Where the project's settings will live: 'root' (default, <dir>/.mouaif.json),
  // 'folder' (<dir>/.mouaif/.mouaif.json) or 'db' (app store, folder
  // untouched). Mutually exclusive — a DB-backed project reads no file, so
  // offering to write one would be a lie.
  const [storage, setStorage] = useState('root');
  // Which config file the folder in view already carries ('root' | 'folder' |
  // null). Answered by the directory listing, refreshed as the user navigates.
  const [dirConfigLayout, setDirConfigLayout] = useState(null);

  async function load(dir) {
    const useDir = dir ?? currentDir;
    setCurrentDir(useDir);
    setStatus('loading…');
    setEntries([]);
    const url = useDir ? ('/api/projects?dir=' + encodeURIComponent(useDir)) : '/api/projects';
    let r;
    try { r = await fetchJson(url); }
    catch (err) { setStatus('network error'); return; }
    if (r.status !== 200) {
      setStatus((r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status));
      return;
    }
    const nextDir = r.body.dir || useDir;
    setCurrentDir(nextDir);
    const nextEntries = r.body.entries || [];
    setEntries(nextEntries);
    const layout = r.body.dirConfigLayout;
    setDirConfigLayout(layout === 'root' || layout === 'folder'
      ? layout
      : (r.body.dirHasConfig === true ? 'root' : null));
    setStatus(nextEntries.length + ' folders');
  }

  async function selectDir(dir) {
    setStatus('registering…');
    const dbBacked = storage === 'db';
    const configFile = !dbBacked;
    const payload = { action: 'register', dir, dbBacked, configFile };
    if (configFile) payload.configLayout = storage;
    let r;
    try { r = await fetchJson('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
    catch (err) { setStatus('network error'); return; }
    if (r.status !== 200) {
      setStatus((r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status));
      return;
    }
    projectsReload.value++;
    back('projects');
  }

  async function createFolder() {
    const name = newName.trim();
    if (!name) { setStatus('name is required'); return; }
    const parent = currentDir;
    setIsCreating(true);
    setStatus('creating…');
    let r;
    try { r = await fetchJson('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', parent, name }) }); }
    catch (err) { setStatus('network error'); setIsCreating(false); return; }
    if (r.status === 201) {
      setNewName('');
      setStatus('created.');
      setIsCreating(false);
      nav('projects/new?dir=' + encodeURIComponent(r.body.path));
    } else {
      setStatus((r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status));
      setIsCreating(false);
    }
  }

  function parentDir() {
    const d = currentDir;
    if (!d) return null;
    const norm = d.replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    return idx > 0 ? norm.slice(0, idx) : '';
  }

  useEffect(() => { load(props.dir || ''); }, [props.dir]);

  // What the chosen option does to the folder in view. Concrete about "this
  // folder" so the user knows which case they are in before they commit. An
  // existing config file is always adopted where it is — never moved or
  // duplicated — so the note says so when the choice would differ.
  const existingPath = dirConfigLayout === 'folder' ? CONFIG_DIR + CONFIG_FILE : CONFIG_FILE;
  const storageNote = storage === 'db'
    ? 'Settings go in the app database. Nothing is written to the folder.'
    : dirConfigLayout
      ? 'Uses the existing ' + existingPath + ' as-is.'
      : storage === 'folder'
        ? 'Writes ' + CONFIG_DIR + CONFIG_FILE + ' — one folder for all mouaif files.'
        : 'Writes ' + CONFIG_FILE + ' at the folder root.';

  function goUp() {
    const parent = parentDir();
    if (parent != null) nav('projects/new?dir=' + encodeURIComponent(parent));
  }

  function openEntry(e) {
    nav('projects/new?dir=' + encodeURIComponent(e.path));
  }

  // Layout, top to bottom: header, current path + Up, the folder list (the
  // thing being browsed, first on screen), "Create new folder", then a sticky
  // bottom bar with the storage choice and one explicit "Add <folder>" button.
  // The choice only matters at the moment of adding, so it sits next to the
  // button that acts on it instead of pushing the list below the fold.
  const busy = status === 'registering…';
  return h('section', { class: 'picker' },
    h('div', { class: 'view-head' },
      h('a', { href: '#/projects', class: 'view-back', 'aria-label': 'Back to projects' }, '‹'),
      h('h2', { class: 'view-title' }, 'Add project')
    ),
    h('div', { class: 'picker__bar' },
      h('button', {
        class: 'btn picker__up',
        type: 'button',
        onClick: goUp,
        disabled: !currentDir || parentDir() == null,
        'aria-label': 'Go to parent folder'
      }, '↑'),
      h('p', { class: 'picker__path', title: currentDir || 'user home' }, currentDir || 'user home')
    ),
    h('p', { class: 'status picker__status', 'aria-live': 'polite' }, status),
    h('ul', { class: 'picker__list', 'aria-label': 'Subfolders' },
      entries.length === 0
        ? h('li', { class: 'picker__empty' }, 'no subfolders here')
        : entries.map(e => h('li', {
            key: e.name,
            class: 'picker__row',
            role: 'button',
            tabIndex: 0,
            onClick: () => openEntry(e),
            onKeyDown: (ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                openEntry(e);
              }
            }
          },
          h('span', { class: 'picker__name' }, e.name),
          e.hasConfig
            ? h('span', { class: 'picker__badge', title: 'Has a config file' },
                e.configLayout === 'folder' ? CONFIG_DIR : CONFIG_FILE)
            : null,
          h('span', { class: 'picker__meta', 'aria-hidden': 'true' }, '›')
        ))
    ),
    h('details', { class: 'picker__create' },
      h('summary', null, 'Create new folder'),
      h('div', { class: 'row' },
        h('input', {
          class: 'input',
          id: 'newFolderName',
          type: 'text',
          placeholder: 'folder name',
          value: newName,
          onInput: (e) => setNewName(e.target.value)
        })
      ),
      h('div', { class: 'row row--actions' },
        h('button', {
          class: 'btn btn--primary',
          type: 'button',
          onClick: createFolder,
          disabled: isCreating
        }, 'Create')
      )
    ),
    h('div', { class: 'picker__footer' },
    h('fieldset', { class: 'picker__storage' },
      h('legend', { class: 'picker__storage-legend' }, 'Settings stored in'),
      // A stacked list, not a segmented row: each choice gets its own row
      // with the file name and what happens in words, so a small screen
      // reads the consequence instead of decoding a chip. Always visible —
      // no collapse — so where the settings go is never hidden behind a tap.
      h('ul', { class: 'picker__storage-list', role: 'radiogroup' },
      STORAGE_OPTIONS.map(opt => h('li', { key: opt.value },
        h('label', {
        class: 'picker__storage-item' + (storage === opt.value ? ' is-on' : ''),
        title: opt.hint
        },
        h('input', {
          type: 'radio',
          name: 'picker-storage',
          value: opt.value,
          checked: storage === opt.value,
          onChange: () => setStorage(opt.value),
          'aria-label': opt.label + ' — ' + opt.hint
        }),
        h('span', { class: 'picker__storage-item-mark', 'aria-hidden': 'true' }),
        h('span', { class: 'picker__storage-item-text' },
          h('span', { class: 'picker__storage-item-label' }, opt.label),
          h('span', { class: 'picker__storage-item-hint' }, opt.hint)
        )
        )
      ))
      ),
      h('p', { class: 'picker__storage-note', 'aria-live': 'polite' }, storageNote)
    ),
      h('button', {
        class: 'btn btn--primary picker__add',
        type: 'button',
        onClick: () => selectDir(currentDir),
        disabled: busy || !currentDir,
        'aria-label': 'Select this folder'
      }, busy ? 'Adding…' : ('Add “' + baseName(currentDir) + '”'))
    )
  );
}
