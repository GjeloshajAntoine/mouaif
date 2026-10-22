# Long-running agent mockup — maintainer notes

## What this is

`scripts/long-running-agent-mockup/` is a **review harness** for a proposed
chat surface: a long-running agent run. It is not a shipped feature. The run
card (`.lra*`) and the run designer have no production renderer and no server
behind them; they are mockup-local DOM.

Everything around the proposal is real, so a design decision can be judged in
the context it will ship in:

- the chat view uses `frontend/src/style.css` (imported by
  `scripts/long-running-agent-mockup/style.css`);
- the user bubble and the tool cards come from the production renderers
  (`appendMessageToTranscript`, `appendToolCallCard`, `appendToolResultCard`
  in `frontend/src/components/chat/transcript.js`);
- the head, the composer and the transcript rows are the production class
  names, so they are styled by the production stylesheet.

## Running it

```bash
npm run mockup:long-running-agent            # serve on a free loopback port
npm run mockup:long-running-agent -- --build # .mouaif/long-running-agent-mockup/index.html
npm run test:long-running-agent-mockup       # browser regression
```

The bundle travels as a data-script URL for the same reason the chat view
mockup does it: the app's local-preview proxy rewrites root paths in
JavaScript and its text matcher mistakes regex literals for paths.

## Design decisions the mockup encodes

- **The run card is pinned while the run is live.** `paint()` re-appends the
  card to the end of the transcript while the run is running or paused, and
  `restoreRunCardToSlot()` puts it back where it was created when the run
  settles. The anchor is recorded by `recordRunCardSlot()` at creation time.
  This mirrors the shipped behaviour of a running `subagent` card (see
  `ensureSubagentSlotMarker` / `restoreSubagentCardToSlot` in `transcript.js`).
- **A tweak is queued, never applied mid-step.** `applyTweak()` stores the
  change on `run.draft` and puts the free-text instruction in
  `run.pendingInstruction`; `advance()` delivers it at the next turn
  boundary. The run keeps its identity and its current step.
- **A tweak on a settled run applies at once.** Only `advance()` delivers a
  queued instruction, and `advance()` returns early unless the run is
  running — so queueing on a finished run stranded the message forever.
  `applyTweak()` now branches: a live run queues, a settled run applies the
  change and says on the card that it applies to the next run.
- **The card shows the agent and the model.** The meta line reads
  `agent · model · turns …`, so a tweak to either is visible on the card
  and not only in the designer.
- **One step runs at a time.** `run.pending` guards the interval-driven
  `advance()` so a step whose result has not landed yet is not started twice.
  Each step gets its own tool-call id (`mock-<index>-<counter>`), because the
  production renderer keys cards by id and a repeated id would adopt the
  previous card instead of drawing a new one.
- **A run instance carries a token.** A step that was in flight when the run
  was replaced (Start again, Reset) must not land its result on the new run;
  the closure compares `run.token`.

## The agent control panel

`scripts/long-running-agent-mockup/agent-panel.html` is the same proposal as
a single-file **on-the-fly MCP App**: a live control panel for the running
agent, mounted by the production host (`InstantMcpApp`) in the real MCP Apps
sandbox.

It is a real AppBridge participant, not a picture of one:

- panel → agent: `window.mouaifApp.sendMessage(...)`;
- agent → panel: `create_mcp_app({ message })`, delivered through the
  AppBridge `sendToolInput` / `sendToolResult` notifications. The panel
  reads `structuredContent.state` and falls back to a JSON object in a
  plain text reply, so a plain answer still fills it in.

`scripts/test-agent-panel-app.mjs` drives it through the production host:
the real `InstantMcpApp` component, the real sandbox, the real AppBridge.
It checks that the app boots and links, that an agent push fills the panel
in, that the buttons and the steer field send real `ui/message` payloads,
and that the panel fits 360 / 390 / 430 px with 44 px touch targets. It
writes `.mouaif/agent-panel.png` and `.mouaif/agent-panel-chat.png` as
review captures.

`scripts/lib/mcp-apps-cdp.mjs` gained `appContextBySelector(selector)`: the
shared `appContext()` probes for a `#ready` element, which only fits the
original fixture. An app with its own markup needs its own anchor.

## Test coverage

`scripts/test-long-running-agent-mockup.mjs` drives the page in headless
Chrome at 360 / 390 / 430 px:

- the designer opens as a sheet and shows the creation fields;
- a run creates the card, the plan steps and the four live actions;
- the tweak path changes the agent and queues the instruction, and shows
  fewer fields than create mode;
- pause / resume / skip / stop change the run state;
- the run card is pinned while the run is live and returns to its creation
  slot when it settles;
- every action control is at least 44 px tall;
- the production tool cards render inside the transcript;
- no runtime error, and no horizontal document overflow.

The test is part of `npm run test:browser-build`.

## Not in scope

The mockup deliberately does not invent server behaviour: no endpoint, no
persisted run record, no resume, no notification, no approval flow for the
run's own writes. Those are decided when the proposal becomes a feature.
