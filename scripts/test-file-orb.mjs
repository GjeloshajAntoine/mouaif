// The composer file button's "glass orb" style, end to end.
//
// Three things have to agree for the option to work at all, and each one is a
// place the feature can silently half-break:
//
//   1. the preference — `fileOrbFromApp()` must read the app store defensively
//      (absent key, hand-edited string, failed fetch all mean "flat");
//   2. the plumbing — `fileOrbButton` is an app-level key, so it must be in
//      Settings.DEFAULTS (otherwise it can never be reset) AND in
//      server-shared.js's CLIENT_SETTINGS_KEYS allowlist (otherwise the server
//      stores it and then strips it out of every /api/settings response, which
//      looks exactly like the toggle not saving);
//   3. the render — FileToolbar must emit the orb markup only when asked, and
//      the *same* aria-label either way (the style is a skin, not a behaviour).
//
// Plus one CSS invariant, because a specificity trap already bit this feature:
// the flat rule `.file-toolbar__folder > svg path { fill: var(--fg) }` ties on
// classes and beats on elements `.file-toolbar__folder-face path { fill:
// url(#…) }`, so every orb layer silently repainted flat white and the 3D read
// as a sticker. Every gradient-fill rule must therefore carry the
// `.file-toolbar--orb` prefix so it out-ranks the flat rule.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// This file is ESM (for top-level await), but src/*.js is CommonJS.
const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
// `check` is async (the render harness awaits the stats fetch), and the calls
// are collected rather than awaited inline so a failure names the check that
// broke instead of only the file.
const checks = [];
function check(name, fn) {
  checks.push(async () => {
    await fn();
    pass += 1;
    console.log('  ok   - ' + name);
  });
}

// ---- 1. the preference reader -------------------------------------------

const { fileOrbFromApp, FILE_ORB_DEFAULT, FILE_ORB_KEY, orbCountFont, ORB_FONT_MAX } = await import(
  'data:text/javascript;base64,' + Buffer.from(read('frontend/src/components/chat/fileOrb.js')).toString('base64')
);

check('the orb is opt-in, so the default is the flat button', () => {
  assert.equal(FILE_ORB_DEFAULT, false);
  assert.equal(FILE_ORB_KEY, 'fileOrbButton');
});

check('fileOrbFromApp reads the boolean and defends everything else', () => {
  assert.equal(fileOrbFromApp({ app: { fileOrbButton: true } }), true);
  assert.equal(fileOrbFromApp({ app: { fileOrbButton: false } }), false);
  // Absent key, missing app bag, failed fetch, null: all the flat default.
  assert.equal(fileOrbFromApp({ app: {} }), false);
  assert.equal(fileOrbFromApp({}), false);
  assert.equal(fileOrbFromApp(null), false);
  assert.equal(fileOrbFromApp(undefined), false);
  // The app store holds a TEXT blob, so a hand-edited (or project-merged)
  // value can legitimately arrive as a string.
  assert.equal(fileOrbFromApp({ app: { fileOrbButton: 'true' } }), true);
  assert.equal(fileOrbFromApp({ app: { fileOrbButton: 'false' } }), false);
  // Anything else must not produce a third state.
  assert.equal(fileOrbFromApp({ app: { fileOrbButton: 1 } }), false);
  assert.equal(fileOrbFromApp({ app: { fileOrbButton: 'yes' } }), false);
  assert.equal(fileOrbFromApp({ app: { fileOrbButton: null } }), false);
});

// ---- 2. the server-side plumbing ----------------------------------------

check('fileOrbButton is a resettable app default', () => {
  const settingsSrc = read('src/settings.js');
  assert.match(settingsSrc, /fileOrbButton: false,/, 'Settings.DEFAULTS must carry the key');
  // RESETTABLE_APP_KEYS is derived from Object.keys(DEFAULTS), so being in
  // DEFAULTS is what makes the key reachable by Settings → reset.
  const shared = read('src/server-shared.js');
  assert.match(shared, /new Set\(\[\.\.\.Object\.keys\(settings\.DEFAULTS\)/, 'resettable keys come from DEFAULTS');
});

check('fileOrbButton survives the client allowlist', () => {
  const shared = read('src/server-shared.js');
  const listStart = shared.indexOf('const CLIENT_SETTINGS_KEYS = Object.freeze([');
  assert.ok(listStart > -1, 'CLIENT_SETTINGS_KEYS block found');
  const listEnd = shared.indexOf(']);', listStart);
  const block = shared.slice(listStart, listEnd);
  assert.match(block, /'fileOrbButton'/, 'the key must be allowlisted or the server stores it and strips it');
});

check('the running server would round-trip the key', () => {
  // Exercise the real modules against a throwaway store, rather than pattern
  // matching: set the key through settings.js, then confirm settingsForClient
  // (the function every /api/settings response goes through) still has it.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-orb-'));
  const priorHome = process.env.MOUAIF_HOME;
  process.env.MOUAIF_HOME = home;
  try {
    // Fresh module registry so settings.js captures the temp home.
    const settings = require(path.join(ROOT, 'src/settings.js'));
    const { settingsForClient } = require(path.join(ROOT, 'src/server-shared.js'));
    settings.setApp({ [FILE_ORB_KEY]: true });
    assert.equal(settings.getApp()[FILE_ORB_KEY], true, 'settings.js persists the key');
    assert.equal(settingsForClient(settings.getApp())[FILE_ORB_KEY], true, 'the client sees the key');
    assert.equal(settingsForClient(settings.DEFAULTS)[FILE_ORB_KEY], false, 'the default is published too');
  } finally {
    if (priorHome === undefined) delete process.env.MOUAIF_HOME;
    else process.env.MOUAIF_HOME = priorHome;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---- 3. the render ------------------------------------------------------

// Run the real component with a minimal hook harness, in both modes. The h()
// stub records every element flat, so node lookups are plain filters.
// The git-stats effect is fired after the first render (and its promise
// awaited) because the counts only exist once the fetch resolves — without
// that, the emboss copies would never be in the tree to assert on.
async function renderToolbar(orb) {
  const nodes = [];
  let cursor = 0;
  let first = true;
  const states = [];
  const effects = [];
  const context = vm.createContext({
    String, Object, JSON, Set,
    fetchJson: async () => ({ status: 200, body: { ok: true, stdout: '12\t3\tsrc/a.js\n' } }),
    useRef: (v) => { const i = cursor++; if (first) states[i] = { current: v }; return states[i]; },
    useState: (v) => { const i = cursor++; if (first) states[i] = typeof v === 'function' ? v() : v; return [states[i], (next) => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
    useEffect: (fn) => { effects.push(fn); },
    useCallback: (fn) => fn,
    // The click-outside hook is a DOM concern; the render path only needs it
    // to not throw.
    useClickOutside: () => {},
    h: (tag, attrs, ...children) => { const node = { tag, attrs: attrs || {}, children: children.flat() }; nodes.push(node); return node; }
  });
  const strip = (src) => src.replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  vm.runInContext(strip(read('frontend/src/components/chat/gitCount.js')), context);
  // fileOrb.js exports the count sizer FileToolbar calls, so it has to be in
  // the same context (the import lines are stripped, not resolved).
  vm.runInContext(strip(read('frontend/src/components/chat/fileOrb.js')), context);
  // `useClickOutside` is the only import FileToolbar reaches for that the stub
  // context already provides, so nothing else needs loading.
  vm.runInContext(strip(read('frontend/src/components/chat/FileToolbar.jsx')), context);
  const render = () => {
    cursor = 0;
    nodes.length = 0;
    context.FileToolbar({ projectDir: '/fixture/project', orb });
    first = false;
    return nodes;
  };
  render();
  const pending = effects.splice(0).map((fn) => fn());
  first = false;
  // Let the stats fetch settle, then render the resolved state.
  await Promise.all(pending).catch(() => {});
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return render();
}

const cls = (nodes, name) => nodes.filter((n) => typeof n.attrs.class === 'string' && n.attrs.class.split(' ').includes(name));
const trigger = (nodes) => nodes.find((n) => n.attrs.class === 'file-toolbar__trigger');
const root = (nodes) => nodes.find((n) => typeof n.attrs.class === 'string'
  && /^file-toolbar( file-toolbar--orb)?$/.test(n.attrs.class));

check('orb=false renders the flat button and nothing else', async () => {
  const nodes = await renderToolbar(false);
  assert.equal(root(nodes).attrs.class, 'file-toolbar', 'no modifier class');
  assert.equal(trigger(nodes).attrs['aria-expanded'], 'false');
  assert.equal(cls(nodes, 'file-toolbar__plate').length, 0, 'no slab');
  assert.equal(cls(nodes, 'file-toolbar__folder--3d').length, 0, 'no extruded folder');
  assert.equal(cls(nodes, 'file-toolbar__folder').length, 1, 'exactly one flat folder');
  assert.equal(cls(nodes, 'file-toolbar__sheen').length, 0, 'no sphere sheen layer');
  assert.equal(cls(nodes, 'file-toolbar__count-echo').length, 0, 'no emboss copies');
});

check('orb=true renders the full 3D stack', async () => {
  const nodes = await renderToolbar(true);
  assert.equal(root(nodes).attrs.class, 'file-toolbar file-toolbar--orb', 'modifier class drives the paint');
  assert.equal(cls(nodes, 'file-toolbar__sheen').length, 1, 'the sliding highlight disc');
  assert.equal(cls(nodes, 'file-toolbar__plate').length, 1, 'the slab the folder floats in front of');
  assert.equal(cls(nodes, 'file-toolbar__cast').length, 1, 'the slab contact shadow');
  assert.equal(cls(nodes, 'file-toolbar__folder--3d').length, 1, 'the extruded folder');
  assert.equal(cls(nodes, 'file-toolbar__folder-ground').length, 1, 'the folder contact shadow');
  for (const layer of ['file-toolbar__folder-side', 'file-toolbar__folder-body', 'file-toolbar__folder-shade', 'file-toolbar__folder-face', 'file-toolbar__folder-sheen', 'file-toolbar__folder-shine']) {
    assert.equal(cls(nodes, layer).length, 1, layer + ' present exactly once');
  }
  // Every gradient the layers reference must actually be defined, or the fill
  // resolves to nothing and the layer disappears.
  const defs = nodes.filter((n) => n.tag === 'linearGradient' || n.tag === 'radialGradient').map((n) => n.attrs.id);
  for (const id of ['fileToolbarFolderSide', 'fileToolbarFolderBody', 'fileToolbarFolderFace', 'fileToolbarFolderShade', 'fileToolbarFolderSheen']) {
    assert.ok(defs.includes(id), 'defines ' + id);
  }
});

check('both styles announce the same label — the orb is a skin, not a behaviour', async () => {
  const flat = trigger(await renderToolbar(false));
  const orbNodes = await renderToolbar(true);
  const orb = trigger(orbNodes);
  assert.equal(orb.attrs['aria-label'], flat.attrs['aria-label']);
  assert.equal(orb.attrs.title, flat.attrs.title);
  assert.equal(orb.attrs.type, 'button');
  assert.equal(orb.attrs['aria-haspopup'], flat.attrs['aria-haspopup']);
  // The counts are duplicated for the emboss, so the copies must be hidden
  // from assistive tech or every figure would be read twice.
  const echoes = cls(orbNodes, 'file-toolbar__count-echo');
  assert.equal(echoes.length, 2, 'one echo per count');
  for (const echo of echoes) assert.equal(echo.attrs['aria-hidden'], 'true', 'the emboss copy is decorative');
});

// ---- 3b. the count sizer -------------------------------------------------

check('orbCountFont shrinks as the longest count grows', () => {
  // Monotonically non-increasing: a longer count can never be drawn larger
  // than a shorter one, or the widest string would overflow.
  const sizes = [2, 3, 4, 5].map((n) => parseFloat(orbCountFont(n)));
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i] <= sizes[i - 1], 'step ' + (i + 2) + ' must not exceed step ' + (i + 1));
  }
  // And the size actually drops at the point width starts to bind.
  assert.ok(sizes[0] > sizes[sizes.length - 1], 'the 2-glyph step is the largest');
  assert.ok(parseFloat(orbCountFont(2)) <= ORB_FONT_MAX, 'the ceiling is respected');
});

check('orbCountFont is clamped, never undefined', () => {
  // Anything the formatter cannot emit still has to produce a usable length:
  // an `undefined` here becomes `font-size: undefined`, which drops the whole
  // declaration and leaves the count at the inherited size.
  for (const input of [0, 1, 2, 3, 4, 5, 6, 99, -1, NaN, undefined, null, '3', 'junk']) {
    const out = orbCountFont(input);
    assert.match(String(out), /^\d+(\.\d+)?px$/, 'orbCountFont(' + JSON.stringify(input) + ') = ' + out);
  }
  assert.equal(orbCountFont(1), orbCountFont(2), 'below the floor clamps up');
  assert.equal(orbCountFont(99), orbCountFont(5), 'above the ceiling clamps down');
  assert.equal(orbCountFont('3'), orbCountFont(3), 'a numeric string is accepted');
});

check('every step clears the folder on BOTH axes', () => {
  // The two budgets the sizer has to satisfy: the plate (ORB_FOLDER_W/H in
  // FileToolbar.jsx, mirrored by `.file-toolbar__plate` in chat-composer.css)
  // less the 2px inset `.file-toolbar--orb .file-toolbar__git-stats` applies
  // on every side. They are read out of the two files rather than pinned
  // here, so shrinking the plate cannot leave the sizer silently overshooting
  // it. Width is per-string rather than per-glyph: `.` is far narrower than a
  // digit, so `+9.9k` (2.63em) is wider than `+995k` at the size it is drawn.
  // The em widths are measured in the running app at weight 800 with tabular
  // figures.
  const INSET = 2;
  const plate = {
    w: Number(component.match(/const ORB_FOLDER_W = (\d+(?:\.\d+)?);/)[1]),
    h: Number(component.match(/const ORB_FOLDER_H = (\d+(?:\.\d+)?);/)[1])
  };
  const cssPlate = css.match(/\.file-toolbar--orb \.file-toolbar__plate \{([^}]*)\}/);
  assert.ok(cssPlate, 'found the plate rule');
  const CSS_PLATE_W = Number(cssPlate[1].match(/width:\s*(\d+(?:\.\d+)?)px/)[1]);
  const CSS_PLATE_H = Number(cssPlate[1].match(/height:\s*(\d+(?:\.\d+)?)px/)[1]);
  assert.equal(CSS_PLATE_W, plate.w, 'the plate width matches ORB_FOLDER_W');
  assert.equal(CSS_PLATE_H, plate.h, 'the plate height matches ORB_FOLDER_H');
  const CONTENT_W = plate.w - INSET * 2;
  const CONTENT_H = plate.h - INSET * 2;
  const LINE_HEIGHT = 0.85;
  const WIDTH_EM = { 2: 1.19, 3: 1.77, 4: 2.63, 5: 2.92 };
  const label = { 2: '+0', 3: '+99', 4: '+9.9k', 5: '+995k' };
  for (const [lenStr, em] of Object.entries(WIDTH_EM)) {
    const size = parseFloat(orbCountFont(Number(lenStr)));
    const width = em * size;
    const height = 2 * LINE_HEIGHT * size;
    assert.ok(width <= CONTENT_W, label[lenStr] + ' at ' + size + 'px is ' + width.toFixed(1) + 'px wide, budget ' + CONTENT_W);
    assert.ok(height <= CONTENT_H, label[lenStr] + ' at ' + size + 'px needs ' + height.toFixed(1) + 'px of height, budget ' + CONTENT_H);
  }
  // The steps must not be needlessly conservative. Steps 4 and 5 are
  // width-bound, so for each of them the next 0.5px up has to bust the width
  // budget — otherwise the sizer is leaving chunkiness on the table for no
  // reason. (Steps 2 and 3 are height-bound, where a 0.5px rise also busts,
  // but that is the height row above, not this one.)
  for (const lenStr of ['4', '5']) {
    const size = parseFloat(orbCountFont(Number(lenStr)));
    assert.ok(WIDTH_EM[lenStr] * (size + 0.5) > CONTENT_W,
      label[lenStr] + ': ' + (size + 0.5) + 'px would be ' +
      (WIDTH_EM[lenStr] * (size + 0.5)).toFixed(1) + 'px wide, so ' + size + 'px is maximal');
  }
});

check('the emboss scales with the font instead of being a fixed length', () => {
  // A fixed 0.6px extrusion is a visible bevel on 11px digits and an
  // invisible smear on 8px ones, so every emboss offset must be in `em` and
  // the font size must come from `--orb-count`.
  // The emboss block: from the echo rule to the defs rule (the folder rules
  // sit above it, so these two are the right bounds).
  const from = css.indexOf('.file-toolbar__count-echo');
  const to = css.indexOf('.file-toolbar__defs');
  const block = css.slice(from, to);
  assert.ok(from > -1 && to > from, 'found the emboss block');
  assert.match(block, /left:\s*0\.\d+em;/, 'the echo offset is in em');
  assert.match(block, /top:\s*0\.\d+em;/, 'the echo offset is in em');
  assert.match(block, /0 0\.\d+em 0 rgba\(255, 255, 255/, 'the white lip is in em');
  const statsRule = css.match(/\.file-toolbar--orb \.file-toolbar__git-stats \{([^}]*)\}/);
  assert.ok(statsRule, 'found the orb stats rule');
  assert.match(statsRule[1], /font-size:\s*var\(--orb-count/, 'the size is driven by the inline variable');
});

// ---- 4. the CSS invariants ---------------------------------------------
const css = read('frontend/src/chat-composer.css');
const component = read('frontend/src/components/chat/FileToolbar.jsx');

check('every orb gradient fill out-specifies the flat folder rule', () => {
  // The flat rule is `.file-toolbar__folder > svg path` = (0,1,2). Each orb
  // fill rule must be at least (0,2,1) to win, which means the orb class.
  // Rules are scanned as balanced `selector { declarations }` pairs, so a
  // nested at-rule or a preceding rule cannot bleed into the match.
  const offenders = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim().split('\n').pop().trim();
    if (!/fill:\s*url\(#/.test(rule[2])) continue;
    if (!/^\.file-toolbar--orb\b/.test(selector)) offenders.push(selector);
  }
  assert.deepEqual(offenders, [], 'gradient fills without the orb prefix: ' + offenders.join(' | '));
});

check('the orb paint is scoped to the orb class', () => {
// Nothing in the orb block may leak onto the flat button.
assert.match(css, /\.file-toolbar--orb \.file-toolbar__trigger::before \{/, 'sphere is variant-scoped');
assert.match(css, /\.file-toolbar--orb \.file-toolbar__stack \{/, 'orbit is variant-scoped');
assert.match(css, /\.file-toolbar--orb \.file-toolbar__plate \{/, 'slab is variant-scoped');
});
check('the pictogram fits inside the painted sphere, with glass left over', () => {
// The button is 44px with the flat trigger's 2px inset, so the painted
// sphere is 40px. The stack is chevron + folder + chevron; the folder is the
// widest thing and the six stacked SVG copies all share its box.
const CHEV = 2;   // the stack's 1px flex gap, twice
const chevronW = Number(component.match(/const ORB_CHEVRON_W = (\d+(?:\.\d+)?);/)[1]);
const chevronH = Number(component.match(/const ORB_CHEVRON_H = (\d+(?:\.\d+)?);/)[1]);
const folderW = Number(component.match(/const ORB_FOLDER_W = (\d+(?:\.\d+)?);/)[1]);
const folderH = Number(component.match(/const ORB_FOLDER_H = (\d+(?:\.\d+)?);/)[1]);
const SPHERE = 44 - 2 * 2;
const stackW = Math.max(chevronW, folderW);
const stackH = chevronH * 2 + folderH + CHEV;
assert.ok(stackW <= SPHERE * 0.70,
'stack width ' + stackW + 'px is ' + (100 * stackW / SPHERE).toFixed(0) + '% of the ' + SPHERE + 'px sphere; over 70% there is no glass left around the artwork');
assert.ok(stackH <= SPHERE * 0.85,
'stack height ' + stackH + 'px is ' + (100 * stackH / SPHERE).toFixed(0) + '% of the ' + SPHERE + 'px sphere; over 85% the chevrons reach the rim');
// And the plate the counts are laid out on has to be the folder's box, or the
// sizer's budgets (computed from ORB_FOLDER_W/H) describe the wrong rectangle.
// That equality is asserted in the sizer check above.
assert.ok(folderW >= 16, 'the folder must stay wide enough for a legible count');
});

check('only the highlights animate, so the pictogram stays crisp', () => {
  const motionStart = css.indexOf('@media (prefers-reduced-motion: no-preference)');
  assert.ok(motionStart > -1, 'a no-preference block exists');
  const motionBlock = css.slice(motionStart);
  for (const name of ['file-orb-sheen', 'file-orb-folder-sheen']) {
    const at = css.indexOf('@keyframes ' + name);
    assert.ok(at > motionStart, name + ' is inside the no-preference block');
  }
  assert.doesNotMatch(motionBlock, /@keyframes file-orb-(tilt|float)/, 'the glyph does not orbit between pixels');
  assert.doesNotMatch(motionBlock, /\.file-toolbar--orb \.file-toolbar__(stack|plate)\s*\{[^}]*animation:/, 'the stack and plate stay still');
});

check('the pictogram is front-on and pixel-aligned', () => {
  const stack = css.match(/\.file-toolbar--orb \.file-toolbar__stack \{([^}]*)\}/);
  const plate = css.match(/\.file-toolbar--orb \.file-toolbar__plate \{([^}]*)\}/);
  assert.ok(stack && plate, 'the stack and plate rules exist');
  assert.match(stack[1], /transform:\s*translateZ\(0\)/, 'the stack gets a compositing layer without rotation');
  assert.match(plate[1], /transform:\s*translateZ\(0\)/, 'the folder stays front-on');
  assert.doesNotMatch(stack[1] + plate[1], /perspective|rotate|scale/, 'no subpixel transform softens the glyph');
});

// ---- 5. the orb reads as glass, not as a shaded disc ---------------------
// Four things carry the reference's look, and each one is a place the render
// can silently regress to the flat-looking button it replaced. They are
// asserted as *relationships* between the declared tones rather than as
// literal hex values, so the palette can still be tuned.
const LIGHTNESS = (hex) => {
  const m = String(hex).match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};
const gradientStops = (from, to) => {
  const a = component.indexOf("'" + from + "'");
  const b = component.indexOf("'" + to + "'");
  if (a < 0 || b <= a) return [];
  return [...component.slice(a, b).matchAll(/'stop-color':\s*'(#[0-9a-f]{6})'/gi)].map((m) => m[1]);
};

check('the chevrons are drawn as a bevelled solid, not one currentColor path', async () => {
  // The bar crosses the ball's own sheen, where a bare `currentColor` bar
  // (--fg-soft, a grey) measured under 1.4:1 and disappeared. The orb must
  // therefore emit a white face *and* a dark side copy per chevron, while the
  // flat variant keeps exactly the single path it always had.
  const orbNodes = await renderToolbar(true);
  const flatNodes = await renderToolbar(false);
  assert.equal(cls(orbNodes, 'file-toolbar__chevron').length, 2, 'one SVG per chevron');
  assert.equal(cls(orbNodes, 'file-toolbar__chevron--up').length, 1, 'the up bar is addressable');
  assert.equal(cls(orbNodes, 'file-toolbar__chevron--down').length, 1, 'the down bar is addressable');
  assert.equal(cls(orbNodes, 'file-toolbar__chevron-face').length, 2, 'a lit face per bar');
  assert.equal(cls(orbNodes, 'file-toolbar__chevron-side').length, 2, 'a dark side per bar');
  assert.equal(cls(flatNodes, 'file-toolbar__chevron').length, 0, 'the flat button is untouched');
  assert.equal(cls(flatNodes, 'file-toolbar__chevron-face').length, 0, 'the flat button sheds no skin');
  // The face must not be left to inherit: it is the only thing that makes the
  // bar visible over the lit half of the sphere.
  assert.match(css, /\.file-toolbar--orb \.file-toolbar__chevron-face \{[^}]*fill:\s*#(?:ffffff|e8f2ff)/, 'the bar face is near-white');
  assert.match(css, /\.file-toolbar--orb \.file-toolbar__chevron-side \{[^}]*fill:\s*rgba\(/, 'the bar side is a dark tone');
});

check('the folder is the only painted centre object', () => {
  // The reference has one broad folder silhouette, not a folder floating on a
  // second rounded rectangle. Keep the plate for 3D positioning, but require
  // its face to stay transparent and shadowless.
  const tileRule = css.match(/\.file-toolbar--orb \.file-toolbar__plate-face \{([^}]*)\}/);
  assert.ok(tileRule, 'found the plate-face rule');
  assert.match(tileRule[1], /background:\s*transparent;/, 'the plate does not paint a second card');
  assert.match(tileRule[1], /box-shadow:\s*none;/, 'the plate has no rectangular edge');
  assert.match(component, /const ORB_FOLDER_PATH = /, 'orb mode has its own broad folder silhouette');
  assert.match(component, /\['face', h\('path', \{ d: ORB_FOLDER_PATH \}\)\]/, 'the visible folder uses the orb silhouette');
  const countRule = css.match(/\.file-toolbar--orb \.file-toolbar__git-additions,[\s\S]*?\.file-toolbar--orb \.file-toolbar__git-deletions \{([^}]*)\}/);
  assert.ok(countRule, 'found the orb count positioning rule');
  assert.match(countRule[1], /position:\s*relative;/, 'each count anchors its emboss copy');

  const faceStops = gradientStops('fileToolbarFolderFace', 'fileToolbarFolderShade').map(LIGHTNESS).filter((n) => n !== null);
  assert.ok(faceStops.length >= 4, 'the face is a five-stop ramp');
  assert.ok(Math.max(...faceStops) > 0.9, 'the face is near-white at the top');
});

check('the orb counts are the brighter validated pair', () => {
  // #006600 was chosen for a flat glyph on --fg. Embossed into a lit solid
  // with a dark under-copy and a white lip it reads as near-black, so the orb
  // carries its own, measurably *lighter* pair — and both must still clear the
  // 4.5:1 small-text budget against the pale bed they actually sit on. The
  // flat pair must NOT move: the orb is a skin, and the flat button's
  // contrast notes are pinned to #006600 / #b30000.
  const orbAdd = css.match(/\.file-toolbar--orb \.file-toolbar__git-additions \{[^}]*color:\s*(#[0-9a-f]{6})/i);
  const orbDel = css.match(/\.file-toolbar--orb \.file-toolbar__git-deletions \{[^}]*color:\s*(#[0-9a-f]{6})/i);
  const flatAdd = css.match(/\.file-toolbar__git-additions \{[^}]*color:\s*(#[0-9a-f]{6})/i);
  const flatDel = css.match(/\.file-toolbar__git-deletions \{[^}]*color:\s*(#[0-9a-f]{6})/i);
  assert.ok(orbAdd && orbDel, 'the orb overrides both inks');
  assert.equal(flatAdd[1].toLowerCase(), '#006600', 'the flat green is unchanged');
  assert.equal(flatDel[1].toLowerCase(), '#b30000', 'the flat red is unchanged');
  const chan = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
  };
  const contrast = (a, b) => {
    const la = lum(a); const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const bed = '#eceaf1';   // the face's pale bed, the same tone the flat pair uses
  for (const [name, orb, flat] of [['green', orbAdd[1], flatAdd[1]], ['red', orbDel[1], flatDel[1]]]) {
    assert.ok(lum(orb) > lum(flat),
      'the orb ' + name + ' (' + orb + ') must be lighter than the flat ' + flat + ' it replaced');
    assert.ok(contrast(orb, bed) >= 4.5,
      'orb ' + name + ' ' + orb + ' is ' + contrast(orb, bed).toFixed(2) + ':1 on ' + bed + ', needs 4.5:1');
    assert.ok(contrast(flat, bed) >= 4.5, 'the flat ' + name + ' must keep its own budget');
  }
});

// Run them in order; the first failure rejects and stops the file.
for (const run of checks) await run();
console.log('\ntest-file-orb: OK (' + pass + ' checks)');
