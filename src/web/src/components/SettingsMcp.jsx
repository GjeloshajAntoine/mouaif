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
import { useRef, useEffect, useState } from 'preact/hooks';
import { fetchJson, setStatus, setActiveProject, activeProject } from '../api.js';
import { nav } from '../router.js';
import { McpAuthSeg, segMode } from './settings/toolAuth.js';

function projectQS(projectDir) {
  return projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
}

export function SettingsMcpView(props = {}) {
  // Scope comes from the URL, never from local tab state: the route
  // carries projectDir only when the user arrived from the Active
  // project card, so #/settings/mcp is always the app-wide list even
  // when an active project exists.
  const projectDir = typeof props.projectDir === 'string' ? props.projectDir : '';
  const projectName = projectDir ? projectDir.split(/[/\\]/).filter(Boolean).pop() || projectDir : '';

  const openBtn = useRef(null);
  const refreshBtn = useRef(null);
  const [dirInput, setDirInput] = useState('');
  const [serversList, setServersList] = useState([]);
  const [listStatus, setListStatus] = useState({ text: '', kind: '' });
  const [busyIds, setBusyIds] = useState(new Set()); // server ids being acted on
  // App-level MCP gate (mcp.authorization in the app store) — the
  // fallback for every project without its own gate (layer 4 of the
  // MCP authorization layering). Shown on the app list only; the app
  // store has no server registry, so it carries just mode + allowlist.
  const [appMcpAuth, setAppMcpAuth] = useState({ mode: 'ask', allowlist: [] });
  const [appMcpStatus, setAppMcpStatus] = useState('');
  const appMcpAuthRef = useRef(appMcpAuth);
  appMcpAuthRef.current = appMcpAuth;

  // Save the app-level gate. No projectDir: the PUT is scoped with
  // { scope: 'app' } and rejects server/tool maps.
  async function saveAppMcpAuth(patch) {
    setAppMcpStatus('saving…');
    const r = await fetchJson('/api/tools/authorization', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'app', mcp: patch })
    });
    if (r.status === 200) {
      setAppMcpStatus('saved');
      const m = r.body && r.body.mcp;
      if (m) {
        setAppMcpAuth({
          mode: (m && m.mode) || appMcpAuthRef.current.mode,
          allowlist: m && Array.isArray(m.allowlist) ? m.allowlist : appMcpAuthRef.current.allowlist
        });
      }
    } else {
      setAppMcpStatus('HTTP ' + r.status);
    }
  }

  // Debounced allowlist editor for the app gate (typing a regex must
  // not fire a PUT per keystroke).
  const saveAppMcpAllowlistDebounced = useRef((() => {
    let t = null;
    return (text) => {
      if (t) clearTimeout(t);
      setAppMcpStatus('…');
      t = setTimeout(() => {
        const allowlist = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const mode = allowlist.length ? 'allowlist' : 'ask';
        setAppMcpAuth({ mode, allowlist });
        saveAppMcpAuth({ mode, allowlist });
      }, 350);
    };
  })());

  async function load() {
    if (openBtn.current) openBtn.current.disabled = true;
    setListStatus({ text: 'loading…', kind: 'busy' });
    // Without projectDir the REST surface returns app-scoped servers
    // only; with it the merged app + project view.
    const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
    let r;
    try {
      r = await fetchJson('/api/mcp/servers' + qs);
    } catch (e) {
      setListStatus({ text: 'network error', kind: 'error' });
      if (openBtn.current) openBtn.current.disabled = false;
      return;
    }
    if (openBtn.current) openBtn.current.disabled = false;
    if (r.status !== 200) {
      setListStatus({ text: 'HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : ''), kind: 'error' });
      return;
    }
    setServersList(r.body.servers || []);
    setListStatus({ text: (r.body.servers || []).length + ' configured', kind: 'success' });
    // App list only: read the app-level MCP gate (the shared fallback
    // every project inherits until it sets its own).
    if (!projectDir) {
      try {
        const ar = await fetchJson('/api/tools/authorization?scope=app');
        const m = ar.status === 200 && ar.body && ar.body.mcp;
        if (m) {
          setAppMcpAuth({
            mode: (m && m.mode) || 'ask',
            allowlist: m && Array.isArray(m.allowlist) ? m.allowlist : []
          });
          setAppMcpStatus('');
        }
      } catch { /* keep defaults */ }
    }
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

  function serverRow(s) {
    const status = s.status || 'stopped';
    const disabled = s.enabled === false;
    const enabledBit = disabled ? 'disabled' : 'enabled';
    const toolBit = (s.tools && s.tools.length) ? s.tools.length + ' tool' + (s.tools.length === 1 ? '' : 's') : 'no tools';
    const isBusy = busyIds.has(s.id);
    // The editor link carries the list's own context: the app list
    // links projectDir-less, the project list links with projectDir and
    // the row's scope so an edit returns to the same list.
    const qs = projectDir
      ? projectQS(projectDir) + '&scope=' + encodeURIComponent(s.scope || 'project')
      : '?scope=app';
    const href = '#/settings/mcp/' + encodeURIComponent(s.id) + qs;
    const showStop = status === 'ready' || status === 'errored' || status === 'starting';
    // Why is Start unavailable? A disabled server cannot start from the
    // list — the user must re-enable it first. Say so instead of
    // leaving a dead button with no explanation.
    const startDisabled = disabled || status === 'starting' || isBusy;
    const startTitle = disabled
      ? 'Server is off — enable it in the editor (tap the row) to start it.'
      : (status === 'starting' ? 'Starting…' : 'Start this server');
    return h('li', { key: s.id, class: 'mcp__row' + (isBusy ? ' mcp__row--busy' : '') },
      h('a', { class: 'group__row settings-project__agent-link mcp__row-main', href },
        h('span', { class: 'group__row-body' },
          h('span', { class: 'group__row-label mcp__row-name' }, s.name, ' ', scopeBadge(s)),
          h('span', { class: 'settings-project__link-sub mcp__row-sub' }, (s.transport === 'http' ? 'http · ' : '') + status + ' · ' + enabledBit)
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
      disabled
        ? h('div', { class: 'mcp__row-err mcp__row-off' },
            'Server is off — the model does not see its tools. Tap the row to edit and re-enable it.')
        : null,
      (s.status === 'errored' && s.error)
        ? h('div', { class: 'mcp__row-err' }, (s.error.code || 'ERR') + ': ' + (s.error.message || ''))
        : null
    );
  }

  async function callLifecycle(action, id) {
    if (busyIds.has(id)) return;
    setBusyIds(prev => new Set(prev).add(id));
    setListStatus({ text: action + '…', kind: 'busy' });
    let r;
    try {
      r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir })
      });
    } catch (e) { setBusyIds(prev => { const n = new Set(prev); n.delete(id); return n; }); setListStatus({ text: 'network error', kind: 'error' }); return; }
    if (r.status !== 200) {
      setBusyIds(prev => { const n = new Set(prev); n.delete(id); return n; });
      setListStatus({ text: 'HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : ''), kind: 'error' });
      return;
    }
    setBusyIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    setListStatus({ text: action + 'ed', kind: 'success' });
    load();
  }

  async function refreshTools(id) {
    if (busyIds.has(id)) return;
    setBusyIds(prev => new Set(prev).add(id));
    setListStatus({ text: 'refreshing tools…', kind: 'busy' });
    const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
    let r;
    try {
      r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + '/tools' + qs);
    } catch (e) { setBusyIds(prev => { const n = new Set(prev); n.delete(id); return n; }); setListStatus({ text: 'network error', kind: 'error' }); return; }
    if (r.status !== 200) {
      setBusyIds(prev => { const n = new Set(prev); n.delete(id); return n; });
      setListStatus({ text: 'HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : ''), kind: 'error' });
      return;
    }
    setBusyIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    setListStatus({ text: (r.body.tools || []).length + ' tools', kind: 'success' });
    load();
  }

  useEffect(() => { load(); }, [projectDir]);

  const newHref = '#/settings/mcp/new' + (projectDir ? projectQS(projectDir) + '&scope=project' : '?scope=app');
  const backHref = projectDir ? ('#/settings/project?projectDir=' + encodeURIComponent(projectDir)) : '#/settings';

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: backHref, class: 'view-back', 'aria-label': 'Back' }, '←'),
      h('h2', { class: 'view-title' }, projectDir ? 'MCP servers · ' + projectName : 'MCP servers · app defaults')
    ),
    h('p', { class: 'hint hint--compact' },
      projectDir
        ? 'Servers this project can use: the app-wide servers (app badge) plus any servers committed to this project\'s .mcp.json (project badge). If a project server has the same name as an app one, the project server is the one that runs.'
        : 'Model Context Protocol servers available in every project. The AI client discovers each server\'s tools and advertises them to the model. A project can add its own servers on top of these.'),
    // ---- App-level permission default (app list only) -------------------
    // The app store has no server registry, so the app list shows only
    // the single shared gate — the default every project starts from. A
    // project can override it from Settings → Project → Tools.
    !projectDir
      ? h('div', { class: 'group' },
          h('div', { class: 'group__title' }, 'Default permission', h('span', { class: 'group__title-note' }, 'Starting point for every project')),
          h('ul', { class: 'group__list' },
            h('li', { class: 'settings-project__tool' },
              h('div', { class: 'settings-project__tool-head' },
                h('div', { class: 'settings-project__item-title' }, 'All MCP tools'),
                h('div', { class: 'settings-project__item-note' },
                  'How MCP tool calls are handled by default in every project. A project can change this or set per-server rules from its own project settings. ',
                  segMode(appMcpAuth.mode) === 'off' ? 'Off means MCP tools are hidden from the model and cost no tokens. ' : null,
                  h('span', { class: 'settings-project__item-status', 'aria-live': 'polite' }, appMcpStatus)
                )
              ),
              h(McpAuthSeg, {
                name: 'MCP app default',
                slug: null,
                servers: {},
                shared: appMcpAuth,
                namePrefix: 'app-mcp',
                onSave: (patch) => {
                  if (!patch) return;
                  const mode = patch.mode || 'ask';
                  const allowlist = Array.isArray(patch.allowlist) ? patch.allowlist : [];
                  setAppMcpAuth({ mode, allowlist });
                  saveAppMcpAuth({ mode, allowlist });
                }
              }),
              segMode(appMcpAuth.mode) === 'ask'
                ? h('details', { class: 'settings-project__allowlist' },
                    h('summary', null, appMcpAuth.allowlist.length ? ('Auto-approve list (' + appMcpAuth.allowlist.length + ')') : 'Auto-approve list'),
                    h('p', { class: 'settings-project__help' }, 'Calls whose summary matches one of these regexes run without asking; everything else still asks. One per line, auto-saves.'),
                    h('textarea', { class: 'input settings-project__mono', rows: 3, spellcheck: false, placeholder: '^navigate$\n^take_snapshot$', value: appMcpAuth.allowlist.join('\n'), onInput: (e) => saveAppMcpAllowlistDebounced.current(e.target.value) })
                  )
                : null
            )
          )
        )
      : null,
    // ---- Server list -----------------------------------------------------
    h('div', { class: 'group' },
      h('div', { class: 'group__title' }, 'Servers', h('span', { class: 'group__title-note' }, serversList.length + ' configured')),
      h('ul', { class: 'group__list mcp__list', 'aria-label': 'MCP servers' },
        serversList.length
          ? serversList.map(serverRow)
          : h('li', { class: 'mcp__empty' },
              projectDir
                ? 'No MCP servers for this project yet. Tap "+" to add one. App-wide servers are managed from Settings → App defaults → MCP servers.'
                : 'No app-wide MCP servers yet. Tap "+" to add one — it will be available in every project.')
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
            h('button', { ref: openBtn, class: 'btn', type: 'button', onClick: openProject }, 'Open')
          ),
          h('span', { class: 'hint hint--compact' }, 'Project servers live with the project (committed to .mcp.json). Open a project to manage them.')
        )
      : null,
    h('div', { class: 'page-bar' },
      h('a', { href: '#/settings/mcp/registry' + projectQS(projectDir), class: 'btn btn--small', type: 'button' }, 'Browse Registry'),
      h('span', {
        class: 'status page-bar__status' + (listStatus.kind ? ' status--' + listStatus.kind : ''),
        'aria-live': 'polite'
      }, listStatus.text),
      h('button', {
        ref: refreshBtn, class: 'btn btn--small', type: 'button',
        'aria-label': 'Refresh servers',
        onClick: () => load()
      }, '↻'),
      h('a', { href: newHref, class: 'page-bar__add', 'aria-label': 'Add MCP server' }, '+')
    )
  );
}

export function SettingsMcpEditView(props) {
  const id = props.id || '';
  // projectDir comes from the route first. For *add* mode only, fall
  // back to the active project (so the "+" button on the project list
  // pre-fills the context). For *edit* mode, the route's projectDir is
  // the only source of truth — the active project may be different.
  const routeProjectDir = props.projectDir || '';
  const activeDir = (activeProject.value && activeProject.value.dir) || '';
  const projectDir = id ? routeProjectDir : (routeProjectDir || activeDir);
  // The scope an add creates in, pre-selected from the list the user
  // came from; an edit always reflects the server's actual scope
  // (scope is fixed at creation — delete + re-add to move).
  const [addScope, setAddScope] = useState(
    props.scope === 'app' ? 'app' : (props.scope === 'project' ? 'project' : (routeProjectDir ? 'project' : 'app'))
  );
  const [currentScope, setCurrentScope] = useState(props.scope === 'app' ? 'app' : 'project');

  const nameEl = useRef(null);
  const [transport, setTransport] = useState('stdio');
  const commandEl = useRef(null);
  const urlEl = useRef(null);
  const argsEl = useRef(null);
  const envEl = useRef(null);
  const headersEl = useRef(null);
  const cwdEl = useRef(null);
  const enabledEl = useRef(null);
  const statusEl = useRef(null);
  const saveBtn = useRef(null);
  const deleteBtn = useRef(null);

  const [currentServer, setCurrentServer] = useState(null);
  const [toolAuths, setToolAuths] = useState({});
  const [toolsState, setToolsState] = useState([]);
  const [toolAuthMsg, setToolAuthMsg] = useState('');
  // Write-only env/headers: the server returns only key names (values
  // are redacted). We store the key list so the UI can show hints.
  const [configuredEnvKeys, setConfiguredEnvKeys] = useState([]);
  const [configuredHeaderKeys, setConfiguredHeaderKeys] = useState([]);
  const [clearEnv, setClearEnv] = useState(false);
  const [clearHeaders, setClearHeaders] = useState(false);

  async function load() {
    if (id) {
      // List and find by id; the dedicated /api/mcp/servers/:id route
      // is reserved for a future revision (a `getServer` REST shape).
      // With projectDir the list is the merged app + project view;
      // without it the app-wide list. Either way the record's scope
      // tells the editor which file the save lands in.
      const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
      let r;
      try {
        r = await fetchJson('/api/mcp/servers' + qs);
      } catch (e) { setStatus(statusEl, 'network error', 'error'); return; }
      if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); return; }
      const current = (r.body.servers || []).find(s => s.id === id) || null;
      if (!current) { setStatus(statusEl, 'Server not found', 'error'); return; }
      setCurrentServer(current);
      setCurrentScope(current.scope === 'app' ? 'app' : 'project');
      if (nameEl.current) nameEl.current.value = current.name || '';
      setTransport(current.transport === 'http' ? 'http' : 'stdio');
      if (commandEl.current) commandEl.current.value = current.command || '';
      if (urlEl.current) urlEl.current.value = current.url || '';
      if (argsEl.current) argsEl.current.value = (current.args || []).join(' ');
      // Secret values are write-only. The server only returns key names.
      // Show the key names as a placeholder hint so the user knows what's
      // configured without losing the write-only semantics.
      if (envEl.current) {
        envEl.current.value = '';
        const envKeys = Object.keys(current.env || {}).filter(k => current.env[k] && current.env[k].configured);
        setConfiguredEnvKeys(envKeys);
        envEl.current.placeholder = envKeys.length
          ? 'Already configured: ' + envKeys.join(', ') + '. Enter new values or leave blank to keep.'
          : 'API_TOKEN=...\nLOG_LEVEL=info';
      }
      if (headersEl.current) {
        headersEl.current.value = '';
        const headerKeys = Object.keys(current.headers || {}).filter(k => current.headers[k] && current.headers[k].configured);
        setConfiguredHeaderKeys(headerKeys);
        headersEl.current.placeholder = headerKeys.length
          ? 'Already configured: ' + headerKeys.join(', ') + '. Enter new values or leave blank to keep.'
          : 'Authorization: Bearer ...';
      }
      if (cwdEl.current) cwdEl.current.value = current.cwd || '';
      if (enabledEl.current) enabledEl.current.checked = current.enabled === true;
      if (deleteBtn.current) deleteBtn.current.hidden = false;
      setToolsState(current.tools || []);
      // Per-tool overrides for THIS server's tools live under
      // mcp.authorization.tools.<composedName> — project-scoped, so the
      // section only renders for project-scoped servers with a project.
      if (current.scope !== 'app' && projectDir) {
        try {
          const ar = await fetchJson('/api/tools/authorization?projectDir=' + encodeURIComponent(projectDir));
          const mcp = ar.status === 200 && ar.body.mcp;
          const map = (mcp && mcp.tools && typeof mcp.tools === 'object') ? mcp.tools : {};
          setToolAuths(map);
        } catch { /* keep empty map */ }
      }
    } else {
      if (deleteBtn.current) deleteBtn.current.hidden = true;
      if (enabledEl.current) enabledEl.current.checked = true;
    }
    setStatus(statusEl, '');
  }

  async function saveToolAuth(composedName, value) {
    setToolAuthMsg('saving…');
    const patch = {};
    if (value === 'inherit') patch[composedName] = null;
    else patch[composedName] = { mode: value };
    const r = await fetchJson('/api/tools/authorization', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, mcp: { tools: patch } })
    });
    if (r.status === 200) {
      setToolAuthMsg('saved');
      setToolAuths((prev) => {
        const next = Object.assign({}, prev);
        if (value === 'inherit') delete next[composedName];
        else next[composedName] = { mode: value };
        return next;
      });
    } else {
      setToolAuthMsg('HTTP ' + r.status);
    }
  }

  function renderToolsList() {
    if (!toolsState.length) {
      return h('li', { class: 'mcp__tools-empty' }, (currentServer && currentServer.status === 'ready') ? 'No tools reported by this server.' : 'Start the server to see its tools.');
    }
    return toolsState.map((t) => {
      const composed = 'mcp__' + (currentServer && currentServer.slug || '') + '__' + t.name;
      const entry = toolAuths[composed];
      const value = (entry && entry.mode) || 'inherit';
      return h('li', { key: composed, class: 'mcp__tools-row' },
        h('div', { class: 'mcp__tools-name' }, composed),
        t.description ? h('div', { class: 'mcp__tools-desc' }, t.description) : null,
        h('div', { class: 'row row--inline' },
          h('label', { class: 'label' }, 'Authorization'),
          h('select', {
            class: 'input',
            value,
            onChange: (e) => saveToolAuth(composed, e.target.value)
          },
            h('option', { value: 'inherit' }, 'Inherit (shared / server)'),
            h('option', { value: 'off' }, 'Off'),
            h('option', { value: 'ask' }, 'Ask'),
            h('option', { value: 'allow' }, 'Allow')
          )
        )
      );
    });
  }
  function parseArgs(text) {
    if (!text || !text.trim()) return [];
    // Whitespace-separated tokens. We deliberately do not run a shell
    // parser here — the user is configuring an executable, not
    // authoring a one-liner. Quoted multi-word args are not yet
    // supported; a future revision can add shlex.
    return text.trim().split(/\s+/).filter(Boolean);
  }

  function parseEnv(text) {
    if (!text || !text.trim()) return {};
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      out[m[1]] = m[2];
    }
    return out;
  }

  function parseHeaders(text) {
    if (!text || !text.trim()) return {};
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([^:=\s][^:=]*?)\s*[:=]\s*(.*)$/);
      if (!m) continue;
      out[m[1].trim()] = m[2];
    }
    return out;
  }

  async function save() {
    if (saveBtn.current) saveBtn.current.disabled = true;
    setStatus(statusEl, 'saving…', 'busy');
    const scope = id ? currentScope : addScope;
    if (!id && scope === 'project' && !projectDir) {
      setStatus(statusEl, 'a project-scoped server needs an active project — switch to App or open a project first', 'error');
      if (saveBtn.current) saveBtn.current.disabled = false;
      return;
    }
    const body = {
      projectDir,
      scope,
      transport,
      name: (nameEl.current.value || '').trim(),
      command: transport === 'stdio' ? (commandEl.current.value || '').trim() : '',
      url: transport === 'http' ? (urlEl.current.value || '').trim() : '',
      args: transport === 'stdio' ? parseArgs(argsEl.current.value) : [],
      cwd: transport === 'stdio' ? (cwdEl.current.value || '').trim() : '',
      enabled: enabledEl.current.checked !== false
    };
    const envText = envEl.current.value || '';
    const headersText = headersEl.current.value || '';
    // Preserve existing env/headers when the textarea is empty (the
    // values are write-only, so the user can't round-trip them).
    // To clear, the user must tap the "Clear" button next to the field.
    if (clearEnv) body.env = {};
    else if (envText.trim()) body.env = parseEnv(envText);
    if (clearHeaders) body.headers = {};
    else if (headersText.trim()) body.headers = parseHeaders(headersText);
    if (!body.name) { setStatus(statusEl, 'name is required', 'error'); if (saveBtn.current) saveBtn.current.disabled = false; return; }
    if (transport === 'stdio' && !body.command) { setStatus(statusEl, 'command is required', 'error'); if (saveBtn.current) saveBtn.current.disabled = false; return; }
    if (transport === 'http' && !body.url) { setStatus(statusEl, 'URL is required', 'error'); if (saveBtn.current) saveBtn.current.disabled = false; return; }
    let r;
    try {
      r = await fetchJson(id ? ('/api/mcp/servers/' + encodeURIComponent(id)) : '/api/mcp/servers', {
        method: id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) { setStatus(statusEl, 'network error', 'error'); if (saveBtn.current) saveBtn.current.disabled = false; return; }
    if (saveBtn.current) saveBtn.current.disabled = false;
    if (r.status !== 200 && r.status !== 201) { setStatus(statusEl, 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''), 'error'); return; }
    setStatus(statusEl, 'saved', 'success');
    nav('settings/mcp' + projectQS(projectDir));
  }

  async function deleteServer() {
    if (!id) return;
    if (!confirm('Delete this MCP server?')) return;
    if (deleteBtn.current) deleteBtn.current.disabled = true;
    setStatus(statusEl, 'deleting…', 'busy');
    const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
    let r;
    try {
      r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + qs, { method: 'DELETE' });
    } catch (e) { setStatus(statusEl, 'network error', 'error'); if (deleteBtn.current) deleteBtn.current.disabled = false; return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); if (deleteBtn.current) deleteBtn.current.disabled = false; return; }
    nav('settings/mcp' + projectQS(projectDir));
  }

  useEffect(() => { load(); }, [id]);

  const title = id ? 'Edit MCP server' : 'Add MCP server';
  // Back button: always go to the list the user came from. If the route
  // carries a projectDir, go back to the project list; otherwise go to
  // the app-wide list. The edit view's own projectDir is the route's
  // value, not the active project fallback.
  const backQSPath = id ? routeProjectDir : projectDir;
  const backHref = '#/settings/mcp' + projectQS(backQSPath);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: backHref, class: 'view-back', 'aria-label': 'Back to MCP servers' }, '←'),
      h('h2', { class: 'view-title' }, title)
    ),
    // ---- Scope (add only; fixed at creation) ----------------------------
    id
      ? h('p', { class: 'hint hint--compact' },
          currentScope === 'app'
            ? 'Scope: app-wide — stored in the app store, visible to every project.'
            : 'Scope: project — stored in this project\'s .mcp.json so it can be committed with the repo.',
          ' Scope is set at creation; delete and re-add to move a server.')
      : h('div', { class: 'row' },
          h('label', { class: 'label' }, 'Scope'),
          h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Server scope' },
            [{ value: 'app', label: 'App (all projects)' }, { value: 'project', label: 'This project' }].map((m) =>
              h('label', { key: m.value, class: 'seg__item' + (addScope === m.value ? ' seg__item--on' : '') },
                h('input', {
                  type: 'radio', name: 'mcp-add-scope', value: m.value,
                  checked: addScope === m.value,
                  onChange: () => setAddScope(m.value)
                }),
                h('span', { class: 'seg__pill' }, m.label)
              )
            )
          ),
          addScope === 'project' && !projectDir
            ? h('span', { class: 'hint hint--compact' }, 'No active project — open a chat in the project first, or pick App scope.')
            : null
        ),
    h('div', { class: 'row' },
      h('label', { class: 'label', for: 'mcp-name' }, 'Name'),
      h('input', { ref: nameEl, class: 'input', id: 'mcp-name', type: 'text', placeholder: 'e.g. filesystem' })
    ),
    h('div', { class: 'row' },
      h('label', { class: 'label' }, 'Transport'),
      h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'MCP transport' },
        [{ value: 'stdio', label: 'Stdio' }, { value: 'http', label: 'HTTP' }].map((m) =>
          h('label', { key: m.value, class: 'seg__item' + (transport === m.value ? ' seg__item--on' : '') },
            h('input', {
              type: 'radio', name: 'mcp-transport', value: m.value,
              checked: transport === m.value,
              onChange: () => setTransport(m.value)
            }),
            h('span', { class: 'seg__pill' }, m.label)
          )
        )
      )
    ),
    transport === 'stdio' ? h(Fragment, null,
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'mcp-command' }, 'Command'),
        h('input', { ref: commandEl, class: 'input', id: 'mcp-command', type: 'text', placeholder: 'node' })
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'mcp-args' }, 'Arguments (whitespace-separated)'),
        h('input', { ref: argsEl, class: 'input', id: 'mcp-args', type: 'text', placeholder: 'path/to/server.js' })
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'mcp-env' }, 'Environment (one KEY=value per line)'),
        h('textarea', { ref: envEl, class: 'input', id: 'mcp-env', rows: 4, spellcheck: false, placeholder: 'API_TOKEN=...\nLOG_LEVEL=info', 'aria-describedby': 'mcp-env-hint' }),
        h('span', { id: 'mcp-env-hint', class: 'hint hint--compact' }, 'Values are write-only and are never returned by the API. Leave blank to preserve existing values.'),
        id && configuredEnvKeys.length
          ? h('div', { class: 'row row--inline', style: 'margin-top:4px' },
              h('span', { class: 'hint', style: 'font-size:0.72rem;color:var(--muted);flex:1' }, 'Configured keys: ' + configuredEnvKeys.join(', ')),
              h('button', {
                class: 'btn btn--small', type: 'button',
                style: 'color:var(--danger);border-color:var(--danger)',
                onClick: () => { setClearEnv(true); if (envEl.current) { envEl.current.value = ''; envEl.current.placeholder = ''; } }
              }, 'Clear all')
            )
          : null
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'mcp-cwd' }, 'Working directory (optional, relative to project)'),
        h('input', { ref: cwdEl, class: 'input', id: 'mcp-cwd', type: 'text', placeholder: 'tools/my-mcp' })
      )
    ) : h(Fragment, null,
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'mcp-url' }, 'HTTP URL'),
        h('input', { ref: urlEl, class: 'input', id: 'mcp-url', type: 'url', placeholder: 'https://example.com/mcp' })
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'mcp-headers' }, 'HTTP headers (one Name: value per line)'),
        h('textarea', { ref: headersEl, class: 'input', id: 'mcp-headers', rows: 4, spellcheck: false, placeholder: 'Authorization: Bearer ...', 'aria-describedby': 'mcp-headers-hint' }),
        h('span', { id: 'mcp-headers-hint', class: 'hint hint--compact' }, 'Header values are write-only and are never returned by the API. Leave blank to preserve existing values.'),
        id && configuredHeaderKeys.length
          ? h('div', { class: 'row row--inline', style: 'margin-top:4px' },
              h('span', { class: 'hint', style: 'font-size:0.72rem;color:var(--muted);flex:1' }, 'Configured keys: ' + configuredHeaderKeys.join(', ')),
              h('button', {
                class: 'btn btn--small', type: 'button',
                style: 'color:var(--danger);border-color:var(--danger)',
                onClick: () => { setClearHeaders(true); if (headersEl.current) { headersEl.current.value = ''; headersEl.current.placeholder = ''; } }
              }, 'Clear all')
            )
          : null
      )
    ),
    h('div', { class: 'row row--inline' },
      h('input', { ref: enabledEl, class: 'checkbox', id: 'mcp-enabled', type: 'checkbox' }),
      h('label', { class: 'label', for: 'mcp-enabled' }, 'Enabled')
    ),
    id && currentScope !== 'app' && projectDir ? h('div', { class: 'row' },
      h('h3', { class: 'mcp__tools-h' }, 'Discovered tools'),
      h('p', { class: 'hint hint--compact' },
        'Per-tool authorization overrides. "Inherit" uses the server-level or shared fallback gate; a tool override wins for that call. ',
        h('span', { class: 'settings-project__item-status', 'aria-live': 'polite' }, toolAuthMsg)
      ),
      h('ul', { class: 'mcp__tools-list' },
        renderToolsList()
      )
    ) : null,
    h('div', { class: 'row row--actions' },
      h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: save }, 'Save'),
      h('button', { ref: deleteBtn, class: 'btn btn--danger', type: 'button', onClick: deleteServer, hidden: true }, 'Delete')
    ),
    h('div', { class: 'row' },
      h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
    )
  );
}
