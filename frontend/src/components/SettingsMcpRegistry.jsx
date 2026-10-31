// mouaif web — SettingsMcpRegistry: the MCP store.
//
// Browse the official MCP Registry (registry.modelcontextprotocol.io) like an
// app store: search as you type, filter by how a server runs, see at a glance
// whether it needs a key or is already installed, see how much it is used
// (weekly npm / PyPI downloads, McpPopularity), and install it from a sheet
// that asks only for what the server needs (McpStoreSheet).
// See docs/features/mcp-registry-browser.md.
import { h, Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fetchJson } from '../api.js';
import { settingsLink } from './settings/projectNavigation.js';
import { projectQS } from './settings/projectQS.js';
import { McpStoreSheet, avatarStyle, initial, editorHref } from './settings/McpStoreSheet.jsx';
import { McpPopularity } from './settings/McpPopularity.jsx';
import { friendlyName, publisher, summary, findInstalled, registryMeta, relativeDate, weeklyDownloads } from './settings/mcpRegistryInstall.js';

const PAGE = 30;
const SEARCH_DEBOUNCE_MS = 350;

const FILTERS = [
  ['all', 'All'],
  ['remote', 'Hosted'],
  ['local', 'Local'],
  ['nokey', 'No key']
];

const SORTS = [
  ['popularity', 'Popular'],
  ['updatedAt', 'Updated'],
  ['name', 'A–Z']
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
    // Popular: most weekly downloads first. Servers without a count (hosted
    // ones publish none) follow, installable first, then most recently
    // updated — never an invented score.
    const da = weeklyDownloads(a);
    const db = weeklyDownloads(b);
    const wa = da ? da.weekly : -1;
    const wb = db ? db.weekly : -1;
    if (wa !== wb) return wb - wa;
    const sa = summary(a).supported ? 1 : 0;
    const sb = summary(b).supported ? 1 : 0;
    if (sa !== sb) return sb - sa;
    return (Date.parse(registryMeta(b).updatedAt) || 0) - (Date.parse(registryMeta(a).updatedAt) || 0);
  };
}

// Small 12px glyphs for the card's fact row (decorative; the text says it).
const FACT_ICONS = {
  check: 'M9.5 16.2 5.3 12l-1.1 1.1 5.3 5.3L20.8 7.1 19.7 6 9.5 16.2Z',
  cloud: 'M18.5 10.1A6.5 6.5 0 0 0 6.1 8.4 5 5 0 0 0 7 18.5h11a4.2 4.2 0 0 0 .5-8.4Zm-.5 6.9H7a3.5 3.5 0 0 1-.4-7l.9-.1.4-.8a5 5 0 0 1 9.5 1.7l.1 1.2 1.2.1a2.7 2.7 0 0 1-.2 5Z',
  box: 'M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7L12 2.5Zm0 1.7 6.6 3.5L12 11.2 5.4 7.7 12 4.2ZM5 9l6.2 3.3v7.2L5 16.1V9Zm7.8 10.5v-7.2L19 9v7.1l-6.2 3.4Z',
  key: 'M7.5 9a5.5 5.5 0 1 0 5.2 7.3h2.3v2.2h2v-2.2h1.5v2.2h2v-3.8h-7.8A5.5 5.5 0 0 0 7.5 9Zm0 1.6a3.9 3.9 0 1 1 0 7.8 3.9 3.9 0 0 1 0-7.8Zm0 2.4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 1.6a7.4 7.4 0 1 1 0 14.8 7.4 7.4 0 0 1 0-14.8Zm-.8 2.9v5.3l4.3 2.6.8-1.3-3.5-2.1V7.5h-1.6Z',
  tool: 'M21 6.6 17.6 10l-3.6-3.6L17.4 3a5 5 0 0 0-6.6 6.3L3.3 16.8a2 2 0 0 0 2.9 2.9l7.5-7.5A5 5 0 0 0 21 6.6Z'
};

function factIcon(name) {
  return h('svg', { class: 'mcps-fact__icon', viewBox: '0 0 24 24', width: 12, height: 12, 'aria-hidden': 'true' },
    h('path', { d: FACT_ICONS[name], fill: 'currentColor' }));
}

export function SettingsMcpRegistryView(props = {}) {
  const projectDir = typeof props.projectDir === 'string' ? props.projectDir : '';
  const from = typeof props.from === 'string' ? props.from : '';
  const chatId = typeof props.chatId === 'string' ? props.chatId : '';
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
  const backHref = settingsLink('settings/mcp', { projectDir, chatId, from }, { scope: projectDir ? 'project' : 'app' });
  const hiddenByFilter = entries.length - rows.length;

  function card(row) {
    const { entry, info, installed } = row;
    const key = entryKey(entry);
    const server = entry.server || {};
    const updated = relativeDate(registryMeta(entry).updatedAt);
    const deprecated = registryMeta(entry).status && registryMeta(entry).status !== 'active';
    const name = friendlyName(entry);
    // Quiet facts, in reading order: how it runs, whether it needs a key,
    // freshness. Only states that change what you do next get a colour.
    const facts = [];
    if (info.kind === 'remote' || info.kind === 'mixed') facts.push(['', 'cloud', 'Hosted']);
    // "Node.js (npx)" -> "Node.js": the sheet shows the exact command.
    if (info.runtime && info.kind !== 'remote') facts.push(['', 'box', info.runtime.replace(/\s*\(.*\)$/, '')]);
    if (!info.supported) facts.push(['muted', 'tool', 'Manual setup']);
    else if (info.needsKey) facts.push(['warn', 'key', 'Needs API key']);
    else facts.push(['', 'key', 'No key']);
    if (updated) facts.push(['', 'clock', updated]);
    if (deprecated) facts.push(['muted', '', 'Deprecated']);
    return h('li', { key, class: 'mcps-card' + (info.supported ? '' : ' mcps-card--manual') + (installed ? ' mcps-card--installed' : '') },
      h('div', { class: 'mcps-card__head' },
        h('span', { class: 'mcps-avatar', style: avatarStyle(server.name), 'aria-hidden': 'true' }, initial(entry)),
        h('div', { class: 'mcps-card__titles' },
          h('button', { class: 'mcps-card__hit', type: 'button', onClick: () => setOpenKey(key), 'aria-label': name + ' — details' },
            h('span', { class: 'mcps-card__title' }, name)),
          h('span', { class: 'mcps-card__pub' }, publisher(entry))
        ),
        installed
          ? h('a', { class: 'btn btn--small mcps-card__cta', href: editorHref(installed, projectDir, from, chatId), 'aria-label': 'Open ' + installed.name + ' settings' }, 'Open')
          : h('button', { class: 'btn btn--small mcps-card__cta' + (info.supported ? ' btn--primary' : ''), type: 'button', onClick: () => setOpenKey(key), 'aria-label': (info.supported ? 'Get ' : 'View ') + name }, info.supported ? 'Get' : 'View')
      ),
      server.description ? h('p', { class: 'mcps-card__desc' }, server.description) : null,
      h('div', { class: 'mcps-card__meta' },
        installed ? h('span', { class: 'mcps-fact mcps-fact--ok' }, factIcon('check'), 'Installed') : null,
        h(McpPopularity, { downloads: weeklyDownloads(entry) }),
        facts.map(([tone, icon, text]) => h('span', { key: text, class: 'mcps-fact' + (tone ? ' mcps-fact--' + tone : '') }, icon ? factIcon(icon) : null, text))
      )
    );
  }

  const skeleton = Array.from({ length: 6 }, (_, i) => h('li', { key: 's' + i, class: 'mcps-card mcps-card--skeleton', 'aria-hidden': 'true' },
    h('div', { class: 'mcps-card__head' },
      h('span', { class: 'mcps-avatar' }),
      h('span', { class: 'mcps-card__titles' }, h('span', { class: 'mcps-skel mcps-skel--title' }), h('span', { class: 'mcps-skel mcps-skel--short' }))),
    h('span', { class: 'mcps-skel' }),
    h('span', { class: 'mcps-skel mcps-skel--meta' })
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
        h('div', { class: 'mcps-filterbar' },
          h('div', { class: 'mcps-chips', role: 'radiogroup', 'aria-label': 'Filter' },
            FILTERS.map(([v, label]) => h('button', {
              key: v, type: 'button', role: 'radio', 'aria-checked': filter === v ? 'true' : 'false',
              class: 'mcps-chip' + (filter === v ? ' mcps-chip--on' : ''), onClick: () => setFilter(v)
            }, label))),
          h('label', { class: 'mcps-sort' },
            h('svg', { class: 'mcps-sort__icon', viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' },
              h('path', { d: 'M3 6h13v1.6H3V6Zm0 5.2h9v1.6H3v-1.6Zm0 5.2h5V18H3v-1.6ZM18.2 6h1.6v9.9l2.1-2.1 1.1 1.1-4 4-4-4 1.1-1.1 2.1 2.1V6Z', fill: 'currentColor' })),
            h('select', { class: 'mcps-sort__select', 'aria-label': 'Sort', value: sort, onChange: (e) => setSort(e.target.value) },
              SORTS.map(([v, label]) => h('option', { key: v, value: v }, label))))
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
        '. Usage bars show last week\'s npm or PyPI downloads; hosted servers publish none. Anyone can publish to the Registry — install servers you trust. Not listed? ',
        h('a', { href: settingsLink('settings/mcp/new', { projectDir, chatId, from }, { scope: projectDir ? 'project' : 'app' }) }, 'Add one by hand'),
        '.')
    ),
    openRow
    ? h(McpStoreSheet, {
      entry: openRow, projectDir, from, chatId,
      installed: findInstalled(openRow, configured),
      onClose: () => setOpenKey(''),
      onInstalled: () => loadConfigured()
      })
    : null
  );
}
