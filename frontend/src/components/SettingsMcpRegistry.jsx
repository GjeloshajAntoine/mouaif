// mouaif web — SettingsMcpRegistry: browse the official MCP Registry
// with popularity scoring and one-tap "Add to project" / "Add app-wide".
// See docs/features/mcp-registry-browser.md.
import { h, Fragment } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';
import { fetchJson, setStatus } from '../api.js';
import { nav } from '../router.js';
import { projectQS } from './settings/projectQS.js';

// Visual popularity bar
function popularityBar(score) {
  const pct = Math.min(100, Math.max(0, score || 0));
  let cls = 'reg-pop';
  if (pct >= 70) cls += ' reg-pop--high';
  else if (pct >= 40) cls += ' reg-pop--mid';
  else cls += ' reg-pop--low';
  return h('span', { class: cls, title: 'Popularity: ' + pct + '/100' },
    h('span', { class: 'reg-pop__bar', style: 'width:' + pct + '%' }),
    h('span', { class: 'reg-pop__label' }, pct)
  );
}

// Extract the first package's command suggestion from a registry entry
function extractPkgInfo(entry) {
  const server = entry && entry.server || {};
  const pkgs = Array.isArray(server.packages) ? server.packages : [];
  if (!pkgs.length) return null;
  const pkg = pkgs[0];
  const type = pkg.type || 'uvx';
  const args = Array.isArray(pkg.arguments) ? pkg.arguments.map(a => a.value || a).filter(Boolean) : [];
  const env = {};
  if (Array.isArray(pkg.environmentVariables)) {
    for (const ev of pkg.environmentVariables) {
      if (ev && ev.name && ev.default) env[ev.name] = ev.default;
      else if (ev && ev.name && ev.isRequired) env[ev.name] = '';
    }
  }
  const cmd = type === 'uvx' ? 'uvx' : (type === 'npx' ? 'npx' : (pkg.command || type));
  const fullArgs = type === 'uvx' || type === 'npx'
    ? [pkg.packageName || pkg.name || cmd].concat(args)
    : args;
  return { command: cmd, args: fullArgs, env };
}

export function SettingsMcpRegistryView(props = {}) {
  const projectDir = typeof props.projectDir === 'string' ? props.projectDir : '';
  const searchEl = useRef(null);
  const statusEl = useRef(null);
  const [servers, setServers] = useState([]);
  const [metadata, setMetadata] = useState({ count: 0, nextCursor: null });
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState('popularity');
  const [sortDir, setSortDir] = useState('desc');
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState('');
  const [addingId, setAddingId] = useState(null); // id being added

  async function loadRegistry(opts = {}) {
    const q = opts.search !== undefined ? opts.search : search;
    const c = opts.cursor !== undefined ? opts.cursor : cursor;
    const sF = opts.sortField !== undefined ? opts.sortField : sortField;
    const sD = opts.sortDir !== undefined ? opts.sortDir : sortDir;
    setBusy(true);
    setStatus(statusEl, 'loading…', 'busy');
    const params = new URLSearchParams();
    if (q) params.set('search', q);
    if (c) params.set('cursor', c);
    params.set('sort', sF);
    params.set('dir', sD);
    params.set('limit', '30');
    try {
      const r = await fetchJson('/api/mcp/registry?' + params.toString());
      if (r.status !== 200) {
        setStatus(statusEl, 'Registry error: HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''), 'error');
        setBusy(false);
        return;
      }
      setServers(r.body.servers || []);
      setMetadata(r.body.metadata || { count: 0, nextCursor: null });
      setCursor(c ? (r.body.metadata && r.body.metadata.nextCursor) || '' : '');
      setStatus(statusEl, (r.body.metadata && r.body.metadata.count) + ' servers found', 'success');
    } catch (e) {
      setStatus(statusEl, 'Network error: ' + (e.message || e), 'error');
    }
    setBusy(false);
  }

  function doSearch() {
    const val = (searchEl.current && searchEl.current.value || '').trim();
    setSearch(val);
    setCursor('');
    loadRegistry({ search: val, cursor: '' });
  }

  function doNextPage() {
    if (!metadata.nextCursor) return;
    loadRegistry({ cursor: metadata.nextCursor });
  }

  function doPrevPage() {
    // We don't keep history; just reload the current search without cursor
    loadRegistry({ cursor: '' });
  }

  async function addToProject(entry) {
    const name = entry.server ? entry.server.name : (entry.name || '');
    if (!name) return;
    const displayName = name.includes('/') ? name.split('/').pop() : name;
    const pkgInfo = extractPkgInfo(entry);
    if (!pkgInfo) {
      setStatus(statusEl, 'Cannot install: no package info for ' + displayName, 'error');
      return;
    }
    setAddingId(name);
    setStatus(statusEl, 'Adding ' + displayName + '…', 'busy');
    const scope = projectDir ? 'project' : 'app';
    const body = {
      projectDir: projectDir || null,
      scope,
      transport: 'stdio',
      name: displayName,
      command: pkgInfo.command,
      args: pkgInfo.args,
      env: pkgInfo.env
    };
    try {
      const r = await fetchJson('/api/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (r.status === 201 || r.status === 200) {
        setStatus(statusEl, displayName + ' added!', 'success');
        // Navigate to the edit view for the new server
        const id = r.body && r.body.server && r.body.server.id;
        if (id) {
          setTimeout(() => {
            nav('settings/mcp/' + encodeURIComponent(id) + projectQS(projectDir) + '&scope=' + scope);
          }, 600);
        }
      } else {
        setStatus(statusEl, 'HTTP ' + r.status + ': ' + (r.body && r.body.error || 'unknown'), 'error');
      }
    } catch (e) {
      setStatus(statusEl, 'Network error: ' + (e.message || e), 'error');
    }
    setAddingId(null);
  }

  useEffect(() => { loadRegistry({}); }, []);

  const backHref = '#/settings/mcp' + projectQS(projectDir);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: backHref, class: 'view-back', 'aria-label': 'Back to MCP servers' }, '←'),
      h('h2', { class: 'view-title' }, 'MCP Registry' + (projectDir ? ' · ' + projectDir.split(/[/\\]/).pop() : ''))
    ),
    // Scroll container (flush route) — see SettingsMcp for the same
    // single-root-<section> rationale.
    h('section', null,
    h('p', { class: 'hint hint--compact' },
      'Browse the ',
      h('a', { href: 'https://registry.modelcontextprotocol.io', target: '_blank', rel: 'noopener noreferrer' }, 'official MCP Registry'),
      '. Servers are scored by update recency and package count. Tap a server to add it to ',
      projectDir ? 'this project' : 'the app-wide list',
      '.'
    ),
    // Search bar and sorting controls
    h('div', { class: 'row row--inline', style: 'margin-bottom:8px; gap:8px; flex-wrap:wrap;' },
      h('input', {
        ref: searchEl,
        class: 'input',
        style: 'flex: 1 1 200px;',
        type: 'text',
        placeholder: 'Search servers by name…',
        'aria-label': 'Search MCP registry',
        onKeyDown: (e) => { if (e.key === 'Enter') doSearch(); }
      }),
      h('button', { class: 'btn', type: 'button', onClick: doSearch, disabled: busy }, 'Search'),
      h('select', {
        class: 'input',
        style: 'width: auto;',
        value: sortField + '|' + sortDir,
        onChange: (e) => {
          const [f, d] = e.target.value.split('|');
          setSortField(f);
          setSortDir(d);
          setCursor('');
          loadRegistry({ sortField: f, sortDir: d, cursor: '' });
        },
        disabled: busy
      },
        h('option', { value: 'popularity|desc' }, 'Most popular'),
        h('option', { value: 'popularity|asc' }, 'Least popular'),
        h('option', { value: 'updatedAt|desc' }, 'Recently updated'),
        h('option', { value: 'updatedAt|asc' }, 'Oldest updated'),
        h('option', { value: 'name|asc' }, 'Name (A-Z)'),
        h('option', { value: 'name|desc' }, 'Name (Z-A)')
      )
    ),
    // Server list
    h('ul', { class: 'reg-list', 'aria-label': 'Registry servers' },
      !servers.length && !busy
        ? h('li', { class: 'mcp__empty' }, 'No servers found. Try a different search term.')
        : servers.map((entry) => {
            const server = entry && entry.server || {};
            const name = server.name || entry.name || '';
            const displayName = name.includes('/') ? name.split('/').pop() : name || 'unknown';
            const description = server.description || '';
            const meta = entry._meta && entry._meta['io.modelcontextprotocol.registry/official'] || {};
            const status = meta.status || 'active';
            const updated = meta.updatedAt ? new Date(meta.updatedAt).toLocaleDateString() : null;
            const packages = Array.isArray(server.packages) ? server.packages : [];
            const pkgCount = packages.length;
            const popScore = entry.popularity ? entry.popularity.score : 0;
            const isAdding = addingId === name;
            return h('li', { key: name, class: 'reg-row' },
              h('div', { class: 'reg-row__head' },
                h('div', { class: 'reg-row__name' }, displayName,
                  h('span', { class: 'reg-row__ver' }, meta.isLatest !== undefined ? 'latest' : ''),
                  status !== 'active'
                    ? h('span', { class: 'reg-row__status reg-row__status--' + status }, status)
                    : null
                ),
                popularityBar(popScore)
              ),
              description
                ? h('div', { class: 'reg-row__desc' }, description.slice(0, 200) + (description.length > 200 ? '…' : ''))
                : null,
              h('div', { class: 'reg-row__meta' },
                h('span', { class: 'reg-row__meta-item' }, name),
                pkgCount > 0 ? h('span', { class: 'reg-row__meta-item' }, pkgCount + ' package' + (pkgCount === 1 ? '' : 's')) : null,
                updated ? h('span', { class: 'reg-row__meta-item' }, 'Updated ' + updated) : null
              ),
              h('div', { class: 'reg-row__actions' },
                h('button', {
                  class: 'btn btn--small' + (popScore >= 70 ? ' btn--primary' : ''),
                  type: 'button',
                  disabled: isAdding || busy,
                  onClick: () => addToProject(entry)
                }, isAdding ? 'Adding…' : 'Add to ' + (projectDir ? 'project' : 'app'))
              )
            );
          })
    ),
    // Pagination
    h('div', { class: 'page-bar' },
      h('span', {
        class: 'status page-bar__status' + (statusEl.current && statusEl.current.dataset.state ? ' status--' + statusEl.current.dataset.state : ''),
        'aria-live': 'polite'
      }, (statusEl.current && statusEl.current.textContent) || ''),
      h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite', style: 'display:none' }),
      h('button', {
        class: 'btn btn--small', type: 'button',
        disabled: !cursor || busy,
        onClick: doPrevPage,
        'aria-label': 'First page'
      }, '⇤'),
      h('button', {
        class: 'btn btn--small', type: 'button',
        disabled: !metadata.nextCursor || busy,
        onClick: doNextPage,
        'aria-label': 'Next page'
      }, 'Next →')
    )
    )
  );
}
