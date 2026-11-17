// Extension tool renderers (docs/features/extensions.md, slot `tool.renderer`).
//
// An extension can show a matching tool call's result as its own view: the
// card's ordinary result body moves under a "Raw result" fold and the view
// mounts above it, receiving the call's arguments and result through the
// standard MCP Apps notifications (an existing MCP App works unchanged).
// Renderers count toward the live-view budget (appHostContext.js); an
// evicted one leaves a "Show view" button.
import { mountMcpApp } from './McpAppFrame.jsx';
import { claimSurface, touchSurface } from './appHostContext.js';
import { openExtensionSheet, annotationsFor, ANNOTATIONS_CHANGED } from './extensionEvents.js';

const byProject = new Map(); // projectDir -> [surface]

export function setToolRenderers(projectDir, list) {
  byProject.set(projectDir, Array.isArray(list) ? list : []);
}

function globToRegExp(glob) {
  return new RegExp('^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}

// findToolRenderer(projectDir, toolName) -> surface | null (the first match).
export function findToolRenderer(projectDir, toolName) {
  const list = byProject.get(projectDir) || [];
  const name = String(toolName || '');
  for (const s of list) {
    const tools = (s.match && s.match.tool) || [];
    if (tools.some((p) => (p.includes('*') ? globToRegExp(p).test(name) : p === name))) return s;
  }
  return null;
}

// mountToolRenderer(body, { projectDir, chatId, callId, renderer, onAuthorize })
export function mountToolRenderer(body, { projectDir, chatId, callId, renderer, onAuthorize }) {
  const raw = document.createElement('details');
  raw.className = 'ext-renderer__raw';
  const summary = document.createElement('summary');
  summary.textContent = 'Raw result';
  raw.appendChild(summary);
  while (body.firstChild) raw.appendChild(body.firstChild);
  const host = document.createElement('div');
  host.className = 'ext-renderer';
  host.addEventListener('pointerdown', () => touchSurface(key));
  body.append(host, raw);
  const key = 'renderer:' + callId;
  const title = renderer.extensionName === renderer.title ? renderer.title : renderer.extensionName + ' · ' + renderer.title;
  function evict() {
    host.textContent = '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ext-renderer__show';
    btn.textContent = 'Show ' + title;
    btn.addEventListener('click', (e) => { e.stopPropagation(); mount(); });
    host.appendChild(btn);
  }
  function mount() {
    host.textContent = '';
    const slot = document.createElement('div');
    host.appendChild(slot);
    claimSurface(key, evict, () => host.isConnected);
    mountMcpApp(slot, { projectDir, chatId, callId,
      surface: { extensionId: renderer.extensionId, surfaceId: renderer.surfaceId, slot: 'tool.renderer' },
      onAuthorize });
  }
  mount();
}

// ---- message.action -------------------------------------------------------
//
// Actions under saved chat messages: a small puzzle button in the row's
// actions. One matching action opens directly; several open a short menu.
// Opening goes through openExtensionSheet with the message's seq, so the
// sheet mounts the view with that message (src/server-handlers-mcp-apps.js).
// appendMessageAnnotations(headEl, projectDir, chatId, m) — the badges views
// set on this saved message (mouaif/message.annotate); refilled on change.
export function appendMessageAnnotations(headEl, projectDir, chatId, m) {
  if (!projectDir || !chatId || !m || !Number.isSafeInteger(m.seq)) return;
  const wrap = document.createElement('span');
  wrap.className = 'chat-msg__notes';
  wrap._notesKey = { projectDir, chatId, seq: m.seq };
  headEl.appendChild(wrap);
  fillAnnotations(wrap);
}

function fillAnnotations(wrap) {
  const { projectDir, chatId, seq } = wrap._notesKey;
  const notes = annotationsFor(projectDir, chatId, seq);
  wrap.textContent = '';
  wrap.hidden = !notes.length;
  for (const n of notes) {
    const chip = document.createElement('span');
    chip.className = 'chat-msg__note';
    chip.dataset.tone = n.tone;
    chip.textContent = n.text;
    chip.title = (n.title ? n.title + ' · ' : '') + 'from ' + n.extensionId;
    wrap.appendChild(chip);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(ANNOTATIONS_CHANGED, (e) => {
    const { projectDir, chatId, seqs } = e.detail || {};
    for (const wrap of document.querySelectorAll('.chat-msg__notes')) {
      const k = wrap._notesKey;
      if (k && k.projectDir === projectDir && k.chatId === chatId && seqs.includes(k.seq)) fillAnnotations(wrap);
    }
  });
}

const messageActionsByProject = new Map(); // projectDir -> [surface]

export function setMessageActions(projectDir, list) {
  messageActionsByProject.set(projectDir, Array.isArray(list) ? list : []);
  // Rows drawn before the list arrived (or after it changed) catch up.
  for (const wrap of document.querySelectorAll('.chat-msg__ext')) {
    if (wrap._extProject === projectDir) fillMessageActions(wrap);
  }
}

function messageActionsFor(projectDir, role) {
  return (messageActionsByProject.get(projectDir) || []).filter((s) => ((s.match && s.match.role) || 'assistant') === role);
}

const PUZZLE_D = 'M10 3a2 2 0 0 1 4 0v2h4a1 1 0 0 1 1 1v4h-2a2 2 0 0 0 0 4h2v4a1 1 0 0 1-1 1h-4v-2a2 2 0 0 0-4 0v2H6a1 1 0 0 1-1-1v-4h2a2 2 0 0 0 0-4H5V6a1 1 0 0 1 1-1h4V3Z';

// appendMessageActions(actionsEl, projectDir, m) — no-op without a saved seq.
// The row always gets an (empty) slot so a later setMessageActions can fill
// it; the list is read again on click, so a stale entry never mounts.
export function appendMessageActions(actionsEl, projectDir, m) {
  if (!projectDir || !m || !Number.isSafeInteger(m.seq)) return;
  const wrap = document.createElement('span');
  wrap.className = 'chat-msg__ext';
  wrap._extProject = projectDir;
  wrap._extRole = m.role;
  wrap._extSeq = m.seq;
  actionsEl.appendChild(wrap);
  fillMessageActions(wrap);
}

function fillMessageActions(wrap) {
  const projectDir = wrap._extProject;
  const role = wrap._extRole;
  const seq = wrap._extSeq;
  const has = messageActionsFor(projectDir, role).length > 0;
  if (!has) { wrap.textContent = ''; wrap.hidden = true; return; }
  wrap.hidden = false;
  if (wrap.firstChild) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn chat-msg__ext-btn';
  btn.setAttribute('aria-label', 'Extension actions');
  btn.title = 'Extension actions';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="' + PUZZLE_D + '"/></svg>';
  let menu = null;
  const close = () => { if (menu) { menu.remove(); menu = null; document.removeEventListener('pointerdown', away, true); } };
  const away = (e) => { if (!wrap.contains(e.target)) close(); };
  const open = (s) => { close(); openExtensionSheet({ extensionId: s.extensionId, surfaceId: s.surfaceId, messageSeq: seq }); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu) { close(); return; }
    const list = messageActionsFor(projectDir, role);
    if (!list.length) return;
    if (list.length === 1) { open(list[0]); return; }
    menu = document.createElement('div');
    menu.className = 'ext-menu__list';
    menu.setAttribute('role', 'menu');
    for (const s of list) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'ext-menu__item';
      item.setAttribute('role', 'menuitem');
      item.textContent = s.title;
      item.addEventListener('click', (ev) => { ev.stopPropagation(); open(s); });
      menu.appendChild(item);
    }
    wrap.appendChild(menu);
    document.addEventListener('pointerdown', away, true);
  });
  wrap.appendChild(btn);
}
