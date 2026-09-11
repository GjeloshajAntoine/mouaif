'use strict';

// The Inspector styles are the biggest CSS surface in the app, so
// `frontend/src/inspector.css` is an entry point that `@import`s twelve
// per-panel parts (see docs/features/inspector.md). Vite inlines those
// imports into one bundle.
//
// Tests that read the Inspector CSS as *source* (they regex for rules
// wherever the rule lives) want the whole cascade, not the 39-line entry,
// so this helper inlines the imports the same way the bundler does:
//
//   const { readInspectorCss } = require('./inspector-css.js');
//   const css = readInspectorCss();
//
// Paths are relative to the repo root, and `inlineImports` is exported for
// any other entry-point CSS file that gets split later.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IMPORT_RE = /@import\s+['"]([^'"]+)['"]\s*;/g;

// inlineImports(css, fromDir) — replace every `@import './x.css';` with the
// referenced file's contents, recursively. Non-CSS and unresolvable imports
// are left as written.
function inlineImports(css, fromDir) {
  return css.replace(IMPORT_RE, (match, rel) => {
    if (!rel.endsWith('.css')) return match;
    const abs = path.resolve(fromDir, rel);
    if (!fs.existsSync(abs)) return match;
    return inlineImports(fs.readFileSync(abs, 'utf8'), path.dirname(abs));
  });
}

// readInspectorCss(relPath) — the Inspector cascade as one string.
function readInspectorCss(relPath) {
  const rel = relPath || 'frontend/src/inspector.css';
  const abs = path.join(ROOT, rel);
  return inlineImports(fs.readFileSync(abs, 'utf8'), path.dirname(abs));
}

module.exports = { readInspectorCss, inlineImports };
