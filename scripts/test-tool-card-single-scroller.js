'use strict';

// Regression test: an expanded tool card has exactly ONE vertical scroller,
// its body.
//
// The shell card used to nest three: the body (40dvh), the live output
// (`.tool-card__shell-live-pre`, 30dvh) and the full command
// (`.tool-preview__pre--args`, 33dvh). On a touch screen a swipe that started
// inside an inner box scrolled that box, then the body, then the transcript,
// and the live-output pin (which scrolls the body) could not follow output
// that was scrolling inside its own box.
//
// This resolves every rule in tool-cards.css that makes an element scroll
// vertically and checks the list against the known, deliberate scrollers.

const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../frontend/src/tool-cards.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// Scrollers that are allowed to exist. Each is either the card body itself
// or a surface that is NOT inside a scrolling body (the ask_user body is
// `overflow: visible`, so its option list is the only scroller there).
const ALLOWED = new Set([
  '.tool-card.is-expanded .tool-card__body',
  '.tool-card--authorization .tool-card__body',
  '.tool-card.tool-card--subagent .tool-card__body',
  '.tool-card__ask-options'
]);

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

const scrollers = [];
const re = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = re.exec(css))) {
  const decls = m[2];
  const vertical = /overflow-y\s*:\s*(auto|scroll)/.test(decls) || /(?:^|;)\s*overflow\s*:\s*(auto|scroll)/.test(decls);
  if (!vertical) continue;
  for (const sel of m[1].split(',')) scrollers.push(sel.trim().replace(/\s+/g, ' '));
}

for (const sel of scrollers) {
  check('vertical scroller is an allowed surface: ' + sel, ALLOWED.has(sel));
}

for (const inner of ['.tool-card__shell-live-pre', '.tool-preview__pre--args', '.tool-preview__terminal', '.tool-preview__pre']) {
  const hit = scrollers.find((s) => s.endsWith(inner));
  check(inner + ' does not scroll inside the card body', !hit, hit);
}

// The height caps that used to come with the nested scrollers are gone too;
// a cap without a scroller would silently clip the output instead.
for (const inner of ['.tool-card__shell-live-pre', '.tool-preview__pre--args']) {
  const rule = new RegExp('(?:^|})\\s*' + inner.replace(/[.-]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm').exec(css);
  check(inner + ' carries no max-height', !!rule && !/max-height/.test(rule[1]), rule ? rule[1].trim() : 'rule not found');
}

console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
if (failed) process.exitCode = 1;
