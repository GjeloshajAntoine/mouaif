# Chat element mockup — maintainer notes

## Overview

`mouaif` has no component library or storybook: every chat element is
imperative DOM, built by a renderer in `frontend/src/components/chat/` and
styled by `frontend/src/*.css`. The **chat element mockup** is the dev-only
harness that mounts those same renderers on one static page, so a layout or
behaviour decision can be reviewed at a 360–430 px phone width without opening
the app, and a CSS change can be diffed against the element it actually
affects.

It is throwaway scaffolding, not a shipped surface. The whole directory lives
under `.mouaif/`, which `.gitignore` excludes, and nothing under `frontend/` or
`src/` imports it — the dependency runs one way only.

## What it renders

One section per element, each mounted by the module the app itself calls:

| Section | Renderer |
| --- | --- |
| Full transcript | `reconcileTranscriptRows` over a `seq`-keyed message list |
| Message bubbles | `appendMessageToTranscript`, `appendErrorCard` |
| Live streaming rows | `appendReasoningToLive`, `appendDeltaToLive` |
| System prompt + per-turn meta | `renderSystemPromptMessage`, `renderUsageMeta` |
| Header cards | `placeHeaderCard` + `mountToolsCard` / `mountAgentFilesCard` / `mountSkillsCard`, `buildSetupCard` |
| Tool cards — collapsed | `appendToolCallCard` → `appendToolResultCard` |
| Tool cards — expanded | the same pair, then `card._lazyBody()` |
| Live tool states | `appendToolCallCard` (live) + `handleShellOutputEvent`, `updateProgressCard`, a failed result |
| Overlay cards | `askUserCard`, `authorizationCard` |
| Usage summary chips | `updateUsageSummary` |

The fixture (`data.js`) is one persisted transcript plus the surrounding chat
state — the tool catalog, the MCP servers, agent files, skills, the system
prompt and the chat record. Because the tool rows are drawn through
`reconcileTranscriptRows`, a `write_file` / `shell` card recovers its call
arguments from the persisted call row, exactly as a reload does.

## Files

```
.mouaif/chat-element-preview/
  index.html   the page
  data.js      the fixture
  main.js      one mount per case, through the real renderers
  style.css    the preview shell (imports frontend/src/style.css)
  build.mjs    esbuild → out/
  shot.sh      optional headless PNG capture
```

## Usage

```bash
cd .mouaif/chat-element-preview
node build.mjs     # bundle main.js + style.css with the app stylesheet into out/
./shot.sh 390      # optional: 390 px PNG of the whole page → shot.png
```

`index.html` loads `out/main.js` as a classic script, so it works over
`file://` (a `type="module"` script is refused there). `shot.sh` needs
`google-chrome` and `python3` with Pillow, the same dependencies as
`.mouaif/subagent-preview/shot.sh`.

The tree is gitignored, so it is not committed. The harness is plumbing whose
only durable part is the fixture and the case list in `main.js`; re-create the
directory (or restore it from your shell history) if it is lost. This note is
the in-repo record of what it contains and which element each case renders.

## Implementation notes

- **The bundle is IIFE, not ESM.** `build.mjs` sets `format: 'iife'` for the
  same reason `.mouaif/subagent-preview` does: the page is opened from disk.
- **The stylesheet is the app stylesheet.** `style.css` only imports
  `frontend/src/style.css` and adds the page shell. Two rules are deliberately
  overridden so a static capture is honest:
  - the entry animation is disabled (`.chat-msg` uses
    `animation-fill-mode: both`, which starts at `opacity: 0`, so every row
    would be captured invisible);
  - `content-visibility: auto` (the off-screen row skipping in
    `chat-transcript.css`) is turned off, because every row on this page is
    meant to be looked at, and a skipped row collapses to its
    `contain-intrinsic-size` placeholder;
  - a subagent card's nested transcript box is un-clipped: the live box is a
    bottom-pinned scroller, and a screenshot can only show one scroll position.
- **The real mounters, not the internal builders.** `buildToolsCard`,
  `buildAgentFilesCard` and `buildSkillsCard` are module-private by design
  (`buildSetupCard` is the only exported builder); the harness therefore mounts
  cards through `mountToolsCard` / `mountAgentFilesCard` / `mountSkillsCard`,
  which is also what makes the header block's slot order the app's own.
- **`authorizationCard` returns a promise that is never resolved** in the
  mockup — the card is parked, which is the state the case documents.
- **Frame shapes matter.** A live chunk is `{ id, stream, delta }`, not
  `{ text }`. When a stream frame shape changes server-side
  (`src/ai-stream.js`), update the fixture in `main.js` to match; a stale
  fixture would preview a card the app no longer produces — the same rule the
  subagent preview documents.

## Related

- [Chat UI](../../features/chat-ui.md) — the conversation view these elements
  compose.
- [Tool card expanded view](../../features/tool-card-expanded-view.md) — what an
  expanded card must hold, which the tool-card cases exercise.
- [Subagent transcript](../../features/subagent-transcript.md) — the delegated
  chat the `subagent` case renders.
