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

// buildPresetCard(state)
//
// A popover-style card for selecting an agent preset. Shows the current
// preset name (or "— none —") and a dropdown to pick/change it.
// The preset applies on the next turn (like the tool filter card).
function buildPresetCard(state) {
  const presets = state.presets || [];
  const currentPresetId = state.chat && state.chat.presetId;
  const card = document.createElement('div');
  card.className = 'chat-view__tools-card';
  card.dataset.presetCard = '1';

  const head = document.createElement('div');
  head.className = 'chat-view__tools-card-head';
  const title = document.createElement('span');
  title.className = 'chat-view__tools-card-title';
  title.textContent = 'Preset';
  const note = document.createElement('span');
  note.className = 'chat-view__tools-card-note';
  note.textContent = currentPresetId ? 'tap to change' : 'none';
  head.appendChild(title); head.appendChild(note);
  card.appendChild(head);

  if (!presets.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-view__tools-empty';
    empty.textContent = 'No presets. Create one in Settings → Agent presets.';
    card.appendChild(empty);
    return card;
  }

  const sel = document.createElement('select');
  sel.className = 'input';
  sel.setAttribute('aria-label', 'Agent preset');
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '— none —';
  sel.appendChild(noneOpt);
  for (const p of presets) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.title || p.id;
    if (p.id === currentPresetId) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    if (sel._onChange) sel._onChange(sel.value || null);
  });
  card.appendChild(sel);
  return card;
}

// buildSkillsCard(state)
//
// A card listing discovered skills with per-skill toggle checkboxes.
// The chat's selectedSkills (from the preset or direct) control which
// skills are injected into the upstream context.
function buildSkillsCard(state) {
  const discoveredSkills = state.discoveredSkills || [];
  const selectedSkills = state.selectedSkills || null; // null = all
  const card = document.createElement('div');
  card.className = 'chat-view__tools-card';
  card.dataset.skillsCard = '1';

  const head = document.createElement('div');
  head.className = 'chat-view__tools-card-head';
  const title = document.createElement('span');
  title.className = 'chat-view__tools-card-title';
  title.textContent = 'Skills';
  const note = document.createElement('span');
  note.className = 'chat-view__tools-card-note';
  note.textContent = selectedSkills ? selectedSkills.length + ' selected' : 'all';
  head.appendChild(title); head.appendChild(note);
  card.appendChild(head);

  if (!discoveredSkills.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-view__tools-empty';
    empty.textContent = 'No skills discovered. Add .agents/skills/<name>/SKILL.md files.';
    card.appendChild(empty);
    return card;
  }

  const list = document.createElement('div');
  list.className = 'chat-view__skills-list';

  // "All skills" toggle at the top
  const allRow = document.createElement('label');
  allRow.className = 'checkbox-row';
  allRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:0.9rem;margin-bottom:4px;';
  const allCheckbox = document.createElement('input');
  allCheckbox.type = 'checkbox';
  allCheckbox.checked = !selectedSkills;
  allCheckbox.addEventListener('change', () => {
    if (allCheckbox.checked) {
      // Select all = clear the chat's selectedSkills (null = all)
      if (list._onSkillChange) list._onSkillChange(null);
    }
  });
  allRow.appendChild(allCheckbox);
  const allLabel = document.createElement('span');
  allLabel.textContent = 'All skills';
  allRow.appendChild(allLabel);
  list.appendChild(allRow);

  for (const s of discoveredSkills) {
    const row = document.createElement('label');
    row.className = 'checkbox-row';
    row.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:0.9rem;padding-left:12px;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedSkills ? selectedSkills.includes(s.name) : true;
    cb.addEventListener('change', () => {
      if (list._onSkillChange) {
        // Collect all checked names
        const checked = [];
        for (const r of list.querySelectorAll('.checkbox-row')) {
          const inp = r.querySelector('input[type="checkbox"]');
          const labelSpan = r.querySelector('span');
          if (inp && inp.checked && labelSpan && labelSpan.textContent !== 'All skills') {
            checked.push(labelSpan.textContent);
          }
        }
        list._onSkillChange(checked.length === discoveredSkills.length ? null : checked);
      }
    });
    row.appendChild(cb);
    const labelSpan = document.createElement('span');
    labelSpan.textContent = s.name;
    row.appendChild(labelSpan);
    list.appendChild(row);
  }

  card.appendChild(list);
  return card;
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
    else if (g.id === 'ask_user') g.control = makeSegVNode('ask_user', g.id);
    else if (g.id === 'files') g.control = makeSegVNode('file', g.id);
  }

  // Render the Preact ToolTree into a container div.
  const treeHost = document.createElement('div');
  treeHost.className = 'chat-view__tools-tree';

  function onToggleGroup(groupId, checked) {
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

export function mountPresetCard(refs, state) {
  if (!refs.transcript.current) return;
  const existing = refs.transcript.current.querySelector('[data-preset-card="1"]');
  if (existing) existing.remove();
  const card = buildPresetCard(state);
  refs.presetCard.current = card;
  // Insert after the tools card or system prompt.
  const toolsCard = refs.transcript.current.querySelector('[data-tools-card="1"]');
  const sysMsg = refs.transcript.current.querySelector('[data-sys-prompt="1"]');
  if (toolsCard && toolsCard.parentNode === refs.transcript.current) {
    refs.transcript.current.insertBefore(card, toolsCard.nextSibling);
  } else if (sysMsg && sysMsg.parentNode === refs.transcript.current) {
    refs.transcript.current.insertBefore(card, sysMsg.nextSibling);
  } else {
    refs.transcript.current.appendChild(card);
  }
}

export function updatePresetCard(refs, state) {
  if (!refs.presetCard.current || !refs.presetCard.current.parentNode) return;
  const fresh = buildPresetCard(state);
  refs.presetCard.current.parentNode.replaceChild(fresh, refs.presetCard.current);
  refs.presetCard.current = fresh;
}

export function mountSkillsCard(refs, state) {
  if (!refs.transcript.current) return;
  const existing = refs.transcript.current.querySelector('[data-skills-card="1"]');
  if (existing) existing.remove();
  const card = buildSkillsCard(state);
  refs.skillsCard.current = card;
  // Insert after the preset card or tools card.
  const presetCard = refs.transcript.current.querySelector('[data-preset-card="1"]');
  const toolsCard = refs.transcript.current.querySelector('[data-tools-card="1"]');
  const target = presetCard || toolsCard;
  const sysMsg = refs.transcript.current.querySelector('[data-sys-prompt="1"]');
  if (target && target.parentNode === refs.transcript.current) {
    refs.transcript.current.insertBefore(card, target.nextSibling);
  } else if (sysMsg && sysMsg.parentNode === refs.transcript.current) {
    refs.transcript.current.insertBefore(card, sysMsg.nextSibling);
  } else {
    refs.transcript.current.appendChild(card);
  }
}

export function updateSkillsCard(refs, state) {
  if (!refs.skillsCard.current || !refs.skillsCard.current.parentNode) return;
  const fresh = buildSkillsCard(state);
  refs.skillsCard.current.parentNode.replaceChild(fresh, refs.skillsCard.current);
  refs.skillsCard.current = fresh;
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
function buildAgentFilesCard(state) {
  const af = state.agentFiles || { files: [], enabled: true, explicit: false };
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
  note.textContent = af.explicit
    ? (af.enabled ? 'on — applies next turn' : 'off — applies next turn')
    : (af.enabled ? 'on (default) — tap to disable' : 'off (default) — tap to enable');
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

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'chat-view__agent-files-toggle';
  toggle.setAttribute('aria-pressed', af.enabled ? 'true' : 'false');
  toggle.textContent = af.enabled ? 'Disable' : 'Enable';
  toggle.addEventListener('click', () => state._toggleAgentFiles && state._toggleAgentFiles(!af.enabled));
  card.appendChild(toggle);

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
export function authorizationCard(request, projectDir, chatId, refs, resume) {
  return new Promise((resolve) => {
    if (!refs.transcript.current) return resolve('deny');
    const card = document.createElement('div');
    card.className = 'tool-card tool-card--authorization';
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
    const actions = document.createElement('div');
    actions.className = 'tool-card__actions';
    for (const [decision, label] of [
      ['allow-once', 'Allow once'],
      ['allow-session', 'Allow for session'],
      ['allow-always', 'Always allow'],
      ['deny', 'Deny']
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn' + (decision === 'deny' ? ' btn--danger' : '');
      button.textContent = label;
      button.addEventListener('click', async () => {
        for (const child of actions.querySelectorAll('button')) child.disabled = true;
        const r = await fetchJson('/api/tools/authorization/decision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectDir, chatId, callId: request.callId, decision })
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
    }
    card.appendChild(head); card.appendChild(detail); card.appendChild(actions);
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

export { buildSetupCard, buildToolsCard, buildPresetCard, buildSkillsCard, mountPresetCard, updatePresetCard, mountSkillsCard, updateSkillsCard };
