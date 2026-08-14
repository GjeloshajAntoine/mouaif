// mouaif web — ProjectsView
import { h, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { fetchJson, projectsReload } from '../api.js';
import { nav } from '../router.js';
import { formatCost } from '../usage.js';
import { useClickOutside } from '../hooks/useClickOutside.js';

const CHAT_PAGE_SIZE = 30;

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

function ProjectMenu({ project, onRename, onUnregister }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  useClickOutside(menuRef, () => setOpen(false), open);

  return h('div', { ref: menuRef, class: 'project-card__menu' },
    h('button', {
      class: 'project-card__menu-btn',
      type: 'button',
      'aria-haspopup': 'true',
      'aria-expanded': String(open),
      'aria-label': 'Project options',
      onClick: (e) => { e.stopPropagation(); setOpen(!open); }
    }, '⋯'),
    h('div', {
      class: 'project-card__menu-pop',
      hidden: !open,
      role: 'menu',
      onClick: e => e.stopPropagation()
    },
      h('button', { type: 'button', onClick: () => { setOpen(false); nav('settings/project?projectDir=' + encodeURIComponent(project.path)); } }, 'Settings…'),
      h('button', { type: 'button', onClick: () => { setOpen(false); onRename(project); } }, 'Rename…'),
      h('button', { type: 'button', 'data-danger': '1', onClick: () => { setOpen(false); onUnregister(project); } }, 'Unregister')
    )
  );
}

function ChatList({ project }) {
  const [chats, setChats] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    let canceled = false;
    async function init() {
      setLoading(true);
      try {
        const r = await fetchJson('/api/chats?projectDir=' + encodeURIComponent(project.path) + '&offset=0&limit=' + CHAT_PAGE_SIZE);
        if (canceled) return;
        if (r.status === 200) {
          const list = r.body.chats || [];
          setChats(list);
          setTotal(r.body.total || list.length);
          setOffset(list.length);
        } else {
          setChats([]);
          setTotal(0);
        }
      } catch (err) {
        if (!canceled) { setChats([]); setTotal(0); }
      }
      if (!canceled) setLoading(false);
    }
    init();
    return () => { canceled = true; };
  }, [project.path]);

  async function loadMore() {
    if (loadingMore || loading || offset >= total) return;
    setLoadingMore(true);
    try {
      const r = await fetchJson('/api/chats?projectDir=' + encodeURIComponent(project.path) + '&offset=' + offset + '&limit=' + CHAT_PAGE_SIZE);
      if (r.status === 200) {
        const list = r.body.chats || [];
        setChats(prev => [...prev, ...list]);
        setTotal(r.body.total || total || (offset + list.length));
        setOffset(prev => prev + list.length);
      }
    } catch (err) {}
    setLoadingMore(false);
  }

  async function createChat() {
    setIsCreating(true);
    try {
      const r = await fetchJson('/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir: project.path }) });
      if (r.status !== 201) { alert('create chat failed: HTTP ' + r.status); setIsCreating(false); return; }
      const chat = r.body && r.body.chat;
      if (chat && chat.id) {
        nav('chat/' + encodeURIComponent(chat.id) + '?projectDir=' + encodeURIComponent(project.path));
      } else {
        // Fallback: reload list
        const r2 = await fetchJson('/api/chats?projectDir=' + encodeURIComponent(project.path) + '&offset=0&limit=' + CHAT_PAGE_SIZE);
        if (r2.status === 200) {
          const list = r2.body.chats || [];
          setChats(list);
          setTotal(r2.body.total || list.length);
          setOffset(list.length);
        }
        setIsCreating(false);
      }
    } catch (err) {
      alert('create chat failed: network error');
      setIsCreating(false);
    }
  }

  async function deleteChat(chat) {
    if (!confirm('Delete chat "' + (chat.title || chat.id) + '"?')) return;
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chat.id) + '?projectDir=' + encodeURIComponent(project.path), { method: 'DELETE' });
    if (r.status !== 200) { alert('delete failed: HTTP ' + r.status); return; }
    setChats(prev => prev.filter(c => c.id !== chat.id));
    setTotal(prev => Math.max(0, prev - 1));
    setOffset(prev => Math.max(0, prev - 1));
  }

  return h(Fragment, null,
    h('ul', {
      class: 'project-card__chats',
      'aria-label': 'Chats in ' + (project.name || project.path),
      onScroll: (e) => {
        const el = e.currentTarget;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) {
          loadMore();
        }
      }
    },
      loading ? h('li', { class: 'project-card__chats-empty' }, 'loading chats…') :
      (chats.length === 0) ? h('li', { class: 'project-card__chats-empty' }, 'No chats yet. Tap "+ New chat" below to start one.') :
      chats.map(c => {
        const costBits = c.totalCost || { total: 0, known: false, currency: 'USD' };
        const costStr = costBits.known ? formatCost(costBits.total) : '--';
        const dateBits = fmtChatDate(c);
        const dateStr = (dateBits.kind === 'created' ? 'new · ' : '') + dateBits.text;
        const traceStr = c.trace ? ' · trace' : '';
        const titleStr = (c.title && c.title.trim()) ? c.title : 'New chat';

        return h('li', {
          key: c.id,
          onClick: () => nav('chat/' + c.id + '?projectDir=' + encodeURIComponent(project.path)),
          'aria-label': c.running ? titleStr + ' (running)' : undefined
        },
          h('span', { class: 'project-card__chat-title' }, titleStr),
          c.running ? h('span', { class: 'project-card__chat-running', 'aria-hidden': 'true' }) : null,
          h('span', {
            class: 'project-card__chat-meta',
            'data-trace': c.trace ? '1' : undefined,
            'data-running': c.running ? '1' : undefined,
            'data-cost-known': costBits.known ? '1' : '0'
          }, costStr + ' · ' + dateStr + traceStr),
          h('button', {
            class: 'project-card__chat-delete',
            type: 'button',
            'aria-label': 'Delete chat ' + titleStr,
            onClick: (e) => { e.stopPropagation(); deleteChat(c); }
          }, '×')
        );
      }),
      loadingMore ? h('li', { class: 'project-card__chats-more' }, 'Loading more…') :
      (!loading && offset < total) ? h('li', { class: 'project-card__chats-more' }, 'Scroll for more…') : null
    ),
    h('button', {
      class: 'project-card__new',
      type: 'button',
      onClick: createChat,
      disabled: isCreating
    }, '+ New chat')
  );
}

export function ProjectsView() {
  const [projects, setProjects] = useState([]);
  const [statusText, setStatusText] = useState('loading…');
  const [statusState, setStatusState] = useState('busy');

  async function loadProjects() {
    setStatusText('loading…');
    setStatusState('busy');
    try {
      const r = await fetchJson('/api/projects/registered');
      if (r.status !== 200) {
        setStatusText('HTTP ' + r.status);
        setStatusState('error');
        return;
      }
      const list = r.body.projects || [];
      setProjects(list);
      setStatusText(list.length + ' projects');
      setStatusState(list.length ? 'success' : null);
    } catch (err) {
      setStatusText('network error');
      setStatusState('error');
    }
  }

  useEffect(() => {
    loadProjects().catch(err => {
      setStatusText('load failed');
      setStatusState('error');
      console.warn('loadProjects rejected:', err);
    });
  }, [projectsReload.value]);

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

  return h('section', null,
    h('div', { class: 'page-bar' },
      h('div', { class: 'page-bar__title' }, 'Chats'),
      h('span', { class: 'status page-bar__status', 'data-state': statusState || undefined, 'aria-live': 'polite' }, statusText),
      h('button', { class: 'page-bar__add', type: 'button', onClick: () => nav('projects/new'), 'aria-label': 'Add project' }, '+')
    ),
    h('ul', { class: 'projects__list', 'aria-label': 'Registered projects' },
      projects.length === 0 && statusState !== 'busy' ?
      h('li', { class: 'projects__empty' },
        h('span', { class: 'projects__empty-icon', dangerouslySetInnerHTML: { __html: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.379a1.5 1.5 0 0 1 1.06.44L11.88 8.38a.5.5 0 0 0 .354.146H19.5A1.5 1.5 0 0 1 21 10.027v7.473A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z"/></svg>' } }),
        h('p', { class: 'projects__empty-title' }, 'No projects yet'),
        h('p', { class: 'projects__empty-text' }, 'Tap "Add project" to register a folder on disk. Each project keeps its own chats, prompt profile, and trace setting.')
      )
      : projects.map(p => {
          const costBits = p.totalCost || { total: 0, known: false, currency: 'USD' };
          const costStr = costBits.known ? formatCost(costBits.total) : '--';
          return h('li', { key: p.id, class: 'project-card' },
            h('div', { class: 'project-card__head' },
              h('div', { class: 'project-card__name' }, p.name || p.path),
              h('span', { class: 'project-card__cost' }, costStr),
              h(ProjectMenu, { project: p, onRename: renameProject, onUnregister: unregisterProject })
            ),
            h('div', { class: 'project-card__path' }, p.path),
            h(ChatList, { project: p })
          );
      })
    )
  );
}