// mouaif web — SettingsPromptsView + SettingsPromptEditView
//
// Both views are project-scoped. The active project is resolved in
// this order:
//   1. The `projectDir` prop passed in from the router (used by
//      deep links and tests).
//   2. The `activeProject` signal (set when the user opened a chat).
// If neither resolves, the view shows a "pick a project" empty
// state and never calls the API.
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { fetchJson, setStatus, activeProject } from '../api.js';
import { nav } from '../router.js';

function resolveProjectDir(view) {
  if (view && view.projectDir) return view.projectDir;
  return (activeProject.value && activeProject.value.dir) || '';
}

export function SettingsPromptsView(props) {
  const projectDir = resolveProjectDir(props);
  const listEl = useRef(null);
  const statusEl = useRef(null);

  async function load() {
    if (!projectDir) {
      if (listEl.current) listEl.current.innerHTML = '';
      setStatus(statusEl, 'open a chat to pick a project first', 'error');
      return;
    }
    setStatus(statusEl, 'loading…', 'busy');
    let r;
    try { r = await fetchJson('/api/prompts?projectDir=' + encodeURIComponent(projectDir)); }
    catch (err) { setStatus(statusEl, 'network error', 'error'); return; }
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
      main.href = '#/settings/prompts/' + encodeURIComponent(p.id) + '?projectDir=' + encodeURIComponent(projectDir);
      const name = document.createElement('div');
      name.className = 'prompt-row__title';
      name.textContent = p.title || p.id;
      const meta = document.createElement('div');
      meta.className = 'prompt-row__meta';
      meta.textContent = p.content.length > 60 ? p.content.slice(0, 60) + '…' : p.content;
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

  useEffect(() => { load(); }, [projectDir]);

  if (!projectDir) {
    return h(Fragment, null,
      h('div', { class: 'view-head' },
        h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
        h('h2', { class: 'view-title' }, 'Custom prompts')
      ),
      h('section', null,
        h('p', { class: 'hint' }, 'No project selected. Open a chat to pick a project, or use the picker to add a new one.'),
        h('div', { class: 'row row--actions' },
          h('a', { href: '#/projects/new', class: 'btn btn--primary' }, 'Open project picker')
        )
      )
    );
  }

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/project', class: 'view-back', 'aria-label': 'Back to project' }, '←'),
      h('h2', { class: 'view-title' }, 'Custom prompts')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, 'Per-project system prompts. Saved in the project\'s .mouaif.json alongside other settings.'),
      h('p', { class: 'hint hint--compact' }, h('code', null, projectDir)),
      h('ul', { ref: listEl, class: 'prompts__list', 'aria-label': 'Custom prompts' }),
      h('div', { class: 'row row--actions' },
        h('a', {
          href: '#/settings/prompts/new?projectDir=' + encodeURIComponent(projectDir),
          class: 'btn btn--primary'
        }, '+ Add prompt'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      )
    )
  );
}

export function SettingsPromptEditView(props) {
  const promptId = (props && props.id) || '';
  const projectDir = resolveProjectDir(props);
  const titleRef = useRef(null);
  const contentRef = useRef(null);
  const saveBtn = useRef(null);
  const deleteBtn = useRef(null);
  const statusEl = useRef(null);

  async function load() {
    if (!projectDir) {
      setStatus(statusEl, 'no project selected', 'error');
      return;
    }
    if (!promptId) {
      // New prompt — nothing to load; refs are pre-cleared.
      if (titleRef.current) titleRef.current.value = '';
      if (contentRef.current) contentRef.current.value = '';
      setStatus(statusEl, '', '');
      return;
    }
    setStatus(statusEl, 'loading…', 'busy');
    let r;
    try { r = await fetchJson('/api/prompts/' + encodeURIComponent(promptId) + '?projectDir=' + encodeURIComponent(projectDir)); }
    catch (err) { setStatus(statusEl, 'network error', 'error'); return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); return; }
    const p = r.body.prompt;
    if (titleRef.current) titleRef.current.value = p.title || '';
    if (contentRef.current) contentRef.current.value = p.content || '';
    setStatus(statusEl, 'loaded', 'success');
  }

  async function save() {
    if (!projectDir) { setStatus(statusEl, 'no project selected', 'error'); return; }
    const title = (titleRef.current && titleRef.current.value || '').trim();
    const content = (contentRef.current && contentRef.current.value || '').trim();
    if (!content) { setStatus(statusEl, 'prompt content is required', 'error'); return; }
    if (saveBtn.current) saveBtn.current.disabled = true;
    setStatus(statusEl, 'saving…', 'busy');
    const body = { projectDir, title, content };
    const url = promptId ? '/api/prompts/' + encodeURIComponent(promptId) : '/api/prompts';
    const method = promptId ? 'PATCH' : 'POST';
    let r;
    try { r = await fetchJson(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (err) { setStatus(statusEl, 'network error', 'error'); if (saveBtn.current) saveBtn.current.disabled = false; return; }
    if (saveBtn.current) saveBtn.current.disabled = false;
    if (r.status !== 200 && r.status !== 201) { setStatus(statusEl, 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''), 'error'); return; }
    setStatus(statusEl, 'saved.', 'success');
    if (!promptId && r.status === 201) {
      nav('settings/prompts/' + encodeURIComponent(r.body.prompt.id) + '?projectDir=' + encodeURIComponent(projectDir));
    }
  }

  async function deletePrompt() {
    if (!promptId) return;
    if (!projectDir) { setStatus(statusEl, 'no project selected', 'error'); return; }
    if (!confirm('Delete this prompt? Chats that referenced it will fall back to no custom prompt.')) return;
    if (deleteBtn.current) deleteBtn.current.disabled = true;
    setStatus(statusEl, 'deleting…', 'busy');
    let r;
    try { r = await fetchJson('/api/prompts/' + encodeURIComponent(promptId) + '?projectDir=' + encodeURIComponent(projectDir), { method: 'DELETE' }); }
    catch (err) { setStatus(statusEl, 'network error', 'error'); if (deleteBtn.current) deleteBtn.current.disabled = false; return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); if (deleteBtn.current) deleteBtn.current.disabled = false; return; }
    nav('settings/prompts?projectDir=' + encodeURIComponent(projectDir));
  }

  useEffect(() => { load(); }, [projectDir, promptId]);

  if (!projectDir) {
    return h(Fragment, null,
      h('div', { class: 'view-head' },
        h('a', { href: '#/settings/project', class: 'view-back', 'aria-label': 'Back' }, '←'),
        h('h2', { class: 'view-title' }, promptId ? 'Edit prompt' : 'Add prompt')
      ),
      h('section', null,
        h('p', { class: 'hint' }, 'No project selected. Open a chat to pick a project, or use the picker to add a new one.'),
        h('div', { class: 'row row--actions' },
          h('a', { href: '#/projects/new', class: 'btn btn--primary' }, 'Open project picker')
        )
      )
    );
  }

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/prompts?projectDir=' + encodeURIComponent(projectDir), class: 'view-back', 'aria-label': 'Back to prompts' }, '←'),
      h('h2', { class: 'view-title' }, promptId ? 'Edit prompt' : 'Add prompt')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, h('code', null, projectDir)),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'spe-title' }, 'Title'),
        h('input', { ref: titleRef, class: 'input', id: 'spe-title', type: 'text', placeholder: 'My custom prompt' })
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
