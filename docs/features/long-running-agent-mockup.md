# Long-running agent mockup

## Overview

An interactive review page proposes how a **long-running agent run** should look inside the chat view: a run card that stays pinned while the agent works, a designer that creates a run, and live tweaks that steer a run without restarting it. It is a mockup, not a shipped feature — the run card and the designer have no production renderer yet.

The chat view around the proposal is real: the production stylesheet and the production transcript renderers draw the head, the bubbles, the tool cards and the composer, so what the page shows is what the app draws.

## Usage

From the repository root, run:

```bash
npm run mockup:long-running-agent
```

Open the loopback URL printed by the command. The preview uses its own available port, never the application's port 5732. To choose a port or build a standalone file:

```bash
npm run mockup:long-running-agent -- --port=8141
npm run mockup:long-running-agent -- --build
```

Build output is `.mouaif/long-running-agent-mockup/index.html`, which can be opened from disk. On a phone, use the app's local preview proxy URL for the printed loopback address rather than opening loopback directly.

What to try:

- **Design run** opens the designer. Set a name, a goal, a plan template, a turn budget, an autonomy level, the agent and the model, then tap **Start the run**.
- The run card shows the goal, a progress bar, the plan steps, the spent turns and cost, and four actions: **Pause**, **Tweak**, **Skip step** and **Stop**.
- **Tweak** opens the same designer in a reduced form — only the fields a live run may change — plus a free-text instruction delivered at the run's next turn boundary.
- Typing in the composer while a run is live sends the message to the agent; it is echoed on the run card as a **You:** line.
- **Speed** changes the simulation clock (1×, 4×, 16×). **Reset** clears the transcript.
- Check narrow widths first: 360, 390 and 430 CSS pixels. The designer is a bottom sheet on a phone and a side panel on a wide frame.

Nothing runs a tool, calls a provider, changes a setting or touches a real chat. Every run is a local simulation with synthetic data, and every API route on the preview server fails closed.

## The proposal

| Surface | Decision under review |
| --- | --- |
| Run card | One card per run, pinned to the bottom of the transcript while the run is live, returning to its chronological slot when the run settles. It carries the goal, a progress bar, the plan, the spent turns and cost, and the live actions. |
| Run controls | **Pause / Resume**, **Tweak**, **Skip step**, **Stop**. Every action is a 44 px tap target; there are no hover-only affordances. |
| Tweak timing | A tweak never interrupts a step in flight. It is queued and applied at the run's next turn boundary, so the run's identity and its current step survive the change. |
| Autonomy | Three levels — read-only, guarded, autonomous — decide how much the run may do without asking. |
| Turn budget | The run stops on its own once the budget is spent, instead of running forever. |
| Designer | One surface for both creating and tweaking. The phone layout is a bottom sheet; the wide layout is a side panel. |

## Related

- [Subagent orchestration](./subagent-tools.md) — the shipped background delegation this mockup builds on.
- [Chat view mockup](./chat-view-mockup.md) — the review page for every native tool card.
- [Progress tool](./progress-tool.md) — the live progress bar a running turn already draws.
- [Agents](./agents.md) — the stored personas a run delegates to.
