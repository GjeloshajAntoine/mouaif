# Documentation site — static publishing split — implementation notes

> Agent-facing reference for [`docs/features/docs-site.md`](../../features/docs-site.md). The human-facing surface lives in that file; the implementation details, build flags, and source paths live here.

### Build entry point

| Command | Output | Notes |
|---------|--------|-------|
| `npm run docs:build` | `docs-dist/` (gitignored) | `node scripts/build-docs.js` — public site only |
| `npm run docs:build:internal` | `docs-dist/` | `node scripts/build-docs.js --with-internal` — adds `decisions.html`, `agent-notes.html`, `agent/*.html` |
| `node scripts/build-docs.js --out <dir>` | `<dir>` | Overrides the output directory (used by tests / previews) |

The script is CommonJS, dependency-free, and runs under plain `node`. `node -c scripts/build-docs.js` is part of `npm run lint`.

### Source → output mapping

- `docs/features/<slug>.md` → `docs-dist/features/<slug>.html` for every file that does not start with `_` (templates/drafts are skipped).
- `docs/agent/features/<slug>.md` → `docs-dist/agent/<slug>.html` + `docs-dist/agent-notes.html` (only with `--with-internal`).
- `docs/decisions.md` → `docs-dist/decisions.html` (only with `--with-internal`).
- `docs/features/images/**` → copied verbatim to `docs-dist/features/images/**`.
- `index.html` and `documentation.html` are generated markup inside `buildLandingPage()` / `buildDocumentationPage()`, not rendered from a Markdown file.

### Public allowlist

`PUBLIC_GUIDE_SLUGS` (`scripts/build-docs.js`, near the top) is the single source of truth for the public guide set and ordering. It feeds the top navigation (`renderTopNav`), the sidebar (`renderSidebar`), the documentation index cards, and the landing-page links. Adding a guide to the published site means adding its slug there — a file in `docs/features/` is built but stays out of the navigation otherwise.

`docs/README.md` is no longer rendered into a page: the build only looks for an optional `## Feature source index` section to order cards. The landing page copy lives in `buildLandingPage()`.

### Internal gating

`main()` parses `--out <dir>` and `--with-internal` (alias `--internal`). `buildDecisionsPage`, `buildAgentNotesPage`, and `buildAgentFeaturePages` are called only when `withInternal` is true, so a public build produces no file a crawler could reach under `decisions.html`, `agent-notes.html`, or `agent/`. The agent pages keep their own sidebar, which links to `../decisions.html` and `../agent-notes.html`; those targets only exist in an internal build, which is why the two halves must be built together.

`docs-dist/` is listed in `.gitignore`, so the CI step `git diff --exit-code -- docs-dist` in `.github/workflows/ci.yml` is a no-op today — the deployment is a branch deploy built by `scripts/publish-docs.js` (see Deployment below), not by a workflow.

`sanitizeUrl()` drops relative targets matching `isMaintainerPagePath()` (`…/decisions.md`, `…/agent/…`) when `includeInternalPages` is false, so the ~14 feature pages that cite a decisions section and the page that cites the agent note keep their label as plain text instead of emitting an anchor to a file the public build never writes. With `--with-internal` the same links resolve to `decisions.html` / `agent/<slug>.html`.

### Renderer scope

The renderer covers ATX headings (with slug anchors), fenced code blocks, blockquotes, nested ordered/unordered lists, GFM tables with `:` alignment, paragraphs, hard line breaks, and the inline subset (`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, links, images with titles). Every text node is HTML-escaped before inline patterns are re-applied; `sanitizeUrl()` allows only relative paths, fragments, `http(s)`, and `mailto`, and rewrites `.md` links to `.html` inside docs pages.

### Deployment

The public site is deployed from the `gh-pages` branch — a **branch deploy**, with no GitHub Actions workflow. `scripts/publish-docs.js` (`npm run docs:publish`) runs the public build into a scratch directory, refuses to publish if `decisions.html` or `agent/` appears, and commits the result at the root of `gh-pages` before force-pushing it with `git push <remote> <commit>:refs/heads/gh-pages`.

Implementation detail worth remembering when editing the script:

- **The working tree is never touched.** The branch tree is assembled in a throwaway index (`GIT_INDEX_FILE` in a temp dir), with `GIT_DIR` pointed at the real repository and `GIT_WORK_TREE` at the staging directory, so the site lands at the branch root without a `docs-dist/` prefix. Index commands (`read-tree --empty`, `add -A -f .`, `write-tree`, `commit-tree`) run from the staging directory.
- **The index starts empty** (`read-tree --empty`), so a doc that was deleted or renamed disappears from the branch instead of lingering.
- **History is chained with `git ls-remote`** (read-only) rather than a fetched local ref, so the push reaches the remote whether or not it was fetched first. The commit is created with `commit-tree`, and the push is forced because the branch is generated output.
- **`.nojekyll`** is written by `scripts/build-docs.js` into every build, so Pages serves the rendered HTML instead of running Jekyll, which would rewrite asset paths and drop underscore-prefixed files.
- **The commit is authored by the script** (`GIT_AUTHOR_*` / `GIT_COMMITTER_*` in the environment), so publishing does not depend on `git config user.*`.

`.github/workflows/ci.yml` keeps `npm run docs:build` + `git diff --exit-code -- docs-dist` and additionally runs `node scripts/publish-docs.js --dry-run` to exercise the publish path without pushing. `docs-dist/` stays in `.gitignore`; the `gh-pages` branch is the only published artifact.

