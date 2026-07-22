// mouaif web — SettingsMcpView (MCP server list) + SettingsMcpEditView
// MCP = Model Context Protocol. Servers can be configured app-wide
// (visible to every project) or per project (committed to
// <projectDir>/.mcp.json). The list view has an App / Project scope
// switcher; a project entry with the same slug shadows the app entry.
// See docs/features/mcp.md.
import { h, Fragment } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';
import { fetchJson, setStatus, setActiveProject, activeProject } from '../api.js';
import { nav } from '../router.js';

function projectDirFromProps(props = {}) {
  // The route can override the active project (testing + deep links).
  return props.projectDir || (activeProject.value && activeProject.value.dir) || '';
}

function projectQS(projectDir) {
  return projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
}

export function SettingsMcpView(props = {}) {
  const statusEl = useRef(null);
  const loadBtn = useRef(null);
  // Scope: 'project' shows the merged app + project view for the active
  // project (with per-server authorization rows); 'app' shows only the
  // app-wide entries (no project needed, no per-project authorization).
  const [scope, setScope] = useState(() => (projectDirFromProps(props) ? 'project' : 'app'));
  const [projectDir, setProjectDir] = useState(projectDirFromProps(props));
  // MCP authorization is layered (decisions §18): a per-server entry
  // under mcp.authorization.servers.<slug> overrides the shared
  // fallback gate; a per-tool entry under mcp.authorization.tools.
  // <composedName> overrides both. The state below mirrors the
  // persisted maps so each row is its own segmented control.
  const [mcpAuth, setMcpAuth] = useState({ mode: 'ask', allowlist: [], servers: {}, tools: {} });
  const [mcpAuthStatusMsg, setMcpAuthStatusMsg] = useState('');
  const [serversList, setServersList] = useState([]);
  const [listStatus, setListStatus] = useState({ text: '', kind: '' });

  function segMode(mode) { return mode === 'allowlist' ? 'ask' : mode; }

  // One PUT path for every MCP authorization change. The patch body
  // carries { mode?, servers?, tools? } — see setAuthorization.
  async function saveMcpAuthorization(patch) {
    setMcpAuthStatusMsg('saving…');
    const r = await fetchJson('/api/tools/authorization', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, mcp: patch })
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

  async function load(override) {
    const dir = (override && Object.prototype.hasOwnProperty.call(override, 'projectDir'))
      ? override.projectDir
      : projectDir;
    const sc = (override && override.scope) || scope;
    if (sc === 'project' && !dir) {
      setServersList([]);
      setListStatus({ text: 'pick a project directory first', kind: 'error' });
      return;
    }
    if (loadBtn.current) loadBtn.current.disabled = true;
    setListStatus({ text: 'loading…', kind: 'busy' });
    const qs = dir ? '?projectDir=' + encodeURIComponent(dir) : '';
    let r;
    try {
      r = await fetchJson('/api/mcp/servers' + qs);
    } catch (e) {
      setListStatus({ text: 'network error', kind: 'error' });
      if (loadBtn.current) loadBtn.current.disabled = false;
      return;
    }
    if (loadBtn.current) loadBtn.current.disabled = false;
    if (r.status !== 200) {
      setListStatus({ text: 'HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : ''), kind: 'error' });
      return;
    }
    setServersList(r.body.servers || []);
    setListStatus({ text: (r.body.servers || []).length + ' configured', kind: 'success' });
    // Layered MCP authorization (shared fallback + per-server map,
    // lives in .mcp.json) is project-scoped — skip it on the App tab.
    if (sc === 'project' && dir) {
      try {
        const ar = await fetchJson('/api/tools/authorization?projectDir=' + encodeURIComponent(dir));
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
  }

  function pickScope(next) {
    setScope(next);
    if (next === 'app') load({ scope: 'app' });
    else load({ scope: 'project' });
  }

  function applyProjectDirInput(value) {
    const dir = (value || '').trim();
    setProjectDir(dir);
    if (dir) setActiveProject(dir, '');
    if (scope === 'project') load({ scope: 'project', projectDir: dir });
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
    const href = '#/settings/mcp/' + encodeURIComponent(s.id) + projectQS(projectDir)
      + (projectDir ? '&' : '?') + 'scope=' + encodeURIComponent(s.scope || scope);
    return h('li', { key: s.id, class: 'mcp__row' },
      h('a', { class: 'mcp__row-main', href },
        h('div', { class: 'mcp__row-name' }, s.name, ' ', scopeBadge(s)),
        h('div', { class: 'mcp__row-sub' }, status + ' · ' + enabledBit + ' · ' + toolBit),
        (s.status === 'errored' && s.error)
          ? h('div', { class: 'mcp__row-err' }, (s.error.code || 'ERR') + ': ' + (s.error.message || ''))
          : null,
        h('div', { class: 'mcp__row-chev' }, '›')
      ),
      // Quick-action row: Start / Stop / Refresh. Inline so the user
      // does not have to open the editor just to control the lifecycle.
      h('div', { class: 'mcp__row-actions' },
        h('button', {
          class: 'btn btn--small', type: 'button',
          disabled: s.enabled === false,
          onClick: () => callLifecycle('start', s.id)
        }, status === 'ready' ? 'Restart' : 'Start'),
        (status === 'ready' || status === 'errored' || status === 'starting')
          ? h('button', { class: 'btn btn--small', type: 'button', onClick: () => callLifecycle('stop', s.id) }, 'Stop')
          : null,
        status === 'ready'
          ? h('button', { class: 'btn btn--small', type: 'button', onClick: () => refreshTools(s.id) }, 'Refresh tools')
          : null
      )
    );
  }

  async function callLifecycle(action, id) {
    setListStatus({ text: action + '…', kind: 'busy' });
    let r;
    try {
      r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir })
      });
    } catch (e) { setListStatus({ text: 'network error', kind: 'error' }); return; }
    if (r.status !== 200) {
      setListStatus({ text: 'HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : ''), kind: 'error' });
      return;
    }
    setListStatus({ text: action + 'ed', kind: 'success' });
    load();
  }

  async function refreshTools(id) {
    setListStatus({ text: 'refreshing tools…', kind: 'busy' });
    const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
    let r;
    try {
      r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + '/tools' + qs);
    } catch (e) { setListStatus({ text: 'network error', kind: 'error' }); return; }
    if (r.status !== 200) {
      setListStatus({ text: 'HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : ''), kind: 'error' });
      return;
    }
    setListStatus({ text: (r.body.tools || []).length + ' tools', kind: 'success' });
    load();
  }

  useEffect(() => { load(); }, []);

  const newHref = '#/settings/mcp/new' + projectQS(projectDir) + (projectDir ? '&' : '?') + 'scope=' + scope;

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', {
        href: (scope === 'project' && projectDir)
          ? ('#/settings/project?projectDir=' + encodeURIComponent(projectDir))
          : '#/settings',
        class: 'view-back',
        'aria-label': 'Back'
      }, '‹'),
      h('h2', { class: 'view-title' }, 'MCP servers')
    ),
    h('p', { class: 'hint hint--compact' },
      'Connect Model Context Protocol servers. App-wide servers are visible to every project; project servers are committed to that project\'s .mcp.json. The AI client discovers each server\'s tools and advertises them to the model.'),
    // ---- Scope switcher -------------------------------------------------
    h('div', { class: 'seg seg--block', role: 'tablist', 'aria-label': 'Configuration scope' },
      h('button', {
        type: 'button', role: 'tab', 'aria-selected': scope === 'app',
        class: 'seg__item seg__item--btn' + (scope === 'app' ? ' seg__item--on' : ''),
        onClick: () => pickScope('app')
      }, h('span', { class: 'seg__pill' }, 'App')),
      h('button', {
        type: 'button', role: 'tab', 'aria-selected': scope === 'project',
        class: 'seg__item seg__item--btn' + (scope === 'project' ? ' seg__item--on' : ''),
        onClick: () => pickScope('project')
      }, h('span', { class: 'seg__pill' }, 'Project'))
    ),
    scope === 'project'
      ? h('div', { class: 'row' },
          h('label', { class: 'label', for: 'mcp-project-dir' }, 'Project directory'),
          h('div', { class: 'row row--inline' },
            h('input', {
              class: 'input', id: 'mcp-project-dir', type: 'text',
              placeholder: 'C:/path/to/project', value: projectDir,
              onInput: (e) => setProjectDir(e.target.value)
            }),
            h('button', { ref: loadBtn, class: 'btn', type: 'button', onClick: () => applyProjectDirInput(projectDir) }, 'Load')
          )
        )
      : null,
    // ---- Tool permissions (project scope only) --------------------------
    scope === 'project' && projectDir
      ? h('div', { class: 'group' },
          h('div', { class: 'group__title' }, 'Tool permissions', h('span', { class: 'group__title-note' }, 'Per server, with a shared fallback')),
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
                    overridden ? ('Override: ' + effMode + '. ') : ('Inherits the shared fallback (' + mcpAuth.mode + '). '),
                    segMode(effMode) === 'off' ? 'Hidden from the model — costs no tokens. ' : null,
                    h('span', { class: 'settings-project__item-status', 'aria-live': 'polite' }, mcpAuthStatusMsg)
                  )
                ),
                authSegs('mcp-server-' + slug, segMode(effMode), (mode) => pickServerMode(slug, mode)),
                overridden
                  ? h('button', { class: 'btn btn--small', type: 'button', onClick: () => pickServerMode(slug, 'inherit') }, 'Use shared fallback')
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
                h('div', { class: 'settings-project__item-title' }, 'Shared fallback (all MCP servers)'),
                h('div', { class: 'settings-project__item-note' },
                  'Applies to every server without an override. ',
                  segMode(mcpAuth.mode) === 'off' ? 'Hidden from the model — costs no tokens. ' : null
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
    h('ul', { class: 'mcp__list', 'aria-label': 'MCP servers' },
      serversList.length
        ? serversList.map(serverRow)
        : h('li', { class: 'mcp__empty' },
            scope === 'app'
              ? 'No app-wide MCP servers yet. Tap "+" to add one — it will be visible to every project.'
              : 'No MCP servers for this project yet. Tap "+" to add one, or check the App tab for app-wide servers.')
    ),
    h('div', { class: 'page-bar' },
      h('span', {
        class: 'status page-bar__status' + (listStatus.kind ? ' status--' + listStatus.kind : ''),
        'aria-live': 'polite'
      }, listStatus.text),
      h('a', { href: newHref, class: 'page-bar__add', 'aria-label': 'Add MCP server' }, '+')
    )
  );
}

export function SettingsMcpEditView(props) {
  const id = props.id || '';
  const projectDir = props.projectDir || (activeProject.value && activeProject.value.dir) || '';
  // The scope an add creates in; an edit always reflects the server's
  // actual scope (scope is fixed at creation — delete + re-add to move).
  const [addScope, setAddScope] = useState(props.scope === 'app' ? 'app' : (projectDir ? 'project' : 'app'));
  const [currentScope, setCurrentScope] = useState(props.scope === 'app' ? 'app' : 'project');

  const nameEl = useRef(null);
  const commandEl = useRef(null);
  const argsEl = useRef(null);
  const envEl = useRef(null);
  const cwdEl = useRef(null);
  const enabledEl = useRef(null);
  const statusEl = useRef(null);
  const saveBtn = useRef(null);
  const deleteBtn = useRef(null);

  let current = null;
  const [toolAuths, setToolAuths] = useState({});
  const [toolsState, setToolsState] = useState([]);
  const [toolAuthMsg, setToolAuthMsg] = useState('');

  async function load() {
    if (id) {
      // List and find by id; the dedicated /api/mcp/servers/:id route
      // is reserved for a future revision (a `getServer` REST shape).
      // The list is the merged app + project view, so a server of either
      // scope is found; scope on the record tells the editor which file
      // the save lands in.
      const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
      let r;
      try {
        r = await fetchJson('/api/mcp/servers' + qs);
      } catch (e) { setStatus(statusEl, 'network error', 'error'); return; }
      if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); return; }
      current = (r.body.servers || []).find(s => s.id === id) || null;
      if (!current) { setStatus(statusEl, 'Server not found', 'error'); return; }
      setCurrentScope(current.scope === 'app' ? 'app' : 'project');
      if (nameEl.current) nameEl.current.value = current.name || '';
      if (commandEl.current) commandEl.current.value = current.command || '';
      if (argsEl.current) argsEl.current.value = (current.args || []).join(' ');
      // Secret values are write-only. The server only returns key names.
      if (envEl.current) envEl.current.value = '';
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
      return h('li', { class: 'mcp__tools-empty' }, (current && current.status === 'ready') ? 'No tools reported by this server.' : 'Start the server to see its tools.');
    }
    return toolsState.map((t) => {
      const composed = 'mcp__' + (current.slug || '') + '__' + t.name;
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
      name: (nameEl.current.value || '').trim(),
      command: (commandEl.current.value || '').trim(),
      args: parseArgs(argsEl.current.value),
      cwd: (cwdEl.current.value || '').trim(),
      enabled: enabledEl.current.checked !== false
    };
    const envText = envEl.current.value || '';
    if (!id || envText.trim()) body.env = parseEnv(envText);
    if (!body.name) { setStatus(statusEl, 'name is required', 'error'); if (saveBtn.current) saveBtn.current.disabled = false; return; }
    if (!body.command) { setStatus(statusEl, 'command is required', 'error'); if (saveBtn.current) saveBtn.current.disabled = false; return; }
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
  const backQs = projectQS(projectDir);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/mcp' + backQs, class: 'view-back', 'aria-label': 'Back to MCP servers' }, '←'),
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
      h('span', { id: 'mcp-env-hint', class: 'hint hint--compact' }, 'Values are write-only and are never returned by the API. Leave blank to preserve existing values when editing.')
    ),
    h('div', { class: 'row' },
      h('label', { class: 'label', for: 'mcp-cwd' }, 'Working directory (optional, relative to project)'),
      h('input', { ref: cwdEl, class: 'input', id: 'mcp-cwd', type: 'text', placeholder: 'tools/my-mcp' })
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
