// mouaif web — Chat cards (setup, tools, MCP, authorization, ask_user)
//
// All the in-transcript cards that aren't plain chat bubbles. Most
// of the work is imperative DOM construction so the rest of the
// transcript (which is also imperative) can stay homogeneous.

import { fetchJson } from '../../api.js';
import { afterTranscriptAppend } from './scroll.js';
import { h, render } from 'preact';
import { ToolTree, buildToolGroups, groupToolNames, childToolName, toolPermission } from '../ToolTree.jsx';
import { McpAuthSeg, ToolAuthSeg, TOOL_MODE_CHOICES, ASK_USER_MODE_CHOICES } from '../settings/toolAuth.js';
import { AuthModelPicker } from '../AuthModelPicker.jsx';
import { placeHeaderCard, HEADER_CARD_ORDER } from './headerCards.js';
import { saveSkillSelection } from './skillState.js';

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
    { id: 'extensive',  label: 'Extensive — full tools + best-practice guidance' },
    { id: 'chat',       label: 'Chat — empty prompt' }
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
? 'all permitted tools — tap to change'
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
    state.usedTools || new Set(),
    { native: state.toolAuth || {}, mcp: state.mcpAuth || {} }
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
  // Last start failure per server (set by state._reloadMcpServer).
  const startErrors = state._mcpStartErrors || {};
  for (const g of groups) {
    if (g && g.serverId && startErrors[g.serverId]) g.startError = startErrors[g.serverId];
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
    // The single `mouaif` family backs both of the tool's rows ("Chats" and
    // "mouaif"). Each row gets its own segment, but either one writes the
    // same chat-scoped gate, so the two always render the same mode.
    mouaif: 'mouaif',
    'mouaif-settings': 'mouaif',
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
      namePrefix: 'chat-auth-' + g.id,
      // A tap writes THIS CHAT's mode in one request. The endpoint
      // replaces the entry, so the stored value always equals the tap;
      // a separate "clear" write is both redundant and harmful — the two
      // un-awaited responses raced, and a slow clear reverted the pick.
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
      // One write per tap (see the native rows above): the clear-then-write
      // pair raced, and a slow clear reverted the segment.
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
    // The filter stores tool NAMES; a category's children share one tool and
    // key their rows by action (see groupToolNames).
    if (state._toggleToolGroup) state._toggleToolGroup(groupToolNames(group), checked);
  }

  function onToggleTool(groupId, toolId, checked) {
    // A category child row writes the tool it belongs to, not its tree id
    // (`mouaif:list`) — toggleToolGroup drops names it does not know, so the
    // id made the tap a silent no-op (see childToolName).
    const group = groups.find((g) => g.id === groupId);
    if (state._toggleTool) state._toggleTool(childToolName(group, toolId), checked);
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
  // Slot 2 of the header block: below the system-prompt message and above
  // agent files + skills, whichever of those are mounted. Placed by slot
  // rather than by looking up a sibling anchor, because every anchor a
  // mounter could look for may legitimately be absent (the system-prompt row
  // is removed and re-inserted on refresh, the empty state goes with the
  // first message) — and the old appendChild() fallback for "no anchor
  // found" dropped the card below the whole conversation.
  placeHeaderCard(refs.transcript.current, card, HEADER_CARD_ORDER.tools);
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
  // Slot 3: below the tools card, above skills. See mountToolsCard for why the
  // sibling-anchor lookup was replaced by an explicit slot.
  placeHeaderCard(refs.transcript.current, card, HEADER_CARD_ORDER.agentFiles);
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
  // Slot 4: the last header card, below agent files and above the message
  // rows. See mountToolsCard for why the sibling-anchor lookup was replaced
  // by an explicit slot.
  placeHeaderCard(refs.transcript.current, card, HEADER_CARD_ORDER.skills);
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

function notifySkillSelection(state, refs) {
  updateSkillsCard(refs, state);
  if (typeof state._onSkillsChanged === 'function') state._onSkillsChanged();
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
  if (cur.projectLocked || !items.some((s) => !s.disabled)) return false;
  state.skills = Object.assign({}, cur, {
    enabled: next,
    items: items.map((s) => Object.assign({}, s, {
      chatDisabled: s.disabled ? !!s.chatDisabled : !next
    }))
  });
  notifySkillSelection(state, refs);
  // "off" also lists every selectable skill as a per-chat opt-out: a prompt
  // preset can force the family flag back on for a turn, and the individual
  // opt-outs are what keep the catalog empty in that case.
  const selectable = items.filter((s) => !s.disabled);
  return saveSkillSelection({
    skills: next,
    disabledSkills: next || !selectable.length ? null : selectable.map((s) => s.id)
  }, cur, state, () => notifySkillSelection(state, refs), updateChat, refreshSysPrompt);
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
  if (cur.projectLocked || !selectable.some((s) => s.id === id)) return false;
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
  notifySkillSelection(state, refs);
  return saveSkillSelection(patch, cur, state, () => notifySkillSelection(state, refs), updateChat, refreshSysPrompt);
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
  return toggleToolGroup([name], next, state, refs, updateChat);
}

// knownToolNames(state) -> string[]
//
// Every tool name the tree can show a checkbox for: the live catalog
// plus the cached tool list of each MCP server (a stopped or
// still-starting server has no live catalog entries yet, but
// buildToolGroups still renders its rows from `server.tools`). The
// "all on" snapshot and the collapse-back-to-null check must use this
// set, not the live catalog alone: snapshotting only the live catalog
// while a server was still starting silently unchecked every one of
// its tools on the first tap, and toggling one of its rows was a no-op.
function knownToolNames(state) {
  const t = state.tools || { catalog: [], filter: null };
  const names = new Set();
  for (const tool of (t.catalog || [])) {
    if (!tool || !tool.name) continue;
    if (tool.name === 'mouaif') {
      for (const group of buildToolGroups([tool], [], null)) for (const name of groupToolNames(group)) names.add(name);
    } else names.add(tool.name);
  }
  for (const server of (state.mcpServers || [])) {
    if (!server || !server.id || !Array.isArray(server.tools)) continue;
    const slug = server.slug || server.id;
    // Same fallback rule as buildToolGroups: the cached list only stands
    // in when the server has no live entries, so a stale cached name that
    // has no row can never block the collapse back to `null`.
    if ((t.catalog || []).some((x) => x && x.kind === 'mcp' && x.source === slug)) continue;
    const prefix = 'mcp__' + slug + '__';
    for (const entry of server.tools) {
      const n = typeof entry === 'string' ? entry : (entry && entry.name);
      if (n) names.add(n.startsWith(prefix) ? n : prefix + n);
    }
  }
  return Array.from(names);
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
    // A static shield, not the collapse chevron. The card cannot be folded
    // (its body holds the decision the run is waiting on), and a
    // closed-looking chevron that ignores taps reads as broken. Same
    // treatment as the ask_user card's question icon.
    const icon = document.createElement('span');
    icon.className = 'tool-card__auth-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3Zm-1 5h2v6h-2V7Zm0 8h2v2h-2v-2Z"/></svg>';
    const name = document.createElement('div');
    name.className = 'tool-card__name';
    name.textContent = request.tool || 'tool';
    const title = document.createElement('div');
    title.className = 'tool-card__role';
    title.textContent = 'authorization required';
    head.appendChild(icon); head.appendChild(name); head.appendChild(title);
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
  // A static icon, not the collapse chevron: this card has no toggle,
  // and a chevron that does nothing on tap reads as broken.
  const icon = document.createElement('span');
  icon.className = 'tool-card__ask-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 16.2a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Zm1.3-5.1v.6h-2.5v-.9c0-1.4.8-2 1.6-2.6.7-.5 1.2-.9 1.2-1.6 0-.8-.7-1.4-1.6-1.4-1 0-1.7.6-1.8 1.6H7.7C7.8 6.6 9.6 5 12 5c2.4 0 4.2 1.4 4.2 3.5 0 1.5-.9 2.3-1.8 3-.6.4-1.1.8-1.1 1.6Z"/></svg>';
  head.appendChild(icon);
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
      chip.addEventListener('click', () => onDecision('allow-once', { choice: p, extra: '' }));
      presetsHost.appendChild(chip);
    }
    body.appendChild(presetsHost);
  }
  const options = Array.isArray(request.options) ? request.options : [];
  const multi = !!request.multiSelect;
  const optionsHost = document.createElement('div');
  optionsHost.className = 'tool-card__ask-options' + (multi ? ' tool-card__ask-options--multi' : '');
  optionsHost.setAttribute('role', multi ? 'group' : 'radiogroup');
  optionsHost.setAttribute('aria-label', request.question || 'Options');
  if (multi) {
    const hint = document.createElement('span');
    hint.className = 'tool-card__ask-hint';
    hint.textContent = 'Pick one or more';
    body.appendChild(hint);
  }
  body.appendChild(optionsHost);
  let selectedValues = multi ? new Set() : null;
  let lastTapped = null;
  // Declared below; refreshSelectedUi() also relabels the submit button.
  let submit = null;
  let extra = null;
  let pending = false;
  const error = document.createElement('p');
  error.className = 'tool-card__ask-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  function hasChoice() { return multi ? selectedValues.size > 0 : !!lastTapped; }
  function refreshSubmitUi() {
    if (!submit) return;
    const note = !!(extra && extra.value.trim());
    submit.textContent = pending ? 'Sending…' : (hasChoice() ? 'Send answer' : (note ? 'Send note' : 'Pick an option'));
    submit.disabled = pending || (!hasChoice() && !note);
  }
  async function onDecision(decision, payload) {
    if (pending) return;
    pending = true;
    error.hidden = true;
    card.setAttribute('aria-busy', 'true');
    for (const child of card.querySelectorAll('button')) child.disabled = true;
    extra.disabled = true;
    refreshSubmitUi();
    try {
      const r = await fetchJson('/api/tools/authorization/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, chatId, callId: request.callId, decision, ...(payload ? { payload } : {}) })
      });
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      card.remove();
      setChatStatus(decision === 'deny' ? 'question dismissed' : 'answer sent', 'success');
    } catch (err) {
      error.textContent = 'Could not send. Your answer is kept — try again.';
      error.hidden = false;
      setChatStatus('ask_user failed: ' + (err.message || 'network error'), 'error');
    } finally {
      pending = false;
      card.setAttribute('aria-busy', 'false');
      for (const child of card.querySelectorAll('button')) child.disabled = false;
      extra.disabled = false;
      refreshSubmitUi();
    }
  }
  function refreshSelectedUi() {
    for (const optEl of optionsHost.querySelectorAll('.tool-card__ask-option')) {
      const v = optEl.dataset.value || '';
      const on = multi ? selectedValues.has(v) : (v === (lastTapped && lastTapped.value));
      optEl.classList.toggle('is-selected', !!on);
      optEl.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    refreshSubmitUi();
  }
  for (let i = 0; i < options.length; i++) {
    const opt = options[i] || {};
    const optEl = document.createElement('button');
    optEl.type = 'button';
    optEl.className = 'tool-card__ask-option';
    optEl.dataset.value = String(opt.value || '');
    optEl.setAttribute('role', multi ? 'checkbox' : 'radio');
    optEl.setAttribute('aria-checked', 'false');
    // Visible radio / checkbox mark so the selection reads without colour.
    const mark = document.createElement('span');
    mark.className = 'tool-card__ask-option-mark';
    mark.setAttribute('aria-hidden', 'true');
    optEl.appendChild(mark);
    const text = document.createElement('span');
    text.className = 'tool-card__ask-option-text';
    const label = document.createElement('span');
    label.className = 'tool-card__ask-option-label';
    label.textContent = opt.label || opt.value || ('option ' + (i + 1));
    text.appendChild(label);
    if (opt.description) {
    const desc = document.createElement('span');
    desc.className = 'tool-card__ask-option-desc';
    desc.textContent = opt.description;
    text.appendChild(desc);
    }
    optEl.appendChild(text);
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
  // No visible label row: the placeholder says what the field is and the
  // aria-label names it for screen readers, which saves a line of height.
  extra = document.createElement('textarea');
  extra.id = 'ask-extra-' + card.dataset.toolId;
  extra.className = 'input tool-card__ask-extra';
  extra.rows = 1;
  extra.maxLength = 1000;
  extra.setAttribute('aria-label', 'Note for the model (optional)');
  extra.placeholder = 'Optional note, or answer in your own words';
  extra.addEventListener('input', refreshSubmitUi);
  body.appendChild(extra);
  const actions = document.createElement('div');
  actions.className = 'tool-card__actions';
  submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn btn--primary';
  refreshSubmitUi();
  submit.addEventListener('click', async () => {
    // No option and no note: nothing to send (the button is disabled
    // then, this is a guard). A note with no option is still an answer —
    // it used to be sent as a dismissal, which discarded the typed text.
    if (!hasChoice() && !extra.value.trim()) return;
    await onDecision('allow-once', {
    choice: multi ? Array.from(selectedValues) : (lastTapped ? lastTapped.value : ''),
    extra: extra.value || ''
    });
  });
  actions.appendChild(submit);
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'btn';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => onDecision('deny'));
  actions.appendChild(dismiss);
  body.appendChild(error);
  body.appendChild(actions);
  card.appendChild(body);
  refs.transcript.current.appendChild(card);
  afterTranscriptAppend(refs, true);
  const updateMore = () => {
    const more = optionsHost.scrollHeight - optionsHost.scrollTop - optionsHost.clientHeight > 2;
    optionsHost.classList.toggle('has-more', more);
  };
  optionsHost.addEventListener('scroll', updateMore, { passive: true });
  requestAnimationFrame(updateMore);
  // Mobile-first: scroll the card into view and move keyboard focus
  // to the first option so the user can answer with the on-screen
  // keyboard. The `extra` textarea is below the options; tapping
  // it later is one tap away.
  try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* non-fatal */ }
}

// toggleToolGroup(names, next, state, refs, updateChat)
//
// Group-row version of toggleTool (toggleTool delegates here): flip
// every named tool in one state update + one PATCH. Same null/[]
// filter semantics as toggleTool — enabling every known tool
// collapses back to null.
//
// Race notes: the filter is always derived from the CURRENT
// `state.tools` (never a value captured before an await), and the
// catalog object is re-read at write time, so a background catalog
// refresh that lands between two taps keeps both the new catalog and
// the latest selection. The PATCHes themselves are serialized by
// updateChat (updateChatBound's per-chat queue + per-field tickets).
export async function toggleToolGroup(names, next, state, refs, updateChat) {
  const cur = state.tools || { catalog: [], filter: null };
  const allNames = knownToolNames(state);
  const known = new Set(allNames);
  const requested = (names || []).flatMap((n) => n === 'mouaif' ? allNames.filter((key) => key.startsWith('mouaif:')) : [n]);
  const wanted = new Set(requested.filter((n) => known.has(n)));
  if (!wanted.size) {
    // Nothing to change (e.g. the row belongs to a tool that is no
    // longer known). Re-render anyway so a checkbox the browser already
    // flipped snaps back to the real state instead of lying.
    updateToolsCard(refs, state);
    return;
  }
  let nextFilter;
  if (cur.filter == null) {
    nextFilter = next ? null : allNames.filter((n) => !wanted.has(n));
  } else {
    const set = new Set(cur.filter.flatMap((n) => n === 'mouaif' ? allNames.filter((key) => key.startsWith('mouaif:')) : [n]));
    if (next) for (const n of wanted) set.add(n);
    else for (const n of wanted) set.delete(n);
    // Prefer `null` once every known tool is on, so the chat is not
    // pinned to a stale snapshot. Compare by membership, not size: the
    // stored list can carry names of tools that have since gone away.
    nextFilter = allNames.every((n) => set.has(n)) ? null : Array.from(set);
  }
  if (next && state.toolAuth?.mouaif?.mode === 'off' && [...wanted].some((name) => name.startsWith('mouaif:'))) {
    // A disabled family has no selected actions on screen. Lifting it for
    // one checkbox must not reveal every sibling from null/legacy filters.
    const selected = new Set((nextFilter || allNames).filter((name) => !name.startsWith('mouaif:')));
    for (const name of wanted) selected.add(name);
    nextFilter = allNames.every((name) => selected.has(name)) ? null : Array.from(selected);
  }
  const saveNative = state._saveToolAuth;
  const saveMcp = state._saveMcpAuth;
  const optimistic = Object.assign({}, state.tools || cur, { filter: nextFilter });
  state.tools = optimistic;
  updateToolsCard(refs, state);
  try {
    if (await updateChat({ tools: nextFilter }) === false) throw new Error('Tool selection was not saved');
    if (state.tools !== optimistic) return true;
    if (next) {
      // Selection and permission are separate gates. Checking an Off tool
      // must restore Ask, not leave a selected tool hidden from the model.
      const native = new Set();
      const mcp = { servers: {}, tools: {} };
      for (const name of wanted) {
        const cfg = toolPermission(name, state.toolAuth || {}, state.mcpAuth || {});
        if (cfg.mode !== 'off') continue;
        if (name.startsWith('mcp__')) {
          const slug = name.slice(5).split('__')[0];
          mcp.servers[slug] = { mode: 'ask', allowlist: [] };
          mcp.tools[name] = { mode: 'ask', allowlist: [] };
        } else {
          const entry = (cur.catalog || []).find((t) => t.name === name);
          if (name.startsWith('mouaif:')) {
            if (state.toolAuth?.mouaif?.mode === 'off') native.add('mouaif');
            if (state.toolAuth?.[name]?.mode === 'off') native.add(name);
          } else native.add(entry && entry.source === 'files' ? 'file' : name);
        }
      }
      for (const tool of native) {
        const cfg = (state.toolAuth || {})[tool] || {};
        if (!saveNative || await saveNative(tool, 'ask', cfg.allowlist || []) === false) {
          throw new Error('Tool permission was not saved');
        }
      }
      if (Object.keys(mcp.tools).length && (!saveMcp || await saveMcp(mcp) === false)) {
        throw new Error('Tool permission was not saved');
      }
    }
    return true;
  } catch (error) {
    if (state.tools === optimistic) state.tools = cur;
    if (state.tools === cur && refs.status && refs.status.current) refs.status.current.textContent = error.message || 'Could not save tool selection';
    updateToolsCard(refs, state);
    return false;
  }
}

export { buildSetupCard, buildToolsCard };
