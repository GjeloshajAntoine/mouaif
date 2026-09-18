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
// A second symptom, "the background visibly changes on reload", is a
// step from solid `--bg` to `radial-gradient(...), var(--bg)` once the
// bundle's CSS lands. The two rules set the same `background` property
// at the same specificity, so the later bundle rule paints on top of
// the inline rule; if the two values differ at all, the browser
// repaints visibly. The fix is to inline the bundle's full `html`
// background (gradient + literal `--bg`) so the later rule is a no-op
// repaint of an identical pixel stack.
//
// Three things are checked, all load-bearing:
//   1. frontend/index.html carries an INLINE `html` background, so the
//      rule is in the document at the first paint. A background that
//      lives only in the external bundle cannot fix this — the flash
//      happens while that file is still in flight.
//   2. the inline background value equals the bundle's `html` background
//      value with `var(--bg)` resolved to its literal. The two rules
//      set the same `background` property at the same specificity, so
//      a mismatch is a visible step. They must agree on the full
//      background stack, not just the base colour.
//   3. the inline block comes BEFORE the bundler-injected
//      `<link rel="stylesheet">`. That ordering is what lets the bundle's
//      rule take over (Vite appends its link at the end of <head>); a
//      rule that drifted below it would be inert.
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

// Normalize a CSS background stack so two rules that name the same
// values in the same order compare equal. Whitespace, trailing commas,
// and the optional final `;` are stripped; values are lowercased so
// `#0A0D12` and `#0a0d12` agree.
function normalize(stack) {
  return String(stack || '')
    .trim()
    .replace(/;$/, '')
    .split(',')
    .map((part) => part.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(',');
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

// --- 2. the inline background equals the bundle's html background ---------
// Read the inline `html { background: ... }` value out of the template.
// The body of the rule may span lines, so grab everything between
// `background:` and the next `}`.
const inlineRaw = (/<style>\s*html\s*\{[\s\S]*?background\s*:\s*([^;}]+)[\s\S]*?\}\s*<\/style>/.exec(html) || [])[1];

// Read the bundle's `html { background: ... }` from base.css, with
// `var(--bg)` resolved to its literal so the two stacks compare on
// values rather than on token references.
const bgToken = (/--bg:\s*([^;]+);/.exec(base) || [])[1];
const bgLiteral = (bgToken || '').trim();
const bundleRaw = (/\bhtml\s*\{[\s\S]*?background\s*:\s*([^;}]+)[\s\S]*?\}/.exec(base) || [])[1];
const bundleResolved = bundleRaw ? bundleRaw.replace(/var\(\s*--bg\s*\)/g, bgLiteral) : '';

check('an inline background value can be read back', typeof inlineRaw, 'string');
check('a bundle html background value can be read back', typeof bundleRaw, 'string');
check('the inline html background equals the bundle html background',
  normalize(inlineRaw), normalize(bundleResolved));

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
  // The minified bundle asserts byte-level: the inline block must have
  // survived Vite's minifier and the gradient must still be there with
  // the literal base colour, so a future regression that strips either
  // piece is caught before it lands in dist/.
  check('built index.html: the gradient survived minification',
    /<style>html\{background:radial-gradient\(900px 420px at 50% 110%,rgba\(110,168,254,\.045\),transparent 60%\),#0a0d12\}<\/style>/.test(dist), true);
} else {
  console.log('  ..  - frontend/dist/index.html not built; run npm run build:web to cover the built artifact');
}

// Nothing may be left that would paint the browser's default canvas instead:
// a `color-scheme` hint alone still lands on grey (#121212), not the app bg.
const lightHint = /color-scheme\s*[:=]\s*["']?(light|normal)\b/i.exec(html);
check('no light color-scheme hint in index.html', lightHint, null);

console.log(failures ? '\n' + failures + ' check(s) failed' : '\nOK — the app is dark from the first paint, and the reload no longer steps');
process.exit(failures ? 1 : 0);
