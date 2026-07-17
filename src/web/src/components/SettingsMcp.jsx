// mouaif web — SettingsMcpView (MCP server list) + SettingsMcpEditView
// MCP = Model Context Protocol. The user configures per-project MCP
// servers here: each server is a stdio child process the AI client
// connects to and discovers tools from. See docs/features/mcp.md.
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { fetchJson, setStatus, setActiveProject, activeProject } from '../api.js';
import { nav } from '../router.js';

function projectDirFromProps(props = {}) {
  // The route can override the active project (testing + deep links).
  return props.projectDir || (activeProject.value && activeProject.value.dir) || '';
}

export function SettingsMcpView(props = {}) {
  const listEl = useRef(null);
  const statusEl = useRef(null);
  const projectDirEl = useRef(null);
  const loadBtn = useRef(null);

  let projectDir = projectDirFromProps(props);

  async function load() {
    const dir = (projectDirEl.current && projectDirEl.current.value || '').trim() || projectDir;
    if (!dir) { setStatus(statusEl, 'pick a project directory first', 'error'); return; }
    projectDir = dir;
    setActiveProject(dir, '');
    if (loadBtn.current) loadBtn.current.disabled = true;
    setStatus(statusEl, 'loading…', 'busy');
    let r;
    try {
      r = await fetchJson('/api/mcp/servers?projectDir=' + encodeURIComponent(dir));
    } catch (e) { setStatus(statusEl, 'network error', 'error'); if (loadBtn.current) loadBtn.current.disabled = false; return; }
    if (loadBtn.current) loadBtn.current.disabled = false;
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : ''), 'error'); return; }
    render(r.body.servers || []);
    setStatus(statusEl, (r.body.servers || []).length + ' configured', 'success');
  }

  function render(servers) {
    if (!listEl.current) return;
    listEl.current.innerHTML = '';
    if (!servers.length) {
      const li = document.createElement('li');
      li.className = 'mcp__empty';
      li.textContent = 'No MCP servers yet. Tap "+" to add one.';
      listEl.current.appendChild(li);
      return;
    }
    for (const s of servers) listEl.current.appendChild(renderRow(s));
  }

  function renderRow(s) {
    const li = document.createElement('li');
    li.className = 'mcp__row';

    const main = document.createElement('a');
    main.className = 'mcp__row-main';
    main.href = '#/settings/mcp/' + encodeURIComponent(s.id) + '?projectDir=' + encodeURIComponent(projectDir);
    const name = document.createElement('div');
    name.className = 'mcp__row-name';
    name.textContent = s.name;
    const sub = document.createElement('div');
    sub.className = 'mcp__row-sub';
    const status = s.status || 'stopped';
    const enabledBit = s.enabled === false ? 'disabled' : 'enabled';
    const toolBit = (s.tools && s.tools.length) ? s.tools.length + ' tool' + (s.tools.length === 1 ? '' : 's') : 'no tools';
    sub.textContent = status + ' · ' + enabledBit + ' · ' + toolBit;
    main.appendChild(name); main.appendChild(sub);
    if (s.status === 'errored' && s.error) {
      const err = document.createElement('div');
      err.className = 'mcp__row-err';
      err.textContent = (s.error.code || 'ERR') + ': ' + (s.error.message || '');
      main.appendChild(err);
    }
    const chev = document.createElement('div');
    chev.className = 'mcp__row-chev';
    chev.textContent = '›';
    main.appendChild(chev);
    li.appendChild(main);

    // Quick-action row: Start / Stop / Refresh. Inline so the user
    // does not have to open the editor just to control the lifecycle.
    const actions = document.createElement('div');
    actions.className = 'mcp__row-actions';
    const startBtn = document.createElement('button');
    startBtn.className = 'btn btn--small';
    startBtn.type = 'button';
    startBtn.textContent = status === 'ready' ? 'Restart' : 'Start';
    startBtn.disabled = s.enabled === false;
    startBtn.addEventListener('click', () => callLifecycle('start', s.id));
    actions.appendChild(startBtn);
    if (status === 'ready' || status === 'errored' || status === 'starting') {
      const stopBtn = document.createElement('button');
      stopBtn.className = 'btn btn--small';
      stopBtn.type = 'button';
      stopBtn.textContent = 'Stop';
      stopBtn.addEventListener('click', () => callLifecycle('stop', s.id));
      actions.appendChild(stopBtn);
    }
    if (status === 'ready') {
      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'btn btn--small';
      refreshBtn.type = 'button';
      refreshBtn.textContent = 'Refresh tools';
      refreshBtn.addEventListener('click', () => refreshTools(s.id));
      actions.appendChild(refreshBtn);
    }
    li.appendChild(actions);
    return li;
  }

  async function callLifecycle(action, id) {
    setStatus(statusEl, action + '…', 'busy');
    let r;
    try {
      r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir })
      });
    } catch (e) { setStatus(statusEl, 'network error', 'error'); return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : ''), 'error'); return; }
    setStatus(statusEl, action + 'ed', 'success');
    load();
  }

  async function refreshTools(id) {
    setStatus(statusEl, 'refreshing tools…', 'busy');
    let r;
    try {
      r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + '/tools?projectDir=' + encodeURIComponent(projectDir));
    } catch (e) { setStatus(statusEl, 'network error', 'error'); return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : ''), 'error'); return; }
    setStatus(statusEl, (r.body.tools || []).length + ' tools', 'success');
    load();
  }

  useEffect(() => { load(); }, []);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', {
        href: projectDir ? ('#/settings/project?projectDir=' + encodeURIComponent(projectDir)) : '#/settings',
        class: 'view-back',
        'aria-label': projectDir ? 'Back to project settings' : 'Back to settings'
      }, '‹'),
      h('h2', { class: 'view-title' }, 'MCP servers')
    ),
    h('p', { class: 'hint hint--compact' }, 'Connect per-project Model Context Protocol servers. The AI client discovers each server\'s tools and advertises them to the model.'),
    h('div', { class: 'row' },
      h('label', { class: 'label', for: 'mcp-project-dir' }, 'Project directory'),
      h('div', { class: 'row row--inline' },
        h('input', { ref: projectDirEl, class: 'input', id: 'mcp-project-dir', type: 'text', placeholder: 'C:/path/to/project', value: projectDir }),
        h('button', { ref: loadBtn, class: 'btn', type: 'button', onClick: load }, 'Load')
      )
    ),
    h('ul', { ref: listEl, class: 'mcp__list', 'aria-label': 'MCP servers' }),
    h('div', { class: 'page-bar' },
      h('span', { ref: statusEl, class: 'status page-bar__status', 'aria-live': 'polite' }),
      h('a', {
        href: '#/settings/mcp/new?projectDir=' + encodeURIComponent((projectDirEl.current && projectDirEl.current.value || '').trim() || projectDir),
        class: 'page-bar__add',
        'aria-label': 'Add MCP server'
      }, '+')
    )
  );
}

export function SettingsMcpEditView(props) {
  const id = props.id || '';
  const projectDir = props.projectDir || (activeProject.value && activeProject.value.dir) || '';

  const nameEl = useRef(null);
  const commandEl = useRef(null);
  const argsEl = useRef(null);
  const envEl = useRef(null);
  const cwdEl = useRef(null);
  const enabledEl = useRef(null);
  const statusEl = useRef(null);
  const saveBtn = useRef(null);
  const deleteBtn = useRef(null);
  const toolsListEl = useRef(null);

  let current = null;

  async function load() {
    if (!projectDir) { setStatus(statusEl, 'project directory is required', 'error'); return; }
    if (id) {
      // List and find by id; the dedicated /api/mcp/servers/:id route
      // is reserved for a future revision (a `getServer` REST shape).
      let r;
      try {
        r = await fetchJson('/api/mcp/servers?projectDir=' + encodeURIComponent(projectDir));
      } catch (e) { setStatus(statusEl, 'network error', 'error'); return; }
      if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); return; }
      current = (r.body.servers || []).find(s => s.id === id) || null;
      if (!current) { setStatus(statusEl, 'Server not found', 'error'); return; }
      if (nameEl.current) nameEl.current.value = current.name || '';
      if (commandEl.current) commandEl.current.value = current.command || '';
      if (argsEl.current) argsEl.current.value = (current.args || []).join(' ');
      // Secret values are write-only. The server only returns key names.
      if (envEl.current) envEl.current.value = '';
      if (cwdEl.current) cwdEl.current.value = current.cwd || '';
      if (enabledEl.current) enabledEl.current.checked = current.enabled === true;
      if (deleteBtn.current) deleteBtn.current.hidden = false;
      renderTools(current);
    } else {
      if (deleteBtn.current) deleteBtn.current.hidden = true;
    }
    setStatus(statusEl, '');
  }

  function renderTools(s) {
    if (!toolsListEl.current) return;
    toolsListEl.current.innerHTML = '';
    if (!s || !s.tools || !s.tools.length) {
      const li = document.createElement('li');
      li.className = 'mcp__tools-empty';
      li.textContent = s && s.status === 'ready' ? 'No tools reported by this server.' : 'Start the server to see its tools.';
      toolsListEl.current.appendChild(li);
      return;
    }
    for (const t of s.tools) {
      const li = document.createElement('li');
      li.className = 'mcp__tools-row';
      const name = document.createElement('div');
      name.className = 'mcp__tools-name';
      name.textContent = 'mcp__' + s.slug + '__' + t.name;
      const desc = document.createElement('div');
      desc.className = 'mcp__tools-desc';
      desc.textContent = t.description || '';
      li.appendChild(name); li.appendChild(desc);
      toolsListEl.current.appendChild(li);
    }
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
    const body = {
      projectDir,
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
    nav('settings/mcp?projectDir=' + encodeURIComponent(projectDir));
  }

  async function deleteServer() {
    if (!id) return;
    if (!confirm('Delete this MCP server?')) return;
    if (deleteBtn.current) deleteBtn.current.disabled = true;
    setStatus(statusEl, 'deleting…', 'busy');
    let r;
    try {
      r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + '?projectDir=' + encodeURIComponent(projectDir), { method: 'DELETE' });
    } catch (e) { setStatus(statusEl, 'network error', 'error'); if (deleteBtn.current) deleteBtn.current.disabled = false; return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); if (deleteBtn.current) deleteBtn.current.disabled = false; return; }
    nav('settings/mcp?projectDir=' + encodeURIComponent(projectDir));
  }

  useEffect(() => { load(); }, [id]);

  const title = id ? 'Edit MCP server' : 'Add MCP server';

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/mcp?projectDir=' + encodeURIComponent(projectDir), class: 'view-back', 'aria-label': 'Back to MCP servers' }, '←'),
      h('h2', { class: 'view-title' }, title)
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
    id ? h('div', { class: 'row' },
      h('h3', { class: 'mcp__tools-h' }, 'Discovered tools'),
      h('ul', { ref: toolsListEl, class: 'mcp__tools-list' })
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
