'use strict';

// Meta-test: the published documentation site matches the Markdown sources.
//
// GitHub Pages serves the site from `master` / `docs`, and Pages never runs
// our build — the generated HTML is committed next to the Markdown. So a doc
// edit that skips the publish step leaves the live site describing the old
// behaviour, with nothing to catch it: `scripts/test-docs-links.js` reads the
// rendered HTML, so it happily validates a page that has silently gone stale.
//
// That is not hypothetical. `docs/features/tool-groups.md` kept a "Web
// preview" group row for six commits after the tool moved into the Chats
// family, and `docs/features/docker-race-test.html` was never generated at
// all — its page was absent from the site from the commit that added it.
//
// `node scripts/publish-docs.js --check` builds the public site in a temp dir
// and diffs it against `docs/`. This runs that check, so `npm test` fails on
// drift instead of leaving it for whoever next runs the publish step.
//
// Skipped when there is no reason to expect the committed site to be current:
// a source tarball (no `docs/`), or a checkout where the docs were never
// published (no generated pages at all).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const FEATURES = path.join(DOCS, 'features');

function countHtml(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.html')).length;
  } catch {
    return 0;
  }
}

const published = countHtml(FEATURES);

if (!fs.existsSync(path.join(DOCS, 'index.html')) || published === 0) {
  console.log('docs publish: skipped — docs/ has no generated site to keep in sync');
} else {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'publish-docs.js'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    // The check builds the whole site; a cold run is a few seconds.
    timeout: 180000
  });
  const output = (run.stdout || '') + (run.stderr || '');
  assert.equal(run.status, 0,
    'docs/ is out of date with the Markdown sources — run `npm run docs:publish` and commit the result.\n' + output.trim());
  console.log('docs publish: the committed site matches the Markdown sources (' + published + ' feature pages)');
}
