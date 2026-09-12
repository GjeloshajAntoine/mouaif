'use strict';

// Inspector feature inventory — a guard rail for layout work.
//
// The Inspector is being reworked (see docs/features/inspector.md). Every
// proposal so far is additive, but a refactor of a 1300-line component can
// silently drop a panel, a handler prop or a whole tab without any of the
// behavioural tests noticing: they assert CDP command shapes, not that the
// UI still *offers* the feature.
//
// This test freezes the inventory instead. It reads the real sources and
// asserts that:
//
//   1. the three app tabs are exactly Chats / Inspector / Settings;
//   2. the five Inspector panels exist, each with a label, a chip icon, a
//      render branch and its props;
//   3. every handler the CDP layer exports is consumed by the component
//      (no orphan: a helper wired to nothing is a lost feature);
//   4. every feature-bearing control is still present in the markup
//      (screenshots, tap-to-click, type-into-page, full screen, device
//      presets, draft craft, the close-confirm sheet, ...);
//   5. panel visibility still persists, and the "all hidden" state still
//      resets instead of trapping the user;
//   6. every inspector HTTP endpoint the frontend calls exists server-side.
//
// If a layout change legitimately removes or replaces one of these, the
// change must update this list in the same commit — which is the point: the
// removal becomes a decision on the record instead of an accident.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// The Inspector CSS is split into per-panel parts behind an @import
// entry (frontend/src/inspector.css); readInspectorCss() inlines them so
// these regex checks still see the whole cascade.
const { readInspectorCss } = require('./inspector-css.js');
const read = (p) => (p === 'frontend/src/inspector.css'
  ? readInspectorCss()
  : fs.readFileSync(path.join(root, p), 'utf8'));

const inspector = read('frontend/src/components/Inspector.jsx');
const events = read('frontend/src/components/inspector/events.js');
const app = read('frontend/src/components/App.jsx');
const preview = read('frontend/src/components/inspector/PreviewPanel.jsx');
const styles = read('frontend/src/components/inspector/StylesPanel.jsx');
const consolePanel = read('frontend/src/components/inspector/ConsolePanel.jsx');
const networkPanel = read('frontend/src/components/inspector/NetworkPanel.jsx');
const overview = read('frontend/src/components/inspector/OverviewPanel.jsx');
const jsconsole = read('frontend/src/components/inspector/JsConsole.jsx');
const barrel = read('frontend/src/components/inspector/index.js');
const cdp = read('frontend/src/components/inspector/cdp.js');
// The /api/inspector/* REST surface lives in server-handlers-misc.js and the
// WebSocket upgrade in http-server.js; src/index.js only wires them together.
const server = read('src/server-handlers-misc.js') + '\n' + read('src/http-server.js');
const css = read('frontend/src/inspector.css');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// ---- 1. App tabs -------------------------------------------------------
// The layout work never touches the other tabs, but a stray edit to
// BottomNav would be invisible to every other test.
//
// The bar is no longer a fixed trio: Dictation added a fourth entry. What
// must not change is the *contract* the inspector depends on — it stays a
// tab route with its own label — and that the labels in the bar match the
// order declared here.

const tabsBlock = /const tabs = \[([\s\S]*?)\];/.exec(app);
check('App.jsx declares a tab list', !!tabsBlock);
if (tabsBlock) {
  const entries = [...tabsBlock[1].matchAll(/to:\s*'([^']+)',\s*name:\s*'([^']+)',\s*label:\s*'([^']+)'/g)]
    .map((m) => ({ to: m[1], name: m[2], label: m[3] }));
  // Every tab must route somewhere distinct and be labelled.
  check('every tab is distinct and labelled',
    entries.length >= 3
    && new Set(entries.map((t) => t.to)).size === entries.length
    && entries.every((t) => t.label && t.name),
    entries.map((t) => t.name).join(','));
  check('the core tabs are still present',
    ['chats', 'inspector', 'settings'].every((name) => entries.some((t) => t.name === name)),
    entries.map((t) => t.name).join(','));
  check('the tab labels start with the core labels',
    entries[0].label === 'Chats' && entries[entries.length - 1].label === 'Settings',
    entries.map((t) => t.label).join(','));
  check('Inspector tab routes to #/inspector', entries.some((t) => t.to === 'inspector'));
  // The grid's column count is generated from the array, so a new tab is one
  // entry. A hard-coded `repeat(N, 1fr)` in the stylesheet is the failure this
  // guards: it silently squeezes the last tab off screen.
  const tablistCss = read('frontend/src/layout.css');
  check('the tab grid tracks the tab count',
    /repeat\(var\(--tab-count/.test(tablistCss) && /--tab-count/.test(app));
}
// The inspector is a tab route: it must stay OUT of FULL_PAGE_ROUTES, or the
// tab bar would disappear while inspecting.
const fullPageBlock = /FULL_PAGE_ROUTES = new Set\(\[([\s\S]*?)\]\);/.exec(app);
check('FULL_PAGE_ROUTES declaration found', !!fullPageBlock);
if (fullPageBlock) {
  check('the inspector route still shows the tab bar',
    !/\binspector\b/.test(fullPageBlock[1]), fullPageBlock[1].replace(/\s+/g, ' ').slice(0, 80));
}

// ---- 2. Panels: id, label, icon, render branch -------------------------

const PANEL_IDS = ['preview', 'styles', 'console', 'network', 'overview'];

const panelsBlock = /const PANELS = \[([\s\S]*?)\];/.exec(inspector);
check('Inspector.jsx declares the panel list', !!panelsBlock);
if (panelsBlock) {
  const ids = [...panelsBlock[1].matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
  check('five panels, in order', ids.join(',') === PANEL_IDS.join(','), ids.join(','));
  for (const label of ['Preview', 'Styles', 'Console', 'Network', 'Info']) {
    check('panel label present: ' + label, panelsBlock[1].includes("'" + label + "'"));
  }
}

const iconsBlock = /const PANEL_ICONS = \{([\s\S]*?)\n\};/.exec(inspector);
check('a chip icon exists for every panel', !!iconsBlock
  && PANEL_IDS.every((id) => new RegExp('(^|\\n)\\s*' + id + ':').test(iconsBlock[1])),
  iconsBlock ? PANEL_IDS.filter((id) => !new RegExp('(^|\\n)\\s*' + id + ':').test(iconsBlock[1])).join(',') : 'no PANEL_ICONS');

// Four panels have an explicit branch; 'overview' is the fallback return, so
// it is asserted by shape rather than by an `id === 'overview'` comparison.
for (const id of ['preview', 'styles', 'console', 'network']) {
  check('render branch for ' + id, new RegExp("id === '" + id + "'").test(inspector));
}
check('render branch for overview (fallback)',
  /if \(id === 'network'\) return h\(NetworkPanel[\s\S]{0,220}\n\s*return h\(OverviewPanel/.test(inspector));

const bodyBlock = /const renderPanelBody = \(id\) => \{([\s\S]*?)\n\};/.exec(inspector);
check('renderPanelBody exists', !!bodyBlock);
if (bodyBlock) {
  for (const [name, comp] of [['preview', 'PreviewPanel'], ['styles', 'StylesPanel'],
    ['console', 'ConsolePanel'], ['network', 'NetworkPanel'], ['overview', 'OverviewPanel']]) {
    check(name + ' renders ' + comp, bodyBlock[1].includes('h(' + comp));
  }
}

// ---- 2b. Panel props ---------------------------------------------------
// Each panel's inputs, named explicitly so a refactor cannot quietly drop
// one (e.g. losing pickNodeAt would silently disable tap-to-select).

const STYLE_PROPS = ['pickNodeAt', 'selectBySelector', 'refreshNodeModel', 'hideNodeHighlight',
  'setInlineStyleProperty', 'removeInlineStyleProperty', 'captureElementShot', 'readElementStyles',
  'readElementTree', 'selectAncestorNode', 'selectChildNode', 'readMatchedRules',
  'previewVisible', 'pickHandlerRef', 'pickMode', 'onPickModeChange'];
for (const prop of STYLE_PROPS) {
  check('StylesPanel receives ' + prop, new RegExp('\\b' + prop + ':').test(inspector));
}

const PREVIEW_PROPS = ['capture', 'clickAt', 'subscribe', 'ackFrame', 'refreshRef', 'fullscreenRef',
  'typeBarRef', 'draftCraftRef', 'onInsert', 'onEnter', 'onDraftCraft', 'evaluate',
  'sizePresets', 'sizeId', 'sizeDisabled', 'onSizeChange'];
for (const prop of PREVIEW_PROPS) {
  check('PreviewPanel receives ' + prop, new RegExp('\\b' + prop + ':').test(inspector));
}

check('ConsolePanel receives onRowTap / onReady / onEvaluate / getEval',
  ['onRowTap', 'onReady', 'onEvaluate', 'getEval'].every((p) => new RegExp(p + ':').test(inspector)));
check('NetworkPanel receives onRowTap / onReady',
  /h\(NetworkPanel, \{ onRowTap[\s\S]{0,120}onReady/.test(inspector));
check('OverviewPanel receives metrics', /h\(OverviewPanel, \{ metrics/.test(inspector));

// ---- 3. Every CDP handler is consumed ----------------------------------
// createEventHandlers returns the capability list. A handler that no longer
// appears outside its own module is dead wiring — a feature nobody can reach.

const handlersBlock = /return \{\n\s*onConsoleEvent([\s\S]*?)\n\s*\};/.exec(events);
check('events.js returns a handler list', !!handlersBlock);
if (handlersBlock) {
  const handlers = [...('onConsoleEvent' + handlersBlock[1]).matchAll(/[a-zA-Z]+/g)].map((m) => m[0]);
  // 33 named capabilities today. The floor is deliberately a floor: adding
  // handlers is fine, silently dropping the list is not.
  check('handler list is intact (>= 33 capabilities)', handlers.length >= 33, 'found ' + handlers.length);
  const consumers = inspector + ' ' + preview + ' ' + styles + ' ' + consolePanel + ' ' + networkPanel + ' ' + overview + ' ' + jsconsole;
  const orphans = handlers.filter((h) => !new RegExp('\\b' + h + '\\b').test(consumers));
  check('no orphaned CDP handler', orphans.length === 0, orphans.join(', '));
}

// The server-side proxy the whole tab depends on (the WS URL is built in cdp.js).
check('CDP proxy endpoint still used by the client',
  /api\/inspector\/proxy/.test(cdp) && /api\/inspector\/proxy/.test(server));

// ---- 4. Feature-bearing controls --------------------------------------

const CONTROLS = [
  ['targets list + refresh', /Refresh targets/],
  ['open & inspect', /Open & inspect/],
  ['target row menu', /Target options|TargetMenu/],
  ['close-tab confirmation sheet', /ConfirmSheet/],
  ['back in history', /Page\.navigateToHistoryEntry|goBackAttachedTarget/],
  ['reload tab', /reloadAttachedTarget/],
  ['URL navigate', /navigateAttachedTarget/],
  ['open page in a new tab', /openAttachedPageInNewTab/],
  ['show all panels', /showAllPanels/],
  ['per-panel visibility toggle', /onToggle\(props\.id\)/],
  ['empty state when every panel is hidden', /inspector__panels-empty/],
  ['status pill', /StatusPill/],
  ['detail sheet for a row', /DetailSheet/],
  ['panel chips with entry counts', /inspector__panelchip-badge/],
  ['device size presets', /VIEWPORT_PRESETS/],
  ['apply viewport override', /applyViewport/],
  ['capture loop + fallback poll', /startPreviewStream/],
  ['screencast frame ack', /ackPreviewFrame/],
  ['full-screen preview', /previewFullscreenRef/],
  ['type into page', /previewTypeBarRef/],
  ['draft craft annotation', /DraftCraftAnnotator/],
  ['tap-to-click the page', /clickAt/],
  ['virtual lists for console/network', /consoleVL|networkVL/],
];
for (const [name, re] of CONTROLS) {
  check('control present: ' + name, re.test(inspector));
}

// The entry cap lives in the CDP layer (the backing store trims, so an
// evicted row also releases its captured body).
check('entry retention cap is enforced in the store', /MAX_ENTRIES = 2000/.test(events));
check('evicted entries are dropped from the request map',
  /reqMap|requestId/.test(events) && /MAX_ENTRIES/.test(events));
// The rules scan is budgeted so a huge bundle cannot wedge the tab.
check('matched-rules scan is capped', /RULE_BUDGET = 20000/.test(events));
check('response bodies are truncated before storing', /200000/.test(events));

// Panels' own features.
check('preview: text-input bar', /inspector__typebar/.test(preview));
check('preview: pick-mode banner', /inspector__pickban/.test(preview));
// The target bar used to render directly above the panels, from a selection
// the Inspector retained across a mode switch. On a phone it read as a second
// navigation block that was not one of the app tabs and could not be closed
// without collapsing it by hand, so it was removed. The Styles panel header,
// its element tree and its Matched-rules section carry the same three answers
// inside the tab that owns them; the receipt strip stays in that panel's own
// scroll flow.
check('no target bar above the panels',
!/\bTargetBar\b/.test(inspector) && !/\bBarReceipt\b/.test(inspector));
check('no breadcrumb that walks the tree from above the panels',
!/onSelectAncestor/.test(inspector) && !/onRuleTap/.test(inspector));
check('the timeline of the selection is still published by the styles panel',
/onSelectionChange/.test(styles));
check('the edit sheet switches value types', /inspector__kindseg/.test(styles));
check('the edit sheet offers the unit cycle', /inspector__unitchip/.test(styles));
check('the session receipt is shown with undo', /inspector__receipt/.test(styles));
check('the edit sheet states the edit scope', /inspector__scope/.test(styles));
check('the value-type context comes from the page, not a guessed root size',
  /bases: \{ root: root, parent: parent, self:/.test(read('frontend/src/components/inspector/events.js')));
check('preview: zoom fit/natural toggle', /toggleZoom/.test(preview));
check('preview: escape closes the overlay', /Escape/.test(preview));
check('preview: viewport capture for the PDF viewer', /viewport|clip/i.test(preview));
check('styles: tap-to-select', /pickFromPoint/.test(styles));
check('styles: selector select', /pickBySelector/.test(styles));
check('styles: element tree breadcrumb', /inspector__styles-crumbs/.test(styles));
check('styles: child chips', /inspector__styles-kids/.test(styles));
check('styles: declared styles list', /Declared styles/.test(styles));
check('styles: computed list + filter', /Computed/.test(styles) && /inspector__computed-filter/.test(styles));
check('styles: matched rules section', /MatchedRulesSection/.test(styles));
check('styles: pinned element preview', /inspector__styles-shot/.test(styles));
check('styles: inline edit sheet', /StyleEditSheet/.test(styles));
check('styles: quick-add chips', /COMMON_CSS/.test(styles));
check('styles: changed-first ordering', /orderChangedFirst/.test(styles));
check('console: level styling', /inspector__row-level/.test(consolePanel));
check('console: stack traces / detail', /onRowTap/.test(consolePanel));
check('js console: evaluation entry point', /evaluate|evaluateExpression/.test(jsconsole));
check('network: status classes', /inspector__row-status/.test(networkPanel));
check('overview: metrics polling', /Performance\.getMetrics|metrics/.test(overview));
check('barrel exports every panel',
  ['ConsolePanel', 'JsConsole', 'NetworkPanel', 'PreviewPanel', 'OverviewPanel', 'StylesPanel']
    .every((n) => barrel.includes(n + ' }') || barrel.includes(n + ' } from')));

// ---- 5. Visibility persistence ----------------------------------------

check('panel visibility persists under a stable key',
  /PANEL_STATE_KEY = 'mouaif:inspector:panels'/.test(inspector));
check('persisted state is read back', /loadPanelState/.test(inspector) && /savePanelState/.test(inspector));
check('an all-hidden state resets instead of trapping the user',
  /next\.size \? next : new Set/.test(inspector));
check('hiding the last panel is refused', /next\.size === 1/.test(inspector));
check('device preset choice persists', /VIEWPORT_STATE_KEY/.test(inspector));

// ---- 5b. Mobile-first invariants --------------------------------------
// The project rules: ≥44 px targets, no hover-only affordance, no
// horizontal scrolling inside the styles panel.

check('--tap token is defined', /--tap:\s*44px/.test(read('frontend/src/base.css')));
check('styles panel clips horizontal overflow', /overflow-x:\s*hidden/.test(css));
check('styles panel contains its overscroll', /overscroll-behavior:\s*contain/.test(css));
check('panel chips are labelled on screen (not icon-only)',
  /inspector__panelchip-label/.test(inspector) && /inspector__panelchip-label/.test(css));

// ---- 6. HTTP surface ---------------------------------------------------
// Every endpoint the inspector frontend calls must exist on the server.

const endpoints = new Set([...inspector.matchAll(/api\/inspector\/([a-z-]+)/g)].map((m) => m[1]));
check('frontend calls at least 6 inspector endpoints', endpoints.size >= 6, [...endpoints].join(','));
for (const name of endpoints) {
  check('server serves /api/inspector/' + name,
    new RegExp("api/inspector/" + name + "\\b").test(server)
    || new RegExp("api/inspector/" + name + "\\b").test(read('src/inspector.js')),
    'no handler found');
}
check('the debugger default port is unchanged (9222)',
  /9222/.test(inspector) || /9222/.test(read('src/inspector.js')));

// ---- 7. Chrome profile management --------------------------------------
// The profile manager is the Inspector's only new surface in this round,
// and it is a dialog reachable from the setup phase — exactly the kind of
// thing a layout refactor drops without any behavioural test noticing.

const profilesSheet = read('frontend/src/components/inspector/InspectorProfilesSheet.jsx');
const profilesModule = read('src/inspectorProfiles.js');
const profilesCss = read('frontend/src/inspector-profiles.css');

check('setup screen offers the Chrome profiles entry point',
  /inspector__profiles-open/.test(inspector) && /Chrome profiles/.test(inspector));
check('the profiles sheet is mounted from Inspector.jsx',
  /h\(InspectorProfilesSheet/.test(inspector));
check('the sheet is a dialog sheet with the shared overlay',
  /inspector__overlay/.test(profilesSheet) && /role: 'dialog'/.test(profilesSheet));
check('the sheet uses the shared modal behaviour hook',
  /useModal\(/.test(profilesSheet));
check('each profile row is one button (whole row is a tap target)',
  /inspector__profile-main/.test(profilesSheet) && /aria-pressed/.test(profilesSheet));
check('switching a profile is a per-row action', /onSwitch/.test(profilesSheet));
check('saving an endpoint is separate from switching',
  /onSaveEndpoint/.test(profilesSheet) && /profiles\/endpoint/.test(inspector));
check('profile folders can be added and removed',
  /onAddDir/.test(profilesSheet) && /onRemoveDir/.test(profilesSheet));
check('the active profile is named on the setup screen',
  /activeProfile/.test(inspector) && /activeProfile: inspectorProfiles\.activeProfile\(\)/.test(server));
check('profile rows meet the 44 px tap minimum',
  /min-height: var\(--tap, 44px\)/.test(profilesCss));
check('the profiles sheet part is imported by the entry point',
  // Read the raw entry point: `read()` inlines the @imports, so the
  // import line itself is only visible in the file on disk.
  /@import '\.\/inspector-profiles\.css'/.test(fs.readFileSync(path.join(root, 'frontend/src/inspector.css'), 'utf8')));
check('discovery never writes outside the app store',
  !/fs\.writeFileSync/.test(profilesModule) && !/fs\.mkdirSync/.test(profilesModule));
check('the "added" flag comes from the server, not from profile count',
  /addedDirs/.test(profilesModule)
  && /addedDirs/.test(profilesSheet)
  && !/builtinDirs/.test(profilesSheet));
check('the server exposes the profiles, switch, endpoint and dirs routes',
  ['/api/inspector/profiles\'', '/api/inspector/profiles/switch', '/api/inspector/profiles/endpoint', '/api/inspector/profiles/dirs']
    .every((r) => server.includes(r)));

// ---- Summary -----------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed + ' failed');
assert.equal(failed, 0, failed + ' inspector inventory assertion(s) failed');
