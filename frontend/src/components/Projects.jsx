// mouaif web — ProjectsView
import { h, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { fetchJson, projectsReload } from '../api.js';
import { nav } from '../router.js';
import { formatCost } from '../usage.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { PromptIcon } from './PromptIcon.jsx';
const CHAT_PAGE_SIZE = 30;
// A card's search is a peek, not a page: the card holds about three rows and
// the server caps the list at its own maximum anyway.
const CHAT_SEARCH_LIMIT = 30;
// Typing is what the user does; a request per keystroke is not. Long enough to
// coalesce a burst of typing, short enough that a pause feels answered.
const CHAT_SEARCH_DEBOUNCE_MS = 220;

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
      h('button', { type: 'button', onClick: () => { setOpen(false); nav('settings/project?projectDir=' + encodeURIComponent(project.path) + '&from=projects'); } }, 'Settings…'),
      h('button', { type: 'button', onClick: () => { setOpen(false); onRename(project); } }, 'Rename…'),
      h('button', { type: 'button', 'data-danger': '1', onClick: () => { setOpen(false); onUnregister(project); } }, 'Unregister')
    )
  );
}

function ProjectSearchIcon({ size = 18 }) {
  return h('svg', {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
    stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round',
    'stroke-linejoin': 'round', 'aria-hidden': 'true'
  },
    h('circle', { cx: '11', cy: '11', r: '7' }),
    h('path', { d: 'M20 20l-3.9-3.9' })
  );
}

function ChatList({ project }) {
  const [chats, setChats] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
const [isCreating, setIsCreating] = useState(false);
const [prompts, setPrompts] = useState([]);
// Search state. `searchOpen` is the field's presence, `term` what the user
// typed, `results` the last answered query. While `results.query === term` the
// list renders the results; the moment the term moves on it falls back to the
// normal chat page, so a stale result can never be attributed to a new term.
const [searchOpen, setSearchOpen] = useState(false);
const [term, setTerm] = useState('');
const [results, setResults] = useState(null);
const [searching, setSearching] = useState(false);
const searchInputRef = useRef(null);
const searchSeq = useRef(0);
useEffect(() => {
let canceled = false;
async function init() {
setLoading(true);
try {
const [r, promptRes] = await Promise.all([
fetchJson('/api/chats?projectDir=' + encodeURIComponent(project.path) + '&offset=0&limit=' + CHAT_PAGE_SIZE),
fetchJson('/api/prompts?projectDir=' + encodeURIComponent(project.path)).catch(() => ({ status: 0, body: {} }))
]);
if (canceled) return;
setPrompts(promptRes.status === 200 ? (promptRes.body.prompts || []) : []);
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

  // Debounced search. The field is a controlled input, so every keystroke
  // re-renders; only a settled term goes to the network. Each request carries a
  // sequence number: the response that is not the newest one is dropped, since
  // a slow early request must never overwrite a later answer.
  useEffect(() => {
    const q = term.trim();
    if (!searchOpen) return;
    if (!q) { setResults(null); setSearching(false); return; }
    setSearching(true);
    const mine = ++searchSeq.current;
    const timer = setTimeout(async () => {
      try {
        const r = await fetchJson(
          '/api/chats/search?projectDir=' + encodeURIComponent(project.path)
          + '&q=' + encodeURIComponent(q) + '&limit=' + CHAT_SEARCH_LIMIT
        );
        if (mine !== searchSeq.current) return;
        if (r.status === 200) setResults({ query: q, chats: r.body.chats || [] });
        else setResults({ query: q, chats: [], error: 'HTTP ' + r.status });
      } catch (err) {
        if (mine === searchSeq.current) setResults({ query: q, chats: [], error: 'network error' });
      }
      if (mine === searchSeq.current) setSearching(false);
    }, CHAT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term, searchOpen, project.path]);

  function openSearch() {
    setSearchOpen(true);
    // Focus after the field exists — the input is mounted by the same render
    // that sets the flag, so it is not in the tree yet when this runs.
    requestAnimationFrame(() => {
      const el = searchInputRef.current;
      if (el && el.focus) el.focus();
    });
  }

  function closeSearch() {
    searchSeq.current++;   // drop any answer still in flight
    setSearchOpen(false);
    setTerm('');
    setResults(null);
    setSearching(false);
  }

  // A chat deleted from inside a search result must also leave the normal list
  // and the counts, so both views read from the same state.
  function dropChat(chatId) {
    setChats(prev => prev.filter(c => c.id !== chatId));
    setTotal(prev => Math.max(0, prev - 1));
    setOffset(prev => Math.max(0, prev - 1));
    setResults(prev => prev ? Object.assign({}, prev, { chats: prev.chats.filter(c => c.id !== chatId) }) : prev);
  }

  async function createChat(promptId = null) {
setIsCreating(true);
try {
const body = { projectDir: project.path };
if (promptId) body.promptId = promptId;
const r = await fetchJson('/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
    dropChat(chat.id);
  }

  // chatRow(c, match) — one row of the card's chat list.
  //
  // The same renderer serves the normal page and the search results, because a
  // search hit *is* a chat and must behave identically (tap to open, × to
  // delete, running dot, draft marker). `match` — the `matchField` the search
  // returned — adds the one thing a plain row cannot show: the snippet, which
  // is why this row is in the list when the title alone does not explain it.
  function chatRow(c, match) {
const costBits = c.totalCost || { total: 0, known: false, currency: 'USD' };
const costStr = costBits.known ? formatCost(costBits.total) : '--';
const dateBits = fmtChatDate(c);
const dateStr = (dateBits.kind === 'created' ? 'new · ' : '') + dateBits.text;
const traceStr = c.trace ? ' · trace' : '';
const titleStr = (c.title && c.title.trim()) ? c.title : 'New chat';
// A chat with no persisted messages but a non-empty composer draft is a
// "draft-only" chat. The project card surfaces the start of the draft and
// a yellow (warning) indicator — the inverse of the blue "running" accent.
//
// The list payload carries `draftSnippet` (a bounded head of the draft) and
// `hasDraftImage` instead of the `draft` / `draftAttachments` bodies: a
// pending picture is up to 8 base64 data URLs, and shipping them for every
// row made the whole Chats tab slow. Nothing here needs the body — only the
// first line and "is there also a picture?".
const msgCount = typeof c.messageCount === 'number' ? c.messageCount : 0;
const draftText = typeof c.draftSnippet === 'string' ? c.draftSnippet : '';
const hasDraftImage = c.hasDraftImage === true;
const draftOnly = !c.running && msgCount === 0 && (draftText.trim().length > 0 || hasDraftImage);
const draftSnippet = draftOnly
? (draftText.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Image draft')
: '';
const chatPrompt = c.promptId ? prompts.find((prompt) => prompt.id === c.promptId) : null;
const isMatch = match === 'message' || match === 'draft';
// The snippet is only worth a line when it says something the title does not.
// A title hit whose snippet is the title would print the same words twice.
const showSnippet = isMatch && typeof c.snippet === 'string' && c.snippet.trim() !== ''
  && c.snippet.trim() !== titleStr;
return h('li', {
key: c.id,
'data-match': match || undefined,
class: showSnippet ? 'project-card__chat project-card__chat--match' : 'project-card__chat',
onClick: () => nav('chat/' + c.id + '?projectDir=' + encodeURIComponent(project.path)),
'aria-label': showSnippet
  ? titleStr + ' — ' + (match === 'draft' ? 'draft: ' : '') + c.snippet
  : c.running ? titleStr + ' (running)' : draftOnly ? draftSnippet + ' (draft)' : undefined
},
h('div', { class: 'project-card__chat-main' },
  h('div', { class: 'project-card__chat-line' },
    chatPrompt ? h('span', {
      class: 'project-card__chat-prompt',
      title: chatPrompt.title,
      'aria-label': 'Prompt: ' + chatPrompt.title
    }, h(PromptIcon, { name: chatPrompt.icon, size: 17 })) : null,
    draftOnly
      ? h('span', { class: 'project-card__chat-title project-card__chat-title--draft' }, draftSnippet)
      : h('span', { class: 'project-card__chat-title' }, titleStr),
    showSnippet ? h('span', {
      class: 'project-card__chat-badge',
      'data-match': match
    }, match === 'draft' ? 'draft' : 'text') : null
  ),
  showSnippet ? h('div', { class: 'project-card__chat-snippet' }, c.snippet) : null
),
draftOnly
? h('span', { class: 'project-card__chat-draft', 'aria-hidden': 'true' })
: c.running ? h('span', { class: 'project-card__chat-running', 'aria-hidden': 'true' }) : null,
h('span', {
class: 'project-card__chat-meta',
'data-trace': c.trace ? '1' : undefined,
'data-running': c.running ? '1' : undefined,
'data-draft': draftOnly ? '1' : undefined,
'data-cost-known': costBits.known ? '1' : '0'
}, costStr + ' · ' + dateStr + traceStr),
h('button', {
class: 'project-card__chat-delete',
type: 'button',
'aria-label': 'Delete chat ' + titleStr,
onClick: (e) => { e.stopPropagation(); deleteChat(c); }
}, '×')
);
  }

  // `results.query` is the term the server actually answered. Comparing it to
  // the live `term` is what keeps a stale result off the screen: while the user
  // types, the list falls back to the normal page instead of showing hits for
  // the previous word.
  const answered = results && results.query === term.trim() ? results : null;
  const searchMode = searchOpen && term.trim().length > 0;
  const rows = searchMode
    ? (answered ? answered.chats.map((c) => chatRow(c, c.matchField)) : [])
    : chats.map((c) => chatRow(c, undefined));

  return h(Fragment, null,
    searchOpen ? h('div', { class: 'project-card__search' },
      h('span', { class: 'project-card__search-icon', 'aria-hidden': 'true' }, h(ProjectSearchIcon, { size: 16 })),
      h('input', {
        ref: searchInputRef,
        class: 'project-card__search-input',
        type: 'search',
        value: term,
        placeholder: 'Search titles, drafts, messages…',
        'aria-label': 'Search chats in ' + (project.name || project.path),
        autocomplete: 'off',
        autocapitalize: 'none',
        spellcheck: 'false',
        enterkeyhint: 'search',
        onInput: (e) => setTerm(e.currentTarget.value),
        onKeyDown: (e) => { if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } }
      }),
      h('button', {
        class: 'project-card__search-close',
        type: 'button',
        'aria-label': 'Close search',
        onClick: closeSearch
      }, '×')
    ) : null,
    h('ul', {
      class: 'project-card__chats',
      'aria-label': 'Chats in ' + (project.name || project.path),
      onScroll: (e) => {
        const el = e.currentTarget;
        if (!searchMode && el.scrollTop + el.clientHeight >= el.scrollHeight - 48) {
          loadMore();
        }
      }
    },
      searchMode ?
        (searching && !answered ? h('li', { class: 'project-card__chats-empty' }, 'searching…')
        : answered && answered.error ? h('li', { class: 'project-card__chats-empty' }, 'search failed: ' + answered.error)
        : answered && answered.chats.length === 0 ? h('li', { class: 'project-card__chats-empty' }, 'No chat matches “' + term.trim() + '”.')
        : rows)
      : (loading ? h('li', { class: 'project-card__chats-empty' }, 'loading chats…')
        : (chats.length === 0) ? h('li', { class: 'project-card__chats-empty' }, 'No chats yet. Tap "+ New chat" below to start one.')
        : rows),
      searchMode ? null :
      loadingMore ? h('li', { class: 'project-card__chats-more' }, 'Loading more…') :
      (!loading && offset < total) ? h('li', { class: 'project-card__chats-more' }, 'Scroll for more…') : null
    ),
h('div', { class: 'project-card__new-actions' },
h('button', {
class: 'project-card__new',
type: 'button',
onClick: () => createChat(),
disabled: isCreating
}, '+ New chat'),
prompts.filter((prompt) => prompt.showOnProjectCard).map((prompt) => h('button', {
class: 'project-card__prompt-new',
type: 'button',
key: prompt.id,
onClick: () => createChat(prompt.id),
disabled: isCreating,
'aria-label': 'New chat with ' + prompt.title,
title: 'New chat with ' + prompt.title
}, h(PromptIcon, { name: prompt.icon, size: 20 }))),
h('button', {
class: 'project-card__search-open',
type: 'button',
'aria-expanded': String(searchOpen),
onClick: () => { if (searchOpen) closeSearch(); else openSearch(); },
'aria-label': searchOpen ? 'Close chat search' : 'Search chats in ' + (project.name || project.path),
title: searchOpen ? 'Close search' : 'Search chats'
}, h(ProjectSearchIcon, { size: 18 }))
)
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
      setStatusText(list.length + (list.length === 1 ? ' project' : ' projects'));
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
              h('div', { class: 'project-card__identity' },
                h('div', { class: 'project-card__name' }, p.name || p.path),
                h('div', { class: 'project-card__path' }, p.path)
              ),
              h('span', { class: 'project-card__cost' }, costStr),
              h(ProjectMenu, { project: p, onRename: renameProject, onUnregister: unregisterProject })
            ),
            h(ChatList, { project: p })
          );
      })
    )
  );
}