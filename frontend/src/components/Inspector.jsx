// mouaif web — InspectorView (main component)
//
// Three-phase UI:
//   1. Setup — configure the Chrome debugger URL
//   2. Targets — pick a tab to attach to
//   3. Inspect — live console, network, preview, and overview tabs
//
// Sub-modules live in the inspector/ directory.
// This view is lazy-loaded (see App.jsx), so its CSS is imported here
// rather than via the global style.css chain — it only downloads when
// the Inspector tab is opened.
import '../inspector.css';
import { h, Fragment } from 'preact';
import { createPortal } from 'preact/compat';
import { useRef, useEffect, useState } from 'preact/hooks';
import { fetchJson } from '../api.js';
import { ConsolePanel, NetworkPanel, PreviewPanel, OverviewPanel, StylesPanel, DetailSheet, ConfirmSheet, createCdpConnection } from './inspector/index.js';
import { selectionAcrossModes } from './inspector/targetBar.js';
import { IntentPanel } from './inspector/IntentPanel.jsx';
import { buildIntentPrompt } from './inspector/intent.js';
import { activeProject } from '../api.js';
import { summarizeReceipt, recordChange, undoPlan, undoOrder } from './inspector/scope.js';
import { settlePick, pickBannerText } from './inspector/pickMode.js';
import { createEventHandlers } from './inspector/events.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { DraftCraftAnnotator } from './inspector/DraftCraftAnnotator.jsx';
import { DraftCraftSheet } from './DraftCraftSheet.jsx';
import { buildEntryText } from './inspector/entryText.js';
import { InspectorProfilesSheet } from './inspector/InspectorProfilesSheet.jsx';
// copyText — write a string to the clipboard, falling back to execCommand for
// embedded web views that block navigator.clipboard. Returns true on success.
// Mirrors the helper in chat/GitModal.jsx: the clipboard is never the only
// path to the value (the element label is on screen and in the panel's
// aria-labels), so a refusal is reported rather than thrown.
async function copyText(text) {
try {
await navigator.clipboard.writeText(text || '');
return true;
} catch (_) {
try {
const ta = document.createElement('textarea');
ta.value = text || '';
ta.style.position = 'fixed';
ta.style.opacity = '0';
document.body.appendChild(ta);
ta.select();
const ok = document.execCommand('copy');
document.body.removeChild(ta);
return ok;
} catch (_) {
return false;
}
}
}
// Short human label for a Chrome DevTools target type. Chrome uses a
// handful of types: `page` (a normal tab), `iframe`, `webview`,
// `service_worker`, `background_page` (extension), and a few rarely-seen
// ones (`worker`, `shared_worker`, `other`). The chip color follows the
// type so the list reads at a glance.
const TYPE_META = {
  page:            { label: 'TAB',    short: 'tab', tone: 'accent'  },
  iframe:          { label: 'FRAME',  short: 'frame', tone: 'accent'  },
  webview:         { label: 'VIEW',   short: 'view', tone: 'accent'  },
  service_worker:  { label: 'SW',     short: 'sw',  tone: 'warning' },
  background_page: { label: 'BG',     short: 'bg',  tone: 'muted'   },
  worker:          { label: 'WORKER', short: 'wrk', tone: 'warning' },
  shared_worker:   { label: 'SHARED', short: 'shr', tone: 'warning' },
  other:           { label: 'OTHER',  short: '?',   tone: 'muted'   }
};
function targetMeta(t) {
  const type = (t && t.type) || 'other';
  return TYPE_META[type] || TYPE_META.other;
}
// Chrome renders a top-level PDF in its built-in extension webview.
// Page.captureScreenshot on the outer `page` target includes that separately
// composited surface only for viewport captures. /json/list exposes a stable
// target chain that lets us identify this case without relying on a .pdf URL:
//
//   page (the PDF URL) -> webview (Chrome PDF viewer) -> iframe (PDF URL)
function hasPdfViewerTarget(target, allTargets) {
  if (!target || target.type !== 'page' || !target.id || !Array.isArray(allTargets)) return false;
  const viewer = allTargets.find((item) => item
    && item.type === 'webview'
    && item.parentId === target.id
    && /^chrome-extension:\/\/mhjfbmdgcfjbbpaeojofohoefgiehjai\//.test(item.url || ''));
  if (!viewer || !viewer.id) return false;
  return allTargets.some((item) => item && item.type === 'iframe' && item.parentId === viewer.id);
}
// closeMessage — body text for the in-app confirm sheet. Shows the
// tab's title so the user is closing the right thing; falls back to
// the host (or the target id) when the title is empty. The text is
// deliberately short — the sheet is mobile-first, a single paragraph
// fits the 360 px width with comfortable line-height.
function closeMessage(t) {
  if (!t) return 'Close this tab?';
  const name = t.title || (t.url ? hostOf(t) : '') || t.id || 'this tab';
  return 'Close “' + name + '”?';
}
// hostOf — extract `host[:port]` from a target URL so we can show it
// as a subtitle alongside the title. Returns '' for non-http(s) targets
// (chrome:// pages, bare webSocketDebuggerUrl, etc.).
function hostOf(t) {
  const u = (t && t.url) || '';
  if (!u || !/^https?:\/\//i.test(u)) return '';
  try { return new URL(u).host; } catch { return ''; }
}
// Optional-panel model
// --------------------
// The Inspector is a from-scratch mobile DevTools UI. Instead of the
// previous single-active subtab (Preview / Console / Network / Info)
// the user now picks *which* of the four panels are visible. The
// toggled-on panels are stacked vertically and share the available
// height; toggled-off panels are unmounted, which also stops their
// capture loops (preview screenshots, metrics polling) and the
// virtual-list renderers, so the user pays only for what they look at.
//
// `PANELS` is the canonical ordered list of panel IDs and labels.
// `loadPanelState()` hydrates the visibility set from localStorage
// (the key lives in `PANEL_STATE_KEY`) so the user's choice
// persists across sessions and across inspected targets. The first
// visit (no saved state) shows every panel — the new
// design's default is to surface every signal, and the user narrows
// it down on demand.
const PANELS = [
  { id: 'preview',  label: 'Preview' },
  { id: 'styles',   label: 'Styles' },
  { id: 'console',  label: 'Console' },
  { id: 'network',  label: 'Network' },
  { id: 'overview', label: 'Info'    }
];
const PANEL_STATE_KEY = 'mouaif:inspector:panels';
// Viewport size presets — device-metrics overrides the user can apply
// to the inspected page from the preview toolbar. `null` (the
// "Auto" / native-size entry) clears the override so the page renders
// at the real browser window size again. Presets mirror common
// responsive breakpoints: a small phone, a large phone, a tablet, and
// a laptop. `mobile: true` is only set for the phone entries because
// it flips the viewport meta / DPR behaviour that modern sites key
// responsive design off; tablet and laptop stay desktop-style so
// sites don't unexpectedly switch their media queries.
const VIEWPORT_PRESETS = [
{ id: 'auto',   label: 'Auto', width: null, height: null },
// Phone presets emulate a retina device (deviceScaleFactor 2). Without this
// the capture is rendered at 1x and then upscaled across the same CSS pixels,
// so text looks blurry on a real phone. A 2x capture is downscaled for the
// fit-width preview (sharp) and shown 1:1 in natural-size mode (also sharp).
{ id: 'phone',  label: 'Phone', width: 375, height: 667, mobile: true, deviceScaleFactor: 2 },
{ id: 'phone+', label: 'Phone+', width: 414, height: 896, mobile: true, deviceScaleFactor: 2 },
{ id: 'tablet', label: 'Tablet', width: 768, height: 1024 },
{ id: 'laptop', label: 'Laptop', width: 1280, height: 800 }
];
const VIEWPORT_STATE_KEY = 'mouaif:inspector:viewport';
function loadPanelState() {
  try {
    const raw = localStorage.getItem(PANEL_STATE_KEY);
    if (!raw) return new Set(PANELS.map((p) => p.id));
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set(PANELS.map((p) => p.id));
    const known = new Set(PANELS.map((p) => p.id));
    const next = new Set(arr.filter((id) => known.has(id)));
    // Guard against an all-hidden state: a UI with zero panels is
    // useless, and re-mounting after picking "hide all" would trap
    // the user. Reset to the default instead.
    return next.size ? next : new Set(PANELS.map((p) => p.id));
  } catch { return new Set(PANELS.map((p) => p.id)); }
}
function savePanelState(set) {
  try { localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(Array.from(set))); } catch { /* ignore */ }
}
// The Intent surface's own visibility. A separate key from the panel list
// because it is a separate thing: PANELS is the five inspection views, and this
// is the describe-a-change surface introduced with Part H — a request box and a
// cited diff, not another view of the connected page.
const INTENT_STATE_KEY = 'mouaif:inspector:intent';
function loadIntentState() {
  try { return localStorage.getItem(INTENT_STATE_KEY) === '1'; } catch { return false; }
}
function saveIntentState(value) {
try { localStorage.setItem(INTENT_STATE_KEY, value ? '1' : '0'); } catch { /* ignore */ }
}
// INTENT_SURFACE — the Intent chip is hidden. "Intent" is not one of the five
// inspection views, and as a sixth chip it was the first thing to crowd the
// panel bar at 360 px while being the rarest thing tapped, so the bar now
// carries only PANELS. The surface itself is unchanged and still tested
// (IntentPanel + intent.js, scripts/test-inspector-intent.js): flip this to
// true and the chip and the panel come back exactly as they were.
const INTENT_SURFACE = false;
// PROFILES_ENTRY — the "Chrome profiles" button on the setup screen is hidden.
// It sat between the debugger-URL field and Save & discover, so at 360 px it
// read as a required step between typing a URL and connecting, while a user
// with a single Chrome profile only ever pastes a URL there. The feature is
// unchanged: src/inspectorProfiles.js, the four REST routes, the sheet
// (InspectorProfilesSheet.jsx) and their tests all stay, and typing a second
// profile's port by hand still works. Flip this to true and the button — and,
// with it, the sheet — come back exactly as they were.
const PROFILES_ENTRY = false;
// Hoisted sub-components (module scope) so their identity is stable
// across InspectorView re-renders. Defining them *inside* the render
// function gave every render a brand-new component type, so Preact
// unmounted + remounted the whole subtree on each state change — e.g.
// toggling a panel chip tore down the preview capture loop and reset
// the live preview, and any CDP-triggered rerender lost the open menu
// state. Hoisting keeps the preview <img>, the virtual lists, and the
// menu open-state alive across re-renders; parent data/actions flow in
// as props instead of via closure over the parent render.
function TargetMenu(props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  useClickOutside(menuRef, () => setOpen(false), open);
  const t = props.target;
  const meta = targetMeta(t);
  const canManage = t && t.id && t.type === 'page';
  return h('div', { ref: menuRef, class: 'inspector__row-menu' },
    h('button', {
      class: 'icon-btn inspector__row-menu-btn',
      type: 'button',
      'aria-haspopup': 'true',
      'aria-expanded': String(open),
      'aria-label': 'Target options',
      onClick: (e) => { e.stopPropagation(); setOpen(!open); }
    }, '⋯'),
    h('div', {
      class: 'inspector__row-menu-pop',
      hidden: !open,
      role: 'menu',
      onClick: (e) => e.stopPropagation()
    },
      h('button', { type: 'button', role: 'menuitem', onClick: () => { setOpen(false); props.onConnect(t); } }, 'Connect'),
      canManage ? h('button', { type: 'button', role: 'menuitem', onClick: () => { setOpen(false); props.onReload(t); } }, 'Reload') : null,
      canManage ? h('button', { type: 'button', role: 'menuitem', 'data-danger': '1', onClick: () => { setOpen(false); props.onClose(t); } }, 'Close tab') : null,
      h('div', { class: 'inspector__row-menu-meta' },
        h('span', null, meta.label),
        h('span', null, t && t.id ? t.id : '')
      )
    )
  );
}

function TargetRow(props) {
  const t = props.target;
  const meta = targetMeta(t);
  const title = (t && (t.title || t.url || t.id)) || '';
  const subtitle = hostOf(t) || (t && (t.url || t.webSocketDebuggerUrl || t.id)) || '';
  return h('li', { class: 'inspector__row-target inspector__row-target--' + meta.tone, key: t && t.id },
    h('button', {
      class: 'inspector__row-target-main',
      type: 'button',
      'aria-label': 'Connect to ' + title,
      onClick: () => props.onConnect(t)
    },
      h('span', { class: 'inspector__row-target-chip' }, meta.label),
      h('span', { class: 'inspector__row-target-body' },
        h('span', { class: 'inspector__row-target-title' }, title),
        subtitle && subtitle !== title
          ? h('span', { class: 'inspector__row-target-sub' }, subtitle)
          : null
      )
    ),
    h(TargetMenu, {
      target: t,
      onConnect: props.onConnect,
      onReload: props.onReload,
      onClose: props.onClose
    })
  );
}

// SizeDropdown — a compact select-style control for the Preview panel
// header. Shows the current viewport preset and a chevron; tapping it
// opens a popover list of the presets (with their pixel dimensions).
// Uses the same popover pattern as the target-row and actions menus.
function SizeDropdown(props) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);
  const current = VIEWPORT_PRESETS.find((p) => p.id === props.sizeId) || VIEWPORT_PRESETS[0];
  return h('div', { ref, class: 'inspector__size' },
    h('button', {
      class: 'inspector__size-btn',
      type: 'button',
      'aria-haspopup': 'listbox',
      'aria-expanded': String(open),
      'aria-label': 'Preview size: ' + current.label,
      title: 'Preview size',
      onClick: (e) => { e.stopPropagation(); setOpen(!open); }
    },
      h('span', { class: 'inspector__size-btn-label' }, current.label),
      h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' },
        h('path', { d: 'M7 10l5 5 5-5z', fill: 'currentColor' })
      )
    ),
    h('div', {
      class: 'inspector__size-pop',
      hidden: !open,
      role: 'listbox',
      onClick: (e) => e.stopPropagation()
    },
      VIEWPORT_PRESETS.map((p) => h('button', {
        class: 'inspector__size-opt' + (props.sizeId === p.id ? ' is-on' : ''),
        type: 'button',
        role: 'option',
        'aria-selected': String(props.sizeId === p.id),
        onClick: () => { setOpen(false); props.onChange(p.id); }
      },
        h('span', { class: 'inspector__size-opt-label' }, p.label),
        h('span', { class: 'inspector__size-opt-dims' }, p.width ? (p.width + '×' + p.height) : 'native')
      ))
    )
  );
}

function PanelCard(props) {
const isVisible = props.isVisible;
const toggleAria = isVisible ? 'Hide ' + props.label + ' panel' : 'Show ' + props.label + ' panel';
// The panel's *name* is no longer printed in its header. It is replaced by the
// full-screen button in the same slot, on every card — the pattern the Preview
// card already shipped with, extended to the rest.
//
// The name is not lost, it is moved: the chip in the pinned switcher above
// already names the panel in words, and the button carries the same name in its
// `aria-label` + `title`, so nothing on screen becomes unnameable for assistive
// tech. What the header gains is the row's only wide slot turned into an
// action: a panel body is 32–54 dvh on a phone, which is under half the
// viewport, and this is the one-tap answer for the 470-row computed list, the
// request log and the console.
//
// Two destinations share the one button, because the two cards that have a
// "fuller" surface already own it: Preview opens its viewport-spanning overlay
// (a second screenshot surface with its own header, size presets and type bar),
// and every other card expands into the region below. That is the existing
// Preview behaviour, kept rather than replaced.
const labelNode = h('button', {
class: 'icon-btn inspector__panel-fs' + (props.focused ? ' is-on' : ''),
type: 'button',
'aria-label': props.focused
? 'Exit full screen for ' + props.label
: 'Open ' + props.label + ' full screen',
title: props.focused ? 'Exit full screen' : 'Open ' + props.label + ' full screen',
disabled: !isVisible,
onClick: (e) => { e.stopPropagation(); props.onFullscreen(); }
},
props.focused
? h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true', fill: 'currentColor' },
h('path', { d: 'M9 4v5H4V7h3V4h2Zm6 0h2v3h3v2h-5V4ZM4 15h5v5H7v-3H4v-2Zm11 0h5v2h-3v3h-2v-5Z' })
)
: h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true', fill: 'currentColor' },
h('path', { d: 'M4 9V4h5v2H6v3H4Zm11-5h5v5h-2V6h-3V4ZM6 15v3h3v2H4v-5h2Zm12 0h2v5h-5v-2h3v-3Z' })
)
);
return h('div', {
class: 'inspector__panel'
+ (props.grow ? ' inspector__panel--grow' : '')
+ (props.span ? ' inspector__panel--span' : '')
+ (props.solo ? ' inspector__panel--solo' : '')
+ (props.focused ? ' inspector__panel--fullscreen' : ''),
'data-panel': props.id
},
h('div', { class: 'inspector__panel-head' },
h('div', { class: 'inspector__panel-head-left' },
labelNode,
props.onSizeChange ? h(SizeDropdown, { sizeId: props.sizeId, onChange: props.onSizeChange }) : null
),
h('div', { class: 'inspector__panel-head-actions' },
// Styles panel actions — Clear / Refresh / Pick, the three controls the
// Styles card used to carry in its own action row inside the card body.
// They belong here: this row is the *panel's* chrome (it is where the
// Preview panel keeps its full-screen, refresh, type and eye buttons), and
// they are card-wide actions rather than a property of the element being
// read. Lifting them out is what gives the element's identity — a chip the
// body now carries at full width, tap to copy its selector — the room to
// stop ellipsizing at the 360 px minimum, which is the whole reason the
// three labels were crowding it. Glyph-only, with `aria-label` + `title`,
// like every other control in this row: `.inspector__styles-clear` and
// friends keep them at a 44 px tap target (inspector-styles.css).
props.stylesActions
? h(Fragment, null,
h('button', {
class: 'icon-btn inspector__styles-clear',
type: 'button',
'aria-label': 'Clear selection',
title: 'Clear selection',
disabled: !props.stylesActions.hasElement,
onClick: (e) => { e.stopPropagation(); props.stylesActions.onClear(); }
},
h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
h('path', { d: 'M6 6 18 18 M18 6 6 18', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' })
)
),
h('button', {
class: 'icon-btn inspector__styles-refresh',
type: 'button',
'aria-label': 'Refresh styles',
title: 'Refresh styles',
disabled: !props.stylesActions.hasElement || props.stylesActions.busy,
onClick: (e) => { e.stopPropagation(); props.stylesActions.onRefresh(); }
},
h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
h('path', { d: 'M12 4V1L7 6l5 5V7c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8Z', fill: 'currentColor' })
)
),
h('button', {
class: 'icon-btn inspector__styles-pick' + (props.stylesActions.pickMode ? ' is-on' : ''),
type: 'button',
'aria-pressed': String(!!props.stylesActions.pickMode),
'aria-label': props.stylesActions.pickLabel,
title: props.stylesActions.pickLabel,
disabled: !!props.stylesActions.pickDisabled,
onClick: (e) => { e.stopPropagation(); props.stylesActions.onPick(); }
},
h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
h('path', { d: 'M5 3l14 7-6.5 1.5L10 19 5 3Z', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linejoin': 'round' })
)
)
)
: null,
props.onDraftCraft
? h('button', {
class: 'icon-btn inspector__panel-draft-craft',
type: 'button',
title: 'Draft Craft',
'aria-label': 'Open Draft Craft for this preview',
disabled: !props.isVisible,
onClick: (e) => { e.stopPropagation(); props.onDraftCraft(); }
},
h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
h('path', { d: 'm8 15 2.5-3 2 2 3.5-4 2 3' }),
h('path', { d: 'm16.5 3 .5-1 .5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5Z' })
)
)
: null,
props.onRefresh
? h('button', {
class: 'icon-btn inspector__panel-refresh',
type: 'button',
title: 'Refresh preview',
'aria-label': 'Refresh preview',
disabled: !props.isVisible,
onClick: (e) => { e.stopPropagation(); props.onRefresh(); }
},
h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
h('path', { d: 'M12 4V1L7 6l5 5V7c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8Z', fill: 'currentColor' })
)
)
: null,
props.onTypeBar
? h('button', {
class: 'icon-btn inspector__panel-typebar',
type: 'button',
title: 'Type into page',
'aria-label': 'Type into page',
disabled: !props.isVisible,
onClick: (e) => { e.stopPropagation(); props.onTypeBar(); }
},
h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
h('rect', { x: 3, y: 6, width: 18, height: 12, rx: 2 }),
h('path', { d: 'M6 10h4M6 14h2M12 14h6' })
)
)
: null,
h('button', {
class: 'inspector__panel-eye' + (isVisible ? ' is-visible' : ''),
type: 'button',
'aria-label': toggleAria,
'aria-pressed': String(isVisible),
title: toggleAria,
onClick: () => props.onToggle(props.id)
},
// Eye-open glyph when the panel is visible, eye-closed
// when it's hidden. Drawn as inline SVG so it inherits
// the current color and matches the rest of the chrome
// iconography.
isVisible
? h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
h('path', { d: 'M12 5C5 5 1 12 1 12s4 7 11 7 11-7 11-7-4-7-11-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z', fill: 'currentColor' }),
h('circle', { cx: 12, cy: 12, r: 2.2, fill: 'currentColor' })
)
: h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
h('path', { d: 'M2 5l2-2 18 18-2 2-3.4-3.4A12.8 12.8 0 0 1 12 19c-7 0-11-7-11-7a18.6 18.6 0 0 1 4.1-4.5L2 5Zm10 4a3 3 0 0 1 3 3l-3-3Zm0-4c7 0 11 7 11 7a18.4 18.4 0 0 1-3.3 3.9l-2.5-2.5A4 4 0 0 0 12 8a4 4 0 0 0-.6 0L9.3 5.9A11.5 11.5 0 0 1 12 5Z', fill: 'currentColor' })
)
)
)
),
h('div', { class: 'inspector__panel-body' },
isVisible ? props.children : null
)
);
}
// EscapeToExit — mount a keydown listener that calls `onExit` for one Escape
// press. Registered on `document` in the *bubble* phase (no capture flag), so
// a sheet opened from inside the focused panel — the Styles edit sheet, the
// Add-property browser's confirm, a detail sheet — handles the key first via
// useModal's capture-phase listener and stops it there. Without that ordering
// a single Escape would close the sheet *and* the full-screen panel under it.
//
// Deliberately not useModal: that hook is for a modal overlay (it traps Tab,
// restores focus, claims a slot on the modal stack). Full screen here is not a
// modal — the surface below already carries `role="dialog"` and its own Escape
// path, and the only thing this adds is a key handler that is not tied to a
// sheet's mount.
function EscapeToExit(props) {
const exitRef = useRef(props.onExit);
exitRef.current = props.onExit;
useEffect(() => {
function onKeyDown(event) {
if (event.key !== 'Escape' || event.defaultPrevented) return;
if (exitRef.current) exitRef.current();
}
document.addEventListener('keydown', onKeyDown);
return () => document.removeEventListener('keydown', onKeyDown);
}, []);
return null;
}
// FocusBody — render a panel body inside the full-screen surface.
//
// Kept as a component (rather than calling `render` directly in the overlay's
// JSX) because the body is a *remount*: it is a different DOM node from the one
// in the stacked layout, and Preact needs a stable vnode type for it. It holds
// no state of its own, so the panels' own effects — the console's virtual list,
// the Styles panel's pinned-stack measurement, the preview's capture loop — run
// against this node for as long as the overlay is up, which is what makes the
// overlay a working surface rather than a screenshot of one.
function FocusBody(props) {
return props.render(props.id);
}

// StatusPill — colored leading-dot pill that surfaces the current
// connection state. The previous design was a muted <span ref>;
// the new one uses Preact state so the tone updates on every
// change and the user can read the connection at a glance. The
// tone is derived from the text by classifyStatus, so callers
// keep their imperative `setStatus("saved.")` shape.
function classifyStatus(msg) {
  if (!msg) return 'idle';
  const m = String(msg).toLowerCase();
  if (/fail|error|disconnected|reject|abort|invalid|missing|denied|unknown/.test(m)) return 'danger';
  if (/warn/.test(m)) return 'warn';
  if (/reload|saved|connected|navigat|opened|closed|fetching|loading|saving|connecting|navigating|opening/.test(m)) return 'busy';
  if (/targets/.test(m)) return 'ok';
  return 'info';
}
function StatusPill(props) {
  const tone = classifyStatus(props.text);
  return h('span', {
    class: 'inspector__statuspill inspector__statuspill--' + tone,
    role: 'status',
    'aria-live': 'polite'
  },
    h('span', { class: 'inspector__statuspill-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'inspector__statuspill-text' }, props.text || '')
  );
}
function InspectActionsMenu(props) {
  const [open, setOpen] = useState(false);
  const actionsRef = useRef(null);
  useClickOutside(actionsRef, () => setOpen(false), open);
  return h('div', { ref: actionsRef, class: 'inspector__actions' },
    h('button', {
      class: 'icon-btn inspector__actions-btn',
      type: 'button',
      'aria-haspopup': 'true',
      'aria-expanded': String(open),
      'aria-label': 'Tab actions',
      title: 'Tab actions',
      onClick: (e) => { e.stopPropagation(); setOpen(!open); }
    }, '…'),
    h('div', {
      class: 'inspector__actions-pop',
      hidden: !open,
      role: 'menu',
      onClick: (e) => e.stopPropagation()
    },
      h('button', { type: 'button', role: 'menuitem', onClick: () => { setOpen(false); props.onReload(); } }, 'Reload'),
      h('button', { type: 'button', role: 'menuitem', onClick: () => { setOpen(false); props.onOpenInNewTab(); } }, 'Open in new tab'),
      h('button', { type: 'button', role: 'menuitem', onClick: () => { setOpen(false); props.onShowAll(); } }, 'Show all panels'),
      h('div', { class: 'inspector__actions-pop-sep' }),
      h('button', { type: 'button', role: 'menuitem', 'data-danger': '1', onClick: () => { setOpen(false); props.onClose(); } }, 'Close tab')
    )
  );
}

// Panel chip icons. Inline SVG keeps the panelbar a single 36 px
// row at 360 px (4 icon chips + gaps ≈ 152 px) instead of the
// previous text-label design that wrapped the chips onto a
// second line for "Show all" (104 px tall on a phone). Each
// chip keeps its text label as a tooltip + aria-label for
// screen readers; on screen only the glyph shows, the iOS
// DevTools-style segmented-control pattern.
const PANEL_ICONS = {
  preview: h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
    h('path', { d: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm2 0v14h14V5H5Zm2 10h10v-2H7v2Zm0-4h10V9H7v2Zm0-4h6V5H7v2Z', fill: 'currentColor' })
  ),
  styles: h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
    h('path', { d: 'M4 4h16v3H4V4Zm0 5h14v2H4V9Zm0 4h12v3H4v-3Zm0 5h10v2H4v-2Z', fill: 'currentColor' })
  ),
  console: h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
    h('path', { d: 'M3 4h18v3H3V4Zm0 5h12v2H3V9Zm0 4h18v2H3v-2Zm0 4h12v3H3v-3Z', fill: 'currentColor' })
  ),
  network: h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
    h('path', { d: 'M12 3a9 9 0 0 0-9 9h2a7 7 0 0 1 14 0h2a9 9 0 0 0-9-9Zm0 4a5 5 0 0 0-5 5h2a3 3 0 0 1 6 0h2a5 5 0 0 0-5-5Zm0 4a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm-9 6h18v2H3v-2Z', fill: 'currentColor' })
  ),
  overview: h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
    h('path', { d: 'M3 4h7v7H3V4Zm0 9h7v7H3v-7Zm9-9h9v4h-9V4Zm0 6h9v10h-9V10Z', fill: 'currentColor' })
  )
};
export function InspectorView() {
  const urlInput = useRef(null);
  const pageUrlInput = useRef(null);
  const navUrlInput = useRef(null);
  const saveBtn = useRef(null);
  // status pill — Preact state instead of a DOM ref. The previous
  // design wrote text directly to a muted <span ref>; the new one is
  // a colored leading-dot pill that re-renders on every change so the
  // user can read the connection state at a glance. The imperative
  // call paths (save / load / navigate / open new tab / close tab /
  // reload) still say `setStatus('saved.')`; classifyStatus picks a
  // tone from the text.
  const [statusText, setStatusText] = useState('');
  function setStatus(value) { setStatusText(value == null ? '' : String(value)); }
  const [consoleCount, setConsoleCount] = useState(0);
  const [networkCount, setNetworkCount] = useState(0);
  const consoleCountRef = useRef((n) => setConsoleCount(n | 0));
  const networkCountRef = useRef((n) => setNetworkCount(n | 0));
  consoleCountRef.current = (n) => setConsoleCount(n | 0);
  networkCountRef.current = (n) => setNetworkCount(n | 0);
  const [debuggerUrl, setDebuggerUrl] = useState('');
  const [targets, setTargets] = useState([]);
  const [currentTarget, setCurrentTarget] = useState(null);
  const [cdpReady, setCdpReady] = useState(false);
  // navHistory — the attached tab's session history, as the two history
  // arrows need it: whether there is an entry behind and ahead of the current
  // one. Read once after a navigation settles (onTargetNavigated) rather than
  // on every render, so the arrows stay honest without a per-tick CDP read.
  // `null` means "not read yet": both arrows stay enabled and the tap falls
  // back to the server's own verdict, which is what keeps the row usable when
  // the read fails (an older target, a CDP hiccup).
  const [navHistory, setNavHistory] = useState(null);
// navHistoryBusy — serializes the history reads the nav row issues.
// onTargetNavigated fires for every lifecycle event, and a redirect chain or
// a history rewrite loop would otherwise stack one CDP round-trip per event;
// the newest answer is the only one worth having.
const navHistoryBusy = useRef(false);
// currentTargetRef — the attached target as the *latest* value, for the
// helpers that run from callbacks created in an earlier render (the CDP
// navigation handler, the history read's staleness check). Reading the state
// variable there would close over whatever target was current when that
// callback was built.
const currentTargetRef = useRef(null);
currentTargetRef.current = currentTarget;
  // visiblePanels: a Set of panel IDs currently rendered. Hydrated from
  // localStorage on mount; updated by the per-panel toggle. The single
  // 'panel' state from the previous design is gone — the new UI does
  // not switch between panels, it shows all toggled-on panels stacked.
  const [visiblePanels, setVisiblePanels] = useState(() => loadPanelState());
  const [detailItem, setDetailItem] = useState(null);
  // detailPayload — the Draft Craft payload built from the entry the detail
  // sheet is showing, set by its "Add to chat" button. While it is non-null
  // the DraftCraftSheet is open and the user picks the project + chat; the
  // entry stays in `detailItem`, so cancelling leaves the sheet where it was.
  const [detailPayload, setDetailPayload] = useState(null);
const [draftCraftImage, setDraftCraftImage] = useState(null);
// closePending — when non-null, the ConfirmSheet is shown and the
  // captured `target` is the page the user is about to close. A small
  // object instead of two pieces of state so cancel + confirm are
  // single-key updates and the sheet can read both fields without
  // racing (e.g. null target, open: true). `action` distinguishes
  // the two entry points ('row' = targets list, 'attached' =
  // inspect-phase header menu) so the confirm callback can route to
  // the right code path without keeping two separate flags.
  const [closePending, setClosePending] = useState(null);
  // viewportId — the active device-metrics preset for the inspected
  // page ('auto' clears the override). Persisted to localStorage so the
  // user's last preview size survives re-attach and reload.
  const [viewportId, setViewportId] = useState(() => {
    try { return localStorage.getItem(VIEWPORT_STATE_KEY) || 'auto'; } catch { return 'auto'; }
  });
  const [phase, setPhase] = useState('setup');
  const [, setTick] = useState(0);
  // Chrome profile management (see src/inspectorProfiles.js). The sheet is
  // only reachable from the setup phase, and the scan is read-only and
  // cheap, so this state lives here rather than in a store. `activeProfile`
  // is mirrored from /api/inspector/config so the setup screen can name the
  // active profile without opening the sheet.
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [profilesList, setProfilesList] = useState(null);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profilesError, setProfilesError] = useState('');
  const [activeProfile, setActiveProfile] = useState(null);
  const consoleEntries = useRef([]);
  const networkEntries = useRef([]);
  const consoleVL = useRef(null);
  const networkVL = useRef(null);
  const reqMap = useRef(new Map());
  // previewRefreshRef — the Preview panel assigns its live manual-capture
  // handler to this ref on mount. The "Refresh preview" button in the
  // panel header reads it so it can push a fresh screenshot on tap,
  // independent of the slow fallback poll.
  const previewRefreshRef = useRef(null);
// previewFullscreenRef — the Preview panel assigns its full-screen toggle
// handler to this ref on mount. The panel header's full-screen button reads
// it so the viewport-spanning overlay opens on tap, keeping the full-screen
// state (and the portal) inside PreviewPanel.
const previewFullscreenRef = useRef(null);
// fullscreenOverlayRef — whether that viewport-spanning overlay is open.
// PreviewPanel owns the state and mirrors it here, because the card's full
// screen and the overlay are two destinations for one header button across all
// five cards, and the overlay has to win: it covers the whole viewport, so
// expanding the card *under* it would reveal a state the user never asked for
// the moment the overlay closed.
const fullscreenOverlayRef = useRef({ open: false });
// focusPanelId — which panel is in full screen, or '' for the normal stacked
// layout.
//
// Full screen is the *card* filling the region, not a second overlay: the set of
// full-screen surfaces in this view is already crowded (the Preview overlay
// above, Draft Craft, the sheets, the profile manager), and adding one more
// layer would mean one more z-index and one more Escape rule to keep in order.
// Instead the id is set here and the class is the card's own state marker
// (`.inspector__panel--fullscreen` in inspector-chrome.css, which carries the
// declaration): the surface below is a second mount of this card, and the
// marker is what says which one is the full-screen one. 470 computed rows in the
// viewport instead of ~350 px of a 667 px phone.
//
// Deliberately not persisted: a reload (or a reconnect) comes back to the
// stacked layout, because a full-screen card is a momentary reading mode and a
// remembered one would greet the next session with a screen the user cannot
// explain.
const [focusPanelId, setFocusPanelId] = useState('');
// A hidden card cannot be the full-screen card: its body is not mounted, so the
// mode would render an empty region with one header row in it. Closing the last
// visible panel is already refused in togglePanel, but `showAllPanels` and
// `loadPanelState` are both independent of this state, so the invariant is
// enforced here rather than assumed.
useEffect(() => {
if (focusPanelId && !visiblePanels.has(focusPanelId)) setFocusPanelId('');
}, [focusPanelId, visiblePanels]);
// The Preview overlay taking over ends the card mode — see fullscreenOverlayRef.
// The effect is unconditional (no dependency array) because the only way to learn
// that the overlay closed is to re-render, and the ref is written during the
// child's render, which is exactly a render of this component.
useEffect(() => {
if (fullscreenOverlayRef.current.open && focusPanelId) setFocusPanelId('');
});
// previewTypeBarRef — the Preview panel assigns a small handle ({ open })
// to this ref on mount so the panel header can toggle the "type into
// page" bar on demand (focus the input, scroll it into view). Keeps the
// per-render PreviewPanel identity stable, like refresh/fullscreen.
const previewTypeBarRef = useRef(null);
// Draft Craft is exposed through the Preview panel's existing toolbar so
// it never covers the screenshot or consumes a separate content row.
const previewDraftCraftRef = useRef(null);
// stylesPickRef — the Styles panel assigns its pick-from-point handler to
// this ref on mount. When "pick mode" is on, the PreviewPanel tap routes
// its tap coordinates here instead of clickAt (see onPreviewTap in the
// inspect render), so a tap selects an element for style editing rather
// than poking the page.
const stylesPickRef = useRef(null);
// stylesActive — whether "pick mode" is on. Used to decide onPreviewTap's
// routing and to toggle the pick-mode hint on the Preview panel header.
const [stylesActive, setStylesActive] = useState(false);
// stylesSelection — the Styles panel's live selection snapshot. The Inspector
// keeps its own copy (`selectionStore`) so the target bar and the receipt
// survive that panel being switched off: the selection belongs to the tab, not
// to one panel's mount. The panel clears this to null on unmount, which is what
// tells the store that the live read is gone and the retained copy is all there
// is (see selectionAcrossModes in targetBar.js).
const [stylesSelection, setStylesSelection] = useState(null);
// revealedSelectionRef — the objectId the last Styles-card reveal answered.
// The panel publishes its snapshot on every read (a refresh, an undo re-read),
// and only a *new* element should move the page scroller; re-reading the same
// one must leave the user where they were reading.
const revealedSelectionRef = useRef('');
// selectionStore — the retained snapshot. Written only from a live selection,
// never from the unmount clear, so switching Styles off keeps the element on
// screen while the user reads Console output.
const [selectionStore, setSelectionStore] = useState(null);
useEffect(() => {
  if (stylesSelection && String(stylesSelection.label || '').trim()) setSelectionStore(stylesSelection);
}, [stylesSelection]);
// receipt — the session's edits, owned HERE rather than in the Styles panel.
//
// This is what T4 is for: the receipt has to outlive the panel that made the
// writes. It is recorded by the panel (which knows the value before the write)
// but stored, rendered and *reversed* above the panels, using the objectId the
// Inspector retains — so switching the Styles panel off, or moving to Console,
// leaves an undo list that still works and still describes the element on
// screen. The panel renders its own strip from this same list.
const [receipt, setReceipt] = useState([]);
// receiptNonce — bumped after an undo performed from above, so the Styles panel
// re-reads the element (its own copy of the declarations is now stale).
const [receiptNonce, setReceiptNonce] = useState(0);
function recordReceipt(change) {
setReceipt((prev) => recordChange(prev, change));
}
// ---- Intent (Part H) ---------------------------------------------------
//
// The describe-a-change surface. Three pieces, in order:
//
//   proposeIntent(text) — build the prompt from what the panel already read
//     (the element, its declarations, the page's values and tokens) and send it
//     through the app's existing model client. No new page scrape: the context
//     is the selection snapshot the target bar renders from.
//   applyIntent(writes) — one `style.setProperty` per line through the same
//     handler every other edit uses, and one receipt entry per property, so the
//     whole intent is undoable exactly like a hand-made edit.
//
// The inspector has no models of its own: it uses whichever model the project
// has configured for chat, which is what "reuses the app's existing model
// client" means. With none configured the request fails with a message that
// says so, rather than a spinner that never resolves.
async function proposeIntent(text) {
const selection = selectionAcrossModes(stylesSelection, selectionStore);
if (!selection) throw new Error('Select an element first.');
const modelId = await currentModelId();
if (!modelId) throw new Error('No model configured. Add one in Settings → Models, then try again.');
// The context the prompt is built from: the element, its own declarations, the
// page values and tokens for the properties it declares, and the element's own
// values (the strongest evidence). All of it is already in hand.
const index = {};
const props = new Set(((selection.declared || []).map((d) => String(d.prop || '').toLowerCase())) || []);
// The page index rides on the Styles panel's snapshot; without the panel there
// is no index, and the prompt then says so rather than inventing values.
const pageIndex = (stylesSelection && stylesSelection.index) || null;
for (const prop of pageIndex ? Object.keys(pageIndex.props || {}) : []) {
if (!props.has(prop) && props.size) continue;
const bucket = pageIndex.props[prop];
if (bucket) index[prop] = { values: (bucket.values || []).map((v) => v.value).slice(0, 12) };
}
const tokens = (pageIndex && pageIndex.tokens ? pageIndex.tokens : [])
.map((t) => ({ property: '', name: t.name, value: t.resolved || t.value, count: t.count || 0 }))
.filter((t) => t.value && !/^var\(/i.test(t.value));
const prompt = buildIntentPrompt(text, {
label: selection.label || '',
tag: (selection.label || '').split(/[.#]/)[0],
size: selection.size || '',
role: '',
declared: (selection.declared || []).map((d) => ({ prop: d.prop, value: d.value })),
index,
tokens
});
const projectDir = (activeProject && activeProject.value && activeProject.value.dir) || '';
const r = await fetchJson('/api/ai/chat', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
modelId,
projectDir,
messages: [
{ role: 'system', content: prompt.system },
{ role: 'user', content: prompt.user }
]
})
});
if (r.status !== 200) {
throw new Error((r.body && r.body.error) || ('the model request failed (HTTP ' + r.status + ')'));
}
return String((r.body && r.body.text) || '');
}
// currentModelId — the model the project is configured to use. The same list
// the chat picker reads, with the recent-model order as the preference, so the
// inspector and the chat agree on the default without a second setting.
async function currentModelId() {
const projectDir = (activeProject && activeProject.value && activeProject.value.dir) || '';
try {
const recent = await fetchJson('/api/settings/models/recent?projectDir=' + encodeURIComponent(projectDir));
const fromRecent = recent.status === 200 && recent.body && Array.isArray(recent.body.recent)
? recent.body.recent[0] : null;
if (fromRecent && fromRecent.modelId) return fromRecent.modelId;
} catch { /* fall through to the model list */ }
try {
const models = await fetchJson('/api/ai/models?projectDir=' + encodeURIComponent(projectDir));
const first = models.status === 200 && models.body && Array.isArray(models.body.models)
? models.body.models[0] : null;
return first ? first.id : '';
} catch { return ''; }
}
// applyIntent — write the ticked lines, one property at a time.
//
// Each write reads the property's current value first, so the receipt records
// the true "before" and the whole intent unwinds to the state it started in.
// The receipt is the Inspector's own, so this works with the Styles panel off.
async function applyIntent(writes) {
const objectId = selectionStore && selectionStore.objectId;
if (!objectId || !handlers || !handlers.setInlineStyleProperty) {
throw new Error('No element selected.');
}
for (const w of writes || []) {
if (!w || !w.prop) continue;
const prev = ((selectionStore && selectionStore.declared) || [])
.filter((x) => String(x.prop).toLowerCase() === String(w.prop).toLowerCase())
.map((x) => x.value)[0] || '';
await handlers.setInlineStyleProperty(objectId, w.prop, w.value);
recordReceipt({ prop: w.prop, from: prev, to: w.value });
}
// Re-read so the bar's origin sentence, the Declared list and the Computed list
// all describe the page the intent just changed (the panel does this through
// its own mount; the nonce covers the case where it is switched off).
if (handlers.refreshNodeModel) {
const fresh = await handlers.refreshNodeModel(objectId);
if (fresh) {
const inline = (fresh.inlineProps || []).map((x) => ({ prop: x.prop, value: String(x.value || '') }));
setSelectionStore((prev) => (prev && prev.objectId === objectId ? { ...prev, declared: inline } : prev));
}
}
setReceiptNonce((n) => n + 1);
rerender();
return { ok: true, count: (writes || []).length };
}
// intentContext — what the Intent panel validates proposals against: the
// element's own declarations, the page's values and tokens for them, and the
// numeric step of each scale. Assembled from the retained selection, so a
// proposal is checked against the same evidence the prompt was built from.
function intentContext() {
const selection = selectionAcrossModes(stylesSelection, selectionStore);
if (!selection) return {};
const pageIndex = (stylesSelection && stylesSelection.index) || null;
const index = {};
const declared = (selection.declared || []).map((d) => ({ prop: String(d.prop || '').toLowerCase(), value: d.value }));
const wanted = new Set(declared.map((d) => d.prop));
for (const prop of wanted) {
const bucket = pageIndex && pageIndex.props ? pageIndex.props[prop] : null;
if (!bucket) continue;
const scale = (bucket.values || []).map((v) => v.value);
index[prop] = { values: scale, step: null, unit: '' };
}
const tokens = (pageIndex && pageIndex.tokens ? pageIndex.tokens : [])
.map((t) => ({ property: '', name: t.name, value: t.resolved || t.value, count: t.count || 0 }));
return { declared, index, tokens };
}
// undoEntryFromBar — reverse one entry against the retained element.
//
// The plan decides whether to restore a value or remove a property that did not
// exist before (see scope.js), so an undo never writes an empty value: that is
// the same to the browser as a removal but a different action to read back.
async function undoEntryFromBar(entry) {
  const plan = undoPlan(entry);
  const objectId = selectionStore && selectionStore.objectId;
  if (!plan || !objectId || !handlers) return;
  try {
    if (plan.kind === 'remove') {
    if (handlers.removeInlineStyleProperty) await handlers.removeInlineStyleProperty(objectId, plan.prop);
    } else if (handlers.setInlineStyleProperty) {
    // The plan's priority restores the declaration's cascade weight as well as
    // its value: an undo that put a value back but dropped its `!important`
    // would leave the element in a state this session never created.
    await handlers.setInlineStyleProperty(objectId, plan.prop, plan.value, plan.priority);
    }
    setReceipt((prev) => prev.filter((x) => String(x.prop).toLowerCase() !== String(plan.prop).toLowerCase()));
    // Re-read the element so the retained snapshot stays true while the Styles
    // panel is off: without this the bar's origin sentence keeps describing the
    // value the undo just replaced, because the only other reader of the page is
    // the panel — which is exactly the one that is not mounted.
    if (handlers.refreshNodeModel) {
      const fresh = await handlers.refreshNodeModel(objectId);
      if (fresh) {
        const inline = (fresh.inlineProps || []).map((x) => ({ prop: x.prop, value: String(x.value || '') }));
        setSelectionStore((prev) => (prev && prev.objectId === objectId
        ? { ...prev, declared: inline }
        : prev));
      }
    }
  } catch (e) {
    setStatus((e && e.message) || 'could not undo ' + plan.prop);
    return;
  }
  setReceiptNonce((n) => n + 1);
  rerender();
}
// undoAllFromBar — newest first, so a property edited twice unwinds in one pass
// and cannot be left holding a value a later entry wrote.
async function undoAllFromBar() {
  const entries = undoOrder(receipt);
  for (const entry of entries) {
    // Sequential on purpose: each write re-reads the element, and two writes to
    // the same property must not race.
    // eslint-disable-next-line no-await-in-loop
    await undoEntryFromBar(entry);
  }
  setReceipt([]);
  rerender();
}
// copyElementSelector — what the element button in the Styles panel header
// does on tap: copy `div#id.class` to the clipboard (the desktop Styles pane's
// "Copy selector"). The label is the panel's own `tag#id.class` string, so no
// second selector builder exists here, and the outcome goes to the status pill
// above the panels rather than a toast — that pill is already the one line in
// the view that reports the result of a tap, and it is where a refused
// clipboard write has to be visible.
async function copyElementSelector(label) {
const text = String(label || '');
if (!text) return;
const ok = await copyText(text);
setStatus(ok ? 'copied selector ' + text : 'could not copy the selector');
}
// stylesHandlesRef — the Styles panel's own actions (selectAncestor / clear /
// refresh), published so the identity strip inside that panel and any future
// caller reach one implementation instead of two. The selection
// stays owned by the panel: these calls land on exactly the same code path as
// the panel's own controls, which is what keeps the highlight, the pinned
// preview and the changed-set reset in sync.
const stylesHandlesRef = useRef(null);
// intentOpen — the Intent surface (Part H). It is NOT a sixth panel: PANELS is
// the panel list the feature inventory pins, and the Intent surface is a
// different kind of thing (a request box and a cited diff, not an inspection
// view of the connected page). It is toggled from the panel bar and persists
// like the bar's collapse state, so a user who works this way keeps it.
const [intentOpen, setIntentOpen] = useState(() => loadIntentState());
function toggleIntent() {
setIntentOpen((prev) => {
const next = !prev;
saveIntentState(next);
return next;
});
rerender();
}

// When a panel becomes hidden the corresponding virtual-list
// child unmounts and runs its own `vl.destroy()` cleanup, but
// the parent's `consoleVL.current` / `networkVL.current` still
// point at the destroyed list. The next CDP event would call
// `vl.setData(...)` on the destroyed instance — a no-op, but
// wasteful. Clear the refs eagerly on visibility transitions so
// events.js's `if (vl)` short-circuit fires instead.
useEffect(() => {
  if (!visiblePanels.has('console') && consoleVL.current) {
    try { consoleVL.current.setData([]); } catch { /* destroyed */ }
    consoleVL.current = null;
  }
}, [visiblePanels]);
  useEffect(() => {
    if (!visiblePanels.has('network') && networkVL.current) {
      try { networkVL.current.setData([]); } catch { /* destroyed */ }
      networkVL.current = null;
    }
  }, [visiblePanels]);
  // Run the CDP screencast only while a connected Preview is visible. Effect
  // cleanup sends stop immediately; CDP command ordering makes rapid hide/show
  // transitions resolve as start → stop → start without stale async ownership.
  useEffect(() => {
    const handlers = eventHandlers.current;
    if (!cdpReady || !visiblePanels.has('preview') || !handlers) return;
    handlers.startPreviewStream().catch(() => { /* screenshot fallback remains active */ });
    return () => handlers.stopPreviewStream().catch(() => { /* disconnected */ });
  }, [cdpReady, visiblePanels]);

  function rerender() { setTick(t => t + 1); }

  const conn = useRef(null);
  const eventHandlers = useRef(null);

  function onTargetNavigated(newUrl, newTitle) {
  applyViewport(viewportId);
  if (!newUrl) return;
  setCurrentTarget((prev) => {
  if (!prev) return prev;
  return {
  ...prev,
  url: newUrl,
  title: newTitle || newUrl
  };
  });
  if (navUrlInput.current) {
  navUrlInput.current.value = newUrl;
  }
  // Re-read the session history now that a navigation has landed *and* the
  // address bar is showing the new URL. This is the only moment the two
  // history arrows can change: every path that moves the cursor (the arrows
  // themselves, the Go field, Reload, a link tapped in the preview) ends in
  // this event. Reading here rather than per render is also what keeps a
  // page that fires navigations in a burst — a redirect chain, a history
  // rewrite loop — from issuing one CDP read per event: the read is keyed on
  // the URL the browser actually settled on.
  refreshNavHistory(newUrl);
    // Query the page document.title via CDP Runtime.evaluate to get the real title
    if (conn.current && conn.current.cdpSend) {
      conn.current.cdpSend('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
        .then((r) => {
          const t = r && r.result && r.result.value;
          if (t && typeof t === 'string') {
            setCurrentTarget((prev) => prev ? { ...prev, title: t } : prev);
          }
        })
        .catch(() => {});
    }
    rerender();
  }

  function initCdp(options) {
    conn.current = createCdpConnection();
    const state = {
      consoleEntries, networkEntries, reqMap, consoleVL, networkVL,
      captureBeyondViewport: !options || options.captureBeyondViewport !== false,
      cdpSend: conn.current.cdpSend,
      onNavigate: onTargetNavigated,
      rerender,
      consoleCountRef, networkCountRef
    };
    eventHandlers.current = createEventHandlers(state);
    return conn.current;
  }

  function disconnect() {
  if (conn.current) conn.current.disconnect();
  conn.current = null;
  eventHandlers.current = null;
  setCdpReady(false);
  // Full screen is a mode of a live session, so detaching leaves it: the region
  // is about to render the targets list, and a remembered focus id would hide
  // every card of the next attach as soon as the panels came back.
  if (focusPanelId) exitPanelFullscreen();
  reqMap.current.clear();
  setCurrentTarget(null);
  // The history snapshot belongs to the tab that was attached; a new attach
  // must not inherit the previous tab's back/forward availability.
  setNavHistory(null);
  navHistoryBusy.current = false;
    consoleEntries.current = [];
    networkEntries.current = [];
    setDetailItem(null);
    if (consoleVL.current) { try { consoleVL.current.setData([]); } catch { /* ignore */ } }
    if (networkVL.current) { try { networkVL.current.setData([]); } catch { /* ignore */ } }
    setStatus('');
  }

  // applyViewport — push the chosen size preset to the inspected page
  // via CDP Emulation.setDeviceMetricsOverride (or clear it for 'auto').
  // Persists the choice so re-attach / reload restore the same size.
  function applyViewport(id) {
    const next = id || 'auto';
    setViewportId(next);
    try { localStorage.setItem(VIEWPORT_STATE_KEY, next); } catch { /* ignore */ }
    const handlers = eventHandlers.current;
    const preset = VIEWPORT_PRESETS.find((p) => p.id === next);
    if (handlers && handlers.setViewportSize) {
      handlers.setViewportSize(preset && preset.width ? preset : null).catch(() => { /* emulation unavailable */ });
    }
  }

  function connect(target) {
    if (conn.current) disconnect();
    const hasPdfViewer = hasPdfViewerTarget(target, targets);
    const c = initCdp({ captureBeyondViewport: !hasPdfViewer });
    const handlers = eventHandlers.current;
    setCurrentTarget(target);
    setPhase('inspect');
    consoleEntries.current = [];
    networkEntries.current = [];
    setStatus('connecting…');
    const result = c.connect(debuggerUrl, target.id);
    if (result.error) {
      setStatus(result.error);
      return;
    }
        result.ws.addEventListener('open', () => {
        setStatus('connected to ' + (target.title || target.url || target.id));
        c.cdpSend('Runtime.enable').catch((err) => { setStatus('Runtime.enable failed: ' + err.message); });
        c.cdpSend('Network.enable').catch((err) => { setStatus('Network.enable failed: ' + err.message); });
        // DOM.enable + CSS.enable power the Styles panel (DOM.getNodeForLocation,
        // CSS.getComputedStyleForNode, CSS.getBoxModel etc.). Both are non-fatal:
        // the Styles panel degrades to "no element" if either is unavailable.
        c.cdpSend('DOM.enable').catch(() => { /* styles panel unavailable */ });
        c.cdpSend('CSS.enable').catch(() => { /* computed styles unavailable */ });
        c.cdpSend('Page.enable')
        .then(() => setCdpReady(true))
        .catch(() => { /* preview unavailable */ });
        // First history read for the tab we just attached to, so the two arrows
        // start in the right state — a tab the user arrived at by clicking a link
        // has an entry behind it, a fresh tab has neither. The read goes through
        // the server (its own short-lived target socket), so it does not have to
        // wait for this connection's Page.enable to resolve.
        refreshNavHistory(null);
        // Restore the user's last preview size (device-metrics override).
        // Runs right after Page.enable so the override is applied before the
        // first screenshot capture. 'auto' clears any previous override.
        applyViewport(viewportId);
        c.cdpSend('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }).catch(() => { /* emulation unavailable */ });
        c.cdpSend('Performance.enable').catch(() => { /* metrics unavailable */ });
        c.cdpOn('Runtime.consoleAPICalled', handlers.onConsoleEvent);
        c.cdpOn('Runtime.exceptionThrown', handlers.onExceptionEvent);
        c.cdpOn('Network.requestWillBeSent', handlers.onRequestWillBeSent);
        c.cdpOn('Network.responseReceived', handlers.onResponseReceived);
        c.cdpOn('Network.loadingFinished', handlers.onLoadingFinished);
        c.cdpOn('Network.loadingFailed', handlers.onLoadingFailed);
        c.cdpOn('Page.frameNavigated', handlers.onFrameNavigated);
        c.cdpOn('Page.navigatedWithinDocument', handlers.onNavigatedWithinDocument);
      });
    result.ws.addEventListener('close', (ev) => {
      setCdpReady(false);
      const code = ev && typeof ev.code === 'number' ? ev.code : 0;
      setStatus('disconnected (code ' + code + ')');
      
    });
    result.ws.addEventListener('error', () => {
      // The browser WS error event carries no message. If the server
      // rejected the upgrade it sent a typed JSON body as the close
      // reason — show that instead of the generic "WebSocket error".
      const proxyMsg = c.lastProxyError && c.lastProxyError.current;
      setStatus(proxyMsg || 'WebSocket error');
    });
    rerender();
  }

  async function loadConfig() {
    let r;
    try {
      r = await fetchJson('/api/inspector/config');
      if (r.status !== 200) { setStatus('HTTP ' + r.status); return; }
    setDebuggerUrl(r.body.url || '');
    if (urlInput.current) urlInput.current.value = r.body.url || '';
    setActiveProfile(r.body.activeProfile || null);
    setStatus((r.body.url || '') ? ('current: ' + r.body.url) : 'using default: ' + r.body.defaultUrl);
      rerender();
      // Auto-discover on mount when a debugger URL is already saved.
      // Returning users land on the targets list directly instead of
      // being sent back to the setup screen on every visit. Deferred
      // to the next tick so the targets phase's StatusPill is
      // mounted by the time loadTargets writes to it — the setup
      // phase's <span> would otherwise receive the message.
      if (r.body.url) setTimeout(loadTargets, 0);
    } catch (e) {
      // Outer catch: an exception in any of the state setters or DOM
      // writes below (e.g. from a mid-fetch unmount) would otherwise
      // surface as an unhandled rejection that the user can't see and
      // that also aborts the auto-discovery chain. Surface it on the
      // status line instead.
      setStatus('inspector: ' + (e && e.message || String(e)));
    }
  }

  async function saveConfig() {
    if (!urlInput.current) return;
    const next = (urlInput.current.value || '').trim();
    if (!next) { setStatus('url is required'); return; }
    saveBtn.current.disabled = true;
    setStatus('saving…');
    let r;
    try { r = await fetchJson('/api/inspector/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: next }) }); }
    catch (e) { setStatus('network error'); if (saveBtn.current) saveBtn.current.disabled = false; return; }
    if (saveBtn.current) saveBtn.current.disabled = false;
    if (r.status !== 200) { setStatus('HTTP ' + r.status); return; }
    setDebuggerUrl(r.body.url || next);
    // The server drops the active profile when the URL is typed by hand;
    // mirror that so the setup screen stops naming a profile it no longer
    // describes (see inspectorProfiles.clearActive).
    setActiveProfile((r.body && r.body.activeProfile) || null);
    setStatus('saved.');
  }

  // ---- Chrome profiles -------------------------------------------------
  // The whole block below is reached only through the setup screen's
  // PROFILES_ENTRY button, which is hidden by default, and through the
  // mounted sheet. It is kept intact so the feature can be flipped back on
  // with one flag instead of being rewritten.
  //
  // loadProfiles — fetch the discovered profile list. Read-only on the
  // server (it scans user-data-dirs and the settings store); no Chrome
  // needs to be running for this to succeed.
  async function loadProfiles() {
    setProfilesLoading(true);
    setProfilesError('');
    let r;
    try { r = await fetchJson('/api/inspector/profiles'); }
    catch (e) {
      setProfilesLoading(false);
      setProfilesError('network error loading profiles');
      return;
    }
    setProfilesLoading(false);
    if (r.status !== 200 || !r.body) {
      setProfilesError((r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status));
      return;
    }
    setProfilesList(r.body);
    rerender();
  }

  // openProfiles — the sheet is opened immediately and filled when the
  // scan returns, so a slow filesystem never looks like a dead button.
  function openProfiles() {
    setProfilesOpen(true);
    setProfilesError('');
    loadProfiles();
  }

  // switchProfile — make a profile the attach point. The server writes
  // that profile's endpoint into the global debugger URL, which is the
  // same value every other Inspector path already reads, so the URL field
  // is refreshed from the response rather than assumed.
  async function switchProfile(row) {
    if (!row || !row.id) return;
    if (row.active) { setProfilesOpen(false); return; }
    setStatus('switching to ' + row.label + '…');
    let r;
    try {
      r = await fetchJson('/api/inspector/profiles/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id })
      });
    } catch (e) { setStatus('network error switching profile'); return; }
    if (r.status !== 200 || !r.body || !r.body.url) {
      setStatus((r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status));
      return;
    }
    setDebuggerUrl(r.body.url);
    if (urlInput.current) urlInput.current.value = r.body.url;
    setActiveProfile(r.body.profile ? { id: r.body.profile.id, label: r.body.profile.label } : { id: row.id, label: row.label });
    setStatus('now using ' + row.label + ' at ' + r.body.url);
    setProfilesOpen(false);
    await loadProfiles();
    loadTargets();
  }

  // saveProfileEndpoint — remember a port for a profile without attaching
  // to it, so the user can pre-configure the second Chrome before
  // starting it.
  async function saveProfileEndpoint(row, url) {
    if (!row || !row.id) return;
    let r;
    try {
      r = await fetchJson('/api/inspector/profiles/endpoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, url })
      });
    } catch (e) { setProfilesError('network error saving endpoint'); return; }
    if (r.status !== 200 || !r.body || !r.body.url) {
      setProfilesError((r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status));
      return;
    }
    setProfilesError('');
    setStatus('saved endpoint for ' + row.label);
    await loadProfiles();
  }

  async function addProfileDir(dir) {
    let r;
    try {
      r = await fetchJson('/api/inspector/profiles/dirs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir })
      });
    } catch (e) { setProfilesError('network error adding folder'); return; }
    if (r.status !== 200) {
      setProfilesError((r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status));
      return;
    }
    setProfilesError('');
    setStatus(r.body.profiles + ' profile(s) in that folder');
    await loadProfiles();
  }

  async function removeProfileDir(dir) {
    let r;
    try { r = await fetchJson('/api/inspector/profiles/dirs?dir=' + encodeURIComponent(dir), { method: 'DELETE' }); }
    catch (e) { setProfilesError('network error removing folder'); return; }
    if (r.status !== 200) {
      setProfilesError((r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status));
      return;
    }
    setProfilesError('');
    await loadProfiles();
  }

  // pickProfileUrl — copy a profile's endpoint into the URL field without
  // saving it. This is the escape hatch for "this profile is not the one
  // I want active, but its endpoint is what I need to type".
  function pickProfileUrl(url) {
    if (!url) return;
    if (urlInput.current) urlInput.current.value = url;
    setStatus('copied ' + url + ' into the URL field — tap Save & discover');
    setProfilesOpen(false);
  }

  async function loadTargets() {
    setStatus('fetching targets…');
    let r;
    try { r = await fetchJson('/api/inspector/targets'); }
    catch (e) { setStatus('network error'); return; }
    if (r.status !== 200) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      setStatus(msg);
      return;
    }
    setTargets(r.body.targets || []);
    setPhase('targets');
    setStatus((r.body.targets || []).length + ' targets');
    rerender();
  }

  // actionTarget — Reload / Close for a row in the targets list. Works
  // from the target record alone (no connection needed); the server
  // talks CDP directly to the debug Chrome.
  async function actionTarget(t, action) {
    if (!t || !t.id) return;
    if (action === 'close') { requestClose('row', t); return; }
    setStatus('reloading ' + (t.title || t.url || 'tab') + '…');
    let r;
    try {
      r = await fetchJson('/api/inspector/reload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: t.id }) });
    } catch (e) {
      setStatus('network error');
      return;
    }
    if (r.status !== 200 || !r.body || !r.body.ok) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      setStatus('reload failed: ' + msg);
      return;
    }
    setStatus('reloaded');
  }

  // openAttachedPageInNewTab — "open in a new tab" for the page currently
  // being inspected. The header's "New tab" button sends the target's URL
  // to POST /api/inspector/open (Chrome Target.createTarget / json/new)
  // and reports the outcome on the status line. We do NOT attach to the
  // new tab and do NOT switch the current connection — the user asked for
  // a new tab, not a new inspection.
  async function openAttachedPageInNewTab() {
    const target = currentTarget;
    if (!target || !target.url) return;
    const url = target.url;
    setStatus('opening ' + url + ' in a new tab…');
    let r;
    try {
      r = await fetchJson('/api/inspector/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    } catch (e) {
      setStatus('network error opening new tab');
      return;
    }
    if (r.status !== 200 || !r.body || !r.body.target) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      setStatus('new tab failed: ' + msg);
      return;
    }
    setStatus('opened ' + url + ' in a new tab');
  }

  // closeAttachedTarget — deletes the tab being inspected. Confirms with
  // the user first (deleting a tab cannot be undone), then asks the
  // server to close it (POST /api/inspector/close), walks back to the
  // targets list and refreshes it. While the close is in flight the
  // current connection stays open so we can report the outcome; it is
  // torn down right before going back to the target list.
  function closeAttachedTarget() {
  const target = currentTarget;
  if (!target || !target.id) { setStatus('nothing to close'); return; }
  requestClose('attached', target);
}


  // requestClose / cancelClose / confirmClose — the in-app confirmation
  // flow for Close tab (it replaced the previous window.confirm, which
  // some embedded web views auto-dismiss and returned false without ever
  // showing a UI, so the rest of actionTarget early-returned and the
  // user saw exactly "the button does nothing").
  //
  // requestClose(action, target) — captures the target + origin so the
  // sheet can survive a re-render and the confirm callback knows which
  // code path to run ('row' = targets list, 'attached' = inspect-phase
  // header menu).
  //
  // cancelClose() — closes the sheet, no side effects, no network call.
  // A returning status pill ("closed" / "closing tab…" / "connected to
  // <title>") is not restored: the close path is the user's last tap,
  // and clearing the sheet is feedback enough.
  //
  // confirmClose() — closes the sheet and dispatches to the matching
  // runCloseRow / runCloseAttached flow. Both flows are async; the
  // sheet unmounts so the status pill is visible underneath while the
  // network round-trip runs. Errors surface on the pill instead of
  // re-opening the sheet, so the user always sees a single source of
  // truth about what happened.
  function requestClose(action, target) {
    if (!target || !target.id) return;
    setClosePending({ action, target });
  }
  function cancelClose() {
    setClosePending(null);
  }
  async function confirmClose() {
    const pending = closePending;
    if (!pending || !pending.target || !pending.target.id) { setClosePending(null); return; }
    const target = pending.target;
    setClosePending(null);
    if (pending.action === 'row') await runCloseRow(target);
    else await runCloseAttached(target);
  }
  // runCloseRow — close path used by the targets list: the target may
  // be a tab we never attached to, so just DELETE it via CDP and refresh
  // the list on success. Failure surfaces on the status pill.
  async function runCloseRow(target) {
    setStatus('closing ' + (target.title || target.url || 'tab') + '…');
    let r;
    try {
      r = await fetchJson('/api/inspector/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: target.id }) });
    } catch (e) {
      setStatus('network error');
      return;
    }
    if (r.status !== 200 || !r.body || !r.body.ok) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      setStatus('close failed: ' + msg);
      return;
    }
    setStatus('closed');
    loadTargets();
  }
  // runCloseAttached — close path used by the inspect-phase header menu:
  // the target is the page being inspected, so the in-flight CDP
  // connection survives the network round-trip and is torn down AFTER
  // the close succeeds (so status messages from the close can still
  // reach the pill). On success the user is returned to the targets
  // list, which is refreshed so the closed tab disappears.
  async function runCloseAttached(target) {
    setStatus('closing tab…');
    let r;
    try {
      r = await fetchJson('/api/inspector/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: target.id }) });
    } catch (e) {
      setStatus('network error closing tab');
      return;
    }
    if (r.status !== 200 || !r.body || !r.body.ok) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      setStatus('close failed: ' + msg);
      return;
    }
    disconnect();
    setPhase('targets');
    rerender();
    loadTargets();
  }

  // reloadAttachedTarget — reloads the tab being inspected (POST
  // /api/inspector/reload, CDP Page.reload on the target). The existing
  // connection survives; the page is gone for a moment, then comes back
  // and the preview / console / network panels keep streaming.
  async function reloadAttachedTarget() {
    const target = currentTarget;
    if (!target || !target.id) return;
    setStatus('reloading…');
    let r;
    try {
      r = await fetchJson('/api/inspector/reload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: target.id }) });
    } catch (e) {
      setStatus('network error reloading');
      return;
    }
    if (r.status !== 200 || !r.body || !r.body.ok) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      setStatus('reload failed: ' + msg);
      return;
    }
    setStatus('reloaded');
  }

  // refreshNavHistory — read the attached tab's session history
// (POST /api/inspector/history, CDP Page.getNavigationHistory on the
// target) so the nav row knows whether there is an entry behind and ahead
// of the current one. Two guards keep a burst of navigations from turning
// into a burst of reads: the call is skipped while the previous read is in
// flight, and the answer is dropped when the page has already moved on to
// another URL (`expectedUrl` vs. the live target) — a stale reply would
// otherwise enable the wrong arrow. A failed read clears the snapshot to
// `null`, which the arrows read as "unknown": both stay tappable and the
// server's own verdict answers the tap.
async function refreshNavHistory(expectedUrl) {
const target = currentTarget;
if (!target || !target.id || navHistoryBusy.current || !cdpReady) return;
navHistoryBusy.current = true;
try {
const r = await fetchJson('/api/inspector/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: target.id }) });
if (!r || r.status !== 200 || !r.body || typeof r.body.canGoBack !== 'boolean') {
setNavHistory(null);
return;
}
if (expectedUrl && movedOffUrl(expectedUrl)) return;
setNavHistory(r.body);
} catch (e) {
setNavHistory(null);
} finally {
navHistoryBusy.current = false;
}
}
// movedOffUrl — whether the attached tab has navigated away from `url` while
// a history read was in flight, i.e. the answer describes a page the user has
// already left. Read through a ref rather than as a hook dependency so the
// CDP-event path that calls it does not need `currentTarget` in scope.
function movedOffUrl(url) {
const t = currentTargetRef.current;
return !!(t && t.url && String(t.url) !== String(url));
}
// stepAttachedHistory — one arrow of the nav row. Both directions share the
// request, the error wording and the follow-up read, so back and forward
// cannot drift apart; only the status line and the "there was nowhere to go"
// sentence differ. `delta` is -1 for back and +1 for forward.
async function stepAttachedHistory(dir) {
const target = currentTarget;
if (!target || !target.id) return;
const back = dir === 'back';
const endpoint = back ? '/api/inspector/back' : '/api/inspector/forward';
setStatus(back ? 'going back…' : 'going forward…');
let r;
try {
r = await fetchJson(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: target.id }) });
} catch (e) {
setStatus(back ? 'network error going back' : 'network error going forward');
return;
}
if (r.status !== 200 || !r.body) {
const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
setStatus((back ? 'back' : 'forward') + ' failed: ' + msg);
return;
}
const moved = back ? r.body.wentBack : r.body.wentForward;
setStatus(moved ? (back ? 'went back' : 'went forward') : (back ? 'no page to go back to' : 'no page to go forward to'));
// The step itself fires Page.frameNavigated, which re-reads the history —
// but that event does not arrive when the step moved within the same
// document (hash navigation), so refresh here too. The in-flight guard
// makes the duplicate read a no-op.
if (moved) refreshNavHistory(null);
}
// goBackAttachedTarget — the nav row's back arrow. See
// stepAttachedHistory for the shared request/status handling.
async function goBackAttachedTarget() {
return stepAttachedHistory('back');
}
// goForwardAttachedTarget — the nav row's forward arrow, for a tab the user
// has already stepped back from.
async function goForwardAttachedTarget() {
return stepAttachedHistory('forward');
}

  // navigateAttachedTarget — navigates the tab being inspected to a new
  // URL (POST /api/inspector/navigate, CDP Page.navigate on the target).
  // The connection survives the navigation; the panels keep streaming.
  async function navigateAttachedTarget() {
    const target = currentTarget;
    const input = navUrlInput.current;
    if (!target || !target.id || !input) return;
    let wanted = (input.value || '').trim();
    if (!wanted) { setStatus('enter a url first'); return; }
    // Convenience: bare hosts like "localhost:3000" get http:// so the
    // user doesn't have to type the scheme.
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(wanted)) wanted = 'http://' + wanted;
    setStatus('navigating to ' + wanted + '…');
    let r;
    try {
      r = await fetchJson('/api/inspector/navigate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: target.id, url: wanted }) });
    } catch (e) {
      setStatus('network error navigating');
      return;
    }
    if (r.status !== 200 || !r.body || (typeof r.body.frameId !== 'string' && !r.body.errorText)) {
      const msg = (r.body && (r.body.error || r.body.errorText)) ? (r.body.error || r.body.errorText) : ('HTTP ' + r.status);
      setStatus('navigate failed: ' + msg);
      return;
    }
    setStatus('navigating to ' + wanted + '…');
  }

  // attachByPageUrl — one-step inspect: the user types a page URL and
  // the server tells Chrome to OPEN it in a fresh tab (Chrome /json/new),
  // then we attach straight to that brand-new target. No pre-opening the
  // tab yourself, no picking from the target list.
  async function attachByPageUrl() {
    const input = pageUrlInput.current;
    if (!input) return;
    let wanted = (input.value || '').trim();
    if (!wanted) { setStatus('enter a page url first'); return; }
    // Convenience: bare hosts like "localhost:3000" get http:// so the
    // user doesn't have to type the scheme.
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(wanted)) wanted = 'http://' + wanted;
    setStatus('opening ' + wanted + '…');
    let r;
    try {
      r = await fetchJson('/api/inspector/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: wanted }) });
    } catch (e) { setStatus('network error'); return; }
    if (r.status !== 200 || !r.body || !r.body.target) {
      const msg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
      setStatus(msg);
      return;
    }
    connect(r.body.target);
  }

  useEffect(() => { loadConfig(); return () => { disconnect(); }; }, []);

  if (phase === 'setup') {
    return h(Fragment, null,
      h('section', null,
        h('p', { class: 'hint' }, 'Start Chrome with ', h('code', null, '--remote-debugging-port=9222'), ' and paste its debugger URL below.'),
        h('div', { class: 'row' },
        h('label', { class: 'label', for: 'inspectorUrl' }, 'Chrome debugger URL'),
        h('input', { ref: urlInput, class: 'input', id: 'inspectorUrl', type: 'text', placeholder: 'http://127.0.0.1:9222' })
        ),
        // Chrome profile entry point. Shown above the actions because it *fills*
        // the URL field above: the one thing a user with two Chrome profiles
        // needs is "which of my profiles is this port", and that answer is not
        // something a URL field can give.
        // Gated by PROFILES_ENTRY (currently false) — see the note on that
        // constant for why the row no longer renders by default.
        PROFILES_ENTRY ? h('div', { class: 'inspector__profiles-row' },
        h('button', {
        class: 'btn inspector__profiles-open',
        type: 'button',
        'aria-haspopup': 'dialog',
        'aria-expanded': String(profilesOpen),
        onClick: (e) => { e.stopPropagation(); openProfiles(); }
        }, 'Chrome profiles'),
        activeProfile
        ? h('span', { class: 'inspector__profiles-active', title: 'Active Chrome profile' },
        'active: ', h('strong', null, activeProfile.label))
        : h('span', { class: 'inspector__profiles-active inspector__profiles-active--none' }, 'no profile selected')
        )
        : null,
        h('div', { class: 'row row--actions' },
        h(StatusPill, { text: statusText }),
        h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: () => { saveConfig().then(loadTargets); } }, 'Save & discover'),
        h('button', { class: 'btn', type: 'button', onClick: loadTargets }, 'Discover')
        )
        ),
        h('p', { class: 'hint hint--compact' }, 'Phone tip: ', h('code', null, 'adb reverse tcp:9222 tcp:9222'), ' then ', h('code', null, 'http://127.0.0.1:9222'), '.'),
        (PROFILES_ENTRY && profilesOpen)
        ? h(InspectorProfilesSheet, {
        list: profilesList,
        loading: profilesLoading,
        error: profilesError,
        onSwitch: switchProfile,
        onSaveEndpoint: saveProfileEndpoint,
        onAddDir: addProfileDir,
        onRemoveDir: removeProfileDir,
        onRefresh: loadProfiles,
        onPickUrl: pickProfileUrl,
        onClose: () => setProfilesOpen(false)
        })
        : null
        );
        }

  if (phase === 'targets') {
    return h(Fragment, null,
      h('div', { class: 'view-head' },
        h('a', { href: '#/inspector', class: 'view-back', 'aria-label': 'Back to inspector setup', onClick: (e) => { e.preventDefault(); disconnect(); setPhase('setup'); rerender(); } }, '←'),
        h('h2', { class: 'view-title' }, 'Pick a target')
      ),
      h('section', null,
        h('p', { class: 'hint' }, 'Type a page URL and Chrome opens it in a new tab with the inspector attached. Or tap a target below. Connection is over ', h('code', null, 'ws://'), ' via mouaif (port ' + String(window.location.port || 5732) + '); data flows both ways in real time.'),
        h('div', { class: 'row' },
          h('label', { class: 'label', for: 'inspectorPageUrl' }, 'Page URL'),
          h('input', { ref: pageUrlInput, class: 'input', id: 'inspectorPageUrl', type: 'url', placeholder: 'http://localhost:3000', onKeydown: (e) => { if (e.key === 'Enter') attachByPageUrl(); } })
        ),
        h('div', { class: 'row row--actions' },
          h('button', { class: 'btn btn--primary', type: 'button', onClick: attachByPageUrl }, 'Open & inspect'),
          h('button', { class: 'btn', type: 'button', onClick: loadTargets }, 'Refresh targets')
        ),
        h(StatusPill, { text: statusText }),
        targets.length
          ? h('ul', { class: 'inspector__row-targets', 'aria-label': 'Discoverable targets' },
              targets.map((t) => h(TargetRow, {
                target: t,
                key: t && t.id,
                onConnect: connect,
                onReload: (target) => actionTarget(target, 'reload'),
                onClose: (target) => actionTarget(target, 'close')
              }))
            )
          : h('div', { class: 'inspector__row-targets-empty', role: 'status' },
              h('p', null, 'No targets found.'),
              h('p', { class: 'inspector__row-targets-empty-hint' }, 'Open a tab in Chrome and tap ', h('strong', null, 'Refresh targets'), ' to discover it.')
            )
          ,
          closePending ? h(ConfirmSheet, {
            open: true,
            title: 'Close tab?',
            message: closeMessage(closePending.target),
            confirmLabel: 'Close tab',
            onCancel: cancelClose,
            onConfirm: confirmClose
          }) : null
      )
    );
  }

  const t = currentTarget;
  const handlers = eventHandlers.current;
  // onListTap — unified tap handler for both the console and the
  // network virtual lists. Identifies the row by the `__sig` we set
  // in the panel renderers (a `|`-separated id+rev), then walks the
  // matching virtual list for the row's full data record. The new
  // design renders both lists simultaneously when both panels are
  // visible, so the handler needs to know which list to look in
  // from the panel id rather than the previous single-active-tab
  // selector.
  function onListTap(panelId, ev) {
    const vl = panelId === 'console' ? consoleVL.current : networkVL.current;
    if (!vl) return;
    let node = ev.target;
    while (node && node !== ev.currentTarget && !node.__sig) node = node.parentNode;
    if (!node || !node.__sig) return;
    const sigId = node.__sig.split('|')[0];
    const data = vl.getData();
    const item = data.find((x) => x.id === sigId);
    if (!item) return;
    setDetailItem(item);
    rerender();
  }
  // addDetailItemToChat — the detail sheet's "Add to chat" button. Turn the
  // entry on screen into the Draft Craft text and open the project/chat
  // picker; the entry remains in `detailItem`, so cancelling the picker
  // returns to the same sheet. `activeProject()` supplies the default
  // project, matching how the file editor's Draft Craft opens.
  function addDetailItemToChat() {
    if (!detailItem) return;
    const text = buildEntryText(detailItem, {
      pageTitle: currentTarget && currentTarget.title,
      pageUrl: currentTarget && currentTarget.url
    });
    if (!text) return;
    setDetailPayload({
    projectDir: activeProject(),
    text,
    textLabel: 'inspector entry',
    description: 'Add this Inspector entry to any chat draft.'
    });
  }
  // revealPanelCard — bring one panel card into view inside the page
  // scroller (.app__main), under the pinned switcher. The panelbar is
  // `position: sticky; top: 0` on that scroller, so it stays on screen
  // while the cards scroll away under it: with all five panels on, the
  // Styles card can sit 800 px below the fold (measured at 375 x 667:
  // the chip row pinned at the top while the card's top was at +809).
  // A chip tap, a new selection or an armed pick mode all answer in a
  // card the user may not be looking at, so each of those reveals the
  // card it acts on instead of leaving the outcome off screen.
  //
  // `align: 'top'` puts the card's header just under the switcher —
  // showing a panel means showing its head. `align: 'bottom'` puts the
  // card's *bottom* edge at the bottom of the visible region instead,
  // which is what pick mode wants: the preview the user has to tap is
  // the first card's body, and aligning its top would leave the tap
  // surface below the fold.
  //
  // The scroll is instant, not smooth: a reveal is a consequence of the
  // tap the user just made, and an animated jump reads as the page
  // moving on its own. The sticky switcher is subtracted from the
  // visible region so a revealed card is never tucked underneath it.
  function revealPanelCard(id, align) {
  requestAnimationFrame(() => {
  const main = document.querySelector('.app__main');
  const card = document.querySelector('.inspector__panel[data-panel="' + id + '"]');
  if (!main || !card) return;
  const bounds = main.getBoundingClientRect();
  if (!bounds.height) return; // the view is not on screen; nothing to reveal into
  const bar = document.querySelector('.inspector__panelbar');
  const barBox = bar ? bar.getBoundingClientRect() : null;
  const top = barBox && barBox.height ? Math.max(bounds.top, barBox.bottom) : bounds.top;
  if (top >= bounds.bottom) return;
  const box = card.getBoundingClientRect();
  const pad = 6;
  if (align === 'bottom') {
  if (box.bottom <= bounds.bottom - pad && box.top >= top) return;
  main.scrollTop += box.bottom - (bounds.bottom - pad);
  return;
  }
  if (box.top >= top - pad && box.bottom <= bounds.bottom) return;
  main.scrollTop += box.top - top - pad;
  });
  }
  // togglePanel — flip a panel's visibility. The user's choice is
  // persisted to localStorage so it survives a reload and a new
  // target. If the user hides the last visible panel we keep it
  // visible (loadPanelState would also re-default on next load;
  // doing it here keeps the UI from being empty for a frame).
  // Showing a panel reveals its card: the tap that turned it on is a
  // request to look at it, and the card may be a screen away (see
  // revealPanelCard). Hiding one leaves the page where it is — the
  // cards below move up on their own and nothing new needs the eye.
  function togglePanel(id) {
  const prev = visiblePanels;
  let shown = false;
  let next;
  if (prev.has(id)) {
  if (prev.size === 1) return; // keep at least one visible
  // Hiding the focused card ends full screen, and the mode is cleared *before*
  // the visibility set is written: leaving it one render longer would show the
  // overlay of a panel the user just switched off.
  if (focusPanelId === id) setFocusPanelId('');
  next = new Set(prev);
  next.delete(id);
  } else {
  next = new Set(prev);
  next.add(id);
  shown = true;
  }
  savePanelState(next);
  setVisiblePanels(next);
  rerender();
  if (shown) revealPanelCard(id, 'top');
  }
  // showAllPanels — reset to the default "everything visible".
  // Wired to a button in the empty-state hint and to the toolbar's
  // reset action. Kept cheap (one state setter + persist) because
  // the panels remount on visibility change anyway.
  function showAllPanels() {
    const all = new Set(PANELS.map((p) => p.id));
    savePanelState(all);
    setVisiblePanels(all);
    rerender();
    }
    // togglePanelFullscreen — the panel header's full-screen button, for every card
    // except Preview (whose button keeps opening that panel's own viewport-spanning
    // overlay, because Preview's full screen already exists and is the fuller one:
    // a second screenshot surface with its own header, size presets and type bar).
    //
    // What it does is *one* state write. The card mode is an overlay rendered at the
    // document root (see `.inspector__fs` in inspector-fullscreen.css and the render
    // below), which is what makes it independent of the in-flow panel heights: the
    // Styles body is 52 dvh and the console/network bodies 32 dvh, and a mode that
    // only stretched them in place would still be capped by `.app__main`'s own
    // box — the list would be as tall as the region, but the region is exactly what
    // has the dead space in it. It also means the stacked layout underneath is
    // untouched (same scroll offsets, same mounted panels), so leaving full screen
    // is exactly the state the user left.
    //
    // Not persisted, on purpose: a reload comes back to the stacked layout, because
    // the mode is a momentary reading surface and a remembered one would greet the
    // next session with a screen the user cannot account for.
    function togglePanelFullscreen(id) {
    setFocusPanelId((prev) => (prev === id ? '' : id));
    rerender();
    }
    // exitPanelFullscreen — leave the card mode. Called from the places that end the
// session it belongs to (hiding the focused panel, detaching the target) rather
// than from the button, which is `togglePanelFullscreen` above. Exported for
// those callers; the button's own "leave" is the toggle reaching the same state.
function exitPanelFullscreen() {
setFocusPanelId('');
rerender();
}
    // Entering the Preview card's overlay full screen leaves the stacked layout
    // behind — see the `fullscreenOverlayRef` effect above.
    // PanelCard — one optional panel rendered as a card. The header
  // shows the panel label + a live eye toggle (showing the next
  // state, not the current one: open eye = "currently visible",
  // closed eye = "tap to hide"). The body is a flex child that
  // takes whatever vertical space remains; the `grow` prop tells
  // the first visible panel to take the leftover height, so a user
  // with one panel open gets a single full-height panel, and a
  // user with all four open gets four equal-height panels.
  const visibleIds = PANELS.map((p) => p.id).filter((id) => visiblePanels.has(id));
  const noPanelsVisible = visibleIds.length === 0;
  // Render the optional panels. Each card has its own header +
  // body; the first visible card also gets `grow` so the preview
  // (or whatever the user kept) fills the leftover height.
  // Console and Network each keep their own internal virtual-list
  // scroller — their body height is bounded by CSS so a busy page
  // doesn't force-grow the panel past the available viewport.
  const renderPanelBody = (id) => {
  if (id === 'preview') return h(PreviewPanel, {
  capture: handlers && handlers.captureScreenshot,
  clickAt: (x, y) => {
  // When "pick mode" is on, a tap on the preview selects an element
  // for the Styles panel instead of poking the page. The tap
  // coordinates go straight to the StylesPanel's handler, and the
  // outcome is settled by settlePick: a real selection disarms pick
  // mode (leaving it armed made the next tap silently select another
  // element instead of clicking the page), a miss keeps it armed.
  if (stylesActive && stylesPickRef.current) {
    settlePick(stylesPickRef.current(x, y), () => setStylesActive(false));
    return;
  }
  if (handlers) handlers.clickAt(x, y).catch(() => {});
  },
  // Pick-mode feedback: the banner over the screenshot (and in the
  // full-screen overlay) is the only signal the user has that a tap
  // will select an element rather than click the page.
  pickMode: stylesActive,
  pickHint: pickBannerText(),
  onPickCancel: () => { setStylesActive(false); rerender(); },



    subscribe: conn.current && conn.current.cdpOn,
    ackFrame: handlers && handlers.ackPreviewFrame,
    refreshRef: previewRefreshRef,
fullscreenRef: previewFullscreenRef,
// The overlay's own state, mirrored up: the card's full screen stands down
// when it is open (see fullscreenOverlayRef), and the card's header button
// drives it through `open` below.
fullscreenOpenRef: fullscreenOverlayRef,
typeBarRef: previewTypeBarRef,
    draftCraftRef: previewDraftCraftRef,
    onInsert: handlers ? handlers.insertText : null,
    onEnter: handlers ? handlers.pressEnter : null,
    onDraftCraft: (image) => image && setDraftCraftImage(image),
    // Full-screen header reads the live URL + document.title so it
    // can echo the page identity in the same way the webpreview
    // modal does. `evaluate` wraps Runtime.evaluate; `sizePresets`
    // is the same list the in-panel Size dropdown uses.
    evaluate: (expression) => conn.current ? conn.current.cdpSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }) : Promise.reject(new Error('not connected')),
    // Identity of the attached page, straight from the target the user
    // connected to. The panel's own `liveUrl`/`liveTitle` are seeded from
    // CDP navigation events, and those never fire for a page that is
    // *already loaded* when the Inspector attaches — so a connect to a
    // running tab left the full-screen header on its raw-URL fallback with
    // a blank host subtitle. These props close that gap at mount.
    pageUrl: currentTarget && currentTarget.url,
    pageTitle: currentTarget && currentTarget.title,
    sizePresets: VIEWPORT_PRESETS,
    sizeId: viewportId,
    sizeDisabled: !cdpReady,
    onSizeChange: applyViewport
  });
  if (id === 'styles') return h(StylesPanel, {
    pickNodeAt: handlers ? handlers.pickNodeAt : null,
    selectBySelector: handlers ? handlers.selectBySelector : null,
    refreshNodeModel: handlers ? handlers.refreshNodeModel : null,
    hideNodeHighlight: handlers ? handlers.hideNodeHighlight : null,
    setInlineStyleProperty: handlers ? handlers.setInlineStyleProperty : null,
    removeInlineStyleProperty: handlers ? handlers.removeInlineStyleProperty : null,
    // Pinned element preview: a clipped screenshot of the selected element
    // so the panel can show the result of an edit in place (no page scroll
    // back to the Preview panel).
    captureElementShot: handlers ? handlers.captureElementShot : null,
    // After an inline edit, re-read the element's own properties and their
    // resolved values so the hoisted "changed" rows in both lists show the
    // value that was actually just applied.
    readElementStyles: handlers ? handlers.readElementStyles : null,
// What the element's *siblings* use for the property being edited ("the
// 2nd section.input-section uses 16px"), for the sheet's Match-a-sibling
// group. One read per property the sheet opens on.
readSiblingValues: handlers ? handlers.readSiblingValues : null,
    // Element tree navigation: the breadcrumb and child chips walk the DOM
    // from the selected element, which is far faster on a phone than
    // re-picking a parent or child on the live preview.
    readElementTree: handlers ? handlers.readElementTree : null,
    selectAncestorNode: handlers ? handlers.selectAncestorNode : null,
    selectChildNode: handlers ? handlers.selectChildNode : null,
    // Read-only cascade for the "Matched rules" section: which rule or class
    // is responsible for a value, which is what decides whether an override is
    // fixable from this panel at all.
    readMatchedRules: handlers ? handlers.readMatchedRules : null,
    // Whether the Preview panel is on screen. Pick mode only works by tapping
    // the live preview, so the panel uses this to disable the pick button (and
    // say why) instead of offering an action that cannot complete.
    previewVisible: visiblePanels.has('preview'),
    pickHandlerRef: stylesPickRef,
    panelHandlesRef: stylesHandlesRef,
    // The identity chip in the card body taps to copy the selector. The write
    // (and its fallback) lives in the Inspector because the outcome is reported
    // in the status pill above the panels — the same pill that reports every
    // other result in this view — and because a refused clipboard write has to
    // be visible rather than silent.
    onCopyElement: copyElementSelector,
    // The objectId the Inspector retained, so a freshly mounted panel re-adopts
    // the element that is still shown above rather than coming up empty.
    restoreObjectId: (selectionStore && selectionStore.objectId) || '',
    // The receipt is owned above the panels (see the receipt state): the panel
    // renders it, records into it, and asks for undos through these props, so
    // switching this panel off cannot take the undo list with it.
    receipt,
    onRecordChange: recordReceipt,
    onUndo: (entry) => undoEntryFromBar(entry),
    onUndoAll: () => undoAllFromBar(),
    receiptNonce,
    // A new selection starts a new receipt: the entries name properties of the
    // element that was selected, so undoing them against another element would
    // write to the wrong node.
    onSelectionReset: () => { setReceipt([]); },
    // The ✕ in the panel's action row. `onSelectionReset` above fires on a new
    // selection too, so the Inspector keeps a separate signal for "nothing is
    // selected any more": it drops the retained snapshot, which is what removes
    // the element button from the panel header. Without it the header went on
    // naming an element the user had just cleared, because the store is
    // deliberately sticky across the panel being switched off.
    onCleared: () => { setStylesSelection(null); setSelectionStore(null); },
    // The Styles panel publishes its selection snapshot here so an unmount can
    // be told apart from a cleared selection. Optional on the panel side:
    // without it the Styles panel is exactly what it was before. A *new*
    // element also reveals the Styles card: a selection made from the Preview
    // panel (a pick, or the selector field) answers in a card that can be a
    // screen away under the pinned switcher (see revealPanelCard).
    onSelectionChange: (info) => {
    setStylesSelection(info);
    const objectId = (info && info.objectId) || '';
    if (objectId && objectId !== revealedSelectionRef.current) {
      revealedSelectionRef.current = objectId;
      revealPanelCard('styles', 'top');
    }
    if (!objectId) revealedSelectionRef.current = '';
    },
    pickMode: stylesActive,
    // Arming pick mode reveals the Preview card: the mode's whole instruction
    // is "tap an element in the page", and the page is the preview's body —
    // off screen it is a mode that cannot be used. Bottom-aligned so the tap
    // surface itself is in view, not just the card's header. Disarming leaves
    // the page where the user left it.
    onPickModeChange: (on) => {
    setStylesActive(on);
    if (on) revealPanelCard('preview', 'bottom');
    }
  });
  if (id === 'console') return h(ConsolePanel, { onRowTap: (ev) => onListTap('console', ev), onReady: (vl) => { consoleVL.current = vl; if (handlers) handlers.pushConsole(); }, onEvaluate: (code) => { if (handlers) handlers.evaluateExpression(code); }, getEval: (desc, params) => { if (conn.current) return conn.current.cdpSend('Runtime.evaluate', params); return Promise.reject(new Error('not connected')); } });
  if (id === 'network') return h(NetworkPanel, { onRowTap: (ev) => onListTap('network', ev), onReady: (vl) => { networkVL.current = vl; if (handlers) handlers.pushNetwork(); } });
  return h(OverviewPanel, { metrics: () => handlers ? handlers.fetchMetrics() : Promise.resolve({}) });
};
  // InspectActionsMenu — overflow menu attached to the right side of
  // the view-head. Holds the less-frequent chrome actions (Reload,
  // Open in new tab, Close tab) so the most common action — typing a
  // URL and pressing Go — sits in the always-visible nav row below.
  // The `…` button mirrors the same overflow pattern used by the
  // target rows in TargetMenu and the project cards in Projects.jsx.

// stylesActions — the Styles panel's three card-wide actions (Clear, Refresh,
// Pick), rendered in that card's header by PanelCard.
//
// They used to be a labelled action row inside the card body, sharing one line
// with the selected element's identity; the identity lost that fight at 360 px
// and ellipsized first. The header is where the *panel's* chrome lives (the
// Preview panel keeps full-screen / refresh / type / eye there), so the
// actions moved up and the identity stayed in the body with the row to
// itself. The handlers go through the panel's published handles
// (panelHandlesRef) rather than re-implementing clear/refresh/pick here, so
// arming pick mode still drops the stale selection and disarming it still
// drops the page highlight. `hasElement` and `busy` read the panel's own
// published snapshot, which is what keeps the two buttons honest about
// whether there is anything to act on and whether a read is already running.
// Pick mode needs the live preview to tap, so the pick button is disabled
// while that panel is hidden, which is exactly what the panel's empty state
// says in words.
const stylesElement = selectionAcrossModes(stylesSelection, selectionStore);
const stylesActions = {
hasElement: !!(stylesElement && String(stylesElement.label || '').trim()),
busy: !!(stylesSelection && stylesSelection.busy),
pickMode: stylesActive,
pickLabel: stylesActive
? 'Stop picking — tap the preview to select'
: 'Pick an element from the preview',
pickDisabled: !visiblePanels.has('preview') && !stylesActive,
onClear: () => { const acts = stylesHandlesRef.current; if (acts && acts.clear) acts.clear(); },
onRefresh: () => { const acts = stylesHandlesRef.current; if (acts && acts.refresh) acts.refresh(); },
onPick: () => { const acts = stylesHandlesRef.current; if (acts && acts.togglePick) acts.togglePick(); }
};
  return h(Fragment, null,
    h('div', { class: 'view-head inspector__viewhead' },
      h('a', { href: '#/inspector', class: 'view-back', 'aria-label': 'Back to targets', onClick: (e) => { e.preventDefault(); disconnect(); setPhase('targets'); rerender(); } }, '←'),
      h('h2', { class: 'view-title inspector__title' }, t && (t.title || t.url || 'target')),
      h(InspectActionsMenu, {
        onReload: reloadAttachedTarget,
        onOpenInNewTab: openAttachedPageInNewTab,
        onShowAll: showAllPanels,
        onClose: closeAttachedTarget
      })
    ),
    h('section', null,
    h('div', { class: 'inspector__nav' },
    // Icon-only Back button — navigates the inspected tab one entry
    // back in its history. Mirrors the reload button's glyph size so
    // the URL field stays the widest flex child. Disabled while the
    // attached tab is known to have nothing behind it (see navHistory),
    // so "nowhere to go" is visible before the tap instead of being
    // reported afterwards; an unread history leaves it enabled and the
    // server's own verdict answers the tap.
    h('button', {
    class: 'icon-btn inspector__nav-back',
    type: 'button',
    disabled: !!(navHistory && !navHistory.canGoBack),
    title: 'Go back in this tab\'s history',
    'aria-label': 'Go back in this tab\'s history',
    onClick: goBackAttachedTarget
    },
    h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
    h('path', { d: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2Z', fill: 'currentColor' })
    )
    ),
    // Forward — the other half of history navigation, for a tab the
    // user stepped back from (followed a link, tapped Back, then wants
    // the page again). Same 44 px glyph and same rules; the two sit
    // side by side the way a browser pairs them.
    h('button', {
    class: 'icon-btn inspector__nav-forward',
    type: 'button',
    disabled: !!(navHistory && !navHistory.canGoForward),
    title: 'Go forward in this tab\'s history',
    'aria-label': 'Go forward in this tab\'s history',
    onClick: goForwardAttachedTarget
    },
    h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
    h('path', { d: 'M4 11h12.17l-5.59-5.59L12 4l8 8-8 8-1.41-1.41L16.17 13H4v-2Z', fill: 'currentColor' })
    )
    ),
        // Icon-only Reload button. The text-button Reload (a 44 px
        // button labelled "Reload") was moved into the view-head
        // overflow menu (InspectActionsMenu) so the nav row carries
        // only what the user does every few seconds: type a URL
        // and tap Go. The icon button keeps the 32 px glyph size
        // so the URL field stays the widest flex child.
        h('button', {
          class: 'icon-btn inspector__nav-reload',
          type: 'button',
          title: 'Reload this tab',
          'aria-label': 'Reload this tab',
          onClick: reloadAttachedTarget
        },
          h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
            h('path', { d: 'M12 4V1L7 6l5 5V7c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8Z', fill: 'currentColor' })
          )
        ),
        h('input', {
          ref: navUrlInput,
          class: 'input inspector__nav-input',
          type: 'url',
          placeholder: 'http://localhost:3000',
          enterkeyhint: 'go',
          value: (t && t.url) || '',
          onKeydown: (e) => { if (e.key === 'Enter') navigateAttachedTarget(); }
        }),
        h('button', {
          class: 'btn btn--primary inspector__nav-go',
          type: 'button',
          title: 'Go to this URL in the inspected tab',
          'aria-label': 'Go to this URL in the inspected tab',
          onClick: navigateAttachedTarget
        }, 'Go')
        // Close button moved to InspectActionsMenu so the nav row
        // carries only the URL field + Go (the most common action).
      ),
      // Panelbar — 2-line chips with a corner entry-count badge for
      // the row-shaped panels (console, network). Preview/Info are not
      // countable so they stay unbadged but still print the label under
      // the glyph, so the whole row reads identically at a glance — no
      // icon-only buttons hiding behind aria-labels.
      h('div', { class: 'inspector__panelbar', role: 'group', 'aria-label': 'Optional panels' },
        PANELS.map((p) => {
          const on = visiblePanels.has(p.id);
          const count = p.id === 'console' ? consoleCount
            : p.id === 'network' ? networkCount
            : 0;
          const badgeText = count > 999 ? '999+' : String(count);
          const showBadge = on && count > 0;
          return h('button', {
            class: 'inspector__panelchip' + (on ? ' is-on' : '') + (showBadge ? ' has-badge' : ''),
            type: 'button',
            'aria-label': (on ? 'Hide ' : 'Show ') + p.label + (showBadge ? ' (' + badgeText + ' entries)' : ''),
            'aria-pressed': String(on),
            title: (on ? 'Hide ' : 'Show ') + p.label,
            'data-panel-id': p.id,
            onClick: () => togglePanel(p.id)
          },
            h('span', { class: 'inspector__panelchip-icon', 'aria-hidden': 'true' }, PANEL_ICONS[p.id]),
            h('span', { class: 'inspector__panelchip-label' }, p.label),
showBadge
? h('span', { class: 'inspector__panelchip-badge', 'aria-hidden': 'true' }, badgeText)
: null
);
}),
// Intent — the describe-a-change surface (Part H). Its chip is hidden (see
// INTENT_SURFACE): the panel bar carries PANELS only, so this renders nothing
// unless the surface is switched back on. It is deliberately NOT folded into
// PANELS — it is a request box and a cited diff, not a view of the connected
// page, so it keeps its own toggle and its own storage key.
INTENT_SURFACE ? h('button', {
class: 'inspector__panelchip inspector__panelchip--intent' + (intentOpen ? ' is-on' : ''),
type: 'button',
'aria-label': (intentOpen ? 'Hide' : 'Show') + ' Intent — describe a change in words',
'aria-pressed': String(!!intentOpen),
title: (intentOpen ? 'Hide' : 'Show') + ' Intent — describe a change in words',
'data-panel-id': 'intent',
onClick: toggleIntent
},
h('span', { class: 'inspector__panelchip-icon', 'aria-hidden': 'true' }, '✎'),
h('span', { class: 'inspector__panelchip-label' }, 'Intent')
) : null
),
h(StatusPill, { text: statusText }),
// Intent (Part H) — the describe-a-change surface, directly above the panels
// because it is a way to *make* an edit rather than a view of the page. It
// renders from the same retained selection the target bar uses, so it works
// with the Styles panel off. Unmounted while INTENT_SURFACE is false: with no
// chip to toggle it, a remembered `1` in localStorage would otherwise open a
// surface the user could not close.
INTENT_SURFACE && intentOpen
? h('div', { class: 'inspector__panel inspector__panel--intent' },
    h(IntentPanel, {
    connected: !!selectionAcrossModes(stylesSelection, selectionStore),
    label: (selectionAcrossModes(stylesSelection, selectionStore) || {}).label || '',
    selectionKey: (selectionStore && selectionStore.objectId) || '',
    context: intentContext(),
    onPropose: proposeIntent,
    onApply: applyIntent,
    onDone: () => setStatus('applied')
    })
    )
    : null,
    noPanelsVisible
    ? h('div', { class: 'inspector__panels-empty', role: 'status' },
    h('p', null, 'No panels visible.'),
    h('p', { class: 'inspector__panels-empty-hint' }, 'Tap a panel name above to show it.'),
    h('button', { class: 'btn', type: 'button', onClick: showAllPanels }, 'Show all panels')
    )
    : h('div', { class: 'inspector__panels' },
    visibleIds.map((id, idx) => h(PanelCard, {
    id,
    label: PANELS.find((p) => p.id === id).label,
    // The first visible card takes the leftover height. Full screen does not
    // change that: the overlay below is a separate surface, so the stacked
    // layout the user returns to after closing it is exactly the one they
    // left, with this same card grown.
    grow: idx === 0,
    // Only panel visible: the page below it is otherwise empty, so
    // the body should take the height it has been given instead of
    // sitting at the shared 52 dvh and leaving a blank half-screen
    // under a scroller that is needlessly short.
    solo: visibleIds.length === 1,
    isVisible: visiblePanels.has(id),
    focused: focusPanelId === id,
    onToggle: togglePanel,
    // The Styles panel header's actions: Clear / Refresh /
    // Pick, wired to that panel's own handles. Null for every
    // other panel, so only the Styles card grows them.
    stylesActions: id === 'styles' ? stylesActions : null,
    sizeId: viewportId,
    onSizeChange: id === 'preview' ? applyViewport : null,
    onRefresh: id === 'preview' ? () => previewRefreshRef.current && previewRefreshRef.current() : null,
    // The card's full-screen button. Preview keeps its viewport-spanning
    // overlay — Preview's full screen already exists and is the fuller
    // surface (its own header, size presets, type bar), so replacing it
    // would be a regression dressed up as consistency. Every other card
    // expands into the full-screen overlay below.
    onFullscreen: id === 'preview'
    ? () => { if (previewFullscreenRef.current) previewFullscreenRef.current(); }
    : () => togglePanelFullscreen(id),
    onTypeBar: id === 'preview' ? () => previewTypeBarRef.current && previewTypeBarRef.current.open() : null,
    onDraftCraft: id === 'preview' ? () => previewDraftCraftRef.current && previewDraftCraftRef.current() : null,
    key: id
    }, renderPanelBody(id)))
    )
    ),
    // The full-screen surface itself.
    //
    // One node, mounted at the document root, holding a *second* PanelCard for the
    // focused panel and the body renderer for it. Rendering the card twice is
    // deliberate: one panel body cannot be in two places at once — moving it would
    // have to move its virtual-list scroller and its scroll offset with it (the
    // console and network panels build their lists against the DOM node they own,
    // and the Styles panel publishes its pin height and re-adopts its element on
    // mount) — so the state that matters is either derived per render or stored
    // above the panel (the Inspector owns the receipt, the selection, the target
    // and the CDP handlers, which is exactly why those live there).
    //
    // The body is remounted, not reused: `key` on the card is the panel id plus a
    // mode marker, so the same panel can never be mounted in both places under one
    // key, and closing the overlay leaves the in-flow card exactly as it was —
    // including the Styles panel's scroll position, which is its own node's.
    focusPanelId
    ? createPortal(
    h('div', {
class: 'inspector__fs',
role: 'dialog',
'aria-modal': 'true',
'aria-label': (PANELS.find((p) => p.id === focusPanelId) || {}).label + ' panel, full screen'
},
h(PanelCard, {
id: focusPanelId,
label: (PANELS.find((p) => p.id === focusPanelId) || {}).label,
grow: true,
solo: true,
focused: true,
isVisible: true,
onToggle: togglePanel,
stylesActions: focusPanelId === 'styles' ? stylesActions : null,
sizeId: viewportId,
onSizeChange: null,
onRefresh: null,
onFullscreen: () => togglePanelFullscreen(focusPanelId),
key: 'fs-' + focusPanelId
}, h(FocusBody, { id: focusPanelId, render: renderPanelBody })),
// Escape leaves full screen without a trip back to the header. Registered in
// the bubble phase on purpose, so a sheet opened from inside this surface (the
// Styles edit sheet, a detail sheet) gets the key first through useModal's
// capture-phase listener and stops it there — one Escape closes the sheet, not
// the sheet and the surface under it.
h(EscapeToExit, { onExit: () => togglePanelFullscreen(focusPanelId) })
),
document.body
)
: null,
draftCraftImage ? h(DraftCraftAnnotator, {
image: draftCraftImage,
pageTitle: t && t.title,
pageUrl: t && t.url,
onClose: () => setDraftCraftImage(null)
}) : null,
h(DetailSheet, {
item: detailItem,
  onClose: () => { setDetailItem(null); rerender(); },
  onLoadBody: () => handlers && handlers.loadResponseBody(detailItem),
  // Add to chat routes through the same Draft Craft picker the file
  // editor and the Preview annotator use, so there is one project/chat
  // chooser in the app rather than a second one built for the sheet.
  onAddToChat: addDetailItemToChat
  }),
  detailPayload ? h(DraftCraftSheet, {
  open: true,
  payload: detailPayload,
  placement: 'bottom',
  onClose: () => setDetailPayload(null),
  onAdded: () => {
    setDetailPayload(null);
    setDetailItem(null);
    rerender();
  }
  }) : null,
    closePending ? h(ConfirmSheet, {
      open: true,
      title: 'Close tab?',
      message: closeMessage(closePending.target),
      confirmLabel: 'Close tab',
      onCancel: cancelClose,
      onConfirm: confirmClose
    }) : null
  );
}

