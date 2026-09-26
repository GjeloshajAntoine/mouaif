// Regression test for the static docs build (scripts/build-docs.js).
//
// GitHub Pages serves only docs/, so every relative link on a published page
// must resolve to a file the build writes. Links to repository files outside
// the site (src/, scripts/, .github/, …) must go to GitHub, maintainer pages
// must not be linked from a public build, and public pages must not cite
// decision numbers that only exist in the unpublished decisions log.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(__dirname, 'build-docs.js');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    process.stdout.write('ok   ' + name + '\n');
  } catch (err) {
    failed++;
    process.stdout.write('FAIL ' + name + '\n  ' + (err && err.message) + '\n');
  }
}

function build(extraArgs) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-docs-test-'));
  const res = spawnSync('node', [BUILD, '--out', out].concat(extraArgs), { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, 'build failed: ' + res.stderr);
  return { out, stderr: res.stderr };
}

function htmlFiles(dir) {
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) files.push(...htmlFiles(abs));
    else if (name.endsWith('.html')) files.push(abs);
  }
  return files;
}

function brokenLocalLinks(root) {
  const bad = [];
  for (const file of htmlFiles(root)) {
    const html = fs.readFileSync(file, 'utf8');
    for (const m of html.matchAll(/(?:href|src)="([^"#?]+)[^"]*"/g)) {
      const url = m[1];
      if (/^(https?:|mailto:|data:|\/\/)/.test(url)) continue;
      if (!fs.existsSync(path.resolve(path.dirname(file), url))) {
        bad.push(path.relative(root, file) + ' -> ' + url);
      }
    }
  }
  return bad;
}

const pub = build([]);
const internal = build(['--with-internal']);

try {
  check('public build: no link warnings', () => {
    assert.ok(!/links to missing/.test(pub.stderr), pub.stderr);
  });

  check('internal build: no link warnings', () => {
    assert.ok(!/links to missing/.test(internal.stderr), internal.stderr);
  });

  check('public build: every relative href/src resolves', () => {
    const bad = brokenLocalLinks(pub.out);
    assert.deepStrictEqual(bad.slice(0, 10), [], bad.length + ' broken link(s)');
  });

  check('internal build: every relative href/src resolves', () => {
    const bad = brokenLocalLinks(internal.out);
    assert.deepStrictEqual(bad.slice(0, 10), [], bad.length + ' broken link(s)');
  });

  check('public build: writes no maintainer pages', () => {
    assert.ok(!fs.existsSync(path.join(pub.out, 'decisions.html')));
    assert.ok(!fs.existsSync(path.join(pub.out, 'agent')));
  });

  check('public build: no link to a maintainer page', () => {
    for (const file of htmlFiles(pub.out)) {
      const html = fs.readFileSync(file, 'utf8');
      assert.ok(!/href="[^"]*(decisions|agent-notes)\.html/.test(html), path.relative(pub.out, file));
      assert.ok(!/href="(\.\.\/)*agent\//.test(html), path.relative(pub.out, file));
    }
  });

  check('public build: source-file links point at GitHub', () => {
    const html = fs.readFileSync(path.join(pub.out, 'features', 'docs-site.html'), 'utf8');
    assert.match(html, /href="https:\/\/github\.com\/[^/"]+\/[^/"]+\/blob\/master\/scripts\/build-docs\.js"/);
  });

  check('public feature pages cite no decision numbers', () => {
    const dir = path.join(ROOT, 'docs', 'features');
    const offenders = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'docs-site.md')
      .filter((f) => /decisions\.md|decisions? §|§\d/i.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    assert.deepStrictEqual(offenders, []);
  });

  check('public feature pages have no Implementation notes section', () => {
    // Implementation notes live in docs/agent/features/<slug>.md, which is
    // never published; a public page carries the user-facing surface only.
    const dir = path.join(ROOT, 'docs', 'features');
    const offenders = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
      .filter((f) => /^## Implementation notes\s*$/m.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    assert.deepStrictEqual(offenders, []);
  });

  check('merged pages leave a redirect at their old URL', () => {
    for (const [from, slug, anchor] of [['auth', 'providers', null],
      ['access-authentication', 'authentication', null]]) {
      const html = fs.readFileSync(path.join(pub.out, 'features', from + '.html'), 'utf8');
      const want = slug + '.html' + (anchor ? '#' + anchor : '');
      assert.ok(html.includes('url=' + want), from + '.html does not redirect to ' + want);
      const target = fs.readFileSync(path.join(pub.out, 'features', slug + '.html'), 'utf8');
      if (anchor) assert.ok(target.includes('id="' + anchor + '"'), slug + '.html has no #' + anchor);
    }
  });

  check('every public guide is in the top navigation', () => {
    const html = fs.readFileSync(path.join(pub.out, 'documentation.html'), 'utf8');
    const nav = html.slice(html.indexOf('<nav class="topnav"'), html.indexOf('</nav>'));
    for (const slug of ['getting-started', 'cli-commands', 'authentication', 'app-abilities', 'draft-craft']) {
      assert.ok(nav.includes('href="features/' + slug + '.html"'), slug + ' missing from the top nav');
    }
  });

  check('the landing page bar has no brand row and no extra gap under it', () => {
    // The landing page shows "mouaif" as the hero H1 right under the bar, so
    // its bar is the link row alone (topnav--minimal); every other page keeps
    // the brand, the only place the site name appears there.
    const landing = fs.readFileSync(path.join(pub.out, 'index.html'), 'utf8');
    const nav = landing.slice(landing.indexOf('<nav class="topnav'), landing.indexOf('</nav>'));
    assert.ok(nav.includes('topnav--minimal'), 'landing nav is not the minimal bar');
    assert.ok(!nav.includes('topnav-brand'), 'landing nav still renders the brand row');
    const guide = fs.readFileSync(path.join(pub.out, 'documentation.html'), 'utf8');
    const guideNav = guide.slice(guide.indexOf('<nav class="topnav"'), guide.indexOf('</nav>'));
    assert.ok(guideNav.includes('topnav-brand'), 'guide pages lost the brand row');
    // Two spacings stacked between the bar and the hero: the shared .main
    // padding plus the hero's own. Only the hero's should remain.
    const css = fs.readFileSync(path.join(pub.out, 'assets', 'site.css'), 'utf8');
    assert.match(css, /\.site--full \.main \{[^}]*padding: 0;/, 'landing main still carries page padding');
  });

  check('guide card summaries do not end on a dangling colon', () => {
    const html = fs.readFileSync(path.join(pub.out, 'documentation.html'), 'utf8');
    const blurbs = [...html.matchAll(/<a class="feature-card"[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
    assert.ok(blurbs.length >= 4, 'found ' + blurbs.length + ' cards');
    for (const b of blurbs) assert.ok(!/:\s*$/.test(b), 'card ends with a colon: ' + b);
  });

  check('every page carries a link-preview og:url', () => {
    for (const file of htmlFiles(pub.out)) {
      const html = fs.readFileSync(file, 'utf8');
      // The tiny forwarding pages for a merged slug carry a canonical only.
      if (/http-equiv="refresh"/.test(html)) continue;
      const m = /<meta property="og:url" content="([^"]+)"/.exec(html);
      assert.ok(m, path.relative(pub.out, file) + ' has no og:url');
      assert.match(m[1], /^https:\/\/[^/]+\/[^"]+\.html$/, path.relative(pub.out, file));
    }
  });

  check('the landing page previews the first landing capture', () => {
    const html = fs.readFileSync(path.join(pub.out, 'index.html'), 'utf8');
    const img = /<meta property="og:image" content="([^"]+)"/.exec(html);
    assert.ok(img, 'landing page has no og:image');
    assert.match(img[1], /^https:\/\/[^"]+\/features\/images\/landing\/chat-tools\.png$/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
    // The declared size must be the real PNG size, read without decoding it.
    const png = fs.readFileSync(path.join(ROOT, 'docs', 'features', 'images', 'landing', 'chat-tools.png'));
    const w = /<meta property="og:image:width" content="(\d+)"/.exec(html);
    const h = /<meta property="og:image:height" content="(\d+)"/.exec(html);
    assert.ok(w && h, 'og:image size is not declared');
    assert.strictEqual(Number(w[1]), png.readUInt32BE(16), 'og:image:width');
    assert.strictEqual(Number(h[1]), png.readUInt32BE(20), 'og:image:height');
  });

  check('a feature page previews its own first image', () => {
    const inspector = fs.readFileSync(path.join(pub.out, 'features', 'inspector.html'), 'utf8');
    assert.match(inspector, /og:image" content="https:\/\/[^"]+\/features\/images\/inspector\/mobile-360-all-on\.png"/);
    const draft = fs.readFileSync(path.join(pub.out, 'features', 'draft-craft.html'), 'utf8');
    assert.match(draft, /og:image" content="https:\/\/[^"]+\/features\/images\/draft-craft\/annotator-canvas-360\.png"/);
  });

  check('a page with no image advertises no preview image', () => {
    const html = fs.readFileSync(path.join(pub.out, 'features', 'getting-started.html'), 'utf8');
    assert.ok(!/property="og:image"/.test(html), 'getting-started.html declares an og:image');
    assert.ok(/property="og:url"/.test(html), 'getting-started.html lost its og:url');
  });

  check('inline code keeps a literal [text](url) as text', () => {
    const html = fs.readFileSync(path.join(pub.out, 'features', 'markdown-renderer.html'), 'utf8');
    assert.match(html, /<code>\[text\]\(url\)<\/code>/);
  });

  check('a double-backtick span can hold a single backtick', () => {
    const html = fs.readFileSync(path.join(pub.out, 'features', 'at-mention.html'), 'utf8');
    assert.match(html, /<code>@mcp__fs__read:path=`\/etc\/my file`<\/code>/);
  });
} finally {
  fs.rmSync(pub.out, { recursive: true, force: true });
  fs.rmSync(internal.out, { recursive: true, force: true });
}

if (failed) {
  process.stdout.write(failed + ' check(s) failed\n');
  process.exit(1);
}
process.stdout.write('all docs link checks passed\n');
