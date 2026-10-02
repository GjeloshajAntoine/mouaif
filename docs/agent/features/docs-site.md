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

### Landing page capability sections

`buildLandingPage()` renders the `#screens` section as **one section per capability**, not a bare capture grid: `landingScreens` is an array of `{ id, title, text, src, alt, caption }`, `screenSection()` turns each entry into `<section class="screen[ screen--flip]" id="…"><div class="screen-copy"><h2>…</h2><p>…</p></div>…shotFigure()…</section>`, and every other entry is flipped (`i % 2 === 1`) so the captures alternate sides on a laptop. Adding a capability is one array entry (plus a capture in `scripts/capture-landing-shots.js` when it has no shot yet) — the title, the paragraph and the anchor id all come from that list, so the page cannot drift from the shots. `#screens` replaces the earlier `#screenshots`; the old id was never linked to, so no redirect is needed. The captures are stored in `docs/features/images/landing/` (a subdirectory of the feature image tree) so `copyFeatureImages()` ships them to `features/images/landing/` for free; the `src` is therefore `features/images/landing/<file>.png`, not a `./images/…` path, because the page is generated at the site root and not under `features/`. Captures are 390 × 700 CSS px at device scale factor 2, so each PNG is 780 × 1400 and each is a 2× asset that stays sharp on a retina phone.

Ordering rule: the list leads with what distinguishes the app (a full chat run, the phone terminal, git, Draft Craft, approvals) and deliberately **omits the configuration screens**. The first revision of this section was a screen-by-screen tour in navigation order, which meant the page's second half was Settings, Providers and Project settings — a manual, not a pitch — and its two captures (`settings.png`, `project-settings.png`) were deleted with this change. `docs/features/docs-site.md` is where the rendered section set is listed for a human; this file is where the mechanism lives.

Page order: `chat`, `terminal`, `git`, `editor`, `draft-craft`, `approvals`, `inspector`, `chats`, `new-chat`, `dictate`, `providers`.

`.screen` is a two-track grid — `minmax(0, 1fr) minmax(0, 340px)`, the copy first and a 340 px-capped capture second — with `align-items: center` so a short paragraph sits against the middle of its capture, and `.screen--flip` swaps the tracks plus the `order` of `.screen-copy` / `.shot`. Under 1040 px (the `(min-width: 761px) and (max-width: 1040px)` query, outside the 760 px block so the phone rule cannot leak upward) it collapses to one column with the copy first and the capture centred under it; under 760 px it is the same one-column stack with the capture capped at 340 px, so title → text → capture is the reading order at every narrow width. `.screen--flip` resets the `order` back to copy-first on both of those, which is why the flip only ever shows on a laptop. `.screen .shot img` re-adds `border-radius: 12px`: the capture is the only element in its cell, so there is no `.shot` card behind it to clip it. `.site--full .main` stays capped at 1180 px for the copy column's line length.

`chat-tools.png` is the empty-chat capture: `seedChats()` returns `{ chatId, emptyChatId }`, where the second chat has no messages at all, so its transcript is the header block and nothing else. The shot navigates to `#/chat/<emptyChatId>` and its `recipe` clicks every `.tool-tree__chev.is-collapsed` so the leaf checkboxes are visible instead of closed sections; `waitFor: '[data-tools-card="1"]'` holds the frame until the asynchronously fetched tool catalog has rendered the card.

The section's copy deliberately does not name the system prompt: on a `/` (average or larger) prompt-size profile that card is a long wall of internal instructions, which is the one thing on the page a reader has no use for. The paragraph sells what the frame shows — the model picker, the tool list with its per-row **Off / Ask / Allow** controls, the project instructions already loaded, and the skills column — and the loading order keeps the jargon out of the alt text too. `chat-tools.png` is still the `og:image` for the whole site (see the link-preview section below), so a change to this capture changes every page's preview card.

`subagent-auth.png` is the approval-card capture. A shot may carry `before` / `after` hooks that run in the capture process around its own frame (the loop `await`s `before`, because the Draft Craft hook does network work): this one calls `seedSubagentAuthorization(projectDir, chatId)` (in `scripts/lib/landing-fixture.js`) which parks a real `subagent` call on the authorization gate via `authorize()` and adds the chat to `runningChats` (through `src/server-shared.js`), then `clearSubagentAuthorization` denies the parked wait after the shot. The mounted card comes from the transcript's normal pending-auth poll (`loadPendingAuthorization`) — no DOM fixture — so it renders the real per-run `ModelPickerField` + `ThinkingSelectField`. `waitFor: '.tool-card--authorization .auth-model-picker'` holds until the poll has mounted the card; the card scrolls itself into view.

`terminal.png`, `git.png`, `editor.png` and `draft-craft.png` are the four captures that exist to answer "what does this do that a chat wrapper does not", and all four drive the real UI:

- **`terminal.png`** opens `.file-toolbar__trigger`, taps the **Cli** row and runs a real command: the recipe presses the menu row, waits for `.cli__prompt` (the server has to start a persistent session — a pty via `src/pty.js`), types `npm test` through the native value setter, dispatches Enter, then waits 2.5 s for the output to arrive over SSE and pins `.cli__out` to its tail. The frame is therefore a genuine shell run in the fixture project, showing the key rows a phone keyboard cannot provide.
- **`git.png`** calls `makeGitDirty(projectDir)` in its `before` hook (one staged edit to `README.md`, one unstaged comment in `src/store.js`) so the sheet shows a working tree with changes rather than a clean one, then opens **Git** and waits for `.gm__commit-bar` — the marker that the real `git status` has landed.
- **`editor.png`** opens the file toolbar's **Files** row and walks the real tree — taps `src`, then `store.js` — and selects three lines in the CodeMirror buffer. The selection has to be driven with **mouse events**, not pointer events: CodeMirror's drag-select is wired to `mousedown` / `mousemove` / `mouseup` (see the handlers in `@codemirror/view`), so the pointer events the other recipes use leave the buffer unselected. `waitFor: '.fe__draft-craft'` holds the frame until the editor's action row is mounted, which is also what the capture is for.
- **`draft-craft.png`** seeds the empty chat's `draftAttachments` over `PATCH /api/chats/<id>` with a PNG of the fixture's own preview page, taken through the same debug Chrome by `capturePreviewDataUrl()` (hence `state.base` / `state.cdpBase`, set once in `main`). The recipe then taps the composer's image chip to open the annotator and drives real pointer events: a four-point pen stroke on `.draft-craft__canvas`, then a pin dragged from `.draft-craft__marker-source` onto `.draft-craft__canvas-stage` with its text typed into `.draft-craft__marker-input`. `waitFor: '.draft-craft__marker-input'` holds the frame until the marker row has committed.

Two details the menu-tapping recipes depend on: a `.file-toolbar__menu-item` row's `textContent` includes its icon glyph (`"🖥Cli"`), so both match the row's trailing `span` instead of the whole text; and `.recipe` strings are evaluated bare in the page, so each one that needs polling defines its own local `waitFor` (the draft-craft script has a page-level helper, this one does not).

`dictation.png` (`#/dictation`) is the one capture that touches the fixture's provider rows: the catalog read (`GET /api/ai/transcribe/models`) is live, so with all seven fixture connections in place the page prints one red "No models from …" line per provider the capture machine cannot reach (Google, Ollama, Mistral, Groq all fail against the placeholder keys). Its `before` hook narrows `settings.setApp({ providers })` to `state.idleProvider` — the fixture's own stub built from `upstream.baseUrl`, whose local `/v1/models` answers — and `after` restores the seven. `state.idleProvider` stays null on the `--base` path (no fixture, no stub), and both hooks return early then. The fixture's `MODELS` therefore carries `whisper-1` on `openai-compatible`: `transcribe.transcriptionCandidates()` narrows the project records to the ones that plausibly transcribe, and `whisper-` in the id is the signal that makes the page show a picked model instead of an empty picker (`defaultDictationModel` then adopts the lone strong candidate). The `recipe` scrolls `.dictation__card--recorder` to the centre so the frame is the record button, and `waitFor: '.dictation__field--route'` holds until the catalog fetch has resolved the model and rendered the read-only "Sends as" row.

`providers.png` is the only remaining capture of a settings screen, kept because "connect any provider once, credentials server-side" is a claim a reader wants to see rather than take on faith; the Settings root and the project settings page are no longer shot at all.

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
