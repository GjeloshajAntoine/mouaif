// scripts/publish-docs.js
// Publish the public documentation site into docs/ on the current branch.
//
// Deployment model: GitHub Pages is set to "Deploy from a branch" ->
// `master` / `/docs`. There is no GitHub Actions workflow and no extra
// branch. GitHub Pages only serves files that are committed, and it never
// runs our build, so the generated site (index.html, documentation.html,
// features/*.html, assets/site.css, .nojekyll) is committed into docs/
// next to the Markdown sources.
//
// This script keeps that committed output in sync:
//   1. builds the public site into a scratch directory (never --with-internal,
//      so decisions.html and agent/* can never be published);
//   2. refuses to continue if a maintainer page slipped into the build;
//   3. copies the generated files into docs/, skipping the image tree (it is
//      already the source of truth under docs/features/images/) and deleting
//      stale docs/features/*.html so a removed or renamed doc disappears.
//
// One-time setup per repository:
//   Settings -> Pages -> Build and deployment -> Source: Deploy from a branch
//     Branch: master  /  /docs
//
// Usage:
//   node scripts/publish-docs.js            # build + sync docs/ + git add
//   node scripts/publish-docs.js --check    # verify docs/ is in sync; no writes
//   npm run docs:publish
//   npm run docs:publish:check
//
// --check exits non-zero when the committed docs/ output differs from a fresh
// build, so CI can fail on docs/code drift without writing to the tree.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');

// Files that are copied verbatim from the build into docs/. Everything else
// under the build is either the image tree (already present in docs/) or a
// per-feature HTML page handled by the features/ pass below.
const ROOT_FILES = ['index.html', 'documentation.html', '.nojekyll'];
const ASSETS_DIR = 'assets';
const FEATURES_DIR = 'features';

function walkFiles(dir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + entry.name : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function listGenerated(buildDir) {
  // Per-feature HTML the build produced, as slugs.
  const featuresDir = path.join(buildDir, FEATURES_DIR);
  const featurePages = fs.existsSync(featuresDir)
    ? fs.readdirSync(featuresDir).filter((f) => f.endsWith('.html'))
    : [];
  return {
    rootFiles: ROOT_FILES.filter((f) => fs.existsSync(path.join(buildDir, f))),
    assets: fs.existsSync(path.join(buildDir, ASSETS_DIR))
      ? walkFiles(path.join(buildDir, ASSETS_DIR), '').map((f) => f)
      : [],
    featurePages
  };
}

function main() {
  const argv = process.argv.slice(2);
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') {
      check = true;
    } else if (argv[i] === '-h' || argv[i] === '--help') {
      process.stdout.write(
        'Usage: node scripts/publish-docs.js [--check]\n' +
          '  Builds the public docs site and syncs it into docs/ for a\n' +
          '  branch deploy (Settings -> Pages -> master /docs).\n' +
          '  --check  verify docs/ matches a fresh build without writing.\n'
      );
      process.exit(0);
    } else {
      process.stderr.write('error: unknown argument ' + argv[i] + '\n');
      process.exit(2);
    }
  }

  if (!fs.existsSync(path.join(DOCS_DIR, 'features'))) {
    process.stderr.write('error: docs/features/ not found\n');
    process.exit(2);
  }

  // 1. Build the public site into a scratch directory. Building elsewhere
  //    keeps the source tree (Markdown + images) untouched by the renderer
  //    and guarantees a stale `--with-internal` build cannot leak.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-docs-'));
  process.stdout.write('[publish] building public docs site...\n');
  const build = spawnSync(
    'node',
    [path.join(__dirname, 'build-docs.js'), '--out', staging],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (build.error) throw build.error;
  if (build.status !== 0) {
    process.stderr.write('error: docs build failed\n');
    process.exit(build.status || 1);
  }

  if (
    fs.existsSync(path.join(staging, 'decisions.html')) ||
    fs.existsSync(path.join(staging, 'agent'))
  ) {
    process.stderr.write(
      'error: built site contains maintainer pages; refusing to publish\n'
    );
    process.exit(1);
  }
  if (!fs.existsSync(path.join(staging, '.nojekyll'))) {
    process.stderr.write('error: built site has no .nojekyll; refusing to publish\n');
    process.exit(1);
  }

  const gen = listGenerated(staging);
  const cleanup = () => fs.rmSync(staging, { recursive: true, force: true });

  // 2. Check mode: compare the generated files against what is committed, and
  //    report every difference. Nothing on disk is written.
  if (check) {
    const drift = [];
    const generatedRel = new Set();

    for (const rel of gen.rootFiles) {
      generatedRel.add(rel);
      const want = readIfExists(path.join(staging, rel));
      const have = readIfExists(path.join(DOCS_DIR, rel));
      if (have === null) drift.push('missing docs/' + rel);
      else if (!want.equals(have)) drift.push('stale docs/' + rel);
    }
    for (const rel of gen.assets) {
      const dest = ASSETS_DIR + '/' + rel;
      generatedRel.add(dest);
      const want = readIfExists(path.join(staging, ASSETS_DIR, rel));
      const have = readIfExists(path.join(DOCS_DIR, ASSETS_DIR, rel));
      if (have === null) drift.push('missing docs/' + dest);
      else if (!want.equals(have)) drift.push('stale docs/' + dest);
    }
    for (const page of gen.featurePages) {
      const dest = FEATURES_DIR + '/' + page;
      generatedRel.add(dest);
      const want = readIfExists(path.join(staging, FEATURES_DIR, page));
      const have = readIfExists(path.join(DOCS_DIR, FEATURES_DIR, page));
      if (have === null) drift.push('missing docs/' + dest);
      else if (!want.equals(have)) drift.push('stale docs/' + dest);
    }

    // Committed generated pages that the build no longer produces.
    const committedFeatures = fs
      .readdirSync(path.join(DOCS_DIR, FEATURES_DIR))
      .filter((f) => f.endsWith('.html'));
    for (const f of committedFeatures) {
      if (!generatedRel.has(FEATURES_DIR + '/' + f)) drift.push('orphan docs/' + FEATURES_DIR + '/' + f);
    }

    cleanup();
    if (drift.length) {
      process.stderr.write(
        '[publish] docs/ is out of date with the Markdown sources:\n' +
          drift.map((d) => '  - ' + d).join('\n') +
          '\n  run `npm run docs:publish` and commit the result\n'
      );
      process.exit(1);
    }
    process.stdout.write('[publish] docs/ is in sync with the Markdown sources.\n');
    return;
  }

  // 3. Write mode: sync the generated files into docs/.
  const written = [];
  const removed = [];

  for (const rel of gen.rootFiles) {
    fs.copyFileSync(path.join(staging, rel), path.join(DOCS_DIR, rel));
    written.push('docs/' + rel);
  }

  // Replace the whole assets/ tree so a removed stylesheet does not linger.
  const destAssets = path.join(DOCS_DIR, ASSETS_DIR);
  fs.rmSync(destAssets, { recursive: true, force: true });
  fs.mkdirSync(destAssets, { recursive: true });
  for (const rel of gen.assets) {
    const dest = path.join(destAssets, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(staging, ASSETS_DIR, rel), dest);
    written.push('docs/' + ASSETS_DIR + '/' + rel);
  }

  // Feature pages: write every generated page, then delete any committed
  // *.html the build no longer produces (a renamed or removed doc). Markdown
  // sources and the images/ tree in the same directory are left alone.
  const wantPages = new Set(gen.featurePages);
  for (const page of gen.featurePages) {
    fs.copyFileSync(
      path.join(staging, FEATURES_DIR, page),
      path.join(DOCS_DIR, FEATURES_DIR, page)
    );
    written.push('docs/' + FEATURES_DIR + '/' + page);
  }
  for (const f of fs.readdirSync(path.join(DOCS_DIR, FEATURES_DIR))) {
    if (f.endsWith('.html') && !wantPages.has(f)) {
      fs.rmSync(path.join(DOCS_DIR, FEATURES_DIR, f));
      removed.push('docs/' + FEATURES_DIR + '/' + f);
    }
  }

  cleanup();

  // 4. Stage exactly the generated paths so unrelated edits stay untouched.
  const add = spawnSync('git', ['add', '--', ...generatedGitPaths(gen, removed)], {
    cwd: ROOT,
    stdio: 'inherit'
  });
  if (add.error) throw add.error;
  if (add.status !== 0) {
    process.stderr.write('error: git add failed\n');
    process.exit(add.status || 1);
  }

  process.stdout.write(
    '[publish] synced ' + written.length + ' file(s) into docs/' +
      (removed.length ? ', removed ' + removed.length + ' stale page(s)' : '') +
      '\n[publish] staged. Next: commit and push to master — ' +
      'Pages must be set to master /docs.\n'
  );
}

// The set of docs/ paths git should stage: the synced files plus the removed
// pages (so a deletion is staged too).
function generatedGitPaths(gen, removed) {
  const paths = ['docs/index.html', 'docs/documentation.html', 'docs/.nojekyll'];
  paths.push('docs/assets');
  for (const page of gen.featurePages) paths.push('docs/features/' + page);
  for (const f of removed) paths.push(f);
  return paths;
}

main();
