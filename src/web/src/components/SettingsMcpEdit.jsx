// mouaif web — SettingsMcpEditView (MCP server editor)
// Extracted from SettingsMcp.jsx for a smaller file size.
import { h, Fragment } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';
import { fetchJson, setStatus, activeProject } from '../api.js';
import { nav } from '../router.js';

function projectQS(projectDir) {
  return projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
}

export function SettingsMcpEditView(props) {
  const id = props.id || '';
  const routeProjectDir = props.projectDir || '';
  const activeDir = (activeProject.value && activeProject.value.dir) || '';
  const projectDir = id ? routeProjectDir : (routeProjectDir || activeDir);
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
  const [configuredEnvKeys, setConfiguredEnvKeys] = useState([]);
  const [configuredHeaderKeys, setConfiguredHeaderKeys] = useState([]);
  const [clearEnv, setClearEnv] = useState(false);
  const [clearHeaders, setClearHeaders] = useState(false);

  async function load() {
    if (id) {
      const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
      let r;
      try { r = await fetchJson('/api/mcp/servers' + qs); }
      catch (e) { setStatus(statusEl, 'network error', 'error'); return; }
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
    } else { setToolAuthMsg('HTTP ' + r.status); }
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
          h('select', { class: 'input', value, onChange: (e) => saveToolAuth(composed, e.target.value) },
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
      projectDir, scope, transport,
      name: (nameEl.current.value || '').trim(),
      command: transport === 'stdio' ? (commandEl.current.value || '').trim() : '',
      url: transport === 'http' ? (urlEl.current.value || '').trim() : '',
      args: transport === 'stdio' ? parseArgs(argsEl.current.value) : [],
      cwd: transport === 'stdio' ? (cwdEl.current.value || '').trim() : '',
      enabled: enabledEl.current.checked !== false
    };
    const envText = envEl.current.value || '';
    const headersText = headersEl.current.value || '';
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
    try { r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + qs, { method: 'DELETE' }); }
    catch (e) { setStatus(statusEl, 'network error', 'error'); if (deleteBtn.current) deleteBtn.current.disabled = false; return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); if (deleteBtn.current) deleteBtn.current.disabled = false; return; }
    nav('settings/mcp' + projectQS(projectDir));
  }

  useEffect(() => { load(); }, [id]);

  const title = id ? 'Edit MCP server' : 'Add MCP server';
  const backQSPath = id ? routeProjectDir : projectDir;
  const backHref = '#/settings/mcp' + projectQS(backQSPath);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: backHref, class: 'view-back', 'aria-label': 'Back to MCP servers' }, '←'),
      h('h2', { class: 'view-title' }, title)
    ),
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
                h('input', { type: 'radio', name: 'mcp-add-scope', value: m.value, checked: addScope === m.value, onChange: () => setAddScope(m.value) }),
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
            h('input', { type: 'radio', name: 'mcp-transport', value: m.value, checked: transport === m.value, onChange: () => setTransport(m.value) }),
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
              h('button', { class: 'btn btn--small', type: 'button', style: 'color:var(--danger);border-color:var(--danger)', onClick: () => { setClearEnv(true); if (envEl.current) { envEl.current.value = ''; envEl.current.placeholder = ''; } } }, 'Clear all')
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
              h('button', { class: 'btn btn--small', type: 'button', style: 'color:var(--danger);border-color:var(--danger)', onClick: () => { setClearHeaders(true); if (headersEl.current) { headersEl.current.value = ''; headersEl.current.placeholder = ''; } } }, 'Clear all')
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
      h('ul', { class: 'mcp__tools-list' }, renderToolsList())
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