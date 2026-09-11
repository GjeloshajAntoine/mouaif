'use strict';

// Regression test: opening an image in the file editor must never feed the
// file's bytes to `innerHTML`.
//
// The file editor used to render an SVG preview by decoding the file and
// handing the markup to `dangerouslySetInnerHTML` on a `.fe__media-svg`
// div. That div is in the app's own origin, so any `.svg` a project
// contains — a logo, a fixture, something a model just wrote — ran with
// the page's privileges: `<script>`, `on*` handlers, `<animate onbegin>`,
// `<foreignObject>` in HTML content, session cookie and `/api/*` access.
//
// Every previewable image, SVG included, now goes through one `<img>`
// with the server's `data:` URL. An SVG loaded that way is a separate,
// script-disabled document.
//
// This test is deliberately two-sided:
//   * a source guard on the component (the actual fix — a render test
//     would need CodeMirror and a full DOM), and
//   * a real check against `src/files.js` that the SVG data URL the
//     component receives is exactly what an `<img src>` can render.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const files = require('../src/files.js');

let pass = 0;
let fail = 0;
function check(name, cond, msg) {
  if (cond) { pass++; console.log('  ok   - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (msg ? (' :: ' + msg) : '')); }
}

const EDITOR = path.join(__dirname, '../frontend/src/components/FileEditor.jsx');
const CSS = path.join(__dirname, '../frontend/src/file-editor.css');

async function main() {
  const src = fs.readFileSync(EDITOR, 'utf8');

  // ---- 1. Source guard: no raw markup into the DOM -------------------

  check('the file editor never uses dangerouslySetInnerHTML',
    !src.includes('dangerouslySetInnerHTML'),
    'a preview path that injects file bytes as HTML executes attacker markup');

  check('the file editor does not base64-decode file bytes for display',
    !/\batob\s*\(/.test(src),
    'atob(...) here only ever fed innerHTML');

  check('the image preview renders an <img> with the server data URL',
    /h\('img',\s*\{[\s\S]{0,200}?src:\s*openMedia\.dataUrl/.test(src),
    'expected a single <img src=openMedia.dataUrl> preview branch');

  check('the preview branch has no SVG-specific innerHTML path left',
    !/class:\s*['"]fe__media-svg['"]/.test(src),
    'the SVG branch was the injection point; it must not come back');

  // ---- 2. The CSS container for raw markup stays dead ----------------

  const css = fs.readFileSync(CSS, 'utf8');
  const svgRule = css.match(/\.fe__media-svg\s*\{[\s\S]*?\}/);
  check('.fe__media-svg is a no-op if it still exists at all',
    !svgRule || /display:\s*none/.test(svgRule[0]),
    svgRule ? ('rule is live: ' + svgRule[0].replace(/\s+/g, ' ').slice(0, 60)) : '');

  // ---- 3. Behavioural: the SVG data URL really is img-renderable -----

  const root = fs.mkdtempSync(path.join(os.homedir(), '.mouaif-test-svg-'));
  const payload = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4">'
    + '<script>window.__pwned=1</script>'
    + '<rect width="4" height="4" fill="#6ea8fe"/></svg>';
  fs.writeFileSync(path.join(root, 'pwn.svg'), payload, 'utf8');
  try {
    const media = await files.readMedia(root, 'pwn.svg');
    check('readMedia returns an image/svg+xml data URL',
      media.mime === 'image/svg+xml' && media.dataUrl.startsWith('data:image/svg+xml;base64,'),
      'mime=' + media.mime + ' url=' + String(media.dataUrl).slice(0, 40));
    check('the data URL carries the file bytes verbatim',
      Buffer.from(media.dataUrl.split(',')[1], 'base64').toString('utf8') === payload,
      'the component may only rely on the <img> sandbox, not on sanitising here');
    check('the payload does contain script (so the guard is meaningful)',
      payload.includes('<script>'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---');
  if (fail) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
