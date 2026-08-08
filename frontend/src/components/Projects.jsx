// mouaif web — ProjectsView
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { fetchJson, projectsReload } from '../api.js';
import { nav } from '../router.js';
import { formatCost } from '../usage.js';

const CHAT_PAGE_SIZE = 30;

export function ProjectsView() {
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
    const costEl = document.createElement('span');
    costEl.className = 'project-card__cost';
    // Use the persisted project total cost from the registered list.
    const costBits = project.totalCost || { total: 0, known: false, currency: 'USD' };
    costEl.textContent = costBits.known ? formatCost(costBits.total) : '--';
    head.appendChild(costEl);
    head.appendChild(renderProjectMenu(project));
    frag.appendChild(head);

    const pathEl = document.createElement('div');
    pathEl.className = 'project-card__path';
    pathEl.textContent = project.path;
    frag.appendChild(pathEl);

    const chatsUl = document.createElement('ul');
    chatsUl.className = 'project-card__chats';
    chatsUl.setAttribute('aria-label', 'Chats in ' + (project.name || project.path));
    chatsUl.addEventListener('scroll', () => {
      if (chatsUl.scrollTop + chatsUl.clientHeight >= chatsUl.scrollHeight - 48) {
        loadMoreProjectChats(chatsUl, project);
      }
    });
    const placeholder = document.createElement('li');
    placeholder.className = 'project-card__chats-empty';
    placeholder.textContent = 'loading chats…';
    chatsUl.appendChild(placeholder);
    frag.appendChild(chatsUl);

    const newBtn = document.createElement('button');
    newBtn.className = 'project-card__new';
    newBtn.type = 'button';
    newBtn.textContent = '+ New chat';
    newBtn.addEventListener('click', () => createProjectChat(project, newBtn));
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
    // Document-level close is wired once at the view level (see
    // the useEffect below) so it doesn't stack one listener per
    // project card on every reload. The pop's own toggle still
    // stops propagation so the document click won't re-close it
    // mid-toggle.
    function addItem(label, fn, danger) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      if (danger) b.setAttribute('data-danger', '1');
      b.addEventListener('click', (e) => { e.stopPropagation(); close(); fn(); });
      pop.appendChild(b);
    }
    // Settings… opens the project-overrides view for THIS project
    // (the raw .mouaif.json editor + the resolved view + the Shell
    // tool toggle), so the user can review and edit every setting —
    // including the security-sensitive ones — from the card itself.
    addItem('Settings…', () => nav('settings/project?projectDir=' + encodeURIComponent(project.path)));
    addItem('Rename…', () => renameProject(project));
    addItem('Unregister', () => unregisterProject(project), true);
    wrap.appendChild(pop);
    return wrap;
  }

  async function loadProjectChats(card, project) {
    const ul = card.querySelector('.project-card__chats');
    if (!ul) return;
    ul.dataset.loading = '1';
    ul.dataset.offset = '0';
    ul.dataset.total = '0';
    let r;
    try { r = await fetchJson('/api/chats?projectDir=' + encodeURIComponent(project.path) + '&offset=0&limit=' + CHAT_PAGE_SIZE); }
    catch (err) { renderChatList(ul, [], project, { total: 0 }); return; }
    if (r.status !== 200) { renderChatList(ul, [], project, { total: 0 }); return; }
    const chats = r.body.chats || [];
    renderChatList(ul, chats, project, { total: r.body.total || chats.length, append: false });
  }

  async function loadMoreProjectChats(ul, project) {
    if (!ul || ul.dataset.loading === '1') return;
    const offset = parseInt(ul.dataset.offset || '0', 10) || 0;
    const total = parseInt(ul.dataset.total || '0', 10) || 0;
    if (total && offset >= total) return;
    ul.dataset.loading = '1';
    const sentinel = renderChatLoading(ul);
    let r;
    try { r = await fetchJson('/api/chats?projectDir=' + encodeURIComponent(project.path) + '&offset=' + offset + '&limit=' + CHAT_PAGE_SIZE); }
    catch (err) { sentinel.remove(); ul.dataset.loading = '0'; return; }
    sentinel.remove();
    if (r.status !== 200) { ul.dataset.loading = '0'; return; }
    const chats = r.body.chats || [];
    renderChatList(ul, chats, project, { total: r.body.total || total || (offset + chats.length), append: true });
  }

  function renderChatList(ul, chats, project, opts = {}) {
    if (!opts.append) ul.innerHTML = '';
    const total = typeof opts.total === 'number' ? opts.total : chats.length;
    if (!opts.append) ul.dataset.total = String(total);
    if (!chats.length && !opts.append) {
      ul.dataset.offset = '0';
      ul.dataset.loading = '0';
      const empty = document.createElement('li');
      empty.className = 'project-card__chats-empty';
      // Warmer copy than 'no chats yet': mentions the + New chat
      // button so the user knows where the primary action is.
      empty.textContent = 'No chats yet. Tap "+ New chat" below to start one.';
      ul.appendChild(empty);
      return;
    }
    // The API returns chats sorted by recency and paginated; keep
    // that order while appending later pages so the list can scroll
    // indefinitely without re-rendering already-visible rows.
    for (const c of chats) {
      const li = document.createElement('li');
      const title = document.createElement('span');
      title.className = 'project-card__chat-title';
      // The server defaults title to 'New chat' on create, so a
      // missing title usually means the user never renamed it.
      // Show 'New chat' rather than the 8-char hex id so the row
      // stays human-readable.
      title.textContent = (c.title && c.title.trim()) ? c.title : 'New chat';
      li.appendChild(title);
      const meta = document.createElement('span');
      meta.className = 'project-card__chat-meta';
      // The chat list shows the running cost of the chat instead
      // of the prompt-size profile label. The server attaches a
      // `totalCost` block on every chat in GET /api/chats:
      //   { total: <USD>, known: <bool>, currency: 'USD' }
      // `known` is false when the chat has no assistant messages
      // with a cost block yet (e.g. brand new, or the upstream
      // never reported usage) — render `--` so the row doesn't
      // look like the chat cost $0.00. For known totals, format
      // the same way the per-turn meta line does (decision §14):
      // 2–5 fractional digits, locale decimal separator, $ prefix.
      const costBits = c.totalCost || { total: 0, known: false, currency: 'USD' };
      const costStr = costBits.known ? formatCost(costBits.total) : '--';
      const dateBits = fmtChatDate(c);
      // dateBits.kind is 'opened' when lastOpenedAt is set,
      // 'created' otherwise. Prefix with a single short word so
      // the user can tell at a glance whether the date is "when
      // I last opened it" or "when I created it and never went
      // back". The trace indicator is appended on the right with
      // a small dot so the on/off state is glanceable on a phone.
      const dateStr = (dateBits.kind === 'created' ? 'new · ' : '') + dateBits.text;
      const traceStr = c.trace ? ' · trace' : '';
      meta.textContent = costStr + ' · ' + dateStr + traceStr;
      if (c.trace) meta.dataset.trace = '1';
      // Running indicator: the list endpoint surfaces the same
      // response-only `running` flag as GET /api/chats/:id, so a
      // chat with a run in flight is glanceable from the project
      // card (e.g. started on another tab/device). Shown as a
      // pulsing dot before the meta text; the flag is a snapshot
      // at load time, so it clears on the next list reload.
      if (c.running) {
        meta.dataset.running = '1';
        const dot = document.createElement('span');
        dot.className = 'project-card__chat-running';
        dot.setAttribute('aria-hidden', 'true');
        li.appendChild(dot);
        li.setAttribute('aria-label', ((c.title && c.title.trim()) ? c.title : 'New chat') + ' (running)');
      }
      // Mark the row so the per-row styling / a future tooltip
      // can reach for the known/total fields without re-parsing
      // the formatted text. data-cost-known is "1" / "0".
      meta.dataset.costKnown = costBits.known ? '1' : '0';
      li.appendChild(meta);
      const del = document.createElement('button');
      del.className = 'project-card__chat-delete';
      del.type = 'button';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Delete chat ' + ((c.title && c.title.trim()) ? c.title : c.id));
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteProjectChat(project, c, li, ul); });
      li.appendChild(del);
      li.addEventListener('click', () => nav('chat/' + c.id + '?projectDir=' + encodeURIComponent(project.path)));
      ul.appendChild(li);
    }
    const nextOffset = (parseInt(ul.dataset.offset || '0', 10) || 0) + chats.length;
    ul.dataset.offset = String(nextOffset);
    ul.dataset.total = String(total);
    ul.dataset.loading = '0';
    if (nextOffset < total) {
      const more = document.createElement('li');
      more.className = 'project-card__chats-more';
      more.textContent = 'Scroll for more…';
      ul.appendChild(more);
    }
  }

  function renderChatLoading(ul) {
    const existing = ul.querySelector('.project-card__chats-more');
    if (existing) existing.remove();
    const li = document.createElement('li');
    li.className = 'project-card__chats-more';
    li.textContent = 'Loading more…';
    ul.appendChild(li);
    return li;
  }

  // Smart date for the chat list: prefer the lastOpenedAt when
  // set, fall back to createdAt. Two chats created on the same
  // day would otherwise be indistinguishable on a long list, so
  // we also return a kind ('opened' vs 'created') and a text
  // string that combines a short date with the time. Today shows
  // just the time; this year shows the short date; older chats
  // show the date with the year. The kind lets the caller prefix
  // a "new" marker when the chat was never opened.
  function fmtChatDate(chat) {
    const iso = chat && (chat.lastOpenedAt || chat.createdAt);
    if (!iso) return { kind: 'created', text: '' };
    const d = new Date(iso);
    if (isNaN(d.getTime())) return { kind: 'created', text: '' };
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const sameYear = d.getFullYear() === now.getFullYear();
    let text;
    if (sameDay) text = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    else if (sameYear) text = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    else text = d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
    return { kind: chat.lastOpenedAt ? 'opened' : 'created', text };
  }

  async function createProjectChat(project, btn) {
    btn.disabled = true;
    let r;
    try { r = await fetchJson('/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir: project.path }) }); }
    catch (err) { btn.disabled = false; alert('create chat failed: network error'); return; }
    btn.disabled = false;
    if (r.status !== 201) { alert('create chat failed: HTTP ' + r.status); return; }
    // Navigate straight into the new chat. Re-loading the list
    // in-place (the previous behavior) left the user staring at
    // a +1 entry that they still had to tap; auto-navigation
    // makes the primary action a single tap.
    const chat = r.body && r.body.chat;
    if (chat && chat.id) {
      nav('chat/' + encodeURIComponent(chat.id) + '?projectDir=' + encodeURIComponent(project.path));
    } else {
      // Fallback: server didn't return the new chat record; just
      // refresh the list so the row appears.
      const card = btn.closest('.project-card');
      if (card) loadProjectChats(card, project);
    }
  }

  async function deleteProjectChat(project, chat, li, ul) {
    if (!confirm('Delete chat "' + (chat.title || chat.id) + '"?')) return;
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chat.id) + '?projectDir=' + encodeURIComponent(project.path), { method: 'DELETE' });
    if (r.status !== 200) { alert('delete failed: HTTP ' + r.status); return; }
    li.remove();
    const offset = Math.max(0, (parseInt(ul.dataset.offset || '0', 10) || 0) - 1);
    const total = Math.max(0, (parseInt(ul.dataset.total || '0', 10) || 0) - 1);
    ul.dataset.offset = String(offset);
    ul.dataset.total = String(total);
    if (!ul.querySelector('li:not(.project-card__chats-more)')) renderChatList(ul, [], project, { total: 0 });
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

  // Global click-to-close for every project-card options popover.
  // The previous design attached a `document.addEventListener('click')`
  // inside `renderProjectMenu`, which ran once per card and never
  // removed the listener. After reloading the projects list N
  // times, N listeners were stacked on `document`. Attaching once
  // at the view level and cleaning up on unmount keeps the count
  // flat regardless of how many times the list is refreshed.
  useEffect(() => {
    function onDocClick(ev) {
      // The popover buttons themselves call stopPropagation() in
      // their own click handler, so a click on a project's ⋯
      // button never reaches this listener. Clicks anywhere else
      // (including the popover's menu items, which also
      // stopPropagation, but a stray click on the page body) close
      // every open popover.
      const open = document.querySelectorAll('.project-card__menu-pop:not([hidden])');
      for (const pop of open) {
        pop.hidden = true;
        const btn = pop.parentElement && pop.parentElement.querySelector('.project-card__menu-btn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
      }
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  useEffect(() => {
    loadProjects().catch((err) => {
      // Unhandled rejection: the network-error path inside
      // loadProjects already covers fetch failures, so this only
      // fires for unexpected throws (e.g. setStatus on an
      // unmounted ref). Don't swallow silently.
      if (projectsStatus.current) setStatus('load failed', 'error');
      else console.warn('loadProjects rejected:', err);
    });
  }, [projectsReload.value]);

  // The action bar is a slim row: a small page title on the left
  // ("Chats") and a single + button on the right. Refresh is gone
  // — the list re-loads when the route is re-entered, which is
  // when the user actually needs fresh data.
  return h('section', null,
    h('div', { class: 'page-bar' },
      h('div', { class: 'page-bar__title' }, 'Chats'),
      h('span', { ref: projectsStatus, class: 'status page-bar__status', 'aria-live': 'polite' }),
      h('button', { class: 'page-bar__add', type: 'button', onClick: () => nav('projects/new'), 'aria-label': 'Add project' }, '+')
    ),
    h('ul', { ref: projectsList, class: 'projects__list', 'aria-label': 'Registered projects' })
  );
}