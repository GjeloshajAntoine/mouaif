// mouaif web — ProjectPickerView
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { fetchJson, projectsReload } from '../api.js';
import { nav } from '../router.js';

export function ProjectPickerView(props) {
  const statusEl = useRef(null);
  const listEl = useRef(null);
  const newNameEl = useRef(null);
  const createBtn = useRef(null);
  const currentDir = signal(typeof props.dir === 'string' ? props.dir : '');

  async function load(dir) {
    if (dir) currentDir.value = dir;
    const useDir = currentDir.value;
    if (statusEl.current) statusEl.current.textContent = 'loading…';
    if (listEl.current) listEl.current.innerHTML = '';
    const url = useDir ? ('/api/projects?dir=' + encodeURIComponent(useDir)) : '/api/projects';
    let r;
    try { r = await fetchJson(url); }
    catch (err) { if (statusEl.current) statusEl.current.textContent = 'network error'; return; }
    if (r.status !== 200) {
      if (statusEl.current) statusEl.current.textContent = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      return;
    }
    currentDir.value = r.body.dir || useDir;
    if (statusEl.current) statusEl.current.textContent = r.body.entries.length + ' folders';
    renderEntries(r.body.entries || [], r.body.dir);
  }

  function renderEntries(entries, dir) {
    if (!listEl.current) return;
    listEl.current.innerHTML = '';
    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'picker__empty';
      li.textContent = 'no subfolders here';
      listEl.current.appendChild(li);
      return;
    }
    for (const e of entries) {
      const li = document.createElement('li');
      li.className = 'picker__row';
      const name = document.createElement('span');
      name.className = 'picker__name';
      name.textContent = e.name;
      li.appendChild(name);
      if (e.hasChildren) {
        const open = document.createElement('button');
        open.className = 'picker__open';
        open.type = 'button';
        open.textContent = 'Open';
        open.setAttribute('aria-label', 'Open ' + e.name);
        open.addEventListener('click', () => nav('projects/new?dir=' + encodeURIComponent(e.path)));
        li.appendChild(open);
      } else {
        const leaf = document.createElement('span');
        leaf.className = 'picker__leaf';
        leaf.textContent = 'empty';
        li.appendChild(leaf);
      }
      const select = document.createElement('button');
      select.className = 'picker__select';
      select.type = 'button';
      select.textContent = 'Select';
      select.setAttribute('aria-label', 'Select ' + e.name);
      select.addEventListener('click', () => selectDir(e.path));
      li.appendChild(select);
      listEl.current.appendChild(li);
    }
  }

  async function selectDir(dir) {
    if (statusEl.current) statusEl.current.textContent = 'registering…';
    let r;
    try { r = await fetchJson('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'register', dir }) }); }
    catch (err) { if (statusEl.current) statusEl.current.textContent = 'network error'; return; }
    if (r.status !== 200) {
      if (statusEl.current) statusEl.current.textContent = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      return;
    }
    projectsReload.value++;
    nav('projects');
  }

  async function createFolder() {
    const name = (newNameEl.current && newNameEl.current.value || '').trim();
    if (!name) { if (statusEl.current) statusEl.current.textContent = 'name is required'; return; }
    const parent = currentDir.value;
    if (createBtn.current) createBtn.current.disabled = true;
    if (statusEl.current) statusEl.current.textContent = 'creating…';
    let r;
    try { r = await fetchJson('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', parent, name }) }); }
    catch (err) { if (statusEl.current) statusEl.current.textContent = 'network error'; if (createBtn.current) createBtn.current.disabled = false; return; }
    if (r.status === 201) {
      if (newNameEl.current) newNameEl.current.value = '';
      if (statusEl.current) statusEl.current.textContent = 'created.';
      nav('projects/new?dir=' + encodeURIComponent(r.body.path));
    } else {
      if (statusEl.current) statusEl.current.textContent = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      if (createBtn.current) createBtn.current.disabled = false;
    }
  }

  function parentDir() {
    const d = currentDir.value;
    if (!d) return null;
    const norm = d.replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    return idx > 0 ? norm.slice(0, idx) : '';
  }

  useEffect(() => { load(props.dir || ''); }, [props.dir]);

  return h('section', null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/projects', class: 'view-back', 'aria-label': 'Back to projects' }, '←'),
      h('h2', { class: 'view-title' }, 'Pick a project folder')
    ),
    h('p', { class: 'hint picker__path' }, currentDir.value || 'user home'),
    h('div', { class: 'row row--actions' },
      currentDir.value ? h('button', { class: 'btn', type: 'button', onClick: () => { const p = parentDir(); nav('projects/new?dir=' + encodeURIComponent(p || '')); } }, '↑ Up') : null,
      h('button', { class: 'btn btn--primary', type: 'button', onClick: () => selectDir(currentDir.value) }, 'Select this folder'),
      h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
    ),
    h('ul', { ref: listEl, class: 'picker__list', 'aria-label': 'Subfolders' }),
    h('details', { class: 'picker__create' },
      h('summary', null, 'Create new folder'),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'newFolderName' }, 'name'),
        h('input', { ref: newNameEl, class: 'input', id: 'newFolderName', type: 'text', placeholder: 'my-new-app' })
      ),
      h('div', { class: 'row row--actions' },
        h('button', { ref: createBtn, class: 'btn btn--primary', type: 'button', onClick: createFolder }, 'Create')
      )
    )
  );
}