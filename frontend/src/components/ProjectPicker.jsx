// mouaif web — ProjectPickerView
import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { fetchJson, projectsReload } from '../api.js';
import { nav } from '../router.js';

export function ProjectPickerView(props) {
  const [currentDir, setCurrentDir] = useState(typeof props.dir === 'string' ? props.dir : '');
  const [entries, setEntries] = useState([]);
  const [status, setStatus] = useState('loading…');
  const [newName, setNewName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

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
    setStatus(nextEntries.length + ' folders');
  }

  async function selectDir(dir) {
    setStatus('registering…');
    let r;
    try { r = await fetchJson('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'register', dir }) }); }
    catch (err) { setStatus('network error'); return; }
    if (r.status !== 200) {
      setStatus((r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status));
      return;
    }
    projectsReload.value++;
    nav('projects');
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

  // The picker is a single full-bleed list. Each row is the whole
  // row tap target (open the folder). A trailing select button on
  // each row lets the user pick it without navigating in. The
  // current directory is shown as a single small breadcrumb above
  // the list; the action row is a single "Select this folder"
  // button for the current path.
  return h('section', null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/projects', class: 'view-back', 'aria-label': 'Back to projects' }, '‹'),
      h('h2', { class: 'view-title' }, 'Pick a folder')
    ),
    h('p', { class: 'picker__path' }, currentDir || 'user home'),
    h('div', { class: 'page-bar' },
      h('span', { class: 'status page-bar__status', 'aria-live': 'polite' }, status),
      h('button', { class: 'btn', type: 'button', onClick: () => {
        const parent = parentDir();
        if (parent != null) nav('projects/new?dir=' + encodeURIComponent(parent));
      }, 'aria-label': 'Go to parent folder' }, '↑ Up'),
      h('button', { class: 'page-bar__add', type: 'button', onClick: () => selectDir(currentDir), 'aria-label': 'Select this folder' }, '✓')
    ),
    h('ul', { class: 'picker__list', 'aria-label': 'Subfolders' },
      entries.length === 0
        ? h('li', { class: 'picker__empty' }, 'no subfolders here')
        : entries.map(e => h('li', {
            key: e.name,
            class: 'picker__row',
            role: 'button',
            tabIndex: 0,
            onClick: () => nav('projects/new?dir=' + encodeURIComponent(e.path)),
            onKeyDown: (ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                nav('projects/new?dir=' + encodeURIComponent(e.path));
              }
            }
          },
          h('span', { class: 'picker__name' }, e.name),
          h('span', { class: 'picker__meta' }, '›')
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
    )
  );
}