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
  // MCP authorization is layered (decisions §18): a per-server entry
  // under mcp.authorization.servers.<slug> overrides the shared
  // fallback gate; a per-tool entry under mcp.authorization.tools.
  // <composedName> overrides both. The state below mirrors the
  // persisted maps so each row is its own segmented control. The maps
  // live in the project's .mcp.json, so they render on the project
  // list only.
  const [mcpAuth, setMcpAuth] = useState({ mode: 'ask', allowlist: [], servers: {}, tools: {} });
  const [mcpAuthStatusMsg, setMcpAuthStatusMsg] = useState('');
  const [serversList, setServersList] = useState([]);
  const [listStatus, setListStatus] = useState({ text: '', kind: '' });
  const [busyIds, setBusyIds] = useState(new Set()); // server ids being acted on

  function segMode(mode) { return mode === 'allowlist' ? 'ask' : mode; }

  // One PUT path for every MCP authorization change. The patch body
  // carries { mode?, servers?, tools? } — see setAuthorization. On the
  // app list there is no projectDir, so we write the app-level shared
  // gate with scope: 'app' (the server rejects server/tool maps there —
  // the app store has no server registry, decisions §18).
  async function saveMcpAuthorization(patch) {
    setMcpAuthStatusMsg('saving…');
    const body = projectDir
      ? { projectDir, mcp: patch }
      : { scope: 'app', mcp: patch };
    const r = await fetchJson('/api/tools/authorization', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    setMcpAuthStatusMsg(r.status === 200 ? 'saved' : ('HTTP ' + r.status));
  }

  function pickMcpMode(newMode) {
    // Tapping Allow clears any allowlist: auto-approve-everything makes
    // the patterns meaningless, and dropping them keeps .mcp.json honest.
    const allowlist = newMode === 'allow' ? [] : mcpAuth.allowlist;
    setMcpAuth(Object.assign({}, mcpAuth, { mode: newMode, allowlist }));
    saveMcpAuthorization({ mode: newMode, allowlist });
  }

  function onMcpAllowlistInput(text) {
    const allowlist = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const mode = allowlist.length ? 'allowlist' : 'ask';
    setMcpAuth(Object.assign({}, mcpAuth, { mode, allowlist }));
    saveMcpAuthorization({ mode, allowlist });
  }

  // Per-server override. 'inherit' clears the entry (a null patch);
  // anything else persists { mode } (+ allowlist for mode 'allowlist').
  function pickServerMode(slug, value) {
    const servers = Object.assign({}, mcpAuth.servers);
    const patch = {};
    if (value === 'inherit') {
      delete servers[slug];
      patch[slug] = null;
    } else {
      const entry = { mode: value };
      if (value === 'allowlist') entry.allowlist = (servers[slug] && servers[slug].allowlist) || [];
      servers[slug] = entry;
      patch[slug] = entry;
    }
    setMcpAuth(Object.assign({}, mcpAuth, { servers }));
    saveMcpAuthorization({ servers: patch });
  }

  function onServerAllowlistInput(slug, text) {
    const allowlist = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    // An empty pattern list under Ask means "no override" — clear the
    // entry so the shared fallback stays in charge.
    if (!allowlist.length) { pickServerMode(slug, 'inherit'); return; }
    const servers = Object.assign({}, mcpAuth.servers);
    servers[slug] = { mode: 'allowlist', allowlist };
    setMcpAuth(Object.assign({}, mcpAuth, { servers }));
    saveMcpAuthorization({ servers: { [slug]: { mode: 'allowlist', allowlist } } });
  }

  // Debounced so typing a regex doesn't fire a PUT per keystroke.
  const saveMcpAllowlistDebounced = useRef((() => {
    let t = null;
    return (text) => {
      if (t) clearTimeout(t);
      setMcpAuthStatusMsg('…');
      t = setTimeout(() => onMcpAllowlistInput(text), 350);
    };
  })());
  const saveServerAllowlistDebounced = useRef((() => {
    const timers = new Map();
    return (slug, text) => {
      if (timers.has(slug)) clearTimeout(timers.get(slug));
      setMcpAuthStatusMsg('…');
      timers.set(slug, setTimeout(() => onServerAllowlistInput(slug, text), 350));
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
    // MCP authorization is layered (decisions §18). Both scopes expose the
    // shared gate (mode + allowlist); per-server / per-tool overrides are
    // project-only, so the app list loads the gate with scope=app and
    // leaves the server/tool maps empty.
    try {
      const authUrl = projectDir
        ? '/api/tools/authorization?projectDir=' + encodeURIComponent(projectDir)
        : '/api/tools/authorization?scope=app';
      const ar = await fetchJson(authUrl);
      const mcp = ar.status === 200 && ar.body.mcp;
      setMcpAuth({
        mode: (mcp && mcp.mode) || 'ask',
        allowlist: mcp && Array.isArray(mcp.allowlist) ? mcp.allowlist : [],
        servers: (mcp && mcp.servers && typeof mcp.servers === 'object') ? mcp.servers : {},
        tools: (mcp && mcp.tools && typeof mcp.tools === 'object') ? mcp.tools : {}
      });
      setMcpAuthStatusMsg('');
    } catch { /* keep ask + empty maps */ }
  }

  // App list convenience: jump into a project's list without going back
  // through the chat first.
  function openProject() {
    const dir = (dirInput || '').trim();
    if (!dir) { setListStatus({ text: 'type a project directory first', kind: 'error' }); return; }
    setActiveProject(dir, '');
    nav('settings/mcp' + projectQS(dir));
  }

  // One segmented Off/Ask/Allow control. `name` must be unique per
  // row so the radio inputs don't cross-select between servers.
  function authSegs(name, activeMode, onPick) {
    const modes = [{ value: 'off', label: 'Off' }, { value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }];
    return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': name },
      modes.map((m) =>
        h('label', { key: m.value, class: 'seg__item' + (activeMode === m.value ? ' seg__item--on' : '') },
          h('input', {
            type: 'radio',
            name: 'sp-' + name.replace(/\s+/g, '-').toLowerCase(),
            value: m.value,
            checked: activeMode === m.value,
            onChange: () => onPick(m.value)
          }),
          h('span', { class: 'seg__pill' }, m.label)
        )
      )
    );
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
    const enabledBit = s.enabled === false ? 'disabled' : 'enabled';
    const toolBit = (s.tools && s.tools.length) ? s.tools.length + ' tool' + (s.tools.length === 1 ? '' : 's') : 'no tools';
    const isBusy = busyIds.has(s.id);
    // The editor link carries the list's own context: the app list
    // links projectDir-less, the project list links with projectDir and
    // the row's scope so an edit returns to the same list.
    const qs = projectDir
      ? projectQS(projectDir) + '&scope=' + encodeURIComponent(s.scope || 'project')
      : '?scope=app';
    const href = '#/settings/mcp/' + encodeURIComponent(s.id) + qs;
    return h('li', { key: s.id, class: 'mcp__row' + (isBusy ? ' mcp__row--busy' : '') },
      h('a', { class: 'group__row settings-project__agent-link mcp__row-main', href },
        h('span', { class: 'group__row-body' },
          h('span', { class: 'group__row-label mcp__row-name' }, s.name, ' ', scopeBadge(s)),
          h('span', { class: 'settings-project__link-sub mcp__row-sub' }, (s.transport === 'http' ? 'http · ' : '') + status + ' · ' + enabledBit)
        ),
        h('span', { class: 'group__row-detail' }, toolBit),
        h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
      ),
      (s.status === 'errored' && s.error)
        ? h('div', { class: 'mcp__row-err' }, (s.error.code || 'ERR') + ': ' + (s.error.message || ''))
        : null,
      // Quick-action row: Start / Stop / Refresh. Inline so the user
      // does not have to open the editor just to control the lifecycle.
      h('div', { class: 'mcp__row-actions' },
        h('button', {
          class: 'btn btn--small', type: 'button',
          disabled: s.enabled === false || status === 'starting' || isBusy,
          onClick: () => callLifecycle('start', s.id)
        }, status === 'ready' ? 'Restart' : 'Start'),
        (status === 'ready' || status === 'errored' || status === 'starting')
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
            }, 'Refresh tools')
          : null
      )
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
    // the single shared gate. This is the default every project starts
    // from; a project can set its own gate or per-server rules on top.
    !projectDir
      ? h('div', { class: 'group' },
          h('div', { class: 'group__title' }, 'Default permission', h('span', { class: 'group__title-note' }, 'Starting point for every project')),
          h('ul', { class: 'group__list' },
            h('li', { class: 'settings-project__tool' },
              h('div', { class: 'settings-project__tool-head' },
                h('div', { class: 'settings-project__item-title' }, 'All MCP tools'),
                h('div', { class: 'settings-project__item-note' },
                  'How MCP tool calls are handled by default, in every project. A project can change this or set per-server rules from its own MCP page. ',
                  segMode(mcpAuth.mode) === 'off' ? 'Off means MCP tools are hidden from the model and cost no tokens. ' : null,
                  h('span', { class: 'settings-project__item-status', 'aria-live': 'polite' }, mcpAuthStatusMsg)
                )
              ),
              authSegs('mcp-app-default', segMode(mcpAuth.mode), pickMcpMode),
              segMode(mcpAuth.mode) === 'ask'
                ? h('details', { class: 'settings-project__allowlist' },
                    h('summary', null, mcpAuth.allowlist.length ? ('Auto-approve list (' + mcpAuth.allowlist.length + ')') : 'Auto-approve list'),
                    h('p', { class: 'settings-project__help' }, 'Calls whose summary matches one of these regexes run without asking; everything else still asks. One per line, auto-saves.'),
                    h('textarea', { class: 'input settings-project__mono', rows: 3, spellcheck: false, placeholder: `^navigate$\n^take_snapshot$`, value: mcpAuth.allowlist.join('\n'), onInput: (e) => saveMcpAllowlistDebounced.current(e.target.value) })
                  )
                : null
            )
          )
        )
      : null,
    // ---- Tool permissions (project list only) ---------------------------
    projectDir
      ? h('div', { class: 'group' },
          h('div', { class: 'group__title' }, 'Tool permissions', h('span', { class: 'group__title-note' }, 'Per server, falls back to the app default')),
          h('ul', { class: 'group__list' },
            serversList.map((s) => {
              const slug = s.slug || s.id;
              const entry = mcpAuth.servers && mcpAuth.servers[slug];
              const overridden = !!(entry && entry.mode);
              const effMode = overridden ? entry.mode : mcpAuth.mode;
              const effAllowlist = overridden && Array.isArray(entry.allowlist) ? entry.allowlist : mcpAuth.allowlist;
              return h('li', { key: s.id, class: 'settings-project__tool' },
                h('div', { class: 'settings-project__tool-head' },
                  h('div', { class: 'settings-project__item-title' }, s.name || slug, ' ', scopeBadge(s)),
                  h('div', { class: 'settings-project__item-note' },
                    overridden ? ('Set to ' + effMode + ' for this server. ') : ('Using this project\'s default (' + mcpAuth.mode + '). '),
                    segMode(effMode) === 'off' ? 'Hidden from the model — costs no tokens. ' : null,
                    h('span', { class: 'settings-project__item-status', 'aria-live': 'polite' }, mcpAuthStatusMsg)
                  )
                ),
                authSegs('mcp-server-' + slug, segMode(effMode), (mode) => pickServerMode(slug, mode)),
                overridden
                  ? h('button', { class: 'btn btn--small', type: 'button', onClick: () => pickServerMode(slug, 'inherit') }, 'Use project default')
                  : null,
                segMode(effMode) === 'ask'
                  ? h('details', { class: 'settings-project__allowlist' },
                      h('summary', null, effAllowlist.length ? ('Auto-approve list (' + effAllowlist.length + ')') : 'Auto-approve list'),
                      h('p', { class: 'settings-project__help' }, 'Calls from this server matching one of these regexes run without asking; everything else still asks. One per line, auto-saves.'),
                      h('textarea', {
                        class: 'input settings-project__mono', rows: 3, spellcheck: false,
                        placeholder: `^mcp__${slug}__search`, value: effAllowlist.join('\n'),
                        onInput: (e) => saveServerAllowlistDebounced.current(slug, e.target.value)
                      })
                    )
                  : null
              );
            }),
            h('li', { class: 'settings-project__tool' },
              h('div', { class: 'settings-project__tool-head' },
                h('div', { class: 'settings-project__item-title' }, 'This project\'s default (all MCP servers)'),
                h('div', { class: 'settings-project__item-note' },
                  'Applies to every server above without its own rule. Leave it on Ask to fall back to the app-wide default. ',
                  segMode(mcpAuth.mode) === 'off' ? 'Off hides MCP tools from the model — costs no tokens. ' : null
                )
              ),
              authSegs('mcp-shared', segMode(mcpAuth.mode), pickMcpMode),
              segMode(mcpAuth.mode) === 'ask'
                ? h('details', { class: 'settings-project__allowlist' },
                    h('summary', null, mcpAuth.allowlist.length ? ('Auto-approve list (' + mcpAuth.allowlist.length + ')') : 'Auto-approve list'),
                    h('p', { class: 'settings-project__help' }, 'Calls whose summary matches one of these regexes run without asking; everything else still asks. One per line, auto-saves.'),
                    h('textarea', { class: 'input settings-project__mono', rows: 3, spellcheck: false, placeholder: `^navigate$\n^take_snapshot$`, value: mcpAuth.allowlist.join('\n'), onInput: (e) => saveMcpAllowlistDebounced.current(e.target.value) })
                  )
                : null
            )
          )
        )
      : null,
    // ---- Server list -----------------------------------------------------
    h('ul', { class: 'mcp__list settings-project__agents-list', 'aria-label': 'MCP servers' },
      serversList.length
        ? serversList.map(serverRow)
        : h('li', { class: 'mcp__empty' },
            projectDir
              ? 'No MCP servers for this project yet. Tap "+" to add one. App-wide servers are managed from Settings → App defaults → MCP servers.'
              : 'No app-wide MCP servers yet. Tap "+" to add one — it will be available in every project.')
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
