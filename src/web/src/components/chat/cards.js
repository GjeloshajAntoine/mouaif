// mouaif web — Chat cards (setup, tools, MCP, authorization, ask_user)
//
// All the in-transcript cards that aren't plain chat bubbles. Most
// of the work is imperative DOM construction so the rest of the
// transcript (which is also imperative) can stay homogeneous.

import { fetchJson } from '../../api.js';
import { afterTranscriptAppend } from './scroll.js';
import { isSubagentTool, normalizeToolName } from './tools.js';

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

// applyMcpCollapsed(wrap, collapsedIds)
//
// Reflect the per-MCP collapsed state on the freshly built
// tools-card subtree. Each server's tool list is independently
// collapsible, so we walk every `.chat-view__mcp-item` and apply
// the state matching its `data-mcp-id`. The hidden attribute is
// not enough on its own — the base `.chat-view__mcp-tool-list
// { display: flex }` rule out-specificities the user-agent
// `[hidden] { display: none }` rule, so the toggle also flips
// `.is-collapsed` (visual source of truth, specificity 0,2,0);
// `hidden` is kept so assistive tech still gets the right
// semantics.
//
// `collapsedIds` is either a `Set` of explicitly-collapsed server
// IDs, or `null` to mean "everything is collapsed by default —
// the user hasn't opened any server yet". The default-closed
// behaviour is the one a fresh chat lands on, so the picker
// doesn't push the chat off-screen with every tool list open
// from the start.
function applyMcpCollapsed(wrap, collapsedIds) {
  if (!wrap) return;
  // null / undefined -> all collapsed (the fresh-chat default).
  // Empty Set -> nothing collapsed (every server explicitly
  // expanded by the user). Concrete Set -> the listed servers
  // are collapsed, the rest are open.
  const collapseAll = collapsedIds == null;
  const set = collapsedIds instanceof Set ? collapsedIds : null;
  const items = wrap.querySelectorAll('.chat-view__mcp-item');
  for (const li of items) {
    const id = li.getAttribute('data-mcp-id');
    if (!id) continue;
    const isCollapsed = collapseAll ? true : set.has(id);
    const toggle = li.querySelector('.chat-view__mcp-toggle');
    const sub = li.querySelector('.chat-view__mcp-tool-list');
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.classList.toggle('is-collapsed', isCollapsed);
    }
    if (sub) {
      sub.hidden = isCollapsed;
      sub.classList.toggle('is-collapsed', isCollapsed);
    }
  }
}

// buildMcpServerToggles(state)
//
// Build the MCP enable/disable controls shown under the tool list.
// Rendered as a nested <ul>: one row per configured MCP server
// (parent checkbox enables the server itself, see toggleMcpServer)
// with an indented child row per discovered tool whose checkbox
// flips the per-chat tools filter (see toggleTool). Each server
// row also has its own collapse toggle on the right so the user
// can fold away long server tool lists without hiding the rest —
// the close behaviour is per MCP, not global.
function buildMcpServerToggles(state) {
  const servers = (state.mcpServers || []).filter((s) => s && s.id);
  if (!servers.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'chat-view__mcp-toggles';

  // Map each server to the catalog entries that belong to it, so the
  // nested list stays aligned with /api/tools/list (which the chips
  // above are built from).
  const catalog = (state.tools && state.tools.catalog) || [];
  const bySlug = new Map();
  for (const t of catalog) {
    if (!t || t.kind !== 'mcp' || !t.source || !t.name) continue;
    let bucket = bySlug.get(t.source);
    if (!bucket) { bucket = []; bySlug.set(t.source, bucket); }
    bucket.push(t);
  }

  // Per-MCP collapsed state. The toggle is per server: folding one
  // MCP leaves the others open. Lives across re-renders of the same
  // chat; reset on chat switch (see useChatState).
  //
  // `null` is the fresh-chat default and means "everything is
  // collapsed until the user explicitly opens a server". The
  // first interaction promotes it to a concrete Set (see
  // `flipCollapsed` below).
  const collapsed = state.mcpCollapsed; // null or Set

  const list = document.createElement('ul');
  list.className = 'chat-view__mcp-list';
  list.id = 'chat-view__mcp-list';
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'MCP servers and their tools');

  for (const s of servers) {
    const serverSlug = s.slug || s.id;
    const serverComposed = (n) => 'mcp__' + serverSlug + '__' + n;
    const li = document.createElement('li');
    li.className = 'chat-view__mcp-item';
    li.setAttribute('data-mcp-id', s.id);

    // Parent row layout. The row is a plain <div> (not a <label>)
    // so we can split the click target into three zones:
    //   1. The checkbox  -> enable/disable the server.
    //   2. The text line (name + status) -> collapse/expand this
    //      server's tool list.
    //   3. The arrow button on the right -> collapse/expand.
    // Wrapping the whole row in a <label> would have made every
    // click toggle the server enable, which is the opposite of
    // what the user expects — they want only the checkbox to
    // enable, and the rest of the line to act as the per-MCP
    // collapse handle.
    const parentRow = document.createElement('div');
    parentRow.className = 'chat-view__mcp-server';

    // The checkbox + name share a small <label> so the standard
    // pattern still works: clicking either the box or the name
    // text flips the server enable. The name is also a click
    // target for the collapse, but the inner <label> swallows
    // those clicks for the enable first; we re-broadcast them to
    // the row's collapse handler below so both stay in sync.
    const parentLabel = document.createElement('label');
    parentLabel.className = 'chat-view__mcp-server-label';
    const parentBox = document.createElement('input');
    parentBox.type = 'checkbox';
    parentBox.className = 'checkbox';
    parentBox.checked = s.enabled !== false;
    parentBox.disabled = state.mcpToggleBusy.has(s.id);
    parentBox.setAttribute('aria-label', (s.name || s.id) + ' MCP server enabled');
    // Block clicks on the checkbox from bubbling up to the row's
    // collapse handler — the user explicitly asked for "only
    // clicking on the checkbox should change it".
    parentBox.addEventListener('click', (e) => { e.stopPropagation(); });
    parentBox.addEventListener('change', () => state._toggleMcpServer && state._toggleMcpServer(s.id, parentBox.checked));
    const parentMain = document.createElement('span');
    parentMain.className = 'chat-view__mcp-server-main';
    const parentName = document.createElement('span');
    parentName.className = 'chat-view__mcp-server-name';
    parentName.textContent = s.name || s.id;
    const parentMeta = document.createElement('span');
    parentMeta.className = 'chat-view__mcp-server-meta';
    const status = s.status || 'stopped';
    const serverTools = Array.isArray(s.tools) ? s.tools.length : 0;
    parentMeta.textContent = status + ' · ' + serverTools + ' tool' + (serverTools === 1 ? '' : 's');
    parentMain.appendChild(parentName); parentMain.appendChild(parentMeta);
    parentLabel.appendChild(parentBox);
    parentLabel.appendChild(parentMain);
    parentRow.appendChild(parentLabel);

    // Helper that flips the collapsed state for THIS server and
    // mirrors it to the toggle button + tool list. Used by both
    // the row click handler (text line) and the arrow button.
    //
    // The first user interaction promotes the null/default state
    // to a concrete Set of explicitly-collapsed server IDs, so
    // subsequent updates only have to track the per-server
    // changes from that point on. (e.g. opening server A from
    // the all-collapsed default means "A is open" — we add
    // every other server to the Set so the new state collapses
    // them, and we explicitly leave A out so it stays open.)
    const flipCollapsed = (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      // Snapshot every other server's current effective state
      // before we touch the Set, so opening one server doesn't
      // silently collapse the others (or vice-versa).
      const isCurrentlyCollapsed = collapsed instanceof Set
        ? collapsed.has(s.id)
        : true; // null default => everything starts collapsed
      const nextCollapsed = !isCurrentlyCollapsed;
      // Promote the null default to a concrete Set on first use.
      if (!(collapsed instanceof Set)) {
        const fresh = new Set();
        for (const other of servers) {
          if (other && other.id && other.id !== s.id) fresh.add(other.id);
        }
        if (nextCollapsed) fresh.add(s.id);
        state.mcpCollapsed = fresh;
      } else {
        if (nextCollapsed) collapsed.add(s.id);
        else collapsed.delete(s.id);
        state.mcpCollapsed = collapsed;
      }
      // Mirror the new state to the toggle button + tool list.
      const t = li.querySelector('.chat-view__mcp-toggle');
      const sub = li.querySelector('.chat-view__mcp-tool-list');
      if (t) {
        t.setAttribute('aria-expanded', String(!nextCollapsed));
        t.classList.toggle('is-collapsed', nextCollapsed);
      }
      if (sub) {
        sub.hidden = nextCollapsed;
        sub.classList.toggle('is-collapsed', nextCollapsed);
      }
    };

    // Per-MCP collapse toggle on the right end of the parent row.
    // Sits as its own button so it has a real focus ring + tap
    // target. Only added when the server actually has tools to
    // hide; a server with no tools keeps the row as a plain
    // enable/disable line.
    let hasCollapseToggle = false;
    if (Array.isArray(s.tools) && s.tools.length) {
      hasCollapseToggle = true;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'chat-view__mcp-toggle';
      toggle.setAttribute('aria-label', (s.name || s.id) + ' tools collapse');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-controls', 'chat-view__mcp-tools-' + s.id);
      // Inline SVG arrow. A real <path> renders consistently across
      // browsers and font fallbacks (the Unicode "▾" can disappear
      // on systems missing the geometric shapes block). Sized to
      // 16×16 so it reads clearly at a glance on mobile, rotated
      // 90° via CSS when the row is collapsed.
      const toggleArrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      toggleArrow.setAttribute('class', 'chat-view__mcp-toggle-arrow');
      toggleArrow.setAttribute('viewBox', '0 0 16 16');
      toggleArrow.setAttribute('width', '12');
      toggleArrow.setAttribute('height', '12');
      toggleArrow.setAttribute('aria-hidden', 'true');
      toggleArrow.setAttribute('focusable', 'false');
      const togglePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      togglePath.setAttribute('d', 'M3.5 5.5 L8 10 L12.5 5.5');
      togglePath.setAttribute('fill', 'none');
      togglePath.setAttribute('stroke', 'currentColor');
      togglePath.setAttribute('stroke-width', '2');
      togglePath.setAttribute('stroke-linecap', 'round');
      togglePath.setAttribute('stroke-linejoin', 'round');
      toggleArrow.appendChild(togglePath);
      toggle.appendChild(toggleArrow);
      toggle.addEventListener('click', flipCollapsed);
      parentRow.appendChild(toggle);
    }

    // Click anywhere on the text line (the <label> region) flips
    // the collapse — except clicks that landed on the checkbox.
    // The <label> would otherwise re-dispatch the click to the
    // checkbox and toggle the server enable, so we explicitly
    // preventDefault when the target is the line text, and stop
    // propagation when it is the checkbox. Net effect:
    //   click on checkbox     -> enable/disable server
    //   click on line text    -> collapse/expand
    //   click on arrow button -> collapse/expand
    if (hasCollapseToggle) {
      parentLabel.addEventListener('click', (e) => {
        if (e.target === parentBox) {
          // The checkbox's own stopPropagation already runs in
          // capture phase; this is the bubble-phase belt-and-
          // braces in case the input handler is removed.
          e.stopPropagation();
          return;
        }
        // Label-text click: suppress the implicit click that
        // would be forwarded to the checkbox (which would toggle
        // the server enable) and run the collapse flip instead.
        e.preventDefault();
        flipCollapsed();
      });
    }

    li.appendChild(parentRow);

    // Child list: one row per discovered tool.
    const discovered = (s.tools && s.tools.length) ? s.tools : null;
    const catalogForServer = bySlug.get(serverSlug) || [];
    const childTools = catalogForServer.length
      ? catalogForServer.map((t) => {
        const prefix = 'mcp__' + serverSlug + '__';
        const composed = t.name || '';
        return {
          name: composed.startsWith(prefix) ? composed.slice(prefix.length) : composed,
          composed
        };
      }).filter((t) => t.name && t.composed)
      : (discovered ? discovered.map((t) => {
        const name = (t && t.name) || t;
        return { name, composed: serverComposed(name) };
      }).filter((t) => t.name && t.composed) : []);
    if (childTools.length) {
      const sub = document.createElement('ul');
      sub.className = 'chat-view__mcp-tool-list';
      sub.id = 'chat-view__mcp-tools-' + s.id;
      sub.setAttribute('role', 'group');
      sub.setAttribute('aria-label', (s.name || s.id) + ' tools');
      for (const tool of childTools) {
        const toolName = tool.name;
        const composed = tool.composed;
        const childLi = document.createElement('li');
        childLi.className = 'chat-view__mcp-tool';
        const childLabel = document.createElement('label');
        childLabel.className = 'chat-view__mcp-tool-label';
        const childBox = document.createElement('input');
        childBox.type = 'checkbox';
        childBox.className = 'checkbox';
        const cur = state.tools || { filter: null };
        const enabled = (cur.filter == null) || cur.filter.indexOf(composed) >= 0;
        childBox.checked = enabled;
        childBox.disabled = parentBox.disabled || s.enabled === false;
        childBox.setAttribute('aria-label', (s.name || s.id) + ' — ' + toolName + ' tool enabled');
        const childMain = document.createElement('span');
        childMain.className = 'chat-view__mcp-tool-main';
        const childName = document.createElement('span');
        childName.className = 'chat-view__mcp-tool-name';
        childName.textContent = toolName;
        const childSlug = document.createElement('span');
        childSlug.className = 'chat-view__mcp-tool-slug';
        childSlug.textContent = composed;
        childSlug.setAttribute('aria-hidden', 'true');
        childMain.appendChild(childName); childMain.appendChild(childSlug);
        childBox.addEventListener('change', () => state._toggleTool && state._toggleTool(composed, childBox.checked));
        childLabel.appendChild(childBox); childLabel.appendChild(childMain);
        childLi.appendChild(childLabel);
        sub.appendChild(childLi);
      }
      li.appendChild(sub);
    }

    list.appendChild(li);
  }
  wrap.appendChild(list);
  // Apply the per-MCP collapsed state to the freshly built list so
  // a re-render of the tools card (e.g. after a tool toggle or a
  // server add) keeps the user's per-server choice instead of
  // snapping every server back open.
  applyMcpCollapsed(wrap, collapsed);
  return wrap;
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
  title.textContent = 'Tools available to the model';
  const note = document.createElement('span');
  note.className = 'chat-view__tools-card-note';
  note.textContent = (t.filter == null)
    ? 'tap to disable — applies next turn'
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

  const chips = document.createElement('div');
  chips.className = 'chat-view__tools-chips';
  for (const tool of t.catalog) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chat-view__tools-chip';
    chip.dataset.toolName = tool.name;
    // Effective state: filter === null means "all enabled"
    // (legacy default); an array means "exactly these enabled".
    // The chip is on when either rule says it is.
    const enabled = (t.filter == null) || t.filter.indexOf(tool.name) >= 0;
    if (enabled) chip.classList.add('is-on');
    chip.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    chip.title = tool.description || tool.name;
    const label = document.createElement('span');
    label.className = 'chat-view__tools-chip-label';
    label.textContent = tool.name;
    chip.appendChild(label);
    if (tool.kind === 'mcp' && tool.source) {
      const sub = document.createElement('span');
      sub.className = 'chat-view__tools-chip-sub';
      sub.textContent = tool.source;
      chip.appendChild(sub);
    }
    chip.addEventListener('click', () => state._toggleTool && state._toggleTool(tool.name, !enabled));
    chips.appendChild(chip);
  }
  card.appendChild(chips);

  const mcp = buildMcpServerToggles(state);
  if (mcp) card.appendChild(mcp);
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

export { buildSetupCard, applyMcpCollapsed };
