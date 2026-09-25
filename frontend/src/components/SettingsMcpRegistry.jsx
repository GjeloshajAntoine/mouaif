// mouaif web — SettingsMcpRegistry: the MCP store.
//
// Browse the official MCP Registry (registry.modelcontextprotocol.io) like an
// app store: search as you type, filter by how a server runs, see at a glance
// whether it needs a key or is already installed, and install it from a
// sheet that asks only for what the server needs (McpStoreSheet).
// See docs/features/mcp-registry-browser.md.
import { h, Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fetchJson } from '../api.js';
import { projectQS } from './settings/projectQS.js';
import { McpStoreSheet, avatarStyle, initial, editorHref } from './settings/McpStoreSheet.jsx';
import { friendlyName, publisher, summary, findInstalled, registryMeta, relativeDate } from './settings/mcpRegistryInstall.js';

const PAGE = 30;
const SEARCH_DEBOUNCE_MS = 350;

const FILTERS = [
  ['all', 'All'],
  ['remote', 'Hosted'],
  ['local', 'Local'],
  ['nokey', 'No key']
];

const SORTS = [
  ['popularity', 'Recommended'],
  ['updatedAt', 'Newest'],
  ['name', 'Name A–Z']
];

function entryKey(entry) {
  const s = (entry && entry.server) || {};
  return (s.name || '') + '@' + (s.version || '');
}

function matchesFilter(info, filter) {
  if (filter === 'remote') return info.kind === 'remote' || info.kind === 'mixed';
  if (filter === 'local') return info.kind === 'local' || info.kind === 'mixed';
  if (filter === 'nokey') return info.supported && !info.needsKey;
  return true;
}

function compare(sort) {
  const text = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  return (a, b) => {
    if (sort === 'name') return text.compare(friendlyName(a), friendlyName(b));
    if (sort === 'updatedAt') return (Date.parse(registryMeta(b).updatedAt) || 0) - (Date.parse(registryMeta(a).updatedAt) || 0);
    // Recommended: installable first, then the popularity score.
    const sa = summary(a).supported ? 1 : 0;
    const sb = summary(b).supported ? 1 : 0;
    if (sa !== sb) return sb - sa;
    return ((b.popularity && b.popularity.score) || 0) - ((a.popularity && a.popularity.score) || 0);
  };
}

export function SettingsMcpRegistryView(props = {}) {
  const projectDir = typeof props.projectDir === 'string' ? props.projectDir : '';
  const from = typeof props.from === 'string' ? props.from : '';
  const [entries, setEntries] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('popularity');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [configured, setConfigured] = useState([]);
  const [openKey, setOpenKey] = useState('');
  // Only the newest request may write results: a slow response for "gi"
  // must not overwrite the list for "github".
  const reqSeq = useRef(0);

  async function loadConfigured() {
    try {
      const r = await fetchJson('/api/mcp/servers' + projectQS(projectDir));
      if (r.status === 200) setConfigured(r.body.servers || []);
    } catch { /* installed badges are a nicety */ }
  }

  async function load(opts) {
    const o = opts || {};
    const seq = ++reqSeq.current;
    const more = !!o.cursor;
    if (more) setLoadingMore(true); else { setLoading(true); setError(''); }
    const params = new URLSearchParams();
    const q = o.search !== undefined ? o.search : search;
    if (q.trim()) params.set('search', q.trim());
    if (o.cursor) params.set('cursor', o.cursor);
    params.set('limit', String(PAGE));
    let r;
    try { r = await fetchJson('/api/mcp/registry?' + params.toString()); }
    catch { r = null; }
    if (seq !== reqSeq.current) return;
    setLoading(false);
    setLoadingMore(false);
    if (!r || r.status !== 200) {
      const why = !r ? 'mouaif could not be reached.' : ((r.body && r.body.error) || 'HTTP ' + r.status);
      setError('Could not load the store. ' + why);
      return;
    }
    const got = Array.isArray(r.body.servers) ? r.body.servers : [];
    setEntries((prev) => {
      if (!more) return got;
      const seen = new Set(prev.map(entryKey));
      return prev.concat(got.filter((e) => !seen.has(entryKey(e))));
    });
    setNextCursor((r.body.metadata && r.body.metadata.nextCursor) || null);
  }

  // Search as you type (debounced); the first run is the initial load.
  useEffect(() => {
    const t = setTimeout(() => load({ search }), search ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => { loadConfigured(); }, [projectDir]);

  const rows = useMemo(() => {
    return entries
      .map((entry) => ({ entry, info: summary(entry), installed: findInstalled(entry, configured) }))
      .filter((row) => matchesFilter(row.info, filter))
      .sort((a, b) => compare(sort)(a.entry, b.entry));
  }, [entries, configured, filter, sort]);

  const openRow = openKey ? entries.find((e) => entryKey(e) === openKey) : null;
  const backHref = '#/settings/mcp' + projectQS(projectDir) + (from ? (projectDir ? '&' : '?') + 'from=' + encodeURIComponent(from) : '');
  const hiddenByFilter = entries.length - rows.length;

  function card(row) {
    const { entry, info, installed } = row;
    const key = entryKey(entry);
    const server = entry.server || {};
    const updated = relativeDate(registryMeta(entry).updatedAt);
    const deprecated = registryMeta(entry).status && registryMeta(entry).status !== 'active';
    const badges = [];
    if (installed) badges.push(['ok', 'Installed']);
    if (info.kind === 'remote' || info.kind === 'mixed') badges.push(['accent', 'Hosted']);
    if (info.runtime) badges.push(['plain', info.runtime]);
    if (info.supported) badges.push(info.needsKey ? ['warn', 'Needs API key'] : ['plain', 'No key']);
    else badges.push(['muted', 'Manual setup']);
    if (deprecated) badges.push(['muted', 'Deprecated']);
    return h('li', { key, class: 'mcps-card' + (info.supported ? '' : ' mcps-card--manual') },
      h('button', { class: 'mcps-card__main', type: 'button', onClick: () => setOpenKey(key), 'aria-label': friendlyName(entry) + ' — details' },
        h('span', { class: 'mcps-avatar', style: avatarStyle(server.name), 'aria-hidden': 'true' }, initial(entry)),
        h('span', { class: 'mcps-card__body' },
          h('span', { class: 'mcps-card__title' }, friendlyName(entry)),
          h('span', { class: 'mcps-card__pub' }, publisher(entry) + (updated ? ' · ' + updated : '')),
          server.description ? h('span', { class: 'mcps-card__desc' }, server.description) : null,
          h('span', { class: 'mcps-badges' }, badges.map(([tone, text]) => h('span', { key: text, class: 'mcps-badge mcps-badge--' + tone }, text)))
        )
      ),
      installed
        ? h('a', { class: 'btn btn--small mcps-card__cta', href: editorHref(installed, projectDir, from), 'aria-label': 'Open ' + installed.name + ' settings' }, 'Open')
        : h('button', { class: 'btn btn--small mcps-card__cta' + (info.supported ? ' btn--primary' : ''), type: 'button', onClick: () => setOpenKey(key) }, info.supported ? 'Get' : 'View')
    );
  }

  const skeleton = Array.from({ length: 6 }, (_, i) => h('li', { key: 's' + i, class: 'mcps-card mcps-card--skeleton', 'aria-hidden': 'true' },
    h('span', { class: 'mcps-avatar' }),
    h('span', { class: 'mcps-card__body' }, h('span', { class: 'mcps-skel mcps-skel--title' }), h('span', { class: 'mcps-skel' }), h('span', { class: 'mcps-skel mcps-skel--short' }))
  ));

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: backHref, class: 'view-back', 'aria-label': 'Back to MCP servers' }, '←'),
      h('h2', { class: 'view-title' }, 'MCP store' + (projectDir ? ' · ' + projectDir.split(/[/\\]/).filter(Boolean).pop() : ''))
    ),
    h('section', { class: 'mcps' },
      h('div', { class: 'mcps-toolbar' },
        h('div', { class: 'mcps-search' },
          h('svg', { class: 'mcps-search__icon', viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
            h('path', { d: 'M10.5 4a6.5 6.5 0 1 0 4.03 11.6l4.43 4.43 1.06-1.06-4.43-4.43A6.5 6.5 0 0 0 10.5 4Zm0 1.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z', fill: 'currentColor' })),
          h('input', {
            class: 'input mcps-search__input', type: 'search', inputmode: 'search', enterkeyhint: 'search',
            placeholder: 'Search servers (github, postgres, browser…)', 'aria-label': 'Search the MCP store',
            value: search, autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
            onInput: (e) => setSearch(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') { e.target.blur(); load({ search: e.target.value }); } }
          }),
          search ? h('button', { class: 'icon-btn mcps-search__clear', type: 'button', 'aria-label': 'Clear search', onClick: () => setSearch('') }, '×') : null
        ),
        h('div', { class: 'mcps-chips', role: 'radiogroup', 'aria-label': 'Filter' },
          FILTERS.map(([v, label]) => h('button', {
            key: v, type: 'button', role: 'radio', 'aria-checked': filter === v ? 'true' : 'false',
            class: 'mcps-chip' + (filter === v ? ' mcps-chip--on' : ''), onClick: () => setFilter(v)
          }, label)),
          h('select', { class: 'mcps-sort', 'aria-label': 'Sort', value: sort, onChange: (e) => setSort(e.target.value) },
            SORTS.map(([v, label]) => h('option', { key: v, value: v }, label)))
        )
      ),
      error
        ? h('div', { class: 'mcps-state' },
            h('p', { class: 'mcps-state__text' }, error),
            h('button', { class: 'btn', type: 'button', onClick: () => load({}) }, 'Try again'))
        : h('ul', { class: 'mcps-list', 'aria-label': 'MCP servers', 'aria-busy': loading ? 'true' : 'false' },
            loading ? skeleton : rows.map(card)),
      !loading && !error && !rows.length
        ? h('div', { class: 'mcps-state' },
            h('p', { class: 'mcps-state__text' },
              entries.length
                ? 'No servers here match this filter.'
                : (search ? 'Nothing found for “' + search + '”. Try a shorter or different word.' : 'The store is empty right now.')),
            entries.length && filter !== 'all' ? h('button', { class: 'btn', type: 'button', onClick: () => setFilter('all') }, 'Show all') : null)
        : null,
      !loading && !error && nextCursor
        ? h('div', { class: 'mcps-more-row' },
            h('button', { class: 'btn mcps-more-btn', type: 'button', disabled: loadingMore, onClick: () => load({ cursor: nextCursor }) },
              loadingMore ? 'Loading…' : 'Load more servers'),
            hiddenByFilter > 0 ? h('span', { class: 'hint hint--compact' }, hiddenByFilter + ' loaded server' + (hiddenByFilter === 1 ? ' is' : 's are') + ' hidden by the filter.') : null)
        : null,
      h('p', { class: 'hint hint--compact mcps-foot' },
        'Listings come from the ',
        h('a', { href: 'https://registry.modelcontextprotocol.io', target: '_blank', rel: 'noopener noreferrer' }, 'official MCP Registry'),
        '. Anyone can publish there — install servers you trust. Not listed? ',
        h('a', { href: '#/settings/mcp/new' + (projectDir ? projectQS(projectDir) + '&scope=project' : '?scope=app') + (from ? '&from=' + encodeURIComponent(from) : '') }, 'Add one by hand'),
        '.')
    ),
    openRow
      ? h(McpStoreSheet, {
          entry: openRow, projectDir, from,
          installed: findInstalled(openRow, configured),
          onClose: () => setOpenKey(''),
          onInstalled: () => loadConfigured()
        })
      : null
  );
}
