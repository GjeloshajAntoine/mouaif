// mouaif web — extension docks (docs/features/extensions.md)
//
// The `chat.dock` slot: one bar per active extension view, in the bottom
// stack above the composer. Collapsed it is a 44 px chip — the view's title
// and a badge the view can set (mouaif/chat.badge). Tapping it mounts the
// view (an MCP App in the sandbox) under the chip, up to 30 dvh and
// resizable. A view remembers being open per extension, and an extension
// marked `"collapsed": "open"` starts open. At most MAX_LIVE views run per
// tab (appHostContext.js): opening another closes the least recently used.
// `?safe` shows no extension views.
import { h, Fragment } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { fetchJson, activeProject } from '../../api.js';
import { safeMode } from '../../theme/runtime.js';
import { McpAppFrame } from './McpAppFrame.jsx';
import { claimSurface, releaseSurface, touchSurface } from './appHostContext.js';
import { registerSurface, unregisterSurface } from './extensionEvents.js';
import './extension-ui.css';

export const EXTENSIONS_CHANGED = 'mouaif:extensions-changed';
const POLL_MS = 30000;

export const PUZZLE_PATH = 'M10 3a2 2 0 0 1 4 0v2h4a1 1 0 0 1 1 1v4h-2a2 2 0 0 0 0 4h2v4a1 1 0 0 1-1 1h-4v-2a2 2 0 0 0-4 0v2H6a1 1 0 0 1-1-1v-4h2a2 2 0 0 0 0-4H5V6a1 1 0 0 1 1-1h4V3Z';

export function PuzzleIcon({ size = 16 }) {
  return h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8,
    'stroke-linejoin': 'round', 'aria-hidden': 'true' }, h('path', { d: PUZZLE_PATH }));
}

// useExtensionSurfaces(projectDir, slot) -> [surface] — the active views for a slot.
export function useExtensionSurfaces(projectDir, slot) {
  const [list, setList] = useState([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (safeMode || !projectDir) { setList([]); return undefined; }
    let stopped = false;
    fetchJson('/api/extensions/surfaces?projectDir=' + encodeURIComponent(projectDir) + '&slot=' + encodeURIComponent(slot))
      .then((r) => { if (!stopped) setList(r.status === 200 && Array.isArray(r.body.surfaces) ? r.body.surfaces : []); }, () => {});
    return () => { stopped = true; };
  }, [projectDir, slot, tick]);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') bump(); }, POLL_MS);
    window.addEventListener(EXTENSIONS_CHANGED, bump);
    return () => { clearInterval(timer); window.removeEventListener(EXTENSIONS_CHANGED, bump); };
  }, []);
  return list;
}

function storageKey(surface) {
  return 'mouaif.extensionDock.' + surface.extensionId + '/' + surface.surfaceId;
}
function readOpen(surface) {
  try {
    const v = localStorage.getItem(storageKey(surface));
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* storage unavailable */ }
  return surface.collapsed === 'open';
}
function writeOpen(surface, open) {
  try { localStorage.setItem(storageKey(surface), open ? '1' : '0'); } catch { /* storage unavailable */ }
}

function ExtensionDock({ surface, projectDir, chatId }) {
  const id = surface.extensionId + '/' + surface.surfaceId;
  const budgetKey = 'dock:' + id + '@' + chatId;
  const [open, setOpenState] = useState(() => readOpen(surface));
  const [badge, setBadge] = useState(null);
  const bridge = useRef(null);
  const setOpen = useCallback((next, remember = true) => {
    setOpenState(next);
    if (remember) writeOpen(surface, next);
  }, [surface.extensionId, surface.surfaceId]);

  // Budget: an open dock holds a live frame; another view can evict it.
  useEffect(() => {
    if (!open) return undefined;
    claimSurface(budgetKey, () => setOpenState(false));
    return () => releaseSurface(budgetKey);
  }, [open, budgetKey]);

  // Host events and badges reach this dock by extension/surface id.
  useEffect(() => {
    const entry = { projectDir, chatId, extensionId: surface.extensionId, surfaceId: surface.surfaceId,
      events: surface.events || [], setBadge, bridge: () => bridge.current, open: () => setOpen(true) };
    registerSurface(entry);
    return () => unregisterSurface(entry);
  }, [projectDir, chatId, surface.extensionId, surface.surfaceId, surface.events]);

  const label = surface.extensionName === surface.title ? surface.title : surface.extensionName + ' · ' + surface.title;
  return h('div', { class: 'ext-dock' + (open ? ' ext-dock--open' : ''), 'data-extension': surface.extensionId },
    open ? h('div', { class: 'ext-dock__frame', onPointerDown: () => touchSurface(budgetKey) },
      h(McpAppFrame, { projectDir, chatId, callId: 'surface:' + id,
        surface: { extensionId: surface.extensionId, surfaceId: surface.surfaceId, slot: 'chat.dock',
          projectName: (activeProject.value && activeProject.value.name) || '' },
        onBridge: (b) => { bridge.current = b; },
        onClosed: () => setOpen(false) })) : null,
    h('div', { class: 'run-dock webhook-dock ext-dock__bar', role: 'group', 'aria-label': label },
      h('span', { class: 'webhook-dock__icon' }, h(PuzzleIcon, { size: 16 })),
      h('div', { class: 'run-dock__text' },
        h('div', { class: 'run-dock__goal' }, h('strong', null, surface.title),
          surface.extensionName !== surface.title ? h('span', { class: 'ext-dock__ext' }, ' · ' + surface.extensionName) : null)),
      badge && badge.text ? h('span', { class: 'ext-dock__badge', 'data-tone': badge.tone || 'info', role: 'status' }, badge.text) : null,
      h('button', { class: 'run-dock__btn', type: 'button', 'aria-expanded': open ? 'true' : 'false',
        'aria-label': (open ? 'Close ' : 'Open ') + label, onClick: () => setOpen(!open) }, open ? 'Close' : 'Open')));
}

export function ExtensionDocks({ projectDir, chatId }) {
  const list = useExtensionSurfaces(projectDir, 'chat.dock');
  if (!list.length || !chatId) return null;
  return h(Fragment, null, list.map((surface) => h(ExtensionDock, { key: surface.extensionId + '/' + surface.surfaceId, surface, projectDir, chatId })));
}
