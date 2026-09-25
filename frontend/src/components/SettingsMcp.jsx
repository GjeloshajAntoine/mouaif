// mouaif web — SettingsMcpView (MCP server list)
// MCP = Model Context Protocol. Servers can be configured app-wide
// (visible to every project) or per project (committed to
// <projectDir>/.mcp.json). The two scopes have two homes in Settings:
// Application → MCP servers is the app-wide list (#/settings/mcp), and
// Active project → MCP servers is the project's merged list
// (#/settings/mcp?projectDir=...) with the per-server authorization
// rows. A project entry with the same slug shadows the app entry.
// See docs/features/mcp.md.
import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson, setActiveProject, activeProject } from '../api.js';
import { nav } from '../router.js';
import { projectQS } from './settings/projectQS.js';
import { McpErrorModal } from './chat/McpErrorModal.jsx';

export function SettingsMcpView(props = {}) {
  // Scope comes from the URL, never from local tab state: the route
  // carries projectDir only when the user arrived from the Active
  // project card, so #/settings/mcp is always the app-wide list even
  // when an active project exists.
  const projectDir = typeof props.projectDir === 'string' ? props.projectDir : '';
const from = typeof props.from === 'string' ? props.from : '';
  const projectName = projectDir ? projectDir.split(/[/\\]/).filter(Boolean).pop() || projectDir : '';

  const [isOpenBusy, setIsOpenBusy] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [dirInput, setDirInput] = useState('');
  const [serversList, setServersList] = useState([]);
  const [listStatus, setListStatus] = useState({ text: '', kind: '' });
const [busyIds, setBusyIds] = useState(new Set()); // server ids being acted on
const [activeError, setActiveError] = useState(null);
// Per-row lifecycle status: a start/stop/refresh error belongs to the
  // row the user tapped, not to a global line far from the action. Keyed
  // by server id; cleared on the next action on that row or on reload.
  const [rowStatus, setRowStatus] = useState({}); // { [id]: { text, kind } }

function setRow(id, text, kind, error) {
setRowStatus((prev) => {
const next = Object.assign({}, prev);
if (!text) delete next[id];
else next[id] = { text, kind, error: error || null };
return next;
});
}

  async function load() {
    setIsRefreshing(true);
    setIsOpenBusy(true);
    setListStatus({ text: 'loading…', kind: 'busy' });
    // Without projectDir the REST surface returns app-scoped servers
    // only; with it the merged app + project view.
    const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
    let r;
    try {
      r = await fetchJson('/api/mcp/servers' + qs);
    } catch (e) {
      setListStatus({ text: 'network error', kind: 'error' });
      setIsOpenBusy(false);
      setIsRefreshing(false);
      return;
    }
    setIsOpenBusy(false);
    setIsRefreshing(false);
    if (r.status !== 200) {
      setListStatus({ text: 'HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : ''), kind: 'error' });
      return;
    }
    setServersList(r.body.servers || []);
    setListStatus({ text: (r.body.servers || []).length + ' configured', kind: 'success' });
    // A successful reload reconciles row state with the server, so any
    // stale per-row status (e.g. a "starting…" from before the reload)
    // is dropped.
    setRowStatus({});
  }

  // App list convenience: jump into a project's list without going back
  // through the chat first.
  function openProject() {
    const dir = (dirInput || '').trim();
    if (!dir) { setListStatus({ text: 'type a project directory first', kind: 'error' }); return; }
    setActiveProject(dir, '');
    nav('settings/mcp' + projectQS(dir));
  }

  function scopeBadge(s) {
const isApp = s.scope === 'app';
return h('span', {
class: 'mcp__scope mcp__scope--' + (isApp ? 'app' : 'project'),
title: isApp ? 'App-wide: visible to every project' : 'Project: committed to this project\'s .mcp.json'
}, isApp ? 'app' : 'project');
}
function showServerError(server, error) {
if (!error) return;
const typed = typeof error === 'string'
? { code: 'EMCP_START', message: error }
: { code: error.code || 'EMCP_START', message: error.message || String(error) };
setActiveError({
name: server.name || server.id || 'MCP server',
result: {
serverSlug: server.slug || server.id || '',
error: typed
}
});
}
function serverRow(s) {
    const status = s.status || 'stopped';
    const toolBit = (s.tools && s.tools.length) ? s.tools.length + ' tool' + (s.tools.length === 1 ? '' : 's') : 'no tools';
    const isBusy = busyIds.has(s.id);
    // The editor link carries the list's own context: the app list
    // links projectDir-less, the project list links with projectDir and
    // the row's scope so an edit returns to the same list.
    const qs = projectDir
? projectQS(projectDir) + '&scope=' + encodeURIComponent(s.scope || 'project') + (from ? '&from=' + encodeURIComponent(from) : '')
: '?scope=app' + (from ? '&from=' + encodeURIComponent(from) : '');
const href = '#/settings/mcp/' + encodeURIComponent(s.id) + qs;
    const showStop = status === 'ready' || status === 'errored' || status === 'starting';
    // Why is Start unavailable? A server mid-start cannot be started
    // again, and a row already being acted on is handled by the busy
    // lock in callLifecycle. Every configured server is otherwise
    // startable — there is no separate "enabled" off switch.
    const startDisabled = status === 'starting' || isBusy;
    const startTitle = status === 'starting' ? 'Starting…' : (status === 'ready' ? 'Restart this server' : 'Start this server');
    const row = rowStatus[s.id];
    // One inline message slot per row: a failed action the user just
    // took, then the server's own typed error. The slot sits under the
    // action buttons so the feedback lands next to the tap that caused it.
const rowMessage = row && row.text
? { text: row.text, kind: row.kind || 'error', error: row.error || null }
: (s.status === 'errored' && s.error)
? { text: (s.error.code || 'ERR') + ': ' + (s.error.message || ''), kind: 'error', error: s.error }
: null;
    return h('li', { key: s.id, class: 'mcp__row' + (isBusy ? ' mcp__row--busy' : '') },
      h('a', { class: 'group__row settings-project__agent-link mcp__row-main', href },
        h('span', { class: 'group__row-body' },
          h('span', { class: 'group__row-label mcp__row-name' }, s.name, ' ', scopeBadge(s)),
          h('span', { class: 'settings-project__link-sub mcp__row-sub' }, (s.transport === 'http' ? 'http · ' : '') + status)
        ),
        h('span', { class: 'group__row-detail' }, toolBit)
      ),
      h('div', { class: 'mcp__row-actions', onClick: (e) => e.stopPropagation() },
        h('button', {
          class: 'btn btn--small', type: 'button',
          disabled: startDisabled,
          title: startTitle,
          'aria-label': startTitle,
          onClick: () => callLifecycle('start', s.id)
        }, status === 'ready' ? 'Restart' : 'Start'),
        showStop
          ? h('button', {
              class: 'btn btn--small', type: 'button',
              disabled: isBusy,
              onClick: () => callLifecycle('stop', s.id)
            }, 'Stop')
          : null,
        status === 'ready'
          ? h('button', {
              class: 'btn btn--small', type: 'button',
              disabled: isBusy,
              onClick: () => refreshTools(s.id)
            }, '↻')
          : null
      ),
rowMessage
? h('button', {
class: 'mcp__row-err' + (rowMessage.kind === 'busy' ? ' mcp__row-busy' : ''),
type: 'button',
'aria-label': rowMessage.kind === 'error' ? 'Show full MCP error: ' + rowMessage.text : rowMessage.text,
disabled: rowMessage.kind !== 'error',
onClick: () => showServerError(s, rowMessage.error || { code: 'EMCP_START', message: rowMessage.text })
},
h('span', { class: 'mcp__row-err-text' }, rowMessage.text),
rowMessage.kind === 'error' ? h('span', { class: 'mcp__row-err-more' }, 'Details') : null
)
: null
    );
  }

  async function callLifecycle(action, id) {
    if (busyIds.has(id)) return;
    setBusyIds(prev => new Set(prev).add(id));
    setRow(id, action === 'start' ? 'starting…' : 'stopping…', 'busy');
    let r;
    try {
      r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ projectDir })
});
} catch (e) {
setBusyIds(prev => { const n = new Set(prev); n.delete(id); return n; });
const error = { code: 'EMCP_TRANSPORT', message: 'Could not reach mouaif — check the app is still running, then try again.' };
setRow(id, error.code + ': ' + error.message, 'error', error);
const server = serversList.find((item) => item.id === id) || { id };
showServerError(server, error);
return;
}
if (r.status !== 200) {
      setBusyIds(prev => { const n = new Set(prev); n.delete(id); return n; });
const error = {
code: (r.body && r.body.code) || 'EMCP_START',
message: (r.body && r.body.error) ? String(r.body.error) : ('HTTP ' + r.status)
};
// The failed start may still have marked the server errored
// server-side; reload so the row status reflects reality, but
// keep the just-set row message (load clears rowStatus).
await load();
setRow(id, error.code + ': ' + error.message, 'error', error);
const server = serversList.find((item) => item.id === id) || { id };
showServerError(server, error);
      return;
    }
    setBusyIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    setRow(id, '');
    setListStatus({ text: action + 'ed', kind: 'success' });
    load();
  }

  async function refreshTools(id) {
    if (busyIds.has(id)) return;
    setBusyIds(prev => new Set(prev).add(id));
    setRow(id, 'refreshing tools…', 'busy');
    const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
    let r;
    try {
      r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + '/tools' + qs);
    } catch (e) {
      setBusyIds(prev => { const n = new Set(prev); n.delete(id); return n; });
      setRow(id, 'Could not reach mouaif — check the app is still running, then try again.', 'error');
      return;
    }
    if (r.status !== 200) {
      setBusyIds(prev => { const n = new Set(prev); n.delete(id); return n; });
      const detail = (r.body && r.body.error) ? String(r.body.error) : ('HTTP ' + r.status);
      setRow(id, detail, 'error');
      return;
    }
    setBusyIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    setRow(id, '');
    setListStatus({ text: (r.body.tools || []).length + ' tools', kind: 'success' });
    load();
  }

  useEffect(() => { load(); }, [projectDir]);

// The store route: `from` needs `?` when there is no projectDir query.
const storeHref = '#/settings/mcp/registry' + projectQS(projectDir) + (from ? (projectDir ? '&' : '?') + 'from=' + encodeURIComponent(from) : '');
const newHref = '#/settings/mcp/new' + (projectDir ? projectQS(projectDir) + '&scope=project' : '?scope=app') + (from ? '&from=' + encodeURIComponent(from) : '');
const backHref = projectDir
? ('#/settings/project?projectDir=' + encodeURIComponent(projectDir) + (from ? '&from=' + encodeURIComponent(from) : ''))
: '#/settings';

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: backHref, class: 'view-back', 'aria-label': 'Back' }, '←'),
      h('h2', { class: 'view-title' }, projectDir ? 'MCP servers · ' + projectName : 'MCP servers · app defaults')
    ),
    // The scroll container. Flush routes (no tab bar) rely on a single
    // root <section> matching `.app__main--flush > section` to scroll
    // internally; without it the list/page-bar below a tall set of
    // servers gets clipped with no way to reach it.
    h('section', null,
      h('p', { class: 'hint hint--compact' },
        projectDir
          ? 'Servers this project can use: the app-wide servers (app badge) plus any servers committed to this project\'s .mcp.json (project badge). If a project server has the same name as an app one, the project server is the one that runs.'
          : 'Model Context Protocol servers available in every project. The AI client discovers each server\'s tools and advertises them to the model. A project can add its own servers on top of these.'),
      // ---- Server list -----------------------------------------------------
      // Tool-call permissions (Off/Ask/Allow) deliberately do NOT live on
      // this page: they are per project and sit with the other tool
      // checkboxes in Settings → Project → Tools and the chat tools card.
      // A permission seg here read as a per-server toggle and duplicated
      // the real one.
      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Servers', h('span', { class: 'group__title-note' }, serversList.length + ' configured')),
        h('ul', { class: 'group__list mcp__list', 'aria-label': 'MCP servers' },
          serversList.length
            ? serversList.map(serverRow)
            : h('li', { class: 'mcp__empty' },
                h('span', null, projectDir
                  ? 'No MCP servers for this project yet. '
                  : 'No app-wide MCP servers yet. '),
                h('a', { href: storeHref }, 'Browse the MCP store'),
                projectDir
                  ? ' to install one in a couple of taps, or tap "+" to add one by hand. App-wide servers are managed from Settings → App defaults → MCP servers.'
                  : ' to install one in a couple of taps, or tap "+" to add one by hand — it will be available in every project.')
        )
      ),
      // App list only: deep-link into a project's list.
      !projectDir
        ? h('div', { class: 'row' },
            h('label', { class: 'label', for: 'mcp-open-project' }, 'Project servers'),
            h('div', { class: 'row row--inline' },
              h('input', {
                class: 'input', id: 'mcp-open-project', type: 'text',
                placeholder: 'C:/path/to/project', value: dirInput,
                onInput: (e) => setDirInput(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') openProject(); }
              }),
              h('button', { class: 'btn', type: 'button', onClick: openProject, disabled: isOpenBusy }, 'Open')
            ),
            h('span', { class: 'hint hint--compact' }, 'Project servers live with the project (committed to .mcp.json). Open a project to manage them.')
          )
        : null,
      h('div', { class: 'page-bar' },
      h('a', { href: storeHref, class: 'btn btn--small btn--primary' }, 'Browse store'),
      h('span', {
        class: 'status page-bar__status' + (listStatus.kind ? ' status--' + listStatus.kind : ''),
        'aria-live': 'polite'
      }, listStatus.text),
      h('button', {
        class: 'btn btn--small', type: 'button',
        'aria-label': 'Refresh servers',
        onClick: () => load(),
        disabled: isRefreshing
      }, '↻'),
h('a', { href: newHref, class: 'page-bar__add', 'aria-label': 'Add MCP server' }, '+')
)
),
activeError
? h(McpErrorModal, { error: activeError, onClose: () => setActiveError(null) })
: null
);
}

