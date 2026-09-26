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

On a phone the top navigation's links sit on one sideways-scrolling row whose trailing edge is faded with a CSS mask, so a clipped label reads as "more to the right". `html { scroll-padding-top }` (72 px, 120 px under 760 px) keeps an anchored heading clear of the sticky bar. `renderTopNav({ brand: false })` drops the brand row for the landing page, whose bar is then the link row alone (`topnav topnav--minimal`, one 44 px row on a phone instead of two, since the brand rule was what pushed the links down); `scripts/test-docs-links.js` asserts the landing nav has no `topnav-brand` and that the guide pages still do. `extractBlurb()` drops a trailing lead-in sentence that ends with a colon (a paragraph introducing a table or list), so a card summary never ends mid-thought.

### Landing-page bar and spacing

`buildLandingPage()` calls `renderTopNav({ brand: false })`: the landing page already shows "mouaif" as a 52 px H1 inside the hero, so repeating the `m mouaif` brand row directly above it wasted a full sticky row on a 360–430 px phone. Every other page keeps the brand — there the bar is the only place the site name appears.

The hero also inherited `.main`'s padding (`28px 32px 64px`, `20px 16px 48px` under 760 px), which is tuned for a Markdown page and stacked on top of the hero's own padding: 65 px of dead space between the bar and the eyebrow on a phone, 85 px on a laptop. `.site--full .main { padding: 0 }` cancels it for the landing page only, so the gap under the bar is exactly the hero's own padding (56 px laptop / 24 px phone); the landing sections carry their own `.section` margins.

Under 760 px the CSS brand rule (`flex: 1 0 100%`) was what pushed the links onto a second row; with no brand the minimal bar stays one 44 px row that scrolls sideways, and `.topnav--minimal` drops the 6 px vertical padding the two-row layout needed. `scroll-padding-top` stays at 120 px under 760 px for both bar shapes because it is a single rule shared by the landing page and the feature pages, and the landing hero is not an anchor target.
`docs/README.md` is no longer rendered into a page: the build only looks for an optional `## Feature source index` section to order cards. The landing page copy lives in `buildLandingPage()`.

### Landing page screenshot row

`buildLandingPage()` embeds eight captures through `shotFigure()` and wraps them in a `.shot-row` grid under the `#screenshots` section. The section carries **no `<h2>` and no lead paragraph** — the row sits directly under the hero, so the first thing a reader meets after the tagline is the real UI. The images are stored in `docs/features/images/landing/` (a subdirectory of the feature image tree) so `copyFeatureImages()` ships them to `features/images/landing/` for free; the `src` is therefore `features/images/landing/<file>.png`, not a `./images/…` path, because the page is generated at the site root and not under `features/`. Captures are 390 × 700 CSS px at device scale factor 2, so each PNG is 780 × 1400 and the row is a 2× asset that stays sharp on a retina phone.

Page order (top-left first): `chat-tools`, `subagent-auth`, `chats-list`, `chat-view`, `providers`, `project-settings`, `inspector`, `settings`. Eight captures fill exactly two four-column laptop rows.

The grid is a fixed `repeat(4, minmax(0, 1fr))` — **not** `auto-fit`. A row that does not divide evenly in `auto-fit` leaves the last card alone on its own line and stretched wider than the others; with a fixed four-column grid and `align-items: start` the captures keep their own widths and stop stretching their neighbours. The columns drop to `repeat(2, minmax(0, 1fr))` (centred, 760 px max) in a `(min-width: 761px) and (max-width: 1040px)` query, and to a single centred 340 px-capped column inside the existing `max-width: 760px` block, next to the `.feature` stacking rules. The middle query sits *outside* the 760 px block — nesting it there would have made the phone column rule apply at every width. `.site--full .main` is capped at 1180 px (not 1000 px) so four 390-px-wide captures fit on one laptop row without shrinking.

`chat-tools.png` is the empty-chat capture: `seedChats()` returns `{ chatId, emptyChatId }`, where the second chat has no messages at all, so its transcript is only the header block (setup control, system prompt, tools card). The shot navigates to `#/chat/<emptyChatId>` and its `recipe` clicks every `.tool-tree__chev.is-collapsed` so the leaf checkboxes are visible instead of closed sections; `waitFor: '[data-tools-card="1"]'` holds the frame until the asynchronously fetched tool catalog has rendered the card.

`subagent-auth.png` is the approval-card capture. A shot may carry `before` / `after` hooks that run in the capture process around its own frame: this one calls `seedSubagentAuthorization(projectDir, chatId)` (in `scripts/lib/landing-fixture.js`) which parks a real `subagent` call on the authorization gate via `authorize()` and adds the chat to `runningChats` (through `src/server-shared.js`), then `clearSubagentAuthorization` denies the parked wait after the shot. The mounted card comes from the transcript's normal pending-auth poll (`loadPendingAuthorization`) — no DOM fixture — so it renders the real per-run `ModelPickerField` + `ThinkingSelectField`. `waitFor: '.tool-card--authorization .auth-model-picker'` holds until the poll has mounted the card; the card scrolls itself into view.

`scripts/capture-landing-shots.js` (`npm run docs:shots`) generates every PNG. It builds its own `MOUAIF_HOME` in the OS temp dir, seeds the fixture project, providers, project models and the demo transcript from `scripts/lib/landing-fixture.js`, starts a static page for the Inspector to attach to, launches headless Chrome with `--remote-debugging-port=9222`, and boots the app on an ephemeral port. Shots are taken over raw CDP (a hand-rolled WebSocket client, no dependency): `Emulation.setDeviceMetricsOverride` at 390 × 700 / DSF 2, `Page.navigate` on the app's own hash, two rAF plus a settle delay, an optional `recipe` (`Runtime.evaluate`) for scroll position and taps, an optional `waitFor` selector poll, then `Page.captureScreenshot`.

Two traps worth remembering:

- **The app server keeps the event loop alive** (SSE / polling timers), so the script ends with an explicit `process.exit(0)` after the last synchronous PNG write; without it, `node` hangs after the work is done.
- **The same `chromePort` (9222) is both the capture browser and the Inspector's target**, so a capture Chrome already running on the machine has to be stopped first (or the `--base` path used). The fixture root is a fixed path (`<tmp>/mouaif-demo`), not a `mkdtemp` name, because the project path is rendered inside the captures — a random suffix would end up published on the page.
- The Inspector shot's `recipe` types the preview page URL and the fixture writes `inspector.debuggerUrl` through `PUT /api/inspector/config`, which is what fills the setup form before the tap on **Open & inspect**.

### Link-preview tags

`htmlPage()` takes a `previewImage` (site-root-relative) and a `path` (the page's output path relative to the site root) and emits the social tags into `<head>`:

| Tag | Value |
|-----|-------|
| `og:site_name` | `mouaif docs` |
| `og:type` | `website` |
| `og:title` / `og:description` | The same title/description the page already uses |
| `og:url` | `SITE_ORIGIN + '/' + path` |
| `og:image` (and `twitter:image`) | `SITE_ORIGIN + '/' + previewImage`, only when that file exists |
| `og:image:width` / `og:image:height` | Read from the PNG IHDR header by `pngSize()` (bytes 16–23), so the declared size is the real one without decoding the image |
| `og:image:alt` / `twitter:image:alt` | The page description |
| `twitter:card` | `summary_large_image` |

The image URL is absolute because link scrapers fetch the tags out of context — a relative `og:image` is ignored by every major consumer. `SITE_ORIGIN` is a single constant near the top of the script (`https://gjeloshajantoine.github.io/mouaif`, the `<owner>.github.io/<repo>` shape the branch deploy produces); a CNAME domain or a renamed repository changes exactly that line. `fullPreviewImage()` verifies the file is on disk before it is advertised, so the build never publishes a dead image URL, and `firstPreviewImage(slug)` scrapes the page's own Markdown for its first `![alt](url)` (the same rule `renderInline` uses, including an optional quoted title) and resolves `./images/…` against `docs/features/`, which yields the site-root path `features/images/…`.

Both callers pass `path` so `og:url` is the page's own absolute URL: `index.html`, `documentation.html`, `decisions.html`, `agent-notes.html`, `features/<slug>.html`, `agent/<slug>.html`. The `noindex` meta-refresh pages `buildRedirectPages()` writes are deliberately left with their canonical link only — they are not preview targets. `scripts/test-docs-links.js` asserts every non-redirect page has an `og:url` with the right shape, that the landing page previews the first landing capture with a size matching the PNG header, that a page with a screenshot previews its own first image, and that a page without one carries no `og:image` at all.

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
