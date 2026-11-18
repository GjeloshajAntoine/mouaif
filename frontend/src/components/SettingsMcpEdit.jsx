// mouaif web — SettingsMcpEditView (MCP server editor + live status/tools/logs)
import { h, Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fetchJson } from '../api.js';
import { back, replace } from '../router.js';
import { navTarget, settingsLink } from './settings/projectNavigation.js';
import { McpArguments } from './settings/McpArguments.jsx';
import { McpOAuth } from './settings/McpOAuth.jsx';
import { McpSecretKeys } from './settings/McpSecretKeys.jsx';
import { McpAuthSeg, mcpEffective, segMode } from './settings/toolAuth.js';
import { parseMcpJson, serializeMcpServersJson } from './settings/mcpJsonImport.js';

// Saving stops a running server (src/mcp.js updateServer), so the next
// start picks up the new settings.
const SAVED_TEXT = 'Saved. Tap Start / Test above (or start from the MCP list) to connect with these settings.';
// Confirmation carried across the add → new-server-editor navigation, which
// remounts the view. Read once by the next editor mount, then cleared.
let savedFlash = '';

export function SettingsMcpEditView(props) {
  const id = props.id || '';
  const projectDir = props.projectDir || '';
  const from = typeof props.from === 'string' ? props.from : '';
  const chatId = typeof props.chatId === 'string' ? props.chatId : '';
  const addScope = projectDir ? 'project' : 'app';
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
  const [lifecycleBusy, setLifecycleBusy] = useState(''); // 'start' | 'stop' | 'refresh' | ''
  const [runtimeErr, setRuntimeErr] = useState(null);
  const [statusMsg, setStatusMsg] = useState({ text: '', kind: '' });
  const [transport, setTransport] = useState('stdio');
  const [oauth, setOauth] = useState({ enabled: false, clientId: '', scope: '', grant: 'authorization_code', clientSecret: '', clearClientSecret: false });

  const [currentServer, setCurrentServer] = useState(null);
  const [mcpAuth, setMcpAuth] = useState({ mode: 'ask', allowlist: [], servers: {}, tools: {} });
  const [toolsState, setToolsState] = useState([]);
  const [toolFilter, setToolFilter] = useState('');
  const [toolAuthMsg, setToolAuthMsg] = useState('');
  const [configuredEnvKeys, setConfiguredEnvKeys] = useState([]);
  const [configuredHeaderKeys, setConfiguredHeaderKeys] = useState([]);
  const [clearEnv, setClearEnv] = useState(false);
  const [clearHeaders, setClearHeaders] = useState(false);
  const [pasteJsonOpen, setPasteJsonOpen] = useState(false);
  const [pasteJsonText, setPasteJsonText] = useState('');
  const [pasteJsonErr, setPasteJsonErr] = useState('');
  const [copyNote, setCopyNote] = useState('');
  // Taken once per mount so a stale flash never leaks into a later editor.
  const flashRef = useRef(null);
  if (flashRef.current === null) { flashRef.current = savedFlash; savedFlash = ''; }

  async function load() {
    if (id) {
      const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
      let r;
      try { r = await fetchJson('/api/mcp/servers' + qs); }
      catch { setStatusMsg({ text: 'network error', kind: 'error' }); return false; }
      if (r.status !== 200) { setStatusMsg({ text: 'HTTP ' + r.status, kind: 'error' }); return false; }
      const current = ((r.body && r.body.servers) || []).find((s) => s.id === id) || null;
      if (!current) { setStatusMsg({ text: 'Server not found', kind: 'error' }); return false; }
      setCurrentServer(current);
      setCurrentScope(current.scope === 'app' ? 'app' : 'project');
      setName(current.name || '');
      setTransport(current.transport === 'http' || current.transport === 'sse' ? current.transport : 'stdio');
      setCommand(current.command || '');
      setUrl(current.url || '');
      setOauth({
        enabled: !!current.oauth?.enabled,
        clientId: current.oauth?.clientId || '',
        scope: current.oauth?.scope || '',
        grant: current.oauth?.grant || 'authorization_code',
        clientSecret: '',
        clearClientSecret: false
      });
      setArgs(current.args || []);
      setEnv('');
      setClearEnv(false);
      const envKeys = Object.keys(current.env || {}).filter((k) => current.env[k] && current.env[k].configured);
      setConfiguredEnvKeys(envKeys);
      setEnvPlaceholder(envKeys.length
        ? 'Already configured: ' + envKeys.join(', ') + '. Enter new values or leave blank to keep.'
        : 'API_TOKEN=...\nLOG_LEVEL=info');
      setHeaders('');
      setClearHeaders(false);
      const headerKeys = Object.keys(current.headers || {}).filter((k) => current.headers[k] && current.headers[k].configured);
      setConfiguredHeaderKeys(headerKeys);
      setHeadersPlaceholder(headerKeys.length
        ? 'Already configured: ' + headerKeys.join(', ') + '. Enter new values or leave blank to keep.'
        : 'Authorization: Bearer ...');
      setCwd(current.cwd || '');
      setToolsState(current.tools || []);
      if (projectDir) {
        try {
          const ar = await fetchJson('/api/tools/authorization?projectDir=' + encodeURIComponent(projectDir));
          const mcp = ar.status === 200 && ar.body && ar.body.mcp;
          if (mcp) {
            setMcpAuth({
              mode: mcp.mode || 'ask',
              allowlist: Array.isArray(mcp.allowlist) ? mcp.allowlist : [],
              servers: (mcp.servers && typeof mcp.servers === 'object') ? mcp.servers : {},
              tools: (mcp.tools && typeof mcp.tools === 'object') ? mcp.tools : {}
            });
          }
        } catch { /* keep empty map */ }
      }
    }
    const flash = flashRef.current;
    flashRef.current = '';
    setStatusMsg(flash ? { text: flash, kind: 'success' } : { text: '', kind: '' });
    return true;
  }

  async function saveServerAuth(patch) {
    if (!projectDir) return;
    setToolAuthMsg('saving…');
    try {
      const r = await fetchJson('/api/tools/authorization', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, mcp: patch })
      });
      if (r.status === 200 && r.body && r.body.mcp) {
        const m = r.body.mcp;
        setMcpAuth({
          mode: m.mode || 'ask',
          allowlist: Array.isArray(m.allowlist) ? m.allowlist : [],
          servers: (m.servers && typeof m.servers === 'object') ? m.servers : {},
          tools: (m.tools && typeof m.tools === 'object') ? m.tools : {}
        });
        setToolAuthMsg('saved');
      } else {
        setToolAuthMsg('HTTP ' + r.status);
      }
    } catch {
      setToolAuthMsg('network error');
    }
  }

  async function saveToolAuth(composedName, value) {
    if (!projectDir) return;
    setToolAuthMsg('saving…');
    const patch = { [composedName]: value === 'inherit' ? null : { mode: value } };
    try {
      const r = await fetchJson('/api/tools/authorization', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, mcp: { tools: patch } })
      });
      if (r.status === 200) {
        setToolAuthMsg('saved');
        setMcpAuth((prev) => {
          const tools = Object.assign({}, prev.tools);
          if (value === 'inherit') delete tools[composedName];
          else tools[composedName] = { mode: value };
          return Object.assign({}, prev, { tools });
        });
      } else {
        setToolAuthMsg('HTTP ' + r.status);
      }
    } catch {
      setToolAuthMsg('network error');
    }
  }

  async function callLifecycle(action) {
    if (!id || lifecycleBusy) return;
    setLifecycleBusy(action);
    setRuntimeErr(null);
    setStatusMsg({ text: action === 'start' ? 'Starting server…' : 'Stopping server…', kind: 'busy' });
    let r;
    try {
      r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir })
      });
    } catch {
      setLifecycleBusy('');
      setStatusMsg({ text: 'Could not reach mouaif.', kind: 'error' });
      return;
    }
    setLifecycleBusy('');
    if (r.status !== 200) {
      const msg = (r.body && r.body.error) ? String(r.body.error) : ('HTTP ' + r.status);
      setRuntimeErr({
        code: (r.body && r.body.code) || 'EMCP_START',
        message: msg,
        stderr: (r.body && r.body.stderr) || null
      });
      await load();
      setStatusMsg({ text: msg, kind: 'error' });
      return;
    }
    await load();
    setStatusMsg({
      text: action === 'stop'
        ? 'Stopped.'
        : ('Connected · ' + (((r.body && r.body.server && r.body.server.tools) || []).length) + ' tools discovered.'),
      kind: 'success'
    });
  }

  async function refreshDiscoveredTools() {
    if (!id || lifecycleBusy) return;
    setLifecycleBusy('refresh');
    const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
    try {
      const r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + '/tools' + qs);
      setLifecycleBusy('');
      if (r.status === 200) {
        await load();
        setStatusMsg({ text: ((r.body && r.body.tools) || []).length + ' tools refreshed.', kind: 'success' });
      } else {
        setStatusMsg({ text: (r.body && r.body.error) || ('HTTP ' + r.status), kind: 'error' });
      }
    } catch {
      setLifecycleBusy('');
      setStatusMsg({ text: 'Could not reach mouaif.', kind: 'error' });
    }
  }

  function applyJsonToForm() {
    const parsed = parseMcpJson(pasteJsonText);
    if (!parsed.servers.length) {
      setPasteJsonErr(parsed.errors[0] || 'Could not parse server JSON.');
      return;
    }
    const first = parsed.servers[0];
    setName(first.name || '');
    setTransport(first.transport || 'stdio');
    if ((first.transport || 'stdio') === 'stdio') {
      setCommand(first.command || '');
      setArgs(Array.isArray(first.args) ? first.args : []);
      setCwd(first.cwd || '');
      const envLines = Object.entries(first.env || {}).map(([k, v]) => k + '=' + v).join('\n');
      setEnv(envLines);
    } else {
      setUrl(first.url || '');
      const hdrLines = Object.entries(first.headers || {}).map(([k, v]) => k + ': ' + v).join('\n');
      setHeaders(hdrLines);
      if (first.oauth && first.oauth.enabled) {
        setOauth({
          enabled: true,
          clientId: first.oauth.clientId || '',
          scope: first.oauth.scope || '',
          grant: first.oauth.grant || 'authorization_code',
          clientSecret: '',
          clearClientSecret: false
        });
      }
    }
    setPasteJsonErr('');
    setPasteJsonOpen(false);
    setStatusMsg({
      text: parsed.servers.length > 1
        ? 'Filled form from "' + first.name + '" (use Import JSON on the MCP list to add multiple servers at once).'
        : 'Filled form from JSON — review and tap Save.',
      kind: 'success'
    });
  }

  async function copyCurrentJson() {
    if (!currentServer) return;
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(serializeMcpServersJson(currentServer));
        setCopyNote('Copied JSON');
        setTimeout(() => setCopyNote(''), 2000);
      }
    } catch {
      setCopyNote('Copy failed');
      setTimeout(() => setCopyNote(''), 2000);
    }
  }

  const filteredTools = useMemo(() => {
    const q = toolFilter.trim().toLowerCase();
    if (!q) return toolsState;
    return toolsState.filter((t) =>
      String(t.name || '').toLowerCase().includes(q)
      || String(t.composedName || '').toLowerCase().includes(q)
      || String(t.description || '').toLowerCase().includes(q)
    );
  }, [toolsState, toolFilter]);

  function renderToolsList() {
    if (!toolsState.length) {
      return h('li', { class: 'mcp__tools-empty' },
        (currentServer && currentServer.status === 'ready')
          ? 'No tools reported by this server.'
          : 'Start the server above to discover and inspect its tools.');
    }
    if (!filteredTools.length) {
      return h('li', { class: 'mcp__tools-empty' }, 'No discovered tools match "' + toolFilter.trim() + '".');
    }
    return filteredTools.map((t) => {
      const composed = t.composedName || ('mcp__' + ((currentServer && currentServer.slug) || '') + '__' + t.name);
      const entry = mcpAuth.tools && mcpAuth.tools[composed];
      const value = (entry && entry.mode) || 'inherit';
      return h('li', { key: composed, class: 'mcp__tools-row' },
        h('div', { class: 'mcp__tools-head' },
          h('div', { class: 'mcp__tools-titles' },
            h('div', { class: 'mcp__tools-name' }, t.name || composed),
            t.name && composed !== t.name ? h('div', { class: 'mcp__tools-composed' }, composed) : null
          ),
          projectDir
            ? h('select', {
                class: 'input mcp__tools-select' + (value !== 'inherit' ? ' mcp__drawer-select--ov' : ''),
                'aria-label': 'Authorization for ' + composed,
                value,
                onChange: (e) => saveToolAuth(composed, e.target.value)
              },
                h('option', { value: 'inherit' }, 'Inherit'),
                h('option', { value: 'off' }, 'Off'),
                h('option', { value: 'ask' }, 'Ask'),
                h('option', { value: 'allow' }, 'Allow')
              )
            : null
        ),
        t.description ? h('div', { class: 'mcp__tools-desc' }, t.description) : null
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

  const listScope = id ? currentScope : addScope;
  const listContext = { projectDir, chatId, from };
  const listTarget = navTarget('settings/mcp', listContext, { scope: listScope });
  const backHref = settingsLink('settings/mcp', listContext, { scope: listScope });

  async function save() {
    setIsSaving(true);
    setStatusMsg({ text: 'saving…', kind: 'busy' });
    const scope = id ? currentScope : addScope;
    const body = {
      projectDir, scope, transport,
      name: (name || '').trim(),
      command: transport === 'stdio' ? (command || '').trim() : '',
      url: transport !== 'stdio' ? (url || '').trim() : '',
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
    if (envText.trim()) {
      body.env = parseEnv(envText);
      if (!Object.keys(body.env).length) { setStatusMsg({ text: 'Environment: use one KEY=value per line', kind: 'error' }); setIsSaving(false); return; }
    } else if (clearEnv) body.env = {};
    if (headersText.trim()) {
      body.headers = parseHeaders(headersText);
      if (!Object.keys(body.headers).length) { setStatusMsg({ text: 'HTTP headers: use one Name: value per line', kind: 'error' }); setIsSaving(false); return; }
    } else if (clearHeaders) body.headers = {};
    if (!body.name) { setStatusMsg({ text: 'name is required', kind: 'error' }); setIsSaving(false); return; }
    if (transport === 'stdio' && !body.command) { setStatusMsg({ text: 'command is required', kind: 'error' }); setIsSaving(false); return; }
    if (transport !== 'stdio' && !body.url) { setStatusMsg({ text: 'URL is required', kind: 'error' }); setIsSaving(false); return; }
    let r;
    try {
      r = await fetchJson(id ? ('/api/mcp/servers/' + encodeURIComponent(id)) : '/api/mcp/servers', {
        method: id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch { setStatusMsg({ text: 'network error', kind: 'error' }); setIsSaving(false); return; }
    if (r.status !== 200 && r.status !== 201) {
      setIsSaving(false);
      setStatusMsg({ text: 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''), kind: 'error' });
      return;
    }
    const saved = r.body && r.body.server;
    if (!id && saved && saved.id) {
      savedFlash = SAVED_TEXT;
      replace(navTarget('settings/mcp/' + encodeURIComponent(saved.id), listContext, { scope: listScope }));
      return;
    }
    if (!id) { setIsSaving(false); back(listTarget); return; }
    const reloaded = await load();
    setIsSaving(false);
    if (reloaded) setStatusMsg({ text: SAVED_TEXT, kind: 'success' });
  }

  async function deleteServer() {
    if (!id) return;
    if (!confirm('Delete this MCP server?')) return;
    setIsDeleting(true);
    setStatusMsg({ text: 'deleting…', kind: 'busy' });
    const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
    let r;
    try { r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + qs, { method: 'DELETE' }); }
    catch { setStatusMsg({ text: 'network error', kind: 'error' }); setIsDeleting(false); return; }
    if (r.status !== 200) { setStatusMsg({ text: 'HTTP ' + r.status, kind: 'error' }); setIsDeleting(false); return; }
    back(listTarget);
  }

  useEffect(() => { load(); }, [id]);

  const title = id ? ((currentServer && currentServer.name) || 'Edit MCP server') : 'Add MCP server';
  const srvStatus = (currentServer && currentServer.status) || 'stopped';
  const slug = (currentServer && (currentServer.slug || currentServer.id)) || '';
  const effAuth = id && projectDir && slug
    ? mcpEffective(mcpAuth.servers, slug, mcpAuth)
    : { overridden: false, mode: mcpAuth.mode || 'ask', allowlist: [] };
  const isOff = effAuth.mode === 'off';
  const liveStderr = (runtimeErr && runtimeErr.stderr) || (currentServer && currentServer.stderr) || null;
  const liveError = runtimeErr || (currentServer && currentServer.error) || null;

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: backHref, class: 'view-back', 'aria-label': 'Back to MCP servers' }, '←'),
      h('h2', { class: 'view-title' }, title)
    ),
    h('section', { class: 'mcp-edit' },
      // ---- Existing server: Live runtime card -----------------------------
      id && currentServer
        ? h('div', { class: 'group' },
            h('div', { class: 'group__title' },
              'Runtime & tools',
              h('span', { class: 'group__title-note' },
                currentScope === 'app' ? 'app-wide' : 'project (.mcp.json)')
            ),
            h('div', { class: 'mcp-edit__status-card' },
              h('div', { class: 'mcp-edit__status-head' },
                h('div', { class: 'mcp-edit__status-main' },
                  h('span', { class: 'mcp__dot mcp__dot--' + (isOff ? 'off' : srvStatus), 'aria-hidden': 'true' }),
                  h('strong', null, isOff ? 'Disabled (Off)' : srvStatus),
                  h('span', { class: 'mcp-edit__status-meta' },
                    '· ' + toolsState.length + ' tool' + (toolsState.length === 1 ? '' : 's'))
                ),
                h('div', { class: 'mcp-edit__status-btns' },
                  h('button', {
                    class: 'btn btn--small' + (srvStatus === 'ready' || isOff ? '' : ' btn--primary'),
                    type: 'button',
                    disabled: !!lifecycleBusy || srvStatus === 'starting' || isOff,
                    onClick: () => callLifecycle('start')
                  }, lifecycleBusy === 'start' || srvStatus === 'starting'
                    ? 'Starting…'
                    : (srvStatus === 'ready' ? 'Restart' : 'Start / Test')),
                  (srvStatus === 'ready' || srvStatus === 'starting' || srvStatus === 'errored')
                    ? h('button', {
                        class: 'btn btn--small btn--danger',
                        type: 'button',
                        disabled: !!lifecycleBusy,
                        onClick: () => callLifecycle('stop')
                      }, lifecycleBusy === 'stop' ? 'Stopping…' : 'Stop')
                    : null,
                  srvStatus === 'ready'
                    ? h('button', {
                        class: 'btn btn--small',
                        type: 'button',
                        disabled: !!lifecycleBusy,
                        title: 'Re-discover tools',
                        'aria-label': 'Refresh tools',
                        onClick: refreshDiscoveredTools
                      }, lifecycleBusy === 'refresh' ? '…' : '↻')
                    : null,
                  h('button', {
                    class: 'btn btn--small',
                    type: 'button',
                    onClick: copyCurrentJson,
                    title: 'Copy clean mcpServers JSON snippet'
                  }, copyNote || 'Copy JSON')
                )
              ),
              liveError
                ? h('div', { class: 'mcp-edit__err' },
                    h('span', { class: 'mcp-edit__err-code' }, liveError.code || 'ERROR'),
                    ' ',
                    liveError.message || '')
                : null,
              liveStderr && liveStderr.text
                ? h('details', { class: 'mcp-edit__stderr', open: !!liveError },
                    h('summary', null, liveStderr.truncated ? 'Server output (truncated)' : 'Server output (stderr)'),
                    h('pre', null, liveStderr.text))
                : null
            )
          )
        : null,

      // ---- Existing server in a project: Server-level permission ----------
      id && projectDir && slug
        ? h('div', { class: 'group' },
            h('div', { class: 'group__title' },
              'Server permission in this project',
              toolAuthMsg ? h('span', { class: 'group__title-note', 'aria-live': 'polite' }, toolAuthMsg) : null
            ),
            h('div', { class: 'mcp-hub__gate-card' },
              h('div', { class: 'mcp-hub__gate-body' },
                h('span', { class: 'mcp-hub__gate-label' },
                  effAuth.overridden
                    ? 'Pinned to ' + segMode(effAuth.mode) + ' for this project'
                    : 'Following project default (' + segMode(mcpAuth.mode || 'ask') + ')'),
                h('span', { class: 'mcp-hub__gate-sub' },
                  'Applies to every tool on this server unless overridden per tool below.')
              ),
              h('div', { class: 'mcp__card-auth' },
                h(McpAuthSeg, {
                  name: name || id,
                  slug,
                  servers: mcpAuth.servers,
                  shared: mcpAuth,
                  namePrefix: 'mcp-edit-srv',
                  onSave: (patch) => saveServerAuth(patch)
                }),
                effAuth.overridden
                  ? h('button', {
                      class: 'btn btn--small btn--ghost mcp__reset-ov',
                      type: 'button',
                      onClick: () => saveServerAuth({ servers: { [slug]: null } })
                    }, 'Reset')
                  : null
              )
            )
          )
        : null,

      // ---- New server: quick JSON fill ------------------------------------
      !id
        ? h('div', { class: 'row' },
            h('div', { class: 'mcp-import__label-row' },
              h('button', {
                class: 'btn btn--small',
                type: 'button',
                onClick: () => setPasteJsonOpen(!pasteJsonOpen)
              }, pasteJsonOpen ? 'Hide JSON paste' : 'Fill from JSON')
            ),
            pasteJsonOpen
              ? h('div', { class: 'mcp-edit__json-box' },
                  h('textarea', {
                    class: 'input mcp-import__textarea',
                    rows: 5,
                    spellcheck: false,
                    placeholder: '{ "mcpServers": { "my-server": { "command": "npx", "args": ["-y", "pkg"] } } }',
                    value: pasteJsonText,
                    onInput: (e) => { setPasteJsonText(e.target.value); setPasteJsonErr(''); }
                  }),
                  pasteJsonErr ? h('span', { class: 'status', 'data-state': 'error' }, pasteJsonErr) : null,
                  h('div', { class: 'row row--inline' },
                    h('button', { class: 'btn btn--small btn--primary', type: 'button', onClick: applyJsonToForm }, 'Fill form'),
                    h('button', { class: 'btn btn--small', type: 'button', onClick: () => setPasteJsonOpen(false) }, 'Cancel')
                  )
                )
              : null
          )
        : h('p', { class: 'hint hint--compact' },
            currentScope === 'app'
              ? 'Scope: app-wide — stored in the app store, visible to every project.'
              : 'Scope: project — stored in this project\'s .mcp.json so it can be committed with the repo.',
            ' Scope is set at creation; delete and re-add (or Copy JSON) to move a server.'),

      // ---- Connection configuration ---------------------------------------
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

      // ---- Discovered tools (available in both app & project contexts) ----
      id ? h('div', { class: 'row' },
        h('div', { class: 'mcp__tools-head-bar' },
          h('h3', { class: 'mcp__tools-h' }, 'Discovered tools (' + toolsState.length + ')'),
          toolsState.length > 4
            ? h('input', {
                class: 'input mcp__tools-filter',
                type: 'search',
                placeholder: 'Filter tools…',
                'aria-label': 'Filter discovered tools',
                value: toolFilter,
                onInput: (e) => setToolFilter(e.target.value)
              })
            : null
        ),
        h('p', { class: 'hint hint--compact' },
          projectDir
            ? 'Per-tool authorization overrides for this project. "Inherit" follows the server or project default. '
            : 'Tools advertised by this server. Open a project\'s MCP page to set per-project or per-tool permissions. ',
          h('span', { class: 'settings-project__item-status', 'aria-live': 'polite' }, toolAuthMsg)
        ),
        h('ul', { class: 'mcp__tools-list' }, renderToolsList())
      ) : null,

      h('div', { class: 'row row--actions' },
        h('span', { class: 'status', 'data-state': statusMsg.kind || undefined, 'aria-live': 'polite' }, statusMsg.text),
        id ? h('button', { class: 'btn btn--danger', type: 'button', onClick: deleteServer, disabled: isDeleting }, 'Delete') : null,
        h('button', { class: 'btn btn--primary', type: 'button', onClick: save, disabled: isSaving }, isSaving ? 'Saving…' : 'Save')
      )
    )
  );
}
