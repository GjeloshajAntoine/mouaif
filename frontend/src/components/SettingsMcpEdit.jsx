// mouaif web — SettingsMcpEditView (MCP server editor)
// Extracted from SettingsMcp.jsx for a smaller file size.
import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fetchJson, activeProject } from '../api.js';
import { nav } from '../router.js';
import { navTarget, settingsLink } from './settings/projectNavigation.js';
import { McpArguments } from './settings/McpArguments.jsx';
import { McpOAuth } from './settings/McpOAuth.jsx';
import { McpSecretKeys } from './settings/McpSecretKeys.jsx';

// Saving stops a running server (src/mcp.js updateServer), so the next
// start picks up the new settings.
const SAVED_TEXT = 'Saved. Start the server from the MCP servers list to use these settings.';
// Confirmation carried across the add → new-server-editor navigation, which
// remounts the view. Read once by the next editor mount, then cleared.
let savedFlash = '';

export function SettingsMcpEditView(props) {
const id = props.id || '';
const routeProjectDir = props.projectDir || '';
const from = typeof props.from === 'string' ? props.from : '';
const chatId = typeof props.chatId === 'string' ? props.chatId : '';
  const activeDir = (activeProject.value && activeProject.value.dir) || '';
  const projectDir = id ? routeProjectDir : (routeProjectDir || activeDir);
  const [addScope, setAddScope] = useState(
    props.scope === 'app' ? 'app' : (props.scope === 'project' ? 'project' : (routeProjectDir ? 'project' : 'app'))
  );
  const [currentScope, setCurrentScope] = useState(props.scope === 'app' ? 'app' : 'project');

  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [args, setArgs] = useState([]);
  const [env, setEnv] = useState('');
  const [headers, setHeaders] = useState('');
  const [cwd, setCwd] = useState('');
  const [envPlaceholder, setEnvPlaceholder] = useState('API_TOKEN=...\nLOG_LEVEL=info');
  const [headersPlaceholder, setHeadersPlaceholder] = useState('Authorization: Bearer ...');
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [statusMsg, setStatusMsg] = useState({text: '', kind: ''});
  const [transport, setTransport] = useState('stdio');
  const [oauth, setOauth] = useState({ enabled: false, clientId: '', scope: '', grant: 'authorization_code', clientSecret: '', clearClientSecret: false });

  const [currentServer, setCurrentServer] = useState(null);
  const [toolAuths, setToolAuths] = useState({});
  const [toolsState, setToolsState] = useState([]);
  const [toolAuthMsg, setToolAuthMsg] = useState('');
  const [configuredEnvKeys, setConfiguredEnvKeys] = useState([]);
  const [configuredHeaderKeys, setConfiguredHeaderKeys] = useState([]);
  const [clearEnv, setClearEnv] = useState(false);
  const [clearHeaders, setClearHeaders] = useState(false);
  // Taken once per mount so a stale flash never leaks into a later editor.
  const flashRef = useRef(null);
  if (flashRef.current === null) { flashRef.current = savedFlash; savedFlash = ''; }

  async function load() {
    if (id) {
      const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
      let r;
      try { r = await fetchJson('/api/mcp/servers' + qs); }
      catch (e) { setStatusMsg({text: 'network error', kind: 'error'}); return false; }
      if (r.status !== 200) { setStatusMsg({text: 'HTTP ' + r.status, kind: 'error'}); return false; }
      const current = (r.body.servers || []).find(s => s.id === id) || null;
      if (!current) { setStatusMsg({text: 'Server not found', kind: 'error'}); return false; }
      setCurrentServer(current);
      setCurrentScope(current.scope === 'app' ? 'app' : 'project');
      setName(current.name || '');
      setTransport(current.transport === 'http' || current.transport === 'sse' ? current.transport : 'stdio');
      setCommand(current.command || '');
      setUrl(current.url || '');
      setOauth({ enabled: !!current.oauth?.enabled, clientId: current.oauth?.clientId || '', scope: current.oauth?.scope || '', grant: current.oauth?.grant || 'authorization_code', clientSecret: '', clearClientSecret: false });
      setArgs(current.args || []);
      setEnv('');
      setClearEnv(false);
      const envKeys = Object.keys(current.env || {}).filter(k => current.env[k] && current.env[k].configured);
      setConfiguredEnvKeys(envKeys);
      setEnvPlaceholder(envKeys.length
        ? 'Already configured: ' + envKeys.join(', ') + '. Enter new values or leave blank to keep.'
        : 'API_TOKEN=...\nLOG_LEVEL=info');
      setHeaders('');
      setClearHeaders(false);
      const headerKeys = Object.keys(current.headers || {}).filter(k => current.headers[k] && current.headers[k].configured);
      setConfiguredHeaderKeys(headerKeys);
      setHeadersPlaceholder(headerKeys.length
        ? 'Already configured: ' + headerKeys.join(', ') + '. Enter new values or leave blank to keep.'
        : 'Authorization: Bearer ...');
      setCwd(current.cwd || '');
      setToolsState(current.tools || []);
      if (current.scope !== 'app' && projectDir) {
        try {
          const ar = await fetchJson('/api/tools/authorization?projectDir=' + encodeURIComponent(projectDir));
          const mcp = ar.status === 200 && ar.body.mcp;
          const map = (mcp && mcp.tools && typeof mcp.tools === 'object') ? mcp.tools : {};
          setToolAuths(map);
        } catch { /* keep empty map */ }
      }
    }
    const flash = flashRef.current;
    flashRef.current = '';
    setStatusMsg(flash ? { text: flash, kind: 'success' } : { text: '', kind: '' });
    return true;
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
      // The server returns the provider-safe name the model sees; it can
      // differ from mcp__<slug>__<name> when the raw name has characters
      // or a length providers reject. Fall back for older API responses.
      const composed = t.composedName || ('mcp__' + (currentServer && currentServer.slug || '') + '__' + t.name);
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
    setIsSaving(true);
    setStatusMsg({text: 'saving…', kind: 'busy'});
    const scope = id ? currentScope : addScope;
    if (!id && scope === 'project' && !projectDir) {
      setStatusMsg({text: 'a project-scoped server needs an active project — switch to App or open a project first', kind: 'error'});
      setIsSaving(false);
      return;
    }
    const body = {
      projectDir, scope, transport,
      name: (name || '').trim(),
      command: transport === 'stdio' ? (command || '').trim() : '',
      url: transport !== 'stdio' ? (url || '').trim() : '',
      // clientSecret is write-only: sent only when typed, never read back.
      oauth: transport !== 'stdio' && oauth.enabled ? Object.assign(
        { enabled: true, clientId: oauth.clientId.trim(), scope: oauth.scope.trim() },
        oauth.grant === 'client_credentials' ? { grant: 'client_credentials' } : {},
        oauth.clientSecret.trim() ? { clientSecret: oauth.clientSecret.trim() } : {},
        oauth.clearClientSecret ? { clearClientSecret: true } : {}
      ) : null,
      args: transport === 'stdio' ? args : [],
      cwd: transport === 'stdio' ? (cwd || '').trim() : ''
    };
    const envText = env || '';
    const headersText = headers || '';
    // Typed values replace the whole map (the server does not merge), so
    // they win over a pending Clear all. Text with no valid line would parse
    // to {} and silently wipe every stored key, so it is rejected instead.
    if (envText.trim()) {
      body.env = parseEnv(envText);
      if (!Object.keys(body.env).length) { setStatusMsg({text: 'Environment: use one KEY=value per line', kind: 'error'}); setIsSaving(false); return; }
    } else if (clearEnv) body.env = {};
    if (headersText.trim()) {
      body.headers = parseHeaders(headersText);
      if (!Object.keys(body.headers).length) { setStatusMsg({text: 'HTTP headers: use one Name: value per line', kind: 'error'}); setIsSaving(false); return; }
    } else if (clearHeaders) body.headers = {};
    if (!body.name) { setStatusMsg({text: 'name is required', kind: 'error'}); setIsSaving(false); return; }
    if (transport === 'stdio' && !body.command) { setStatusMsg({text: 'command is required', kind: 'error'}); setIsSaving(false); return; }
    if (transport !== 'stdio' && !body.url) { setStatusMsg({text: 'URL is required', kind: 'error'}); setIsSaving(false); return; }
    let r;
    try {
      r = await fetchJson(id ? ('/api/mcp/servers/' + encodeURIComponent(id)) : '/api/mcp/servers', {
        method: id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) { setStatusMsg({text: 'network error', kind: 'error'}); setIsSaving(false); return; }
    if (r.status !== 200 && r.status !== 201) { setIsSaving(false); setStatusMsg({text: 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''), kind: 'error'}); return; }
    // Save keeps the user on the editor with visible confirmation, so a
    // follow-up step (OAuth sign-in, checking the configured keys) is right
    // there. An edit reloads in place; an add opens the new server's editor
    // (a different route, so the view remounts and reads the flash).
    const saved = r.body && r.body.server;
    if (!id && saved && saved.id) {
    savedFlash = SAVED_TEXT;
    nav(navTarget('settings/mcp/' + encodeURIComponent(saved.id), listContext, { scope: listScope }));
    return;
    }
    if (!id) { setIsSaving(false); nav(listTarget); return; }
    const reloaded = await load();
    setIsSaving(false);
    // A failed reload keeps its own error visible; the save itself worked.
    if (reloaded) setStatusMsg({ text: SAVED_TEXT, kind: 'success' });
  }

  async function deleteServer() {
    if (!id) return;
    if (!confirm('Delete this MCP server?')) return;
    setIsDeleting(true);
    setStatusMsg({text: 'deleting…', kind: 'busy'});
    const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
    let r;
    try { r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + qs, { method: 'DELETE' }); }
    catch (e) { setStatusMsg({text: 'network error', kind: 'error'}); setIsDeleting(false); return; }
    if (r.status !== 200) { setStatusMsg({text: 'HTTP ' + r.status, kind: 'error'}); setIsDeleting(false); return; }
nav(listTarget);
}

  useEffect(() => { load(); }, [id]);

  const title = id ? 'Edit MCP server' : 'Add MCP server';
// The list this editor was opened from, rebuilt the same way the list's
// own rows build their links: an edit keeps the list's projectDir, an add
// follows the scope being created (so an app-wide add returns to the
// app-wide list instead of the active project's). `listScope` is sent back
// explicitly, so a project add that saw no projectDir does not come back as
// an app list.
const listScope = id ? currentScope : addScope;
const backQSPath = id ? routeProjectDir : (listScope === 'app' ? '' : projectDir);
const listContext = { projectDir: backQSPath, chatId, from };
const listTarget = navTarget('settings/mcp', listContext, { scope: listScope });
const backHref = settingsLink('settings/mcp', listContext, { scope: listScope });

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: backHref, class: 'view-back', 'aria-label': 'Back to MCP servers' }, '←'),
      h('h2', { class: 'view-title' }, title)
    ),
    h('section', null,
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
      h('input', { class: 'input', id: 'mcp-name', type: 'text', placeholder: 'e.g. filesystem', value: name, onInput: (e) => setName(e.target.value) })
    ),
    h('div', { class: 'row' },
      h('label', { class: 'label' }, 'Transport'),
      h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'MCP transport' },
        [{ value: 'stdio', label: 'Stdio' }, { value: 'http', label: 'HTTP' }, { value: 'sse', label: 'SSE (legacy)' }].map((m) =>
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
        h('input', { class: 'input', id: 'mcp-command', type: 'text', placeholder: 'node', value: command, onInput: (e) => setCommand(e.target.value) })
      ),
      h(McpArguments, { value: args, onChange: setArgs }),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'mcp-env' }, 'Environment (one KEY=value per line)'),
        h('textarea', { class: 'input', id: 'mcp-env', rows: 4, spellcheck: false, placeholder: clearEnv ? 'KEY=value (optional)' : envPlaceholder, 'aria-describedby': 'mcp-env-hint', value: env, onInput: (e) => setEnv(e.target.value) }),
        h('span', { id: 'mcp-env-hint', class: 'hint hint--compact' }, 'Values are write-only and are never returned by the API. Leave blank to preserve existing values.'),
        id ? h(McpSecretKeys, {
          keys: configuredEnvKeys, noun: 'keys', typed: !!env.trim(), cleared: clearEnv,
          onClear: () => setClearEnv(true), onUndo: () => setClearEnv(false)
        }) : null
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'mcp-cwd' }, 'Working directory (optional, relative to project)'),
        h('input', { class: 'input', id: 'mcp-cwd', type: 'text', placeholder: 'tools/my-mcp', value: cwd, onInput: (e) => setCwd(e.target.value) })
      )
    ) : h(Fragment, null,
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'mcp-url' }, transport === 'sse' ? 'SSE URL' : 'HTTP URL'),
        h('input', { class: 'input', id: 'mcp-url', type: 'url', placeholder: transport === 'sse' ? 'https://example.com/sse' : 'https://example.com/mcp', value: url, onInput: (e) => setUrl(e.target.value) }),
        transport === 'sse' ? h('span', { class: 'hint hint--compact' }, 'For servers that only speak the older HTTP+SSE transport (MCP 2024-11-05). Prefer HTTP when the server offers it.') : null
      ),
      h(McpOAuth, { id, projectDir, saved: currentServer, value: { ...oauth, url }, onChange: setOauth }),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'mcp-headers' }, 'HTTP headers (one Name: value per line)'),
        h('textarea', { class: 'input', id: 'mcp-headers', rows: 4, spellcheck: false, placeholder: clearHeaders ? 'Name: value (optional)' : headersPlaceholder, 'aria-describedby': 'mcp-headers-hint', value: headers, onInput: (e) => setHeaders(e.target.value) }),
        h('span', { id: 'mcp-headers-hint', class: 'hint hint--compact' }, 'Header values are write-only and are never returned by the API. Leave blank to preserve existing values.'),
        id ? h(McpSecretKeys, {
          keys: configuredHeaderKeys, noun: 'headers', typed: !!headers.trim(), cleared: clearHeaders,
          onClear: () => setClearHeaders(true), onUndo: () => setClearHeaders(false)
        }) : null
      )
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
      h('button', { class: 'btn btn--primary', type: 'button', onClick: save, disabled: isSaving }, 'Save'),
      id ? h('button', { class: 'btn btn--danger', type: 'button', onClick: deleteServer, disabled: isDeleting }, 'Delete') : null
    ),
    h('div', { class: 'row' },
      h('span', { class: 'status', 'data-state': statusMsg.kind || undefined, 'aria-live': 'polite' }, statusMsg.text)
    )
    )
  );
}