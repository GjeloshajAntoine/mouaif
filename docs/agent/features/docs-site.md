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

`PUBLIC_GUIDE_SLUGS` (`scripts/build-docs.js`, near the top) is the single source of truth for the public guide set and ordering. It feeds the top navigation (`renderTopNav`), the sidebar (`renderSidebar`), the documentation index cards, and the landing-page links. Adding a guide to the published site means adding its slug there (and a short label in `PUBLIC_GUIDE_TITLES` for the top navigation) — a file in `docs/features/` is built but stays out of the navigation otherwise.

On a phone the top navigation's links sit on one sideways-scrolling row whose trailing edge is faded with a CSS mask, so a clipped label reads as "more to the right". `html { scroll-padding-top }` (72 px, 120 px under 760 px where the nav takes two rows) keeps an anchored heading clear of the sticky bar. `extractBlurb()` drops a trailing lead-in sentence that ends with a colon (a paragraph introducing a table or list), so a card summary never ends mid-thought.

`docs/README.md` is no longer rendered into a page: the build only looks for an optional `## Feature source index` section to order cards. The landing page copy lives in `buildLandingPage()`.

### Screenshot captures

The generated pages no longer embed any screenshots: `buildLandingPage()` has no capture row and the `shotFigure()` helper plus its `.shot` / `.shot-row` CSS were removed with it. Screenshots now live only on Markdown feature pages (the [Draft Craft](draft-craft.md) guide), rendered through the normal Markdown image pass at `./images/<feature>/<shot>.png`, which `copyFeatureImages()` ships verbatim to `features/images/<feature>/`.

`scripts/capture-draft-craft-shots.js` (`npm run docs:shots:draft-craft`) is the remaining capture script. It builds its own `MOUAIF_HOME` in the OS temp dir, seeds the fixture project, providers, project models and the demo transcript from `scripts/lib/landing-fixture.js`, and boots the app on an ephemeral port. Frames are taken over raw CDP (a hand-rolled WebSocket client, no dependency): `Emulation.setDeviceMetricsOverride`, `Page.navigate` on the app's own hash, two rAF plus a settle delay, an optional `recipe` (`Runtime.evaluate`) for taps/drags/selection, an optional `waitFor` selector poll, then `Page.captureScreenshot`.

Two traps worth remembering:

- **The app server keeps the event loop alive** (SSE / polling timers), so the script ends with an explicit `process.exit(0)` after the last synchronous PNG write; without it, `node` hangs after the work is done.
- **The fixture root is a fixed path**, not a `mkdtemp` name, because the project path is rendered inside the captures — a random suffix would end up published on the page.

`scripts/lib/landing-fixture.js` keeps its name (its exports — `installProviders`, `seedChats`, `writePreviewPage`, … — are consumed by the Draft Craft script), but only the seeding helpers it still exports are used.

### Internal gating

`main()` parses `--out <dir>` and `--with-internal` (alias `--internal`). `buildDecisionsPage`, `buildAgentNotesPage`, and `buildAgentFeaturePages` are called only when `withInternal` is true, so a public build produces no file a crawler could reach under `decisions.html`, `agent-notes.html`, or `agent/`. The agent pages keep their own sidebar, which links to `../decisions.html` and `../agent-notes.html`; those targets only exist in an internal build, which is why the two halves must be built together.

`docs-dist/` is listed in `.gitignore`. It is a local/inspection output only — the published site is the generated HTML committed under `docs/` and served by the branch deploy (see Deployment below).

### Link resolution

Every Markdown page is rendered with a context that names its source path under `docs/` (`srcRel`) and its output path in the site (`outRel`). `sanitizeUrl()` hands each relative link to `resolveDocLink()`, which resolves the target against the source file's directory and then asks `outputPathFor()` what the build writes for it:

| Resolved target | Rendered as |
|-----------------|-------------|
| `docs/features/<slug>.md` (not `_`-prefixed) | relative href to `features/<slug>.html` |
| `docs/features/images/…` | relative href to `features/images/…` |
| `docs/decisions.md`, `docs/agent/…` | `decisions.html` / `agent/<slug>.html` with `--with-internal`; plain label text in a public build |
| any other repository file (`src/`, `frontend/`, `scripts/`, `.github/`, `docs/README.md`, …) | `https://github.com/<owner>/<repo>/blob/master/<path>` |
| a path that climbs above the repository | plain label text |

**Merged pages.** `REDIRECTED_SLUGS` maps a removed feature slug to its new page (optionally with a `#anchor`). `buildRedirectPages()` writes `features/<old>.html` as a `noindex` meta-refresh page with a canonical link, because GitHub Pages has no server-side redirects; `outputPathFor()` sends any remaining `.md` link to the old slug straight to the new target. The build throws if a redirected slug still has a Markdown source. Current entries: `auth` → `providers` (provider credentials moved out of the authentication guide) and `access-authentication` → `authentication`.

GitHub Pages serves only `docs/`, so a relative `../../src/…` link would 404 on the published site; the GitHub URL is derived from `repository.url` in `package.json` (no GitHub remote → plain label text). The build prints `[docs] warning: … links to missing …` for any target that does not exist on disk, so a mistyped path shows up at build time. Pages rendered without `srcRel` (the documentation index blurbs) keep the older behaviour: `.md` → `.html` and maintainer paths dropped.

Public feature pages do not cite `docs/decisions.md` or its `§` numbers; the matching agent note carries a **Decisions** section instead, so a maintainer can still find the rationale.

### Renderer scope

The renderer covers ATX headings (with slug anchors), fenced code blocks, blockquotes, nested ordered/unordered lists, GFM tables with `:` alignment, paragraphs, hard line breaks, and the inline subset (`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, links, images with titles). Inline code is stashed before the link and emphasis passes, so a literal `[text](url)` inside backticks stays text, and a run of N backticks closes on the next run of exactly N (a double-backtick span can hold a single backtick; one padding space on each side is trimmed). Every text node is HTML-escaped before inline patterns are re-applied; `sanitizeUrl()` allows only relative paths, fragments, `http(s)`, and `mailto`, and rewrites `.md` links to `.html` inside docs pages.

### Deployment

The site is a **branch deploy** from `master` / `docs` (Settings → Pages → "Deploy from a branch"), with no custom GitHub Actions deployment workflow and no extra branch. GitHub's built-in dynamic `pages-build-deployment` workflow publishes the committed files as-is, so the generated site is committed into `docs/` alongside the Markdown sources. Do not add `actions/configure-pages` or `actions/deploy-pages`: they implement the alternative **GitHub Actions** Pages source and may fail with `Resource not accessible by integration` when the workflow cannot create or reconfigure the Pages site.

`.github/workflows/ci.yml` verifies the committed output but does not deploy it. Its checkout and setup-node actions use their current Node 24-runtime majors, while setup-node selects the current Node LTS release for project commands; this avoids GitHub's deprecated Node action-runtime warning.

`scripts/publish-docs.js` is the sync tool (`npm run docs:publish`, or `npm run docs:publish:check` for verification). It:

1. builds the public site into a scratch dir (`build-docs.js --out <tmp>`), never `--with-internal`;
2. aborts if `decisions.html` or `agent/` appears in the build, or if `.nojekyll` is missing;
3. copies `index.html`, `documentation.html`, `assets/**` and `.nojekyll` into `docs/`, and every build `features/*.html` into `docs/features/`;
4. replaces the whole `docs/assets/` tree and deletes any committed `docs/features/*.html` the build no longer produces, so renamed/removed docs cannot linger as stale pages;
5. runs `git add` on exactly those paths.

Implementation detail worth remembering when editing the script:

- **`--check` mode** compares every generated file against what is committed and lists `missing` / `stale` / `orphan` paths, exiting non-zero on any drift without writing. It is the CI gate (`npm run docs:publish:check` in `.github/workflows/ci.yml`), so committed output and Markdown sources cannot disagree on `master`.
- **The `.md` sources and `docs/features/images/` are never touched** — the build reads them, and the sync only writes generated HTML/CSS/.nojekyll. `docs/features/` therefore holds both `*.md` and `*.html`, which is expected.
- **Building into a scratch dir**, not `docs/`, avoids the image tree colliding with the copied `features/images/` output and keeps a stale `--with-internal` build from ever reaching the published tree.
- **`.nojekyll`** is written by `scripts/build-docs.js` into every build. Pages runs Jekyll on the branch otherwise, which would re-theme the pages and drop underscore-prefixed files.
- **The maintainer pages** (`docs/decisions.md`, `docs/agent/features/*.md`) are still readable as raw Markdown at their `docs/` URLs, exactly as they were under the legacy Jekyll build — the public build simply does not generate HTML for them, and nothing links to them.

`docs-dist/` stays in `.gitignore`; the committed `docs/` output is the only published artifact.

## Implementation notes

`scripts/build-docs.js` is a dependency-free Markdown-to-HTML converter plus a small page shell (sidebar, top navigation, `assets/site.css`). Maintainer pages are written only when `--with-internal` is passed; see [the agent note](./docs-site.md) for the build internals. In a public build, links that point at a maintainer page render as plain text instead of a dead anchor, and links to repository files outside the site (`src/`, `scripts/`, `.github/`, …) point at the file on GitHub, so the published site has no links to pages that were never written. Public pages do not cite decision numbers; those live in the agent notes.
