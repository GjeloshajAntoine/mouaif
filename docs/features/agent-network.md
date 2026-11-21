# Agent network

## Overview

When a chat delegates to subagents, an **Agents** row appears just above the composer. It looks and expands like any other tool card in the chat: a chevron, the latest message between agents, the agent count and a status dot. Expanded, it shows one graph of every agent in the chat: who started whom, which cooperative group they belong to, who waits on whom, and what they say to each other. Each message travels along the edge it uses, so you can follow the conversation between agents as it happens.

## Usage

1. Delegate work (the model calls `subagent`, or you type `@<agent> <task>`). The **Agents** row appears above the composer. Each new message between agents slides into it.
2. Tap the row to expand the graph below it; tap again to collapse. The choice is remembered in this browser.
3. Tap the fullscreen button next to the status dot for the graph, the selected agent and the messages side by side. Escape or the same button returns to the row.
4. Tap an agent (a box, or its name in **Messages**) to see its task, its answer (or error), status, model, group role and dependencies. The details scroll into view, and **Messages** narrows to that agent's exchanges; **Show all** or **×** clears the selection. **Show in chat** scrolls to its card, loading older pages of the chat first when the card is not loaded yet.
5. **Messages** lists the latest exchanges, newest first, with the time each was sent. A message cut short ends in **more**: tap its text to read all of it, tap again to fold it.

## Behavior

| On the graph | Meaning |
| --- | --- |
| Solid line down | Delegation: the upper agent started the lower one |
| Dashed amber arrow | Group dependency: the target waits for the source |
| Dashed box | A declared group member that has not started yet |
| Spinning dashed ring | The agent is running (writing or thinking included) |
| Dot travelling along an edge | A message: blue for assignments and messages, green for answers and reports, amber for handoffs and decisions, red for failures, conflicts and stops |

Only real messages travel. An agent that is writing does not send dots to its parent, and edges stay still while agents run: the ring says the agent is working.

- **Boxes follow the room.** In both shapes the agent boxes widen to fill the width of the card or the full-screen stage, so a phone does not show small boxes in a wide frame and full screen does not scale a narrow tree up to 1.6×.
- **Narrow screens get a vertical graph.** While the top-down tree fits the card (or the full screen), it is drawn as above. When it would be wider than the room it has (several agents side by side on a phone, or a big fan-out in the inline card), the graph switches to an indented outline: one agent per row in delegation order, each child indented under its parent, boxes widened to the available width. It only grows downwards and scrolls with the card body or the full-screen stage. Delegation lines drop from under the parent's status dot into each child; group dependencies arc on the right between the two rows. The layout follows the width live, so rotating a phone or resizing the window switches it.
- Status dots: blue running, amber waiting, green done, red failed, grey ended or cancelled. A background delegation that never reported back before its turn ended shows **ended**; in a chat, background runs are not cancelled at turn end, so a still-running one keeps its blue ring across turns until it settles, is stopped, or the app restarts.
- The row's status dot is blue while any agent runs. Otherwise it is red only when an agent of the latest turn that delegated failed; a failure in an earlier turn no longer keeps it red.
- The head reads `3/4 active` while agents run and `4 agents` otherwise, so it stays on one line on a phone.
- Agents with the same name are numbered in the order they started (`tester 1`, `tester 2`), in the graph, the feed and the details.
- A background agent's answer reaches **Messages** whether it comes back directly or through `subagent_status`. Polling `subagent_messages` again never repeats lines already listed.
- When an agent joins, the boxes glide to their new places and the new box fades in.
- Nested delegations appear at any depth, from live events and from the saved conversation of finished runs.
- Reopening a chat rebuilds the graph and message list from the saved transcript, without animation: a run's nested exchanges are listed before its answer, and only messages that arrive while the row is on screen slide in (not on opening, expanding or switching chats).
- With reduced motion enabled, nothing moves: edges and agents still highlight while a message is in flight.
- Subagent cards no longer draw their own diagram. The graph is the one place to review the relations between agents.

## Related

- [Subagent transcript](subagent-transcript.md)
- [Cooperative subagent groups](cooperative-subagent-groups.md)
- [Recursive delegation](recursive-subagent-delegation.md)
