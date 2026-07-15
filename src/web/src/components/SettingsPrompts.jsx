// mouaif web — SettingsPromptsView + SettingsPromptEditView
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { fetchJson, setStatus } from '../api.js';
import { nav } from '../router.js';

export function SettingsPromptsView() {
  const projectDir = useRef(null);
  const loadBtn = useRef(null);
  const listEl = useRef(null);
  const statusEl = useRef(null);

  let currentDir = '';

  async function load() {
    const dir = (projectDir.current && projectDir.current.value || '').trim();
    if (!dir) { setStatus(statusEl, 'project directory is required', 'error'); return; }
    currentDir = dir;
    if (loadBtn.current) loadBtn.current.disabled = true;
    setStatus(statusEl, 'loading…', 'busy');
    let r;
    try { r = await fetchJson('/api/prompts?projectDir=' + encodeURIComponent(dir)); }
    catch (err) { setStatus(statusEl, 'network error', 'error'); if (loadBtn.current) loadBtn.current.disabled = false; return; }
    if (loadBtn.current) loadBtn.current.disabled = false;
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); return; }
    const list = r.body.prompts || [];
    renderList(list);
    setStatus(statusEl, list.length + (list.length === 1 ? ' prompt' : ' prompts'), 'success');
  }

  function renderList(list) {
    if (!listEl.current) return;
    listEl.current.innerHTML = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'prompts__empty';
      li.textContent = 'No custom prompts yet. Tap "Add prompt" to create your first one.';
      listEl.current.appendChild(li);
      return;
    }
    for (const p of list) {
      const li = document.createElement('li');
      li.className = 'prompt-row';
      const main = document.createElement('a');
      main.className = 'prompt-row__main';
      main.href = '#/settings/prompts/' + encodeURIComponent(p.id) + '?projectDir=' + encodeURIComponent(currentDir);
      const name = document.createElement('div');
      name.className = 'prompt-row__title';
      name.textContent = p.title || p.id;
      const meta = document.createElement('div');
      meta.className = 'prompt-row__meta';
      meta.textContent = '(' + p.role + ')  ' + (p.content.length > 60 ? p.content.slice(0, 60) + '…' : p.content);
      main.appendChild(name);
      main.appendChild(meta);
      const chev = document.createElement('div');
      chev.className = 'prompt-row__chev';
      chev.textContent = '›';
      main.appendChild(chev);
      li.appendChild(main);
      listEl.current.appendChild(li);
    }
  }

  useEffect(() => { load(); }, []);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Custom prompts')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, 'Per-project system/role prompts. Saved in the project\'s .mouaif.json alongside other settings.'),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sp-prompts-dir' }, 'Project directory'),
        h('input', { ref: projectDir, class: 'input', id: 'sp-prompts-dir', type: 'text', placeholder: 'C:\\path\\to\\project' })
      ),
      h('div', { class: 'row row--actions' },
        h('button', { ref: loadBtn, class: 'btn btn--primary', type: 'button', onClick: load }, 'Load'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      ),
      h('ul', { ref: listEl, class: 'prompts__list', 'aria-label': 'Custom prompts' }),
      h('div', { class: 'row row--actions' },
        h('a', { href: '#/settings/prompts/new?projectDir=' + encodeURIComponent(currentDir), class: 'btn btn--primary' }, '+ Add prompt')
      )
    )
  );
}

export function SettingsPromptEditView(props) {
  const promptId = props.id || '';
  const qs = typeof window !== 'undefined' ? new URLSearchParams(window.location.hash.split('?')[1] || '') : new URLSearchParams();
  const dirFromHash = qs.get('projectDir') || '';
  const [currentDir, setCurrentDir] = h(Fragment, null); // signal via ref

  const projectDirRef = useRef(null);
  const titleRef = useRef(null);
  const contentRef = useRef(null);
  const roleRef = useRef(null);
  const saveBtn = useRef(null);
  const deleteBtn = useRef(null);
  const statusEl = useRef(null);

  let loadedDir = '';

  async function load() {
    if (!promptId) {
      // New prompt: seed project dir from URL param
      if (projectDirRef.current) projectDirRef.current.value = dirFromHash;
      return;
    }
    const dir = (projectDirRef.current && projectDirRef.current.value || '').trim();
    if (!dir) { setStatus(statusEl, 'project directory is required', 'error'); return; }
    loadedDir = dir;
    setStatus(statusEl, 'loading…', 'busy');
    let r;
    try { r = await fetchJson('/api/prompts/' + encodeURIComponent(promptId) + '?projectDir=' + encodeURIComponent(dir)); }
    catch (err) { setStatus(statusEl, 'network error', 'error'); return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); return; }
    const p = r.body.prompt;
    if (titleRef.current) titleRef.current.value = p.title || '';
    if (contentRef.current) contentRef.current.value = p.content || '';
    if (roleRef.current) roleRef.current.value = p.role || 'system';
    setStatus(statusEl, 'loaded', 'success');
  }

  function getDir() {
    return (projectDirRef.current && projectDirRef.current.value || '').trim();
  }

  async function save() {
    const dir = getDir();
    if (!dir) { setStatus(statusEl, 'project directory is required', 'error'); return; }
    const title = (titleRef.current && titleRef.current.value || '').trim();
    const content = (contentRef.current && contentRef.current.value || '').trim();
    const role = roleRef.current ? roleRef.current.value : 'system';
    if (!content) { setStatus(statusEl, 'prompt content is required', 'error'); return; }
    if (saveBtn.current) saveBtn.current.disabled = true;
    setStatus(statusEl, 'saving…', 'busy');
    const body = { projectDir: dir, title, content, role };
    const url = promptId ? '/api/prompts/' + encodeURIComponent(promptId) : '/api/prompts';
    const method = promptId ? 'PATCH' : 'POST';
    let r;
    try { r = await fetchJson(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (err) { setStatus(statusEl, 'network error', 'error'); if (saveBtn.current) saveBtn.current.disabled = false; return; }
    if (saveBtn.current) saveBtn.current.disabled = false;
    if (r.status !== 200 && r.status !== 201) { setStatus(statusEl, 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''), 'error'); return; }
    setStatus(statusEl, 'saved.', 'success');
    if (!promptId && r.status === 201) {
      // Redirect to edit the new prompt
      nav('settings/prompts/' + encodeURIComponent(r.body.prompt.id) + '?projectDir=' + encodeURIComponent(dir));
    }
  }

  async function deletePrompt() {
    if (!promptId) return;
    if (!confirm('Delete this prompt? Models in this project will no longer see it.')) return;
    const dir = getDir();
    if (!dir) { setStatus(statusEl, 'project directory is required', 'error'); return; }
    if (deleteBtn.current) deleteBtn.current.disabled = true;
    setStatus(statusEl, 'deleting…', 'busy');
    let r;
    try { r = await fetchJson('/api/prompts/' + encodeURIComponent(promptId) + '?projectDir=' + encodeURIComponent(dir), { method: 'DELETE' }); }
    catch (err) { setStatus(statusEl, 'network error', 'error'); if (deleteBtn.current) deleteBtn.current.disabled = false; return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); if (deleteBtn.current) deleteBtn.current.disabled = false; return; }
    nav('settings/prompts');
  }

  useEffect(() => { load(); }, []);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/prompts', class: 'view-back', 'aria-label': 'Back to prompts' }, '←'),
      h('h2', { class: 'view-title' }, promptId ? 'Edit prompt' : 'Add prompt')
    ),
    h('section', null,
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'spe-dir' }, 'Project directory'),
        h('input', { ref: projectDirRef, class: 'input', id: 'spe-dir', type: 'text', placeholder: 'C:\\path\\to\\project' })
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'spe-title' }, 'Title'),
        h('input', { ref: titleRef, class: 'input', id: 'spe-title', type: 'text', placeholder: 'My custom prompt' })
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'spe-role' }, 'Role'),
        h('select', { ref: roleRef, class: 'input', id: 'spe-role' },
          h('option', { value: 'system' }, 'system'),
          h('option', { value: 'user' }, 'user'),
          h('option', { value: 'assistant' }, 'assistant')
        )
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'spe-content' }, 'Prompt content'),
        h('textarea', { ref: contentRef, class: 'input prompts__textarea', id: 'spe-content', rows: 6, placeholder: 'You are a helpful assistant specialized in…' })
      ),
      h('div', { class: 'row row--actions' },
        h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: save }, promptId ? 'Save' : 'Create'),
        h('button', { ref: deleteBtn, class: 'btn btn--danger', type: 'button', onClick: deletePrompt, hidden: !promptId }, 'Delete'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      )
    )
  );
}