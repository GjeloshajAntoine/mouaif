// mouaif web — Chat cards (setup, tools, MCP, authorization, ask_user)
//
// All the in-transcript cards that aren't plain chat bubbles. Most
// of the work is imperative DOM construction so the rest of the
// transcript (which is also imperative) can stay homogeneous.

import { fetchJson } from '../../api.js';
import { afterTranscriptAppend } from './scroll.js';
import { h, render } from 'preact';
import { ToolTree, buildToolGroups } from '../ToolTree.jsx';
import { McpAuthSeg, ToolAuthSeg, TOOL_MODE_CHOICES, ASK_USER_MODE_CHOICES } from '../settings/toolAuth.js';
import { AuthModelPicker } from '../AuthModelPicker.jsx';

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
// Which rows carry this chat's own Off/Ask/Allow override, so the scope of
// the segments is visible at a glance (decisions §17).
const chatAuth = state._chatAuthOverrides || null;
if (chatAuth && (Object.keys(chatAuth.native || {}).length || chatAuth.mcp)) {
const scoped = document.createElement('span');
scoped.className = 'chat-view__tools-card-scope';
scoped.textContent = 'Off / Ask / Allow apply to this chat only';
head.appendChild(scoped);
}
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

  // Seed each MCP group's busy flag from the hook's in-flight server id.
  // A start can be running across an in-place rebuild (a toggle elsewhere in
  // the tree, a catalog refresh), and the flag must survive that rebuild or
  // the row repaints as idle mid-start and the control becomes tappable again.
  const busyServerId = state._mcpStartBusyServerId;
  if (busyServerId) {
    for (const g of groups) {
      if (g && g.serverId === busyServerId) g.reloadBusy = true;
    }
  }

  // Inject the shared Off/Ask/Allow authorization control on each known
  // group row, exactly like the project settings page. Every native tool
  // — subagent included — renders the same ToolAuthSeg component from
  // ../settings/toolAuth.js, so no row can drift from the others.
  const auth = state.toolAuth || {};
  const toolByGroup = {
    shell: 'shell',
    subagent: 'subagent',
    task: 'task',
    ask_user: 'ask_user',
    report_progress: 'report_progress',
    webpreview: 'webpreview',
    restart_app: 'restart_app',
    image_gen: 'image_gen',
    files: 'file'
  };
  for (const g of groups) {
    const toolName = toolByGroup[g.id];
    if (!toolName) continue;
    const cur = auth[toolName] || { mode: 'ask' };
    g.control = h(ToolAuthSeg, {
      tool: toolName,
      name: toolName,
      mode: cur.mode,
      allowlist: cur.allowlist,
      modes: toolName === 'ask_user' ? ASK_USER_MODE_CHOICES : TOOL_MODE_CHOICES,
      namePrefix: 'chat-auth',
      // In the chat, a pick means "use this mode FOR THIS CHAT": the reset
      // clears the chat's own override first, so the stored value always
      // reflects the tap and a stale chat override can never shadow the
      // project's mode afterwards (decisions §17).
      onClear: () => {
      if (state._saveToolAuth) state._saveToolAuth(toolName, null, []);
      },
      onPick: (mode, allowlist) => {
      if (state._saveToolAuth) state._saveToolAuth(toolName, mode, allowlist);
      }
    });
  }

  // MCP authorization — one Off/Ask/Allow segment per MCP server group
  // (the per-server override, showing the effective mode). Writes go
  // through state._saveMcpAuth so the card re-renders in place.
  const mcpAuth = state.mcpAuth || { mode: 'ask', allowlist: [], servers: {}, tools: {} };
  for (const g of groups) {
    if (!g.id.startsWith('mcp-')) continue;
    const slug = g.id.slice(4);
    g.control = h(McpAuthSeg, {
      name: g.name,
      slug,
      servers: mcpAuth.servers,
      shared: mcpAuth,
      namePrefix: 'chat-mcp',
      // Same as the native rows: a tap pins the mode for this chat; the
      // reset drops the chat's own override so the server falls back to
      // the project's `.mcp.json` value.
      onClear: () => {
      if (state._saveMcpAuth) state._saveMcpAuth({ servers: { [slug]: null } });
      },
      onSave: (patch) => state._saveMcpAuth && state._saveMcpAuth(patch)
    });
  }

  // Render the Preact ToolTree into a container div.
  const treeHost = document.createElement('div');
  treeHost.className = 'chat-view__tools-tree';
  // Preserve which groups the user has expanded across the in-place
  // rebuild that runs on every toggle. Without this, a remount with
  // `collapsedByDefault` snaps every expanded section shut the moment
  // a single checkbox is flipped. The set lives on `state` (not a
  // local var) so it survives the rebuild triggered by the toggle.
  const collapsed = state._toolTreeCollapsed || null;

  function onToggleGroup(groupId, checked) {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    if (state._toggleToolGroup) state._toggleToolGroup(group.tools.map((tool) => tool.id), checked);
  }

  function onToggleTool(groupId, toolId, checked) {
    if (state._toggleTool) state._toggleTool(toolId, checked);
  }

  // Persist the live collapse state on `state` so the next in-place
  // rebuild seeds from it instead of collapsing every section again.
  const captureCollapsed = (set) => { state._toolTreeCollapsed = set; };

  // Which MCP server start is in flight, read from `state` rather than kept
  // only on the group object. `groups` is rebuilt from scratch by every
  // toggle/refresh, so setting `group.reloadBusy` alone was discarded the
  // moment the rebuild ran: the row repainted as idle, the spinner never
  // appeared and the control stayed tappable, letting a second start fire for
  // the same server. The hook records the in-flight server id (it already
  // tracks `mcpStartBusy`), and the render below merges it into each group.
  function markGroupBusy(serverId, busy) {
    if (!serverId) return;
    for (const g of groups) {
      if (g && g.serverId === serverId) g.reloadBusy = busy;
    }
  }
  async function onReloadServer(group) {
    // Start the stopped-but-enabled MCP server via the lifecycle
    // endpoint, then refresh the tree so its live tools appear. The
    // start + refresh dance lives on the hook (state._startMcpServer)
    // so the tools popup's twin "…" control runs the same code — the
    // popup used to render ToolTree with no handler at all, which made
    // its control a no-op.
    const id = group && group.serverId;
    if (!id || !state._startMcpServer) return;
    // Re-entrancy guard: ignore a second tap while this server is starting.
    if (state._mcpStartBusyServerId === id) return;
    markGroupBusy(id, true);
    if (state._updateToolsCard) state._updateToolsCard();
    try {
      await state._startMcpServer(id);
    } finally {
      markGroupBusy(id, false);
      if (state._updateToolsCard) state._updateToolsCard();
    }
  }
  render(h(ToolTree, {
    groups,
    onToggleGroup,
    onToggleTool,
    collapsedByDefault: true,
    initialCollapsed: collapsed,
    onCollapseChange: captureCollapsed,
    onReloadServer
  }), treeHost);
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
// (no explicit choice) is ON regardless of the prompt-size profile.
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
    const row = document.createElement('label');
    row.className = 'chat-view__agent-files-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'checkbox checkbox--sm';
    checkbox.checked = !!af.enabled;
    checkbox.disabled = !!af.projectLocked;
    checkbox.setAttribute('aria-label', 'Use agent file ' + name);
    checkbox.addEventListener('change', () => state._toggleAgentFiles && state._toggleAgentFiles(checkbox.checked));
    const label = document.createElement('span');
    label.className = 'chat-view__agent-files-name';
    label.textContent = name;
    row.appendChild(checkbox);
    row.appendChild(label);
    list.appendChild(row);
  }
  card.appendChild(list);

  return card;
}

// buildSkillsCard(state)
//
// Shows discovered Agent Skills below the tools/agent-files cards.
// Each row is that skill's own switch for this chat: unchecking one
// leaves the others alone and stores the id in the chat's
// `disabledSkills` list. A chat whose family toggle is off shows every
// row unchecked; checking any row turns the chat's skills back on with
// only that skill selected (see toggleSkill below).
function buildSkillsCard(state) {
const sk = state.skills || { items: [], enabled: true, projectLocked: false };
const card = document.createElement('div');
card.className = 'chat-view__skills-card';
card.dataset.skillsCard = '1';
const head = document.createElement('div');
head.className = 'chat-view__skills-head';
const title = document.createElement('span');
title.className = 'chat-view__skills-title';
title.textContent = 'Skills';
const note = document.createElement('span');
note.className = 'chat-view__skills-note';
if (sk.projectLocked) {
note.textContent = 'off (locked by project setting) — enable in Settings → Project';
} else {
note.textContent = sk.enabled ? 'on — tap a skill to scope it' : 'off — tap a skill to enable';
}
head.appendChild(title); head.appendChild(note);
card.appendChild(head);
if (!sk.items.length) {
const empty = document.createElement('div');
empty.className = 'chat-view__skills-empty';
empty.textContent = 'No skills found in .agents/skills.';
card.appendChild(empty);
return card;
}
const list = document.createElement('div');
list.className = 'chat-view__skills-list';
for (const skill of sk.items) {
const disabledByProject = !!skill.disabled;
const disabledForChat = !!skill.chatDisabled;
const checked = !!(sk.enabled && !disabledByProject && !disabledForChat);
const disabled = !!sk.projectLocked || disabledByProject;
const row = document.createElement('label');
row.className = 'chat-view__skills-row';
const checkbox = document.createElement('input');
checkbox.type = 'checkbox';
checkbox.className = 'checkbox checkbox--sm';
checkbox.checked = checked;
checkbox.disabled = disabled;
checkbox.setAttribute('aria-label', 'Use skill ' + (skill.name || skill.id));
checkbox.addEventListener('change', () => {
if (state._toggleSkill) state._toggleSkill(skill.id, checkbox.checked);
});
const body = document.createElement('span');
body.className = 'chat-view__skills-body';
const name = document.createElement('span');
name.className = 'chat-view__skills-name';
name.textContent = skill.name || skill.id;
body.appendChild(name);
if (skill.description) {
const desc = document.createElement('span');
desc.className = 'chat-view__skills-desc';
desc.textContent = skill.description;
body.appendChild(desc);
}
if (disabledByProject) {
const reason = document.createElement('span');
reason.className = 'chat-view__skills-reason';
reason.textContent = 'Disabled in Settings → Project';
body.appendChild(reason);
}
row.appendChild(checkbox);
row.appendChild(body);
list.appendChild(row);
}
card.appendChild(list);
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

// mountSkillsCard(refs, state)
//
// Insert the skills card below agent files (or below tools/system if
// those cards are absent).
export function mountSkillsCard(refs, state) {
  if (!refs.transcript.current) return;
  const existing = refs.transcript.current.querySelector('[data-skills-card="1"]');
  if (existing) existing.remove();
  const card = buildSkillsCard(state);
  refs.skillsCard.current = card;
  const agentFilesCard = refs.transcript.current.querySelector('[data-agent-files-card="1"]');
  const toolsCard = refs.transcript.current.querySelector('[data-tools-card="1"]');
  const sysMsg = refs.transcript.current.querySelector('[data-sys-prompt="1"]');
  const empty = refs.transcript.current.querySelector('.chat-view__empty');
  if (agentFilesCard && agentFilesCard.parentNode === refs.transcript.current) {
    refs.transcript.current.insertBefore(card, agentFilesCard.nextSibling);
  } else if (toolsCard && toolsCard.parentNode === refs.transcript.current) {
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

// updateSkillsCard(refs, state)
//
// Re-render the skills card in place after a chat-level toggle.
export function updateSkillsCard(refs, state) {
  if (!refs.skillsCard.current || !refs.skillsCard.current.parentNode) return;
  const fresh = buildSkillsCard(state);
  refs.skillsCard.current.parentNode.replaceChild(fresh, refs.skillsCard.current);
  refs.skillsCard.current = fresh;
}

// toggleAgentFiles(next, state, refs, updateChat, refreshSysPrompt)
//
// Flip the per-chat agent-files toggle and persist it. The first
// time the user interacts we write an explicit boolean; after that
// the chat carries the user's choice until they reset it (by
// switching to the profile default, which we do not expose in the
// UI — the toggle is sticky). After the PATCH lands we re-fetch the
// resolved system prompt so the transcript card reflects the change
// immediately (agent files are part of the injected system context).
export async function toggleAgentFiles(next, state, refs, updateChat, refreshSysPrompt) {
  const cur = state.agentFiles || { files: [], enabled: true, explicit: false };
  state.agentFiles = { files: cur.files, enabled: next, explicit: true, projectLocked: cur.projectLocked };
  updateAgentFilesCard(refs, state);
  await updateChat({ agentFiles: next });
  if (typeof refreshSysPrompt === 'function') await refreshSysPrompt();
}

// toggleSkills(next, state, refs, updateChat, refreshSysPrompt)
//
// Flip the chat-level skills catalog toggle and persist it — the
// all-skills-on / all-skills-off shortcut used by the composer popup's
// group row. Turning the family on clears this chat's per-skill
// opt-outs, because "on" here means every available skill; individual
// switches go through toggleSkill below.
export async function toggleSkills(next, state, refs, updateChat, refreshSysPrompt) {
  const cur = state.skills || { items: [], enabled: true, projectLocked: false };
  const items = Array.isArray(cur.items) ? cur.items : [];
  state.skills = Object.assign({}, cur, {
    enabled: next,
    items: items.map((s) => Object.assign({}, s, {
      chatDisabled: s.disabled ? !!s.chatDisabled : !next
    }))
  });
  updateSkillsCard(refs, state);
  // "off" also lists every selectable skill as a per-chat opt-out: a prompt
  // preset can force the family flag back on for a turn, and the individual
  // opt-outs are what keep the catalog empty in that case.
  const selectable = items.filter((s) => !s.disabled);
  await updateChat({
    skills: next,
    disabledSkills: next || !selectable.length ? null : selectable.map((s) => s.id)
  });
  if (typeof refreshSysPrompt === 'function') await refreshSysPrompt();
}

// toggleSkill(id, next, state, refs, updateChat, refreshSysPrompt)
//
// Flip ONE skill for this chat and persist the resulting opt-out list on
// the chat record (`disabledSkills`). The family toggle is materialized
// on the way: a chat that had skills switched off shows nothing checked,
// so turning a single skill on writes the family flag on AND every other
// skill into `disabledSkills`. Without that step the first tap on one row
// would bring the whole catalog back — the behaviour this replaced.
export async function toggleSkill(id, next, state, refs, updateChat, refreshSysPrompt) {
  const cur = state.skills || { items: [], enabled: true, projectLocked: false };
  const items = Array.isArray(cur.items) ? cur.items : [];
  // Project-disabled skills are not part of the choice: they stay off
  // however the user moves the rows, and are never written as a per-chat
  // opt-out (that would leak a project decision into the chat record).
  const selectable = items.filter((s) => !s.disabled);
  const base = cur.enabled
    ? new Set(selectable.filter((s) => !s.chatDisabled).map((s) => s.id))
    : new Set();
  if (next) base.add(id);
  else base.delete(id);
  const chatDisabled = selectable.filter((s) => !base.has(s.id)).map((s) => s.id);
  // Nothing left on is the same state as the family toggle off, and the
  // family flag is the one thing the server reads for "inject no catalog".
  const enabled = base.size > 0;
  const patch = {
    skills: enabled,
    // Same reasoning as toggleSkills: when the user turns the last skill off
    // the opt-out list has to survive, so a prompt preset that forces skills
    // on cannot resurrect a catalog the user switched off row by row.
    disabledSkills: enabled ? (chatDisabled.length ? chatDisabled : null) : chatDisabled
  };
  state.skills = Object.assign({}, cur, {
    enabled,
    items: items.map((s) => Object.assign({}, s, {
      chatDisabled: s.disabled ? !!s.chatDisabled : !base.has(s.id)
    }))
  });
  updateSkillsCard(refs, state);
  await updateChat(patch);
  if (typeof refreshSysPrompt === 'function') await refreshSysPrompt();
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

// authorizationCard(request, projectDir, chatId, refs, resume)
//
// Render a 4-button authorization card on the transcript and
// resolve with the user's decision. The chat's runner pauses until
// the user picks; `resume()` is called for any non-deny decision so
// the original tool call can be retried with the same callId.
// removePendingAuthorizationCards(refs) — drop every prompt card the
// chat is parked on: the generic authorization card AND the ask_user
// question card. Both are mounted outside the message flow, so a
// cancel that only removed one kind left the other standing: after
// "Stop" the answered-looking question stayed in the transcript, and
// the next turn (or the same call's own tool_call card) rendered it a
// second time beside the new one.
export function removePendingAuthorizationCards(refs) {
  if (!refs || !refs.transcript || !refs.transcript.current) return;
  const selector = '.tool-card--authorization[data-auth-call-id], .tool-card--ask-user[data-auth-call-id]';
  for (const card of refs.transcript.current.querySelectorAll(selector)) {
    card.remove();
  }
}

// buildAuthModelPicker(state, request, projectDir) -> HTMLElement | null
//
// The authorization card's per-run model picker. Only shown for
// `subagent` calls: while approving the delegated run the user can
// pick which model executes it (this call only — nothing is
// persisted on the chat or an agent). The list is the same union
// the main chat model picker shows: project-defined models plus the
// per-provider live catalog, deduped by (provider, id). The chat's
// current model is preselected. The control is the same trigger +
// modal the chat top bar uses (see ModelPickerField), including its
// Pinned and Recent bookmark sections.
// Returns null when there is nothing to pick from.
function buildAuthModelPicker(state, request, projectDir) {
  if (!state || request.tool !== 'subagent') return null;
  const out = new Map();
  for (const m of (state.models || [])) {
    if (!m || !m.id || !m.provider) continue;
    out.set(m.provider + '\u0000' + m.id, { id: m.id, provider: m.provider, label: m.label || '', thinking: m.thinking || undefined });
  }
  const live = state.liveByProvider || {};
  for (const provider of Object.keys(live)) {
    for (const m of (live[provider] || [])) {
      if (!m || !m.id) continue;
      const key = provider + '\u0000' + m.id;
      if (out.has(key)) continue;
      out.set(key, { id: m.id, provider, label: m.label || '', thinking: m.thinking || undefined });
    }
  }
  const list = Array.from(out.values()).sort((a, b) =>
    (a.provider + a.id).localeCompare(b.provider + b.id));
  if (!list.length) return null;

  const chat = state.chat || {};
  let selected = (chat.providerId && chat.modelId)
    ? { providerId: chat.providerId, modelId: chat.modelId }
    : null;

const host = document.createElement('div');
host.className = 'tool-card__auth-model';

  // The picker holds its own selection; expose it for the decision
  // payload. Picking a model sets the override; tapping the
  // "inherit" row clears it back to the chat default / agent pin.
const mpHost = document.createElement('div');
mpHost.className = 'tool-card__auth-model-field';
render(h(AuthModelPicker, {
models: list,
initialValue: selected,
projectDir,
onChange: (next) => { selected = next; }
}), mpHost);
host.appendChild(mpHost);
host._selected = () => selected;
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
    const modelPicker = buildAuthModelPicker(state, request, projectDir);
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
        // Fold the picked model + thinking level into the decision
        // payload so the subagent dispatcher can run this call on them.
        // Only when the card showed a picker and the user chose a
        // non-default option.
        const chosen = modelPicker && typeof modelPicker._selected === 'function' ? modelPicker._selected() : null;
        if (chosen && decision !== 'deny') {
          const payload = {};
          if (chosen.modelOverride && chosen.modelOverride.providerId && chosen.modelOverride.modelId) {
            payload.modelOverride = {
              providerId: chosen.modelOverride.providerId,
              modelId: chosen.modelOverride.modelId
            };
          }
          if (typeof chosen.thinkingLevel === 'string' && chosen.thinkingLevel) {
            payload.thinkingLevel = chosen.thinkingLevel;
          }
          if (Object.keys(payload).length) body.payload = payload;
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
//
// Scoped to the card's own controls. The card also hosts the per-run subagent
// model picker, whose search box mounts in place inside it, so typing "1"-"4"
// there used to click a decision button — "4" is Deny, which answered a live
// authorization prompt with a keystroke meant for the model filter. Keys that
// originate in a text field belong to that field.
function isTypingTarget(el) {
if (!el) return false;
const tag = String(el.tagName || '').toLowerCase();
return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}
function onKey(e) {
// A key that originated in a text field belongs to that field: neither the
// digits nor Escape may resolve the prompt from under the user's cursor.
if (isTypingTarget(e.target)) return;
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
    // The card must be visible the moment it lands — a question or
    // authorization prompt that mounts below the fold is the same as
    // not mounting it at all.
    try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* non-fatal */ }
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
