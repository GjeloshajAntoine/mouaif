// Verifies that the app's document paints the app background before its
// stylesheet arrives.
//
// The bug this pins: "grey flashes with page reload" — a light frame between
// the document commit and the bundle's CSS. The document's only background
// came from the `@import`-ed index CSS, and that stylesheet is requested
// before the module script runs, so the first paint was the browser's default
// canvas. Measured on a headless Chrome (390x844, mobile): a document with
// the `color-scheme: dark` meta and no stylesheet paints #121212 (RGB
// 18,18,18) — a grey flash. With no color-scheme hint at all it is #fff.
//
// Three things are checked, all load-bearing:
//   1. frontend/index.html carries an INLINE background on `html`, so the
//      rule is in the document at the first paint. A background that lives
//      only in the external bundle cannot fix this — the flash happens while
//      that file is still in flight.
//   2. the inline colour is the literal value of `--bg` in base.css. The
//      inline rule and the bundle's own `html { background: radial-gradient(...),
//      var(--bg) }` set the same property at the same specificity, so they
//      must agree on the base colour or the page visibly steps between them.
//   3. the inline block comes BEFORE the bundler-injected
//      `<link rel="stylesheet">`. That ordering is what lets the bundle's
//      later rule take over and add the accent glow; Vite appends its link at
//      the end of <head>, so a rule that drifted below it would be inert.
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');

const html = read('frontend/index.html');
const base = read('frontend/src/base.css');

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log((ok ? '  ok  - ' : '  FAIL- ') + name
    + (ok ? '' : ' :: got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected)));
}

// --- 1. the inline rule exists, in <head>, before the stylesheet link ------
// Comments are stripped first: the block explaining this rule quotes
// `<link rel="stylesheet">`, which would otherwise look like a real tag.
const markup = html.replace(/<!--[\s\S]*?-->/g, '');
const headEnd = html.indexOf('</head>');
const styleAt = markup.indexOf('<style>');
const styleEnd = markup.indexOf('</style>', styleAt);
const linkAt = markup.indexOf('rel="stylesheet"');
check('index.html has an inline <style> block', styleAt >= 0, true);
check('the inline <style> is inside <head>', styleAt >= 0 && styleAt < headEnd, true);
check('the inline <style> is well formed', styleEnd > styleAt, true);
check('an inline background is declared on html',
  /<style>\s*html\s*\{[^}]*background[^}]*\}\s*<\/style>/.test(markup), true);

// --- 2. the inline colour is exactly --bg ---------------------------------
const inlineColor = (/<style>\s*html\s*\{[^}]*background\s*:\s*([^;}\s]+)/.exec(html) || [])[1];
const bgToken = (/--bg:\s*([^;]+);/.exec(base) || [])[1];
check('an inline background value can be read back', typeof inlineColor, 'string');
check('the inline colour is the --bg token value',
  inlineColor && inlineColor.toLowerCase(), (bgToken || '').trim().toLowerCase());

// --- 3. the inline rule still precedes the bundle's stylesheet ------------
// The template has no stylesheet link of its own (Vite injects it into the
// build output at the end of <head>). Out of the box there is therefore
// nothing to order against, so this also checks the built dist/index.html —
// the artifact the browser actually receives — whenever a build is present.
check('the source template has no stylesheet link to precede',
  linkAt < 0, true);
const distPath = new URL('frontend/dist/index.html', root);
if (fs.existsSync(distPath)) {
  const dist = fs.readFileSync(distPath, 'utf8');
  const distStyleAt = dist.indexOf('<style>');
  const distLinkAt = dist.indexOf('rel="stylesheet"');
  check('built index.html: inline rule precedes the bundle stylesheet',
    distStyleAt >= 0 && distLinkAt >= 0 && distStyleAt < distLinkAt, true);
  check('built index.html: the base background survived minification',
    /<style>html\{background:#0a0d12\}<\/style>/.test(dist), true);
} else {
  console.log('  ..  - frontend/dist/index.html not built; run npm run build:web to cover the built artifact');
}

// Nothing may be left that would paint the browser's default canvas instead:
// a `color-scheme` hint alone still lands on grey (#121212), not the app bg.
const lightHint = /color-scheme\s*[:=]\s*["']?(light|normal)\b/i.exec(html);
check('no light color-scheme hint in index.html', lightHint, null);

console.log(failures ? '\n' + failures + ' check(s) failed' : '\nOK — the app is dark from the first paint');
process.exit(failures ? 1 : 0);
