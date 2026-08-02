// mouaif web — Chat cards (setup, tools, MCP, authorization, ask_user)
//
// All the in-transcript cards that aren't plain chat bubbles. Most
// of the work is imperative DOM construction so the rest of the
// transcript (which is also imperative) can stay homogeneous.

import { fetchJson } from '../../api.js';
import { afterTranscriptAppend } from './scroll.js';
import { isSubagentTool, normalizeToolName } from './tools.js';
import { h, render } from 'preact';
import { ToolTree, buildToolGroups } from '../ToolTree.jsx';
import { McpAuthSeg } from '../settings/toolAuth.js';

// buildSetupCard()
//
// The creation-time prompt-size selector. A single <select> dropdown
// — no title, no description, no tool preview. The control lives in
// the transcript (the message area), above the system-prompt
// message, and is the first thing the user sees on a new chat.
// Once any message exists it is removed entirely (see
// updateSetupVisibility in meta.js).
function buildSetupCard() {
  const sel = document.createElement('select');
  sel.className = 'input chat-view__setup';
  sel.id = 'chatPromptSize';
  sel.setAttribute('aria-label', 'Prompt size');
  for (const opt of [
    { id: 'very-small', label: 'Very small — tool names only, no parameter schemas, smallest prompt' },
    { id: 'average',    label: 'Average — full tools, recommended' },
    { id: 'extensive',  label: 'Extensive — full tools + best-practice guidance' }
  ]) {
    const o = document.createElement('option');
    o.value = opt.id;
    o.textContent = opt.label;
    sel.appendChild(o);
  }
  // Use `selected` on the <option> (not `value` on the <select>) so
  // the initial paint matches the chat's resolved profile on every
  // re-render. Preact reliably re-applies `selected` per render,
  // while a `value` on <select> can be ignored on first mount when
  // the matching <option> hasn't been attached yet.
  sel.addEventListener('change', () => sel._onChange && sel._onChange(sel.value));
  return sel;
}

// buildToolsCard(state)
//
// Build / rebuild the per-chat tool toggle card. Sits below the
// system-prompt message. One chip per catalog entry; the chip's
// pressed state mirrors state.tools.filter (null = all enabled, the
// per-chat array is the explicit selection). Changes are persisted
// on the chat record and affect the next model turn.
function buildToolsCard(state) {
  const t = state.tools || { catalog: [], filter: null };
  const card = document.createElement('div');
  card.className = 'chat-view__tools-card';
  card.dataset.toolsCard = '1';

  const head = document.createElement('div');
  head.className = 'chat-view__tools-card-head';
  const title = document.createElement('span');
  title.className = 'chat-view__tools-card-title';
  title.textContent = 'Tools';
  const note = document.createElement('span');
  note.className = 'chat-view__tools-card-note';
  note.textContent = (t.filter == null)
    ? 'all on — tap to change'
    : 'applies next turn';
  head.appendChild(title); head.appendChild(note);
  card.appendChild(head);

  if (!t.catalog.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-view__tools-empty';
    empty.textContent = 'No tools available. Add an MCP server in Settings → MCP to expose its tools here.';
    card.appendChild(empty);
    return card;
  }

  // Build hierarchical groups from the catalog + MCP servers.
  // The tree shows: Shell, Subagent, Ask user, File tools, then one
  // group per MCP server. Used tools are auto-checked and badged.
  const groups = buildToolGroups(
    t.catalog,
    state.mcpServers || [],
    t.filter,
    state.usedTools || new Set()
  );

  // Inject Off/Ask/Allow authorization segments on each known group
  // row, exactly like the project settings page. The segment calls
  // state._saveToolAuth on tap.
  const auth = state.toolAuth || {};
  function segMode(m) { return m === 'allowlist' ? 'ask' : m; }
  function makeSegVNode(toolName, _groupId) {
    const cur = auth[toolName] || { mode: 'ask' };
    const active = segMode(cur.mode);
    const modes = toolName === 'ask_user'
      ? [{ value: 'off', label: 'Off' }, { value: 'ask', label: 'Ask' }]
      : [{ value: 'off', label: 'Off' }, { value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }];
    return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': toolName + ' authorization' },
      modes.map((m) =>
        h('label', { key: m.value, class: 'seg__item' + (active === m.value ? ' seg__item--on' : '') },
          h('input', {
            type: 'radio',
            name: 'chat-auth-' + toolName,
            value: m.value,
            checked: active === m.value,
            onChange: () => {
              if (state._saveToolAuth) {
                const allowlist = m.value === 'allow' ? [] : (Array.isArray(cur.allowlist) ? cur.allowlist : []);
                state._saveToolAuth(toolName, m.value, allowlist);
              }
            }
          }),
          h('span', { class: 'seg__pill' }, m.label)
        )
      )
    );
  }
  for (const g of groups) {
    if (g.id === 'shell') g.control = makeSegVNode('shell', g.id);
    else if (g.id === 'subagent') g.control = makeSegVNode('subagent', g.id);
    else if (g.id === 'task') g.control = makeSegVNode('task', g.id);
    else if (g.id === 'ask_user') g.control = makeSegVNode('ask_user', g.id);
    else if (g.id === 'report_progress') g.control = makeSegVNode('report_progress', g.id);
    else if (g.id === 'files') g.control = makeSegVNode('file', g.id);
  }

  // MCP authorization — same layered model as project settings:
  // an "MCP default" gate row (the project's shared fallback, layers
  // 3-4) plus one Off/Ask/Allow segment per MCP server group (the
  // per-server override, layer 2; shows the effective mode and gains
  // a ↺ reset when an override is set). Writes go through
  // state._saveMcpAuth so the card re-renders in place.
  const mcpAuth = state.mcpAuth || { mode: 'ask', allowlist: [], servers: {}, tools: {} };
  const mcpServers = state.mcpServers || [];
  const firstMcp = groups.findIndex((g) => g.id.startsWith('mcp-'));
  if (firstMcp >= 0) {
    const onSaveMcp = (patch) => state._saveMcpAuth && state._saveMcpAuth(patch);
    groups.splice(firstMcp, 0, {
      id: 'mcp',
      name: 'MCP default',
      description: 'gate for servers without an override',
      checked: (mcpAuth.mode || 'ask') !== 'off',
      control: h(McpAuthSeg, {
        name: 'MCP default',
        slug: null,
        servers: mcpAuth.servers,
        shared: mcpAuth,
        namePrefix: 'chat-mcp',
        onSave: onSaveMcp
      }),
      tools: []
    });
    for (const g of groups) {
      if (!g.id.startsWith('mcp-')) continue;
      const server = mcpServers.find((s) => s && s.id === g.id.slice(4));
      const slug = (server && (server.slug || server.id)) || g.id.slice(4);
      g.control = h(McpAuthSeg, {
        name: g.name,
        slug,
        servers: mcpAuth.servers,
        shared: mcpAuth,
        namePrefix: 'chat-mcp',
        onSave: onSaveMcp
      });
    }
  }

  // Render the Preact ToolTree into a container div.
  const treeHost = document.createElement('div');
  treeHost.className = 'chat-view__tools-tree';

  function onToggleGroup(groupId, checked) {
    // MCP default gate: the group checkbox is a quick Off ↔ Ask for the
    // project's shared MCP fallback (same shortcut as native groups).
    if (groupId === 'mcp') {
      if (state._saveMcpAuth) state._saveMcpAuth({ mode: checked ? 'ask' : 'off' });
      return;
    }
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    // MCP groups: the parent checkbox enables/disables the server
    // itself (project-level), not the per-chat tool filter.
    if (groupId.startsWith('mcp-')) {
      if (state._toggleMcpServer) state._toggleMcpServer(groupId.slice(4), checked);
      return;
    }
    if (state._toggleToolGroup) state._toggleToolGroup(group.tools.map((tool) => tool.id), checked);
  }

  function onToggleTool(groupId, toolId, checked) {
    if (state._toggleTool) state._toggleTool(toolId, checked);
  }

  render(h(ToolTree, { groups, onToggleGroup, onToggleTool, collapsedByDefault: true }), treeHost);
  card.appendChild(treeHost);

  return card;
}

// mountToolsCard(refs, state)
//
// Insert the tools card into the transcript in the right slot.
// Called from renderTranscript for every chat, and from toggleTool
// after a chip is clicked (so the active-state highlight updates in
// place without a full rebuild).
export function mountToolsCard(refs, state) {
  if (!refs.transcript.current) return;
  const existing = refs.transcript.current.querySelector('[data-tools-card="1"]');
  if (existing) existing.remove();
  const card = buildToolsCard(state);
  refs.toolsCard.current = card;
  // Insert AFTER the system-prompt message so the visual order is:
  //   [setup card] [system prompt] [tools card] [messages/empty]
  // The user asked for the toggles "below the system prompt".
  const sysMsg = refs.transcript.current.querySelector('[data-sys-prompt="1"]');
  const empty = refs.transcript.current.querySelector('.chat-view__empty');
  if (sysMsg && sysMsg.parentNode === refs.transcript.current) {
    refs.transcript.current.insertBefore(card, sysMsg.nextSibling);
  } else if (empty && empty.parentNode === refs.transcript.current) {
    refs.transcript.current.insertBefore(card, empty);
  } else {
    refs.transcript.current.appendChild(card);
  }
}

// buildAgentFilesCard(state)
//
// A small card that shows which agent files (AGENTS.md, CLAUDE.md,
// .github/copilot-instructions.md) were found at the project root
// and whether they are being injected into the model context. One
// toggle flips the per-chat `agentFiles` boolean; the default
// (no explicit choice) follows the prompt-size profile:
// very-small = OFF, average/extensive = ON.
// When `projectLocked` is true, the project has the master switch off
// and the per-chat toggle is disabled.
function buildAgentFilesCard(state) {
  const af = state.agentFiles || { files: [], enabled: true, explicit: false, projectLocked: false };
  const card = document.createElement('div');
  card.className = 'chat-view__agent-files-card';
  card.dataset.agentFilesCard = '1';

  const head = document.createElement('div');
  head.className = 'chat-view__agent-files-head';
  const title = document.createElement('span');
  title.className = 'chat-view__agent-files-title';
  title.textContent = 'Agent files';
  const note = document.createElement('span');
  note.className = 'chat-view__agent-files-note';
  if (af.projectLocked) {
    note.textContent = 'off (locked by project setting) — enable in Settings → Project';
  } else if (af.explicit) {
    note.textContent = af.enabled ? 'on — applies next turn' : 'off — applies next turn';
  } else {
    note.textContent = af.enabled ? 'on (default) — tap to disable' : 'off (default) — tap to enable';
  }
  head.appendChild(title); head.appendChild(note);
  card.appendChild(head);

  if (!af.files.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-view__agent-files-empty';
    empty.textContent = 'No agent files found at the project root.';
    card.appendChild(empty);
    return card;
  }

  const list = document.createElement('div');
  list.className = 'chat-view__agent-files-list';
  for (const name of af.files) {
    const row = document.createElement('div');
    row.className = 'chat-view__agent-files-row';
    const label = document.createElement('span');
    label.className = 'chat-view__agent-files-name';
    label.textContent = name;
    row.appendChild(label);
    list.appendChild(row);
  }
  card.appendChild(list);

  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'chat-view__agent-files-toggle';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = !!af.enabled;
  toggle.disabled = !!af.projectLocked;
  toggle.setAttribute('aria-label', 'Use agent files');
  toggle.addEventListener('change', () => state._toggleAgentFiles && state._toggleAgentFiles(toggle.checked));
  const toggleText = document.createElement('span');
  toggleText.textContent = af.projectLocked ? 'Use agent files (locked)' : 'Use agent files';
  toggleLabel.appendChild(toggle);
  toggleLabel.appendChild(toggleText);
  card.appendChild(toggleLabel);

  return card;
}

// mountAgentFilesCard(refs, state)
//
// Insert the agent-files card into the transcript in the right slot.
// Sits below the tools card (or below the system prompt if no tools
// card is present).
export function mountAgentFilesCard(refs, state) {
  if (!refs.transcript.current) return;
  const existing = refs.transcript.current.querySelector('[data-agent-files-card="1"]');
  if (existing) existing.remove();
  const card = buildAgentFilesCard(state);
  refs.agentFilesCard.current = card;
  const toolsCard = refs.transcript.current.querySelector('[data-tools-card="1"]');
  const sysMsg = refs.transcript.current.querySelector('[data-sys-prompt="1"]');
  const empty = refs.transcript.current.querySelector('.chat-view__empty');
  if (toolsCard && toolsCard.parentNode === refs.transcript.current) {
    refs.transcript.current.insertBefore(card, toolsCard.nextSibling);
  } else if (sysMsg && sysMsg.parentNode === refs.transcript.current) {
    refs.transcript.current.insertBefore(card, sysMsg.nextSibling);
  } else if (empty && empty.parentNode === refs.transcript.current) {
    refs.transcript.current.insertBefore(card, empty);
  } else {
    refs.transcript.current.appendChild(card);
  }
}

// updateAgentFilesCard(refs, state)
//
// Re-render the agent-files card in place after a toggle. Same
// pattern as updateToolsCard.
export function updateAgentFilesCard(refs, state) {
  if (!refs.agentFilesCard.current || !refs.agentFilesCard.current.parentNode) return;
  const fresh = buildAgentFilesCard(state);
  refs.agentFilesCard.current.parentNode.replaceChild(fresh, refs.agentFilesCard.current);
  refs.agentFilesCard.current = fresh;
}

// toggleAgentFiles(next, state, refs, updateChat)
//
// Flip the per-chat agent-files toggle and persist it. The first
// time the user interacts we write an explicit boolean; after that
// the chat carries the user's choice until they reset it (by
// switching to the profile default, which we do not expose in the
// UI — the toggle is sticky).
export async function toggleAgentFiles(next, state, refs, updateChat) {
  const cur = state.agentFiles || { files: [], enabled: true, explicit: false };
  state.agentFiles = { files: cur.files, enabled: next, explicit: true };
  updateAgentFilesCard(refs, state);
  await updateChat({ agentFiles: next });
}

// updateToolsCard(refs, state)
//
// Re-render the tools card in place after a chip toggle. Faster
// than calling renderTranscript (no need to re-fetch messages,
// re-render the empty state, etc.) and avoids a visible flash
// when a chip flips its pressed state.
export function updateToolsCard(refs, state) {
  if (!refs.toolsCard.current || !refs.toolsCard.current.parentNode) return;
  const fresh = buildToolsCard(state);
  refs.toolsCard.current.parentNode.replaceChild(fresh, refs.toolsCard.current);
  refs.toolsCard.current = fresh;
}

// toggleTool(name, next, state, refs, updateChat)
//
// Flip one chip and persist the new filter to the chat. The server
// is the source of truth for which tools are advertised; the PATCH
// response carries the new chat record, so we sync chatRef.current
// in place.
//
// Filter semantics: an empty array and `null` are not the same
// thing. `null` means "all available" (no user choice yet, or
// the user hit Reset). `[]` means "user explicitly chose no
// tools". The first time the user disables a tool we transition
// from `null` to an explicit array; the next time they re-enable
// every chip we go back to `null` so the chat record does not
// grow stale as new tools are added to the catalog.
export async function toggleTool(name, next, state, refs, updateChat) {
  const cur = state.tools || { catalog: [], filter: null };
  const catalog = cur.catalog || [];
  if (!catalog.find((t) => t && t.name === name)) return;
  const allNames = catalog.map((t) => t.name);
  let nextFilter;
  if (cur.filter == null) {
    // First edit: snapshot the implicit "all" set, then apply
    // the toggle. The full set minus the one the user just
    // turned off.
    nextFilter = allNames.filter((n) => n !== name);
    if (next) nextFilter = allNames.slice();
  } else {
    const set = new Set(cur.filter);
    if (next) set.add(name); else set.delete(name);
    // If the explicit set covers every catalog entry, prefer
    // `null` so the filter does not pin a chat to a stale
    // catalog snapshot. Same idea when the set is empty — keep
    // it as `[]` so "no tools" round-trips.
    if (set.size === catalog.length) nextFilter = null;
    else nextFilter = Array.from(set);
  }
  state.tools = { catalog, filter: nextFilter };
  updateToolsCard(refs, state);
  await updateChat({ tools: nextFilter == null ? null : nextFilter });
  // updateChat already syncs state.chat from the server
  // response, so the persisted value matches the local mirror.
}

// toggleMcpServer(id, enabled, state, refs, updateChat, setChatStatus, projectDir, chatId)
//
// Quick project-level MCP enable switch from the chat tool card.
// PATCH stops any running session when the server config changes;
// refresh the catalog after so the tool chips immediately reflect
// enabled/ready MCP tools.
export async function toggleMcpServer(id, enabled, state, refs, updateChat, setChatStatus, projectDir, chatId) {
  if (!id || !projectDir || state.mcpToggleBusy.has(id)) return;
  state.mcpToggleBusy.add(id);
  const servers = state.mcpServers || [];
  const idx = servers.findIndex((s) => s && s.id === id);
  const prev = idx >= 0 ? servers[idx].enabled !== false : null;
  if (idx >= 0) {
    const next = servers.slice();
    next[idx] = Object.assign({}, next[idx], { enabled });
    state.mcpServers = next;
    updateToolsCard(refs, state);
  }
  try {
    const r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, enabled })
    });
    if (r.status !== 200) {
      if (idx >= 0 && prev !== null) {
        const rollback = (state.mcpServers || []).slice();
        rollback[idx] = Object.assign({}, rollback[idx], { enabled: prev });
        state.mcpServers = rollback;
      }
      setChatStatus('MCP update failed: HTTP ' + r.status, 'error');
      return;
    }
    // The PATCH resolved, so the flag is persisted. Show the cached
    // state right away instead of blocking on the server boot: the
    // freshly-PATCHed server record carries the persisted tool cache
    // from its last run, which is enough to paint the child tool
    // rows. Merge it into local state and repaint immediately…
    if (r.body && r.body.server) {
      const servers2 = (state.mcpServers || []).slice();
      const i2 = servers2.findIndex((s) => s && s.id === id);
      if (i2 >= 0) servers2[i2] = r.body.server; else servers2.push(r.body.server);
      state.mcpServers = servers2;
    }
    state.mcpToggleBusy.delete(id);
    updateToolsCard(refs, state);
    setChatStatus(enabled ? 'MCP enabled' : 'MCP disabled', 'success');
    // …then refresh in the background. /api/tools/list awaits
    // ensureEnabledServers (i.e. the actual child-process boot),
    // which is the slow part; when it lands we swap in the live
    // catalog and repaint once more. The user never sees a frozen
    // switch — they see the cached tools instantly, then the live
    // set a moment later.
    Promise.all([
      fetchJson('/api/mcp/servers?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/tools/list?projectDir=' + encodeURIComponent(projectDir))
    ]).then((rr) => {
      if (rr[0].status === 200 && Array.isArray(rr[0].body.servers)) state.mcpServers = rr[0].body.servers;
      if (rr[1].status === 200 && Array.isArray(rr[1].body.tools)) {
        state.tools = Object.assign({}, state.tools || {}, { catalog: rr[1].body.tools });
      }
      updateToolsCard(refs, state);
    }).catch(() => {});
  } finally {
    state.mcpToggleBusy.delete(id);
  }
}

// authorizationCard(request, projectDir, chatId, refs, resume)
//
// Render a 4-button authorization card on the transcript and
// resolve with the user's decision. The chat's runner pauses until
// the user picks; `resume()` is called for any non-deny decision so
// the original tool call can be retried with the same callId.
export function removePendingAuthorizationCards(refs) {
  if (!refs || !refs.transcript || !refs.transcript.current) return;
  for (const card of refs.transcript.current.querySelectorAll('.tool-card--authorization[data-auth-call-id]')) {
    card.remove();
  }
}

// buildAuthModelPicker(state, request) -> HTMLElement | null
//
// The authorization card's per-run model picker. Only shown for
// `subagent` calls: while approving the delegated run the user can
// pick which model executes it (this call only — nothing is
// persisted on the chat or an agent). The list is the same union
// the main chat model picker shows: project-defined models plus the
// per-provider live catalog, deduped by (provider, id). The chat's
// current model is preselected, prefixed with "(chat default)".
// Returns null when there is nothing to pick from.
function buildAuthModelPicker(state, request) {
  if (!state || request.tool !== 'subagent') return null;
  const out = new Map();
  for (const m of (state.models || [])) {
    if (!m || !m.id || !m.provider) continue;
    out.set(m.provider + '\u0000' + m.id, { id: m.id, provider: m.provider, label: m.label || '' });
  }
  const live = state.liveByProvider || {};
  for (const provider of Object.keys(live)) {
    for (const m of (live[provider] || [])) {
      if (!m || !m.id) continue;
      const key = provider + '\u0000' + m.id;
      if (out.has(key)) continue;
      out.set(key, { id: m.id, provider, label: m.label || '' });
    }
  }
  const list = Array.from(out.values()).sort((a, b) =>
    (a.provider + a.id).localeCompare(b.provider + b.id));
  if (!list.length) return null;

  const host = document.createElement('div');
  host.className = 'tool-card__auth-model';
  const label = document.createElement('label');
  label.className = 'tool-card__auth-model-label';
  label.textContent = 'Run this subagent on';
  const sel = document.createElement('select');
  sel.className = 'input tool-card__auth-model-select';
  sel.setAttribute('aria-label', 'Model for this subagent run');
  const chat = state.chat || {};
  const currentKey = (chat.providerId && chat.modelId) ? chat.providerId + '\u0000' + chat.modelId : null;
  const chatItem = currentKey ? out.get(currentKey) : null;
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = chatItem ? '(chat default) ' + chatItem.id : '(chat default)';
  sel.appendChild(defaultOpt);
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m.provider + '\u0000' + m.id;
    opt.textContent = m.id + (m.label && m.label !== m.id ? ' — ' + m.label : '') + ' · ' + m.provider;
    sel.appendChild(opt);
  }
  sel.value = '';
  host.appendChild(label);
  host.appendChild(sel);
  return host;
}

export function authorizationCard(request, projectDir, chatId, refs, resume, state) {
  return new Promise((resolve) => {
    if (!refs.transcript.current) return resolve('deny');
    const card = document.createElement('div');
    card.className = 'tool-card tool-card--authorization';
    if (request.callId) card.dataset.authCallId = request.callId;
    const head = document.createElement('div');
    head.className = 'tool-card__head';
    const chev = document.createElement('span');
    chev.className = 'tool-card__chev';
    chev.setAttribute('aria-hidden', 'true');
    chev.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M9 5.5 15.5 12 9 18.5l1.4 1.4L18.3 12l-7.9-7.9L9 5.5Z"/></svg>';
    const name = document.createElement('div');
    name.className = 'tool-card__name';
    name.textContent = request.tool || 'tool';
    const title = document.createElement('div');
    title.className = 'tool-card__role';
    title.textContent = 'authorization required';
    head.appendChild(chev); head.appendChild(name); head.appendChild(title);
    const detail = document.createElement('pre');
    detail.className = 'tool-card__body';
    detail.textContent = [request.cmd || '', request.projectDir || '', request.timeoutMs ? ('timeout: ' + request.timeoutMs + ' ms') : '']
      .filter(Boolean).join('\n');
    // Per-run model picker for subagent calls. When the user picks a
    // model here, the decision payload carries it so the delegated run
    // executes on that model (this call only; see buildAuthModelPicker).
    const modelPicker = buildAuthModelPicker(state, request);
    const actions = document.createElement('div');
    actions.className = 'tool-card__actions';
    const buttons = [];
    for (const [decision, label, shortcut] of [
      ['allow-once', 'Allow once', '1'],
      ['allow-session', 'Allow session', '2'],
      ['allow-always', 'Always allow', '3'],
      ['deny', 'Deny', '4']
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn' + (decision === 'deny' ? ' btn--danger' : '');
      button.textContent = label + ' [' + shortcut + ']';
      button.setAttribute('aria-label', label + ' (' + shortcut + ')');
      button.dataset.shortcut = shortcut;
      button.addEventListener('click', async () => {
        for (const child of actions.querySelectorAll('button')) child.disabled = true;
        const body = { projectDir, chatId, callId: request.callId, decision };
        // Fold the picked model into the decision payload so the
        // subagent dispatcher can run this call on it. Only when the
        // card showed a picker and the user chose a non-default option.
        if (modelPicker && modelPicker.querySelector('.tool-card__auth-model-select')) {
          const sel = modelPicker.querySelector('.tool-card__auth-model-select');
          const raw = sel && sel.value;
          const sep = raw ? raw.indexOf('\u0000') : -1;
          if (sep > 0 && decision !== 'deny') {
            body.payload = {
              modelOverride: {
                providerId: raw.slice(0, sep),
                modelId: raw.slice(sep + 1)
              }
            };
          }
        }
        const r = await fetchJson('/api/tools/authorization/decision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (r.status !== 200) {
          for (const child of actions.querySelectorAll('button')) child.disabled = false;
          if (refs.status.current) {
            refs.status.current.textContent = 'authorization failed: HTTP ' + r.status;
            refs.status.current.dataset.state = 'error';
          }
          return;
        }
        card.remove();
        if (decision !== 'deny' && typeof resume === 'function') await resume();
        resolve(decision);
      });
      actions.appendChild(button);
      buttons.push(button);
    }
    // Keyboard shortcuts: 1-4 to select, Esc to deny.
    function onKey(e) {
      if (e.key === 'Escape' && buttons[3]) { buttons[3].click(); return; }
      const b = buttons.find((b) => b.dataset.shortcut === e.key);
      if (b) { b.click(); }
    }
    card.addEventListener('keydown', onKey);
    // Auto-focus the first button so keyboard shortcuts work immediately.
    if (buttons[0]) { setTimeout(() => buttons[0].focus(), 100); }
    card.appendChild(head); card.appendChild(detail);
    if (modelPicker) card.appendChild(modelPicker);
    card.appendChild(actions);
    refs.transcript.current.appendChild(card);
    afterTranscriptAppend(refs, true);
  });
}

// askUserCard(request, projectDir, chatId, refs, setChatStatus)
//
// Render an "Ask the user" card. The model has paused the chat to
// ask a structured question with a list of options (2+, no cap);
// the user picks one and may always add a free-form "extra" note
// alongside their pick. The selection + extra text is sent back via
// the /api/tools/authorization/decision endpoint, and the auth gate's
// `wait()` resolves with the payload so the runner can fold both
// into the `tool` message the model sees.
export function askUserCard(request, projectDir, chatId, refs, setChatStatus) {
  if (!refs.transcript.current) return;
  const card = document.createElement('div');
  card.className = 'tool-card tool-card--ask-user';
  card.dataset.toolId = request.callId || ('ask_' + Math.random().toString(36).slice(2, 10));
  if (request.callId) card.dataset.authCallId = request.callId;
  const head = document.createElement('div');
  head.className = 'tool-card__head';
  const chev = document.createElement('span');
  chev.className = 'tool-card__chev';
  chev.setAttribute('aria-hidden', 'true');
  chev.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M9 5.5 15.5 12 9 18.5l1.4 1.4L18.3 12l-7.9-7.9L9 5.5Z"/></svg>';
  head.appendChild(chev);
  const role = document.createElement('span');
  role.className = 'tool-card__role';
  role.textContent = 'the model is asking';
  head.appendChild(role);
  const name = document.createElement('span');
  name.className = 'tool-card__name';
  name.textContent = 'Question';
  head.appendChild(name);
  const pill = document.createElement('span');
  pill.className = 'tool-card__pill tool-card__pill--busy';
  pill.textContent = 'waiting';
  head.appendChild(pill);
  card.appendChild(head);
  const body = document.createElement('div');
  body.className = 'tool-card__body tool-card__ask-body';
  const question = document.createElement('p');
  question.className = 'tool-card__ask-question';
  question.textContent = request.question || '(no question)';
  body.appendChild(question);
  // Quick-answer presets: chips that immediately submit the answer.
  const presets = Array.isArray(request.presets) ? request.presets : [];
  if (presets.length) {
    const presetsHost = document.createElement('div');
    presetsHost.className = 'tool-card__ask-presets';
    for (const p of presets) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tool-card__ask-preset-chip';
      chip.textContent = p;
      chip.addEventListener('click', async () => {
        for (const child of card.querySelectorAll('button')) child.disabled = true;
        const payload = { choice: p, extra: '' };
        const r = await fetchJson('/api/tools/authorization/decision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectDir, chatId, callId: request.callId, decision: 'allow-once', payload })
        });
        if (r.status !== 200) {
          for (const child of card.querySelectorAll('button')) child.disabled = false;
          setChatStatus('ask_user failed: HTTP ' + r.status, 'error');
          return;
        }
        card.remove();
        setChatStatus('answer sent', 'success');
      });
      presetsHost.appendChild(chip);
    }
    body.appendChild(presetsHost);
  }
  const optionsHost = document.createElement('div');
  optionsHost.className = 'tool-card__ask-options';
  body.appendChild(optionsHost);
  const options = Array.isArray(request.options) ? request.options : [];
  const multi = !!request.multiSelect;
  let selectedValues = multi ? new Set() : null;
  let lastTapped = null;
  function refreshSelectedUi() {
    for (const optEl of optionsHost.querySelectorAll('.tool-card__ask-option')) {
      const v = optEl.dataset.value || '';
      const on = multi ? selectedValues.has(v) : (v === (lastTapped && lastTapped.value));
      optEl.classList.toggle('is-selected', !!on);
      optEl.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }
  for (let i = 0; i < options.length; i++) {
    const opt = options[i] || {};
    const optEl = document.createElement('button');
    optEl.type = 'button';
    optEl.className = 'tool-card__ask-option';
    optEl.dataset.value = String(opt.value || '');
    optEl.setAttribute('role', multi ? 'checkbox' : 'radio');
    optEl.setAttribute('aria-checked', 'false');
    const label = document.createElement('span');
    label.className = 'tool-card__ask-option-label';
    label.textContent = opt.label || opt.value || ('option ' + (i + 1));
    optEl.appendChild(label);
    if (opt.description) {
      const desc = document.createElement('span');
      desc.className = 'tool-card__ask-option-desc';
      desc.textContent = opt.description;
      optEl.appendChild(desc);
    }
    optEl.addEventListener('click', () => {
      if (multi) {
        if (selectedValues.has(optEl.dataset.value)) selectedValues.delete(optEl.dataset.value);
        else selectedValues.add(optEl.dataset.value);
      } else {
        lastTapped = { value: optEl.dataset.value, label: opt.label || optEl.dataset.value };
      }
      refreshSelectedUi();
    });
    // Keyboard navigation: Enter/Space to select.
    optEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        optEl.click();
      }
    });
    optionsHost.appendChild(optEl);
  }
  const extraLabel = document.createElement('label');
  extraLabel.className = 'tool-card__ask-extra-label';
  extraLabel.textContent = 'Add an extra answer (always optional)';
  body.appendChild(extraLabel);
  const extra = document.createElement('textarea');
  extra.className = 'input tool-card__ask-extra';
  extra.rows = 2;
  extra.spellcheck = false;
  extra.maxLength = 1000;
  extra.placeholder = 'Add context, a follow-up, or just a note for the model.';
  body.appendChild(extra);
  const actions = document.createElement('div');
  actions.className = 'tool-card__actions';
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn btn--primary';
  submit.textContent = 'Send answer';
  submit.addEventListener('click', async () => {
    const choice = multi
      ? Array.from(selectedValues)
      : (lastTapped ? [lastTapped.value] : []);
    if (!choice.length) {
      // No option selected: treat as a dismiss so the model gets a
      // clean `cancelled: true` result instead of an empty answer.
      for (const child of actions.querySelectorAll('button')) child.disabled = true;
      const r = await fetchJson('/api/tools/authorization/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, chatId, callId: request.callId, decision: 'deny' })
      });
      if (r.status !== 200) {
        for (const child of actions.querySelectorAll('button')) child.disabled = false;
        setChatStatus('ask_user failed: HTTP ' + r.status, 'error');
        return;
      }
      card.remove();
      setChatStatus('question dismissed', 'success');
      return;
    }
    for (const child of actions.querySelectorAll('button')) child.disabled = true;
    const payload = {
      choice: multi ? Array.from(selectedValues) : (lastTapped ? lastTapped.value : ''),
      extra: extra.value || ''
    };
    const r = await fetchJson('/api/tools/authorization/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, chatId, callId: request.callId, decision: 'allow-once', payload })
    });
    if (r.status !== 200) {
      for (const child of actions.querySelectorAll('button')) child.disabled = false;
      setChatStatus('ask_user failed: HTTP ' + r.status, 'error');
      return;
    }
    card.remove();
    setChatStatus('answer sent', 'success');
  });
  actions.appendChild(submit);
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'btn';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', async () => {
    for (const child of actions.querySelectorAll('button')) child.disabled = true;
    const r = await fetchJson('/api/tools/authorization/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, chatId, callId: request.callId, decision: 'deny' })
    });
    if (r.status !== 200) {
      for (const child of actions.querySelectorAll('button')) child.disabled = false;
      setChatStatus('ask_user failed: HTTP ' + r.status, 'error');
      return;
    }
    card.remove();
    setChatStatus('question dismissed', 'success');
  });
  actions.appendChild(dismiss);
  body.appendChild(actions);
  card.appendChild(body);
  refs.transcript.current.appendChild(card);
  afterTranscriptAppend(refs, true);
  // Mobile-first: scroll the card into view and move keyboard focus
  // to the first option so the user can answer with the on-screen
  // keyboard. The `extra` textarea is below the options; tapping
  // it later is one tap away.
  try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* non-fatal */ }
}

// toggleToolGroup(names, next, state, refs, updateChat)
//
// Group-row version of toggleTool: flip every named tool in one
// state update + one PATCH. Same null/[] filter semantics as
// toggleTool — enabling the full catalog collapses back to null.
export async function toggleToolGroup(names, next, state, refs, updateChat) {
  const cur = state.tools || { catalog: [], filter: null };
  const catalog = cur.catalog || [];
  const allNames = catalog.map((t) => t && t.name).filter(Boolean);
  const wanted = new Set((names || []).filter((n) => allNames.includes(n)));
  if (!wanted.size) return;
  let nextFilter;
  if (cur.filter == null) {
    nextFilter = next ? allNames.slice() : allNames.filter((n) => !wanted.has(n));
  } else {
    const set = new Set(cur.filter);
    if (next) for (const n of wanted) set.add(n);
    else for (const n of wanted) set.delete(n);
    nextFilter = set.size === catalog.length ? null : Array.from(set);
  }
  state.tools = { catalog, filter: nextFilter };
  updateToolsCard(refs, state);
  await updateChat({ tools: nextFilter == null ? null : nextFilter });
}

export { buildSetupCard, buildToolsCard };
