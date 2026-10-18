'use strict';

// sectionSpy — the Styles panel's section rail follows the scroller.
//
// The rail used to be a jump list only: four identical chips that could move the
// panel but never said where the user already was. The spy is the missing half,
// and its whole value is in three boundary rules that are easy to get subtly
// wrong and impossible to eyeball in a screenshot:
//
//   1. the reading line is the *bottom of the pinned chrome*, not `scrollTop` —
//      the heading a user sees first is the one under the sticky strips;
//   2. the last section is reported when the panel is at its end, because a short
//      final section can sit entirely inside the last screenful and never cross
//      the reading line;
//   3. before the first section (the element tree and the preview) the rail
//      reports the first section rather than nothing, so it is never blank.
//
// Pure data in, id out — no DOM — so these are asserted directly.

const assert = require('node:assert/strict');
const path = require('node:path');

const mod = require(path.join(__dirname, '../frontend/src/components/inspector/sectionSpy.js'));

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// A four-section panel shaped like the real one at 360 px: Controls is the long
// one, Declared and Rules are short, Computed is long again.
const BOXES = [
  { id: 'controls', top: 316 },
  { id: 'declared', top: 1789 },
  { id: 'rules', top: 2934 },
  { id: 'computed', top: 3019 }
];

console.log('sectionSpy');

// ---- the destination list ----------------------------------------------
check('the four sections are named in scroll order',
  mod.SECTIONS.map((s) => s.id).join(',') === 'controls,declared,rules,computed'
  && mod.SECTION_IDS.length === 4);

// ---- the reading line --------------------------------------------------
check('a scroll inside the first section reports it',
  mod.activeSection(BOXES, 900) === 'controls');
check('a heading that has arrived at the reading line is current',
  mod.activeSection(BOXES, 1789) === 'declared',
  'the jump lands a heading flush under the chrome, so that is the boundary');
check('a heading still below the reading line is not yet current',
  mod.activeSection(BOXES, 1760) === 'controls');
check('the rules heading flips the rail at its offset',
  mod.activeSection(BOXES, 2934) === 'rules'
  && mod.activeSection(BOXES, 2900) === 'declared');
check('a scroll past the computed heading reports computed',
  mod.activeSection(BOXES, 3050) === 'computed');

// ---- the slop ----------------------------------------------------------
// It exists to absorb the few px between "the jump landed the heading" and "the
// spy's line reached it", so a tapped chip is the chip that ends up lit.
check('a small slop still reports a heading the jump has just landed',
  mod.activeSection(BOXES, 1789 - mod.SECTION_SLOP) === 'declared');
check('the slop is the jump inset plus sub-pixel slack',
  mod.SECTION_SLOP === 8,
  'the strips measure fractionally, so an exactly-equal boundary resolves the wrong way');
check('a slop of zero is the raw heading offset',
  mod.activeSection(BOXES, 1789, { slop: 0 }) === 'declared');
check('a caller can widen the slop to flip a section earlier',
  mod.activeSection(BOXES, 1700, { slop: 200 }) === 'declared'
  && mod.activeSection(BOXES, 1700) === 'controls');

// ---- above the first section -------------------------------------------
check('scrolled into the tree or the preview, the first section is reported',
  mod.activeSection(BOXES, 0) === 'controls'
  && mod.activeSection(BOXES, 40) === 'controls',
  'the rail must never be blank');

// ---- the end of the panel ----------------------------------------------
// A short last section can sit entirely inside the last screenful, so its
// heading never crosses the reading line; the rail would keep pointing at the
// section above the one on screen.
check('at the end, the last section wins whatever the offsets say',
  mod.activeSection(BOXES, 2000, { atEnd: true }) === 'computed');
check('at the end with a single short section', 
  mod.activeSection([{ id: 'controls', top: 0 }, { id: 'computed', top: 2900 }], 1000, { atEnd: true }) === 'computed');

// ---- degenerate input --------------------------------------------------
check('no sections reports no section',
  mod.activeSection([], 0) === '' && mod.activeSection(null, 0) === '');
check('a malformed box is skipped rather than poisoning the arithmetic',
  mod.activeSection([{ id: 'controls', top: 0 }, { id: null, top: 10 }, { id: 'rules', top: NaN }, { id: 'computed', top: 50 }], 80) === 'computed');
check('a non-numeric reading line is treated as the top',
  mod.activeSection(BOXES, NaN) === 'controls' && mod.activeSection(BOXES, undefined) === 'controls');

// ---- isAtEnd -----------------------------------------------------------
check('the bottom of the scroller is the end',
  mod.isAtEnd(900, 600, 1500) === true);
check('one row above the bottom still counts as the end, so the last short section is reachable',
  mod.isAtEnd(860, 600, 1500) === true,
  'a heading 1 px under the line is not yet the section on screen');
check('the middle of the list is not the end',
  mod.isAtEnd(400, 600, 2000) === false);
check('a panel with nothing to scroll is always at its end',
  mod.isAtEnd(0, 600, 600) === true);
check('a caller can tighten the slack',
  mod.isAtEnd(860, 600, 1500, 10) === false);

// ---- the wiring --------------------------------------------------------
// The rail must render from the module's list and publish the active id, or the
// spy's answer never reaches the UI. Both are asserted here because they are the
// only link between the pure module and the panel.
const fs = require('node:fs');
const panelSource = fs.readFileSync(path.join(__dirname, '../frontend/src/components/inspector/StylesPanel.jsx'), 'utf8');
const stylesCss = fs.readFileSync(path.join(__dirname, '../frontend/src/inspector-styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

check('the rail renders its chips from the shared list',
  /SECTIONS\.map\(\(s\) =>/.test(panelSource)
  && !/\{ id: 'controls', label: 'Controls' \}/.test(panelSource),
  'a second hand-written list is how the chips and the spy drift apart');
check('the active chip carries a class and aria-current',
  /' is-on'/.test(panelSource) && /'aria-current': s\.id === activeId \? 'true' : undefined/.test(panelSource));check('a tap sets the destination as current immediately',
  /setActiveId\(id\)/.test(panelSource),
  'waiting for the smooth scroll leaves the old chip lit, which reads as a missed tap');
check('the spy runs on scroll through one rAF',
  /syncActiveSection\(\)/.test(panelSource) && /requestAnimationFrame/.test(panelSource));
check('the section offsets are read live, so no cache can go stale',
  /const box = node\.getBoundingClientRect\(\)/.test(panelSource)
  && !/const sectionBoxesRef/.test(panelSource),
  'the preview and the rules load after the render; a cached offset then lights the wrong chip');
check('the jump and the spy use the same chrome height',
  /const offset = pinnedStackHeight\(\)/.test(panelSource)
  && /const chrome = \(pinRef\.current/.test(panelSource),
  'if the jump offsets by one number and the spy reads with another, a tap lands on the wrong chip');
check('the active chip is styled, not just classed',
  /\.inspector__styles-jump-chip\.is-on\s*\{[^}]*background:\s*var\(--accent\)/.test(stylesCss));
check('the rail wraps instead of clipping enlarged text',
  /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(4\.5rem,\s*1fr\)\)/.test(stylesCss),
  'a fixed four-column grid ellipsized "Computed" at a 20 px root font');

// The active chip inverts to the light theme's accent, and its count inverts
// again inside it. Both pairs are read at a glance on a phone, so they have to
// clear AA on the surfaces the chip actually uses.
const { contrast } = require('../frontend/src/components/inspector/contrast.js');
const LIGHT = {
  accent: '#54516d', 'on-accent': '#ffffff', surface: '#ffffff',
  'surface-2': '#f3f3f1', 'surface-3': '#e9e9e6', muted: '#575b60', 'fg-soft': '#484b50'
};check('the active chip label clears AA on the accent fill',
  contrast(LIGHT['on-accent'], LIGHT.accent).ratio >= 4.5,
  contrast(LIGHT['on-accent'], LIGHT.accent).ratio.toFixed(2));
check('the count clears AA inside the active chip',
  contrast(LIGHT.accent, LIGHT['on-accent']).ratio >= 4.5,
  contrast(LIGHT.accent, LIGHT['on-accent']).ratio.toFixed(2));
check('an unselected chip label clears AA on the card surface',
  contrast(LIGHT['fg-soft'], LIGHT['surface-2']).ratio >= 4.5,
  contrast(LIGHT['fg-soft'], LIGHT['surface-2']).ratio.toFixed(2));
check('an unselected count clears AA on its own pill',
  contrast(LIGHT.muted, LIGHT['surface-3']).ratio >= 4.5,
  contrast(LIGHT.muted, LIGHT['surface-3']).ratio.toFixed(2));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
assert.equal(failed, 0, failed + ' sectionSpy assertion(s) failed');
