// scripts/publish-docs.js
// Publish the public documentation site to the `gh-pages` branch.
//
// This is a branch deploy: there is no GitHub Actions workflow. The script
// builds docs-dist/ (public site only — never --with-internal, so the
// decisions log and the agent notes can never reach the published site),
// then commits the result onto an orphan `gh-pages` branch and pushes it.
// GitHub Pages serves that branch directly; the generated `.nojekyll` file
// stops Jekyll from rewriting the already-rendered HTML.
//
// One-time setup per repository:
//   Settings -> Pages -> Build and deployment -> Source: Deploy from a branch
//     Branch: gh-pages  /  (root)
//
// Usage:
//   node scripts/publish-docs.js                       # build + commit + push
//   node scripts/publish-docs.js --dry-run             # build + commit, no push
//   node scripts/publish-docs.js --remote upstream     # push elsewhere
//   npm run docs:publish
//
// The commit is created from docs-dist/ only: every tracked path on the
// gh-pages branch is replaced, so deleting a doc removes its published page.
// The main working tree is never modified — the commit is built with a
// temporary index (GIT_INDEX_FILE), so local changes and staged files are
// untouched.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BRANCH = 'gh-pages';

function git(args, opts) {
  const res = spawnSync('git', args, {
    // Run from the staging directory when given one, so paths are relative to
    // the work tree git is indexing; otherwise from the repo root.
    cwd: (opts && opts.cwd) || ROOT,
    encoding: 'utf8',
    // Git needs a name/email to author the commit; supply one so the script
    // works on a machine that never configured `git config user.*`.
    env: Object.assign({}, process.env, (opts && opts.env) || {})
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !(opts && opts.allowFailure)) {
    const detail = (res.stderr || res.stdout || '').trim();
    throw new Error('git ' + args.join(' ') + ' failed: ' + detail);
  }
  return res;
}

function main() {
  const argv = process.argv.slice(2);
  let dryRun = false;
  let remote = 'origin';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') {
      dryRun = true;
    } else if (argv[i] === '--remote' && i + 1 < argv.length) {
      remote = argv[++i];
    } else if (argv[i] === '-h' || argv[i] === '--help') {
      process.stdout.write(
        'Usage: node scripts/publish-docs.js [--dry-run] [--remote <name>]\n' +
          '  Builds the public docs site and publishes it to the ' + BRANCH + ' branch.\n' +
          '  --dry-run        build and commit, but do not push.\n' +
          '  --remote <name>  git remote to push to (default: origin).\n'
      );
      process.exit(0);
    } else {
      process.stderr.write('error: unknown argument ' + argv[i] + '\n');
      process.exit(2);
    }
  }

  if (!fs.existsSync(path.join(ROOT, 'docs'))) {
    process.stderr.write('error: docs/ directory not found\n');
    process.exit(2);
  }

  // 1. Build the public site into a fresh, throwaway directory. Building into
  //    a scratch dir instead of docs-dist/ guarantees the published branch can
  //    never pick up stale maintainer pages (decisions.html, agent/) left
  //    behind by an earlier `--with-internal` build. Never --with-internal:
  //    the published branch must not contain decisions.html or agent/*.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-docs-'));
  process.stdout.write('[publish] building public docs site...\n');
  const build = spawnSync('node', [path.join(__dirname, 'build-docs.js'), '--out', staging], {
    cwd: ROOT,
    stdio: 'inherit'
  });
  if (build.error) throw build.error;
  if (build.status !== 0) {
    process.stderr.write('error: docs build failed\n');
    process.exit(build.status || 1);
  }

  if (fs.existsSync(path.join(staging, 'decisions.html')) ||
      fs.existsSync(path.join(staging, 'agent'))) {
    process.stderr.write(
      'error: built site contains maintainer pages; refusing to publish\n'
    );
    process.exit(1);
  }
  if (!fs.existsSync(path.join(staging, '.nojekyll'))) {
    process.stderr.write('error: built site has no .nojekyll; refusing to publish\n');
    process.exit(1);
  }

    // 2. Build the branch tree in a throwaway index so the normal working tree,
  //    its index, and any staged changes are left untouched. All index
  //    commands run with the real .git as the object store but the staging
  //    dir as the work tree, so the site lands at the branch root.
  const indexFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-publish-')),
    'index'
  );
  const gitEnv = Object.assign({}, process.env, {
    GIT_INDEX_FILE: indexFile,
    // The real repository object store + refs, indexed against the staging
    // work tree, so the built site lands at the root of the gh-pages branch.
    GIT_DIR: path.join(ROOT, '.git'),
    GIT_WORK_TREE: staging,
    GIT_AUTHOR_NAME: 'mouaif docs',
    GIT_AUTHOR_EMAIL: 'docs@mouaif.invalid',
    GIT_COMMITTER_NAME: 'mouaif docs',
    GIT_COMMITTER_EMAIL: 'docs@mouaif.invalid'
  });
  const gitOpts = { env: gitEnv, cwd: staging };

  // Start from an empty index so removed pages do not linger on the branch.
  git(['read-tree', '--empty'], gitOpts);
  // -f because the staging dir is not covered by the repo's .gitignore rules
  // in the way docs-dist/ is; -A so deletions are recorded too.
  git(['add', '-A', '-f', '.'], gitOpts);

  const tree = git(['write-tree'], gitOpts).stdout.trim();
  // Parent is the previous published tip when one exists, so the branch keeps
  // a readable history; the first ever run creates a parentless commit.
  // Resolved with ls-remote (read-only) so chaining does not depend on a prior
  // fetch or on a local ref for the branch.
  let parent = '';
  const lsRemote = git(
    ['ls-remote', '--heads', remote, 'refs/heads/' + BRANCH],
    Object.assign({}, gitOpts, { allowFailure: true })
  );
  const line = (lsRemote.stdout || '').trim().split('\n')[0] || '';
  if (line) parent = line.split(/\s+/)[0];

  const message = 'docs: publish site' + (dryRun ? ' (dry run)' : '');
  const commitArgs = ['commit-tree', tree, '-m', message];
  if (parent) commitArgs.push('-p', parent);
  const commit = git(commitArgs, gitOpts).stdout.trim();

  if (dryRun) {
    fs.rmSync(path.dirname(indexFile), { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
    process.stdout.write(
      '[publish] dry run: built the public site as commit ' +
        commit.slice(0, 12) + ' (not pushed)\n'
    );
    return;
  }

  // 3. Push the commit straight to the remote branch. The branch is generated
  //    output, so the push is forced: it always replaces, never merges.
  process.stdout.write('[publish] pushing to ' + remote + ' ' + BRANCH + '...\n');
  git([
    'push',
    '--force',
    remote,
    commit + ':refs/heads/' + BRANCH
  ]);

  fs.rmSync(path.dirname(indexFile), { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
  process.stdout.write(
    '[publish] published ' + commit.slice(0, 12) + ' to ' + remote + '/' + BRANCH + '\n'
  );
}

main();
