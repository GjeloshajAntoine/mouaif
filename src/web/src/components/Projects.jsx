// mouaif web — ProjectsView
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { fetchJson, projectsReload } from '../api.js';
import { nav } from '../router.js';

export function ProjectsView() {
  const refreshProjects = useRef(null);
  const projectsList = useRef(null);
  const projectsStatus = useRef(null);

  function setStatus(text, state) {
    if (!projectsStatus.current) return;
    projectsStatus.current.textContent = text;
    if (state) projectsStatus.current.dataset.state = state;
    else delete projectsStatus.current.dataset.state;
  }

  async function loadProjects() {
    setStatus('loading…', 'busy');
    let r;
    try { r = await fetchJson('/api/projects/registered'); }
    catch (err) { setStatus('network error', 'error'); return; }
    if (r.status !== 200) { setStatus('HTTP ' + r.status, 'error'); return; }
    const list = r.body.projects || [];
    projectsList.current.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('li');
      empty.className = 'projects__empty';
      const icon = document.createElement('span');
      icon.className = 'projects__empty-icon';
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.379a1.5 1.5 0 0 1 1.06.44L11.88 8.38a.5.5 0 0 0 .354.146H19.5A1.5 1.5 0 0 1 21 10.027v7.473A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z"/></svg>';
      const title = document.createElement('p');
      title.className = 'projects__empty-title';
      title.textContent = 'No projects yet';
      const text = document.createElement('p');
      text.className = 'projects__empty-text';
      text.textContent = 'Tap "Add project" to register a folder on disk. Each project keeps its own chats, prompt profile, and trace setting.';
      empty.appendChild(icon); empty.appendChild(title); empty.appendChild(text);
      projectsList.current.appendChild(empty);
      setStatus(list.length + ' projects');
      return;
    }
    setStatus(list.length + ' projects', 'success');
    for (const project of list) {
      const li = document.createElement('li');
      li.className = 'project-card';
      li.appendChild(renderProjectCard(project));
      projectsList.current.appendChild(li);
      loadProjectChats(li, project);
    }
  }

  function renderProjectCard(project) {
    const frag = document.createDocumentFragment();

    const head = document.createElement('div');
    head.className = 'project-card__head';
    const name = document.createElement('div');
    name.className = 'project-card__name';
    name.textContent = project.name || project.path;
    head.appendChild(name);
    head.appendChild(renderProjectMenu(project));
    frag.appendChild(head);

    const pathEl = document.createElement('div');
    pathEl.className = 'project-card__path';
    pathEl.textContent = project.path;
    frag.appendChild(pathEl);

    const chatsUl = document.createElement('ul');
    chatsUl.className = 'project-card__chats';
    chatsUl.setAttribute('aria-label', 'Chats in ' + (project.name || project.path));
    const placeholder = document.createElement('li');
    placeholder.className = 'project-card__chats-empty';
    placeholder.textContent = 'loading chats…';
    chatsUl.appendChild(placeholder);
    frag.appendChild(chatsUl);

    const newBtn = document.createElement('button');
    newBtn.className = 'project-card__new';
    newBtn.type = 'button';
    newBtn.textContent = '+ New chat';
    newBtn.addEventListener('click', () => createProjectChat(project, newBtn, chatsUl));
    frag.appendChild(newBtn);

    return frag;
  }

  function renderProjectMenu(project) {
    const wrap = document.createElement('div');
    wrap.className = 'project-card__menu';
    const btn = document.createElement('button');
    btn.className = 'project-card__menu-btn';
    btn.type = 'button';
    btn.textContent = '⋯';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Project options');
    wrap.appendChild(btn);
    const pop = document.createElement('div');
    pop.className = 'project-card__menu-pop';
    pop.hidden = true;
    pop.setAttribute('role', 'menu');
    function close() { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    function toggle() { pop.hidden = !pop.hidden; btn.setAttribute('aria-expanded', String(!pop.hidden)); }
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    document.addEventListener('click', () => close());
    function addItem(label, fn, danger) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      if (danger) b.setAttribute('data-danger', '1');
      b.addEventListener('click', (e) => { e.stopPropagation(); close(); fn(); });
      pop.appendChild(b);
    }
    addItem('Rename…', () => renameProject(project));
    addItem('Unregister', () => unregisterProject(project), true);
    wrap.appendChild(pop);
    return wrap;
  }

  async function loadProjectChats(card, project) {
    const ul = card.querySelector('.project-card__chats');
    let r;
    try { r = await fetchJson('/api/chats?projectDir=' + encodeURIComponent(project.path)); }
    catch (err) { renderChatList(ul, [], project); return; }
    if (r.status !== 200) { renderChatList(ul, [], project); return; }
    renderChatList(ul, r.body.chats || [], project);
  }

  function renderChatList(ul, chats, project) {
    ul.innerHTML = '';
    if (!chats.length) {
      const empty = document.createElement('li');
      empty.className = 'project-card__chats-empty';
      empty.textContent = 'no chats yet';
      ul.appendChild(empty);
      return;
    }
    for (const c of chats) {
      const li = document.createElement('li');
      const title = document.createElement('span');
      title.className = 'project-card__chat-title';
      title.textContent = c.title || c.id;
      li.appendChild(title);
      const meta = document.createElement('span');
      meta.className = 'project-card__chat-meta';
      meta.textContent = c.promptSize + ' · ' + fmtDate(c.lastOpenedAt || c.createdAt);
      li.appendChild(meta);
      const del = document.createElement('button');
      del.className = 'project-card__chat-delete';
      del.type = 'button';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Delete chat ' + (c.title || c.id));
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteProjectChat(project, c, li, ul); });
      li.appendChild(del);
      li.addEventListener('click', () => nav('chat/' + c.id + '?projectDir=' + encodeURIComponent(project.path)));
      ul.appendChild(li);
    }
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString();
  }

  async function createProjectChat(project, btn, ul) {
    btn.disabled = true;
    const r = await fetchJson('/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir: project.path }) });
    btn.disabled = false;
    if (r.status !== 201) { alert('create chat failed: HTTP ' + r.status); return; }
    const card = btn.closest('.project-card');
    if (card) loadProjectChats(card, project);
  }

  async function deleteProjectChat(project, chat, li, ul) {
    if (!confirm('Delete chat "' + (chat.title || chat.id) + '"?')) return;
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chat.id) + '?projectDir=' + encodeURIComponent(project.path), { method: 'DELETE' });
    if (r.status !== 200) { alert('delete failed: HTTP ' + r.status); return; }
    li.remove();
    if (!ul.children.length) renderChatList(ul, [], project);
  }

  async function renameProject(project) {
    const next = prompt('Rename project', project.name || project.path);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === project.name) return;
    const r = await fetchJson('/api/projects/registered/' + encodeURIComponent(project.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: trimmed }) });
    if (r.status !== 200) { alert('rename failed: HTTP ' + r.status); return; }
    loadProjects();
  }

  async function unregisterProject(project) {
    if (!confirm('Unregister project "' + (project.name || project.path) + '"? The folder on disk is not touched.')) return;
    const r = await fetchJson('/api/projects/registered/' + encodeURIComponent(project.id), { method: 'DELETE' });
    if (r.status !== 200) { alert('unregister failed: HTTP ' + r.status); return; }
    loadProjects();
  }

  useEffect(() => { loadProjects(); }, [projectsReload.value]);

  return h('section', null,
    h('div', { class: 'row row--actions' },
      h('button', { class: 'btn btn--primary', type: 'button', onClick: () => nav('projects/new') }, '+ Add project'),
      h('button', { ref: refreshProjects, class: 'btn', type: 'button', onClick: loadProjects }, 'Refresh'),
      h('span', { ref: projectsStatus, class: 'status', 'aria-live': 'polite' })
    ),
    h('ul', { ref: projectsList, class: 'projects__list', 'aria-label': 'Registered projects' })
  );
}