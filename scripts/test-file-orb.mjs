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

const { fileOrbFromApp, FILE_ORB_DEFAULT, FILE_ORB_KEY } = await import(
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

// ---- 4. the CSS invariants ---------------------------------------------

const css = read('frontend/src/chat-composer.css');

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

check('the animation is opt-in under no-preference and holds a frame otherwise', () => {
  const motionStart = css.indexOf('@media (prefers-reduced-motion: no-preference)');
  assert.ok(motionStart > -1, 'a no-preference block exists');
  const motionBlock = css.slice(motionStart);
  // The animated property must be registered, or it flips instead of tweening.
  assert.match(motionBlock, /@property --orb-tilt \{\s*syntax: '<angle>';/, '--orb-tilt is registered as an angle');
  assert.match(motionBlock, /@property --orb-depth \{\s*syntax: '<length>';/, '--orb-depth is registered as a length');
  // The keyframes must live inside the block, so reduced-motion users get the
  // rest pose rather than a jump cut.
  for (const name of ['file-orb-tilt', 'file-orb-float', 'file-orb-sheen', 'file-orb-folder-sheen']) {
    const at = css.indexOf('@keyframes ' + name);
    assert.ok(at > motionStart, name + ' is inside the no-preference block');
  }
  // Only compositable properties may be animated: transform, opacity, and the
  // two registered custom properties. A layout property here would reflow the
  // composer on every frame.
  const kf = css.slice(motionStart);
  for (const banned of ['width:', 'height:', 'top:', 'left:', 'margin', 'padding', 'font-size']) {
    const keyframes = kf.split('@keyframes');
    for (const block of keyframes.slice(1)) {
      const body = block.slice(block.indexOf('{'), block.indexOf('}') + 1);
      assert.ok(!body.includes(banned), 'keyframes must not animate ' + banned);
    }
  }
});

check('the rest pose is a full 3/4 view, not a flat front-on frame', () => {
  // With reduced motion (and before the first animation tick) the base rule is
  // what the user sees, so it must already carry a tilt.
  const m = css.match(/\.file-toolbar--orb \.file-toolbar__stack \{[^}]*transform:([^;]+);/);
  assert.ok(m, 'the stack has a base transform');
  assert.match(m[1], /perspective\(/, 'the base transform sets a perspective');
  assert.match(m[1], /-9deg/, 'a base rotateX offset');
  assert.match(m[1], /6deg/, 'a base rotateY offset');
});

// Run them in order; the first failure rejects and stops the file.
for (const run of checks) await run();
console.log('\ntest-file-orb: OK (' + pass + ' checks)');
