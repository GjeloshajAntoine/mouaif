// mouaif web — SettingsMcpView (MCP management workspace)
// MCP = Model Context Protocol. Servers can be configured app-wide
// (visible to every project) or per project (committed to
// <projectDir>/.mcp.json). The two scopes have two homes in Settings:
// Application → MCP servers is the app-wide list (#/settings/mcp), and
// Active project → MCP servers is the project's merged list
// (#/settings/mcp?projectDir=...) with default & per-server authorization,
// live lifecycle, inline discovered tools, JSON import/export, and
// on-the-fly MCP apps.
// See docs/features/mcp.md.
import { h, Fragment } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { fetchJson } from '../api.js';
import { projectQS } from './settings/projectQS.js';
import { settingsLink } from './settings/projectNavigation.js';
import { McpAuthSeg, mcpEffective, segMode } from './settings/toolAuth.js';
import {
  filterMcpServers,
  serializeMcpServersJson,
  serverTargetSummary,
  summarizeMcpServers
} from './settings/mcpJsonImport.js';
import { McpJsonImportSheet } from './settings/McpJsonImportSheet.jsx';
import { McpErrorModal } from './chat/McpErrorModal.jsx';
import { InstantMcpApp } from './settings/InstantMcpApp.jsx';

export function SettingsMcpView(props = {}) {
  // Scope comes from the URL, never from local tab state: the route
  // carries projectDir only when the user arrived from the Active
  // project card, so #/settings/mcp is always the app-wide list even
  // when an active project exists.
  const projectDir = typeof props.projectDir === 'string' ? props.projectDir : '';
  const from = typeof props.from === 'string' ? props.from : '';
  // The chat a project drill-down was opened from, carried through every
  // list/editor link so Back can return to it instead of the Settings root.
  const chatId = typeof props.chatId === 'string' ? props.chatId : '';
  const projectName = projectDir ? projectDir.split(/[/\\]/).filter(Boolean).pop() || projectDir : '';

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [serversList, setServersList] = useState([]);
  const [mcpAuth, setMcpAuth] = useState({ mode: 'ask', allowlist: [], servers: {}, tools: {} });
  const [authStatusMsg, setAuthStatusMsg] = useState('');
  const [listStatus, setListStatus] = useState({ text: '', kind: '' });
  const [busyIds, setBusyIds] = useState(new Set());
  const [busyAction, setBusyAction] = useState({}); // { [id]: 'start'|'stop'|'refresh' }
  const [batchBusy, setBatchBusy] = useState(''); // 'start' | 'stop' | ''
  const [activeError, setActiveError] = useState(null);
  const [rowStatus, setRowStatus] = useState({}); // { [id]: { text, kind, error? } }
  const [expandedTools, setExpandedTools] = useState({}); // { [id]: boolean }
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [importOpen, setImportOpen] = useState(false);
  const [instantAppOpen, setInstantAppOpen] = useState(false);
  const [copyNote, setCopyNote] = useState('');

  function setRow(id, text, kind, error) {
    setRowStatus((prev) => {
      const next = Object.assign({}, prev);
      if (!text) delete next[id];
      else next[id] = { text, kind, error: error || null };
      return next;
    });
  }

  async function loadAuthorization() {
    const authQs = projectDir
      ? '?projectDir=' + encodeURIComponent(projectDir)
      : '?scope=app';
    try {
      const ar = await fetchJson('/api/tools/authorization' + authQs);
      if (ar.status === 200 && ar.body && ar.body.mcp) {
        const m = ar.body.mcp;
        setMcpAuth({
          mode: m.mode || 'ask',
          allowlist: Array.isArray(m.allowlist) ? m.allowlist : [],
          servers: (m.servers && typeof m.servers === 'object') ? m.servers : {},
          tools: (m.tools && typeof m.tools === 'object') ? m.tools : {}
        });
      }
    } catch { /* keep previous auth view */ }
  }

  async function load() {
    setIsRefreshing(true);
    setListStatus({ text: 'loading…', kind: 'busy' });
    const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
    let r;
    try {
      const [srvRes] = await Promise.all([
        fetchJson('/api/mcp/servers' + qs),
        loadAuthorization()
      ]);
      r = srvRes;
    } catch {
      setListStatus({ text: 'network error', kind: 'error' });
      setIsRefreshing(false);
      return;
    }
    setIsRefreshing(false);
    if (r.status !== 200) {
      setListStatus({ text: 'HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : ''), kind: 'error' });
      return;
    }
    const list = (r.body && r.body.servers) || [];
    setServersList(list);
    setListStatus({ text: list.length + ' configured', kind: 'success' });
    setRowStatus((prev) => {
      const next = {};
      for (const k of Object.keys(prev)) if (prev[k].kind === 'error') next[k] = prev[k];
      return next;
    });
  }

  async function saveAuthPatch(patch, label = 'saved') {
    setAuthStatusMsg('saving…');
    const body = projectDir
      ? { projectDir, mcp: patch }
      : { scope: 'app', mcp: patch };
    try {
      const r = await fetchJson('/api/tools/authorization', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (r.status === 200 && r.body && r.body.mcp) {
        const m = r.body.mcp;
        setMcpAuth({
          mode: m.mode || 'ask',
          allowlist: Array.isArray(m.allowlist) ? m.allowlist : [],
          servers: (m.servers && typeof m.servers === 'object') ? m.servers : {},
          tools: (m.tools && typeof m.tools === 'object') ? m.tools : {}
        });
        setAuthStatusMsg(label);
        load();
      } else {
        setAuthStatusMsg((r.body && r.body.error) || ('HTTP ' + r.status));
      }
    } catch {
      setAuthStatusMsg('network error');
    }
  }

  function saveToolAuth(composedName, value) {
    if (!projectDir) return;
    const nextPatch = { tools: { [composedName]: value === 'inherit' ? null : { mode: value } } };
    saveAuthPatch(nextPatch, 'saved');
  }

  async function copyExportJson() {
    if (!serversList.length) return;
    const json = serializeMcpServersJson(serversList);
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(json);
        setCopyNote('Copied JSON');
        setTimeout(() => setCopyNote(''), 2200);
      }
    } catch {
      setCopyNote('Copy failed');
      setTimeout(() => setCopyNote(''), 2200);
    }
  }

  function toggleExpandTools(serverId) {
    setExpandedTools((prev) => Object.assign({}, prev, { [serverId]: !prev[serverId] }));
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
        error: typed,
        ...(error.stderr ? { stderr: error.stderr } : {})
      }
    });
  }

  function stderrHint(stderr) {
    if (!stderr || typeof stderr.text !== 'string') return '';
    const line = stderr.text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
    return line.length > 120 ? line.slice(0, 117) + '…' : line;
  }

  function clearBusy(id) {
    setBusyIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    setBusyAction((prev) => { const n = Object.assign({}, prev); delete n[id]; return n; });
  }

  async function callLifecycle(action, id) {
    if (busyIds.has(id)) return;
    setBusyIds((prev) => new Set(prev).add(id));
    setBusyAction((prev) => Object.assign({}, prev, { [id]: action }));
    setRow(id, action === 'start' ? 'starting…' : 'stopping…', 'busy');
    let r;
    try {
      r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir })
      });
    } catch {
      clearBusy(id);
      const error = { code: 'EMCP_TRANSPORT', message: 'Could not reach mouaif — check the app is still running, then try again.' };
      setRow(id, error.code + ': ' + error.message, 'error', error);
      const server = serversList.find((item) => item.id === id) || { id };
      showServerError(server, error);
      return;
    }
    if (r.status !== 200) {
      clearBusy(id);
      const error = {
        code: (r.body && r.body.code) || 'EMCP_START',
        message: (r.body && r.body.error) ? String(r.body.error) : ('HTTP ' + r.status),
        ...(r.body && r.body.stderr ? { stderr: r.body.stderr } : {})
      };
      await load();
      setRow(id, error.code + ': ' + error.message, 'error', error);
      const server = serversList.find((item) => item.id === id) || { id };
      showServerError(server, error);
      return;
    }
    clearBusy(id);
    setRow(id, '');
    setListStatus({ text: action === 'stop' ? 'stopped' : 'started', kind: 'success' });
    load();
  }

  async function refreshTools(id) {
    if (busyIds.has(id)) return;
    setBusyIds((prev) => new Set(prev).add(id));
    setBusyAction((prev) => Object.assign({}, prev, { [id]: 'refresh' }));
    setRow(id, 'refreshing tools…', 'busy');
    const qs = projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : '';
    let r;
    try {
      r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id) + '/tools' + qs);
    } catch {
      clearBusy(id);
      setRow(id, 'Could not reach mouaif — check the app is still running, then try again.', 'error');
      return;
    }
    if (r.status !== 200) {
      clearBusy(id);
      const detail = (r.body && r.body.error) ? String(r.body.error) : ('HTTP ' + r.status);
      setRow(id, detail, 'error');
      return;
    }
    clearBusy(id);
    setRow(id, '');
    setListStatus({ text: ((r.body && r.body.tools) || []).length + ' tools', kind: 'success' });
    load();
  }

  async function runBatchLifecycle(action) {
    if (batchBusy) return;
    const targets = serversList.filter((s) => {
      if (!s || busyIds.has(s.id)) return false;
      const slug = s.slug || s.id || '';
      const eff = projectDir ? mcpEffective(mcpAuth.servers, slug, mcpAuth) : { mode: mcpAuth.mode || 'ask' };
      const isOff = s.enabled === false || eff.mode === 'off';
      if (action === 'start') return !isOff && s.status !== 'ready' && s.status !== 'starting';
      return s.status === 'ready' || s.status === 'errored' || s.status === 'starting';
    });
    if (!targets.length) return;
    setBatchBusy(action);
    setListStatus({
      text: (action === 'start' ? 'Starting ' : 'Stopping ') + targets.length + '…',
      kind: 'busy'
    });
    for (const s of targets) {
      try {
        const r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(s.id) + '/' + action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectDir })
        });
        if (r.status !== 200 && action === 'start') {
          const error = {
            code: (r.body && r.body.code) || 'EMCP_START',
            message: (r.body && r.body.error) ? String(r.body.error) : ('HTTP ' + r.status),
            ...(r.body && r.body.stderr ? { stderr: r.body.stderr } : {})
          };
          setRow(s.id, error.code + ': ' + error.message, 'error', error);
        }
      } catch { /* individual error reported on reload */ }
    }
    setBatchBusy('');
    await load();
  }

  useEffect(() => {
    load();
  }, [projectDir]);

  const stats = useMemo(() => summarizeMcpServers(serversList, mcpAuth), [serversList, mcpAuth]);
  const filteredServers = useMemo(
    () => filterMcpServers(serversList, { search, filter, mcpAuth }),
    [serversList, search, filter, mcpAuth]
  );

  function renderServerToolsDrawer(s) {
    const tools = Array.isArray(s.tools) ? s.tools : [];
    const slug = s.slug || s.id || '';
    if (!tools.length) {
      return h('div', { class: 'mcp__drawer' },
        h('p', { class: 'mcp__drawer-empty' },
          s.status === 'ready'
            ? 'This server reported 0 tools.'
            : 'No cached tools yet. Tap Start to connect and discover its tools.')
      );
    }
    return h('div', { class: 'mcp__drawer' },
      h('ul', { class: 'mcp__drawer-list' },
        tools.map((t) => {
          const composed = t.composedName || ('mcp__' + slug + '__' + t.name);
          const ov = mcpAuth.tools && mcpAuth.tools[composed];
          const toolMode = (ov && ov.mode) || 'inherit';
          return h('li', { key: composed, class: 'mcp__drawer-item' },
            h('div', { class: 'mcp__drawer-info' },
              h('code', { class: 'mcp__drawer-name' }, t.name || composed),
              t.description ? h('span', { class: 'mcp__drawer-desc' }, t.description) : null
            ),
            projectDir
              ? h('select', {
                  class: 'input mcp__drawer-select' + (toolMode !== 'inherit' ? ' mcp__drawer-select--ov' : ''),
                  'aria-label': 'Authorization for ' + composed,
                  value: toolMode,
                  onChange: (e) => saveToolAuth(composed, e.target.value)
                },
                  h('option', { value: 'inherit' }, 'Inherit'),
                  h('option', { value: 'off' }, 'Off'),
                  h('option', { value: 'ask' }, 'Ask'),
                  h('option', { value: 'allow' }, 'Allow')
                )
              : null
          );
        })
      )
    );
  }

  function serverRow(s) {
    const status = s.status || 'stopped';
    const tools = Array.isArray(s.tools) ? s.tools : [];
    const toolCount = tools.length;
    const toolBit = toolCount ? toolCount + ' tool' + (toolCount === 1 ? '' : 's') : 'no tools';
    const isBusy = busyIds.has(s.id) || !!batchBusy;
    const slug = s.slug || s.id || '';
    const eff = projectDir
      ? mcpEffective(mcpAuth.servers, slug, mcpAuth)
      : { overridden: false, mode: mcpAuth.mode || 'ask', allowlist: mcpAuth.allowlist || [] };
    const isOff = s.enabled === false || eff.mode === 'off';

    const qs = projectDir
      ? projectQS(projectDir) + '&scope=' + encodeURIComponent(s.scope || 'project') + (chatId ? '&chatId=' + encodeURIComponent(chatId) : '') + (from ? '&from=' + encodeURIComponent(from) : '')
      : '?scope=app' + (chatId ? '&chatId=' + encodeURIComponent(chatId) : '') + (from ? '&from=' + encodeURIComponent(from) : '');
    const href = '#/settings/mcp/' + encodeURIComponent(s.id) + qs;

    const showStop = status === 'ready' || status === 'errored' || status === 'starting';
    const startDisabled = status === 'starting' || isBusy || isOff;
    const startTitle = isOff
      ? 'Server permission is Off — switch to Ask or Allow to start it'
      : (status === 'starting' ? 'Starting…' : (status === 'ready' ? 'Restart this server' : 'Start this server'));
    const hint = stderrHint(s.stderr);
    const row = rowStatus[s.id];
    const targetLine = serverTargetSummary(s);
    const transportLabel = s.transport === 'http' ? 'http' : (s.transport === 'sse' ? 'sse' : 'stdio');
    const oauthBadge = (s.transport === 'http' || s.transport === 'sse') && s.oauth && s.oauth.enabled;
    const envCount = Object.keys(s.env || {}).filter((k) => s.env[k] && s.env[k].configured).length;
    const headerCount = Object.keys(s.headers || {}).filter((k) => s.headers[k] && s.headers[k].configured).length;
    const isOpen = !!expandedTools[s.id];

    const rowMessage = row && row.text
      ? { text: row.text, kind: row.kind || 'error', error: row.error || null }
      : (s.status === 'errored' && s.error)
        ? { text: (s.error.code || 'ERR') + ': ' + (s.error.message || '') + (hint ? ' — ' + hint : ''), kind: 'error', error: { ...s.error, ...(s.stderr ? { stderr: s.stderr } : {}) } }
        : null;

    return h('li', {
      key: s.id,
      class: 'mcp__row' + (isBusy ? ' mcp__row--busy' : '') + (isOff ? ' mcp__row--off' : '')
    },
      h('div', { class: 'mcp__card-top' },
        h('a', { class: 'group__row settings-project__agent-link mcp__row-main', href },
          h('span', { class: 'group__row-body' },
            h('span', { class: 'group__row-label mcp__row-name' },
              s.name,
              ' ',
              scopeBadge(s),
              oauthBadge ? h('span', { class: 'mcp__tag' }, 'OAuth') : null,
              (envCount + headerCount) > 0
                ? h('span', { class: 'mcp__tag' }, (envCount + headerCount) + (envCount ? ' env' : ' hdr'))
                : null
            ),
            h('span', { class: 'settings-project__link-sub mcp__row-sub' },
              h('span', { class: 'mcp__dot mcp__dot--' + (isOff ? 'off' : status), 'aria-hidden': 'true' }),
              h('span', null, transportLabel + ' · ' + (isOff ? 'disabled (Off)' : status))
            ),
            targetLine ? h('span', { class: 'mcp__row-target' }, targetLine) : null
          ),
          h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
        )
      ),
      h('div', { class: 'mcp__card-controls', onClick: (e) => e.stopPropagation() },
        projectDir
          ? h('div', { class: 'mcp__card-auth' },
              h(McpAuthSeg, {
                name: s.name || s.id,
                slug,
                servers: mcpAuth.servers,
                shared: mcpAuth,
                namePrefix: 'mcp-row-' + s.id,
                onSave: (patch) => saveAuthPatch(patch, 'saved')
              }),
              eff.overridden
                ? h('button', {
                    class: 'btn btn--small btn--ghost mcp__reset-ov',
                    type: 'button',
                    title: 'Reset to default MCP permission (' + segMode(mcpAuth.mode || 'ask') + ')',
                    onClick: () => saveAuthPatch({ servers: { [slug]: null } }, 'reset')
                  }, 'Reset')
                : null
            )
          : null,
        h('div', { class: 'mcp__row-actions' },
          h('button', {
            class: 'btn btn--small mcp__tools-toggle' + (isOpen ? ' is-open' : ''),
            type: 'button',
            'aria-expanded': isOpen ? 'true' : 'false',
            onClick: () => toggleExpandTools(s.id)
          }, toolBit + (isOpen ? ' ▴' : ' ▾')),
          h('button', {
            class: 'btn btn--small' + (status === 'ready' || isOff ? '' : ' btn--primary'),
            type: 'button',
            disabled: startDisabled,
            title: startTitle,
            'aria-label': startTitle,
            'aria-busy': busyAction[s.id] === 'start' ? 'true' : undefined,
            onClick: () => callLifecycle('start', s.id)
          }, busyAction[s.id] === 'start' || status === 'starting' ? 'Starting…' : (status === 'ready' ? 'Restart' : 'Start')),
          showStop
            ? h('button', {
                class: 'btn btn--small btn--danger',
                type: 'button',
                disabled: isBusy,
                title: 'Stop this server',
                'aria-label': 'Stop this server',
                'aria-busy': busyAction[s.id] === 'stop' ? 'true' : undefined,
                onClick: () => callLifecycle('stop', s.id)
              }, busyAction[s.id] === 'stop' ? 'Stopping…' : 'Stop')
            : null,
          status === 'ready'
            ? h('button', {
                class: 'btn btn--small',
                type: 'button',
                disabled: isBusy,
                title: 'Refresh tools',
                'aria-label': 'Refresh tools',
                'aria-busy': busyAction[s.id] === 'refresh' ? 'true' : undefined,
                onClick: () => refreshTools(s.id)
              }, busyAction[s.id] === 'refresh' ? '…' : '↻')
            : null,
          s.stderr && s.stderr.text && status !== 'errored'
            ? h('button', {
                class: 'btn btn--small',
                type: 'button',
                title: 'View server output',
                onClick: () => showServerError(s, { code: 'STDERR', message: 'Recent output from ' + (s.name || s.id), stderr: s.stderr })
              }, 'Logs')
            : null
        )
      ),
      isOpen ? renderServerToolsDrawer(s) : null,
      rowMessage && rowMessage.kind !== 'busy'
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

  const ctx = { projectDir, chatId, from };
  const storeHref = settingsLink('settings/mcp/registry', ctx);
  const newHref = settingsLink('settings/mcp/new', ctx, { scope: projectDir ? 'project' : 'app' });
  const backHref = projectDir ? settingsLink('settings/project', ctx) : '#/settings';

  const filterChips = [
    ['all', 'All (' + stats.total + ')'],
    ...(stats.ready ? [['ready', 'Running (' + stats.ready + ')']] : []),
    ...(stats.errored ? [['errored', 'Errors (' + stats.errored + ')']] : []),
    ...(stats.off ? [['off', 'Off (' + stats.off + ')']] : [])
  ];

  const canStartAny = serversList.some((s) => {
    const slug = s.slug || s.id || '';
    const eff = projectDir ? mcpEffective(mcpAuth.servers, slug, mcpAuth) : { mode: mcpAuth.mode || 'ask' };
    return s.enabled !== false && eff.mode !== 'off' && s.status !== 'ready' && s.status !== 'starting';
  });
  const canStopAny = serversList.some((s) => s.status === 'ready' || s.status === 'starting' || s.status === 'errored');

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: backHref, class: 'view-back', 'aria-label': 'Back' }, '←'),
      h('h2', { class: 'view-title' }, projectDir ? 'MCP · ' + projectName : 'MCP · App defaults')
    ),
    // The scroll container. Flush routes (no tab bar) rely on a single
    // root <section> matching `.app__main--flush > section` to scroll
    // internally.
    h('section', { class: 'mcp-hub' },
      h('p', { class: 'hint hint--compact' },
        projectDir
          ? 'Manage everything for this project\'s MCP surface: external servers (app-wide + .mcp.json), default & per-server permissions, discovered tools, JSON import, and single-file MCP apps.'
          : 'App-wide MCP servers and default tool permission shared across every project. A project can add its own servers or override permissions.'),

      // ---- Action bar (Browse store / Add / Import JSON / Export) ----------
      h('div', { class: 'mcp-hub__actions' },
        h('a', { href: storeHref, class: 'btn btn--small btn--primary mcp-hub__cta' }, 'Browse store'),
        h('a', { href: newHref, class: 'btn btn--small mcp-hub__cta', 'aria-label': 'Add MCP server' }, '+ Add server'),
        h('button', {
          class: 'btn btn--small mcp-hub__cta',
          type: 'button',
          onClick: () => setImportOpen(true)
        }, 'Import JSON'),
        serversList.length > 0
          ? h('button', {
              class: 'btn btn--small',
              type: 'button',
              onClick: copyExportJson,
              title: 'Copy clean mcpServers JSON to clipboard'
            }, copyNote || 'Copy JSON')
          : null
      ),

      // ---- Default MCP tool permission (one compact row) ----------------
      h('div', { class: 'mcp-hub__gate-card' },
        h('span', { class: 'mcp-hub__gate-label', title: 'Off hides tools and prevents startup · Ask prompts before running · Allow runs immediately' },
          projectDir ? 'Default permission' : 'Default permission for all projects',
          authStatusMsg ? h('span', { class: 'mcp-hub__gate-note', 'aria-live': 'polite' }, ' · ' + authStatusMsg) : null),
        h(McpAuthSeg, {
          name: projectDir ? 'Project MCP default' : 'App MCP default',
          slug: null,
          servers: mcpAuth.servers,
          shared: mcpAuth,
          namePrefix: 'mcp-shared-gate',
          onSave: (patch) => saveAuthPatch(patch, 'saved')
        })
      ),

      // ---- Server list + search/filter + batch controls --------------------
      h('div', { class: 'group' },
        h('div', { class: 'group__title' },
          'Servers',
          h('span', { class: 'group__title-note' },
            stats.total + ' configured'
            + (stats.ready ? ' · ' + stats.ready + ' running' : '')
            + (stats.tools ? ' · ' + stats.tools + ' tools' : ''))
        ),

        serversList.length > 0
          ? h('div', { class: 'mcp-hub__list-bar' },
              serversList.length > 1 || search
                ? h('div', { class: 'mcp-hub__search-wrap' },
                    h('input', {
                      class: 'input mcp-hub__search',
                      type: 'search',
                      placeholder: 'Filter servers or tools…',
                      'aria-label': 'Filter configured MCP servers and tools',
                      value: search,
                      onInput: (e) => setSearch(e.target.value)
                    }),
                    search
                      ? h('button', {
                          class: 'icon-btn mcp-hub__search-clear',
                          type: 'button',
                          'aria-label': 'Clear filter',
                          onClick: () => setSearch('')
                        }, '×')
                      : null
                  )
                : null,
              h('div', { class: 'mcp-hub__chips-row' },
                filterChips.length > 1
                  ? h('div', { class: 'mcps-chips', role: 'radiogroup', 'aria-label': 'Filter servers' },
                      filterChips.map(([v, label]) => h('button', {
                        key: v,
                        type: 'button',
                        role: 'radio',
                        'aria-checked': filter === v ? 'true' : 'false',
                        class: 'mcps-chip' + (filter === v ? ' mcps-chip--on' : ''),
                        onClick: () => setFilter(v)
                      }, label)))
                  : null,
                h('div', { class: 'mcp-hub__batch' },
                  canStartAny
                    ? h('button', {
                        class: 'btn btn--small',
                        type: 'button',
                        disabled: !!batchBusy || isRefreshing,
                        onClick: () => runBatchLifecycle('start')
                      }, batchBusy === 'start' ? 'Starting…' : 'Start all')
                    : null,
                  canStopAny
                    ? h('button', {
                        class: 'btn btn--small',
                        type: 'button',
                        disabled: !!batchBusy || isRefreshing,
                        onClick: () => runBatchLifecycle('stop')
                      }, batchBusy === 'stop' ? 'Stopping…' : 'Stop all')
                    : null,
                  h('button', {
                    class: 'btn btn--small',
                    type: 'button',
                    'aria-label': 'Refresh servers',
                    title: 'Reload server statuses',
                    disabled: isRefreshing || !!batchBusy,
                    onClick: () => load()
                  }, '↻')
                )
              )
            )
          : null,

        h('ul', { class: 'group__list mcp__list', 'aria-label': 'MCP servers' },
          filteredServers.length
            ? filteredServers.map(serverRow)
            : serversList.length
              ? h('li', { class: 'mcp__empty' },
                  'No configured servers match this filter. ',
                  h('button', {
                    class: 'btn btn--small',
                    type: 'button',
                    onClick: () => { setSearch(''); setFilter('all'); }
                  }, 'Show all'))
              : h('li', { class: 'mcp__empty' },
                  h('span', null, projectDir
                    ? 'No MCP servers configured for this project yet. '
                    : 'No app-wide MCP servers configured yet. '),
                  h('a', { href: storeHref }, 'Browse the MCP store'),
                  ', ',
                  h('button', { class: 'mcp__inline-link', type: 'button', onClick: () => setImportOpen(true) }, 'paste MCP JSON'),
                  ', or ',
                  h('a', { href: newHref }, 'add one by hand'),
                  '.')
        )
      ),

      // ---- Project: On-the-fly single-file MCP app ------------------------
      projectDir
        ? h('div', { class: 'group' },
            h('div', { class: 'group__title' }, 'On-the-fly MCP app', h('span', { class: 'group__title-note' }, 'Single HTML / JS view')),
            h('details', {
              class: 'mcp-hub__app-fold',
              open: instantAppOpen,
              onToggle: (e) => setInstantAppOpen(e.currentTarget.open)
            },
              h('summary', { class: 'mcp-hub__app-summary' },
                h('span', { class: 'mcp-hub__app-summary-body' },
                  h('span', { class: 'mcp-hub__app-summary-title' }, 'Build or import an interactive chat app'),
                  h('span', { class: 'mcp-hub__app-summary-sub' }, 'Create from a prompt or import one .html / .js file — no server needed')
                ),
                h('span', { class: 'mcp-hub__app-summary-chev', 'aria-hidden': 'true' }, instantAppOpen ? '▴' : '▾')
              ),
              h(InstantMcpApp, { key: projectDir, projectDir, embedded: true, onImported: load })
            )
          )
        : null,

      // The Servers title already shows the count and the action bar has
      // Add server, so only surface load errors or progress here.
      listStatus.kind && listStatus.kind !== 'success'
        ? h('p', {
            class: 'status mcp-hub__status',
            'data-state': listStatus.kind,
            'aria-live': 'polite'
          }, listStatus.text)
        : null
    ),
    importOpen
      ? h(McpJsonImportSheet, {
          projectDir,
          onClose: () => setImportOpen(false),
          onImported: () => load()
        })
      : null,
    activeError
      ? h(McpErrorModal, { error: activeError, onClose: () => setActiveError(null) })
      : null
  );
}
