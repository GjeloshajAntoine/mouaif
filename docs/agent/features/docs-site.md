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

### Landing page screenshot row

`buildLandingPage()` embeds seven captures through `shotFigure()` — the same helper the old `#chats` / `#inspector` / `#settings` `.feature` sections used before `637aeda5` dropped them — wrapped in a `.shot-row` grid under the `#screenshots` section. The images are stored in `docs/features/images/landing/` (a subdirectory of the feature image tree) so `copyFeatureImages()` ships them to `features/images/landing/` for free; the `src` is therefore `features/images/landing/<file>.png`, not a `./images/…` path, because the page is generated at the site root and not under `features/`. Captures are 390 × 700 CSS px at device scale factor 2, so each PNG is 780 × 1400 and the row is a 2× asset that stays sharp on a retina phone.

The grid is a fixed `repeat(4, minmax(0, 1fr))` — **not** `auto-fit`. A seven-capture row in `auto-fit` left the last card alone on its own line and stretched wider than the others; with a fixed four-column grid the seven fill one exact row plus three, and `align-items: start` stops the taller captures from stretching their neighbours. The columns drop to `repeat(2, minmax(0, 1fr))` (centred, 760 px max) in a `(min-width: 761px) and (max-width: 1040px)` query, and to a single centred 340 px-capped column inside the existing `max-width: 760px` block, next to the `.feature` stacking rules. The middle query sits *outside* the 760 px block — nesting it there would have made the phone column rule apply at every width. `.site--full .main` is capped at 1180 px (not 1000 px) so four 390-px-wide captures fit on one laptop row without shrinking.

`chat-tools.png` is the empty-chat capture: `seedChats()` returns `{ chatId, emptyChatId }`, where the second chat has no messages at all, so its transcript is only the header block (setup control, system prompt, tools card). The shot navigates to `#/chat/<emptyChatId>` and its `recipe` clicks every `.tool-tree__chev.is-collapsed` so the leaf checkboxes are visible instead of closed sections; `waitFor: '[data-tools-card="1"]'` holds the frame until the asynchronously fetched tool catalog has rendered the card.

`scripts/capture-landing-shots.js` (`npm run docs:shots`) generates every PNG. It builds its own `MOUAIF_HOME` in the OS temp dir, seeds the fixture project, providers, project models and the demo transcript from `scripts/lib/landing-fixture.js`, starts a static page for the Inspector to attach to, launches headless Chrome with `--remote-debugging-port=9222`, and boots the app on an ephemeral port. Shots are taken over raw CDP (a hand-rolled WebSocket client, no dependency): `Emulation.setDeviceMetricsOverride` at 390 × 700 / DSF 2, `Page.navigate` on the app's own hash, two rAF plus a settle delay, an optional `recipe` (`Runtime.evaluate`) for scroll position and taps, an optional `waitFor` selector poll, then `Page.captureScreenshot`.

Two traps worth remembering:

- **The app server keeps the event loop alive** (SSE / polling timers), so the script ends with an explicit `process.exit(0)` after the last synchronous PNG write; without it, `node` hangs after the work is done.
- **The same `chromePort` (9222) is both the capture browser and the Inspector's target**, so a capture Chrome already running on the machine has to be stopped first (or the `--base` path used). The fixture root is a fixed path (`<tmp>/mouaif-demo`), not a `mkdtemp` name, because the project path is rendered inside the captures — a random suffix would end up published on the page.
- The Inspector shot's `recipe` types the preview page URL and the fixture writes `inspector.debuggerUrl` through `PUT /api/inspector/config`, which is what fills the setup form before the tap on **Open & inspect**.

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

