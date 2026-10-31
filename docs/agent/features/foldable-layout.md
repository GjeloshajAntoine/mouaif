# Foldable phones — implementation notes

Public page: `docs/features/foldable-layout.md`.

## Pieces

- `frontend/src/fold.css`, imported last by `style.css`: `.chat-view__dock { display: contents }` plus the two posture blocks.
- `frontend/src/components/chat/Chat.jsx`: `.chat-view__dock` wraps `WebpreviewDock`, `AgentNetworkDock`, `RunDock`, `.chat-view__composer-row` and `.chat-view__status-row`. The modals rendered after it stay direct children of `.chat-view`.

## Rules the code relies on

- **Tabletop** (`vertical-viewport-segments: 2`): `.chat-view` stays a flex column. The dock gets `min-height: env(viewport-segment-height 0 1)`. Because the chat view ends at the viewport's bottom edge (no tab bar on chat), the dock starts right under the hinge, and the transcript box (`flex: 1`) ends at the hinge's top edge. Its `margin-bottom` is the hinge width. A dock taller than the bottom half grows upward, and `max-height: 100%` with `overflow-y: auto` keeps it on screen.
- **Book** (`horizontal-viewport-segments: 2`): `.chat-view` becomes a 3-column grid of segment 0's width, the hinge width, and the rest. Every child goes in column 1, and the dock spans column 3 with `justify-content: flex-end`. Book posture sets `--shell-max: none`, because a centred, capped frame would move the grid away from the segment offsets.
- **No sibling selectors across the bottom stack.** The wrapper changes the DOM parent of the composer and status rows. No CSS rule uses `.chat-view >` or `+`/`~` on those classes; keep it that way, or put the rule inside the dock.

## Tests

- `scripts/test-foldable-layout.mjs` emulates the hinge with `Emulation.setDeviceMetricsOverride({ displayFeature })`. Chrome 140 accepts `Emulation.setDisplayFeaturesOverride` but still reports one segment, so don't switch to it. The test checks the flat screens (dock is `display: contents`), tabletop and book with a 0 px and a 24 px hinge, and the return to flat. `FOLD_SHOTS=<dir>` saves a screenshot per posture.
- `scripts/test-responsive-layout.mjs` includes the fold sizes in its viewport matrix.
