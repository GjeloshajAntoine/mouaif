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
    for (const [from, anchor] of [['auth', 'provider-credentials-let-mouaif-use-models'],
      ['access-authentication', 'app-access-control-who-can-open-mouaif']]) {
      const html = fs.readFileSync(path.join(pub.out, 'features', from + '.html'), 'utf8');
      const want = 'authentication.html#' + anchor;
      assert.ok(html.includes('url=' + want), from + '.html does not redirect to ' + want);
      const target = fs.readFileSync(path.join(pub.out, 'features', 'authentication.html'), 'utf8');
      assert.ok(target.includes('id="' + anchor + '"'), 'authentication.html has no #' + anchor);
    }
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
