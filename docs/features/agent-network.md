# Agent network

## Overview

When a chat delegates to subagents, an **Agents** row appears just above the composer. It looks and expands like any other tool card in the chat: a chevron, the latest message between agents, the agent count and a status dot. Expanded, it shows one graph of every agent in the chat: who started whom, which cooperative group they belong to, who waits on whom, and what they say to each other. Each message travels along the edge it uses, so you can follow the conversation between agents as it happens.

## Usage

1. Delegate work (the model calls `subagent`, or you type `@<agent> <task>`). The **Agents** row appears above the composer. Each new message between agents slides into it.
2. Tap the row to expand the graph below it; tap again to collapse. The choice is remembered in this browser.
3. Tap the fullscreen button next to the status dot for the graph, the selected agent and the messages side by side. Escape or the same button returns to the row.
4. Tap an agent to see its task, status, model, group role and dependencies. **Show in chat** scrolls to its card.
5. **Messages** lists the latest exchanges, newest first. Tap a name to select that agent.

## Behavior

| On the graph | Meaning |
| --- | --- |
| Solid line down | Delegation: the upper agent started the lower one |
| Dashed amber arrow | Group dependency: the target waits for the source |
| Dashed box | A declared group member that has not started yet |
| Spinning dashed ring | The agent is running |
| Dot travelling along an edge | A message: blue for assignments and messages, green for answers and reports, amber for handoffs and decisions, red for failures, conflicts and stops |

- **Narrow screens get a vertical graph.** While the top-down tree fits the card (or the full screen), it is drawn as above. When it would be wider than the room it has (several agents side by side on a phone, or a big fan-out in the inline card), the graph switches to an indented outline: one agent per row in delegation order, each child indented under its parent, boxes widened to the available width. It only grows downwards and scrolls with the card body or the full-screen stage. Delegation lines drop from under the parent's status dot into each child; group dependencies arc on the right between the two rows. The layout follows the width live, so rotating a phone or resizing the window switches it.
- Status dots: blue running, amber waiting, green done, red failed, grey ended or cancelled. A background delegation that never reported back before its turn ended shows **ended**.
- Nested delegations appear at any depth, from live events and from the saved conversation of finished runs.
- Reopening a chat rebuilds the graph and message list from the saved transcript, without animation.
- With reduced motion enabled, nothing moves: edges and agents still highlight while a message is in flight.
- Subagent cards no longer draw their own diagram. The graph is the one place to review the relations between agents.

## Implementation notes

- `layoutNetwork(net)` in `frontend/src/components/chat/agentNetwork.js` returns the top-down tree; `layoutNetwork(net, { vertical: true, width })` returns the outline. Both return `nodeW` and `vertical`, and `edgePath(a, b, kind, layout)` draws edges for either shape.
- `AgentNetworkDock.jsx` measures the graph container with a `ResizeObserver`. It uses the tree when `tree.width` fits (in full screen, when 80% of it fits, since full screen may shrink the tree that far), otherwise the outline.
- Message pulses between a parent and child travel the tree edge; between any other pair (group handoffs) they travel the dependency arc.
- `scripts/test-agent-network.mjs` covers the outline's row order, indentation and width.

## Related

- [Subagent transcript](subagent-transcript.md)
- [Cooperative subagent groups](cooperative-subagent-groups.md)
- [Recursive delegation](recursive-subagent-delegation.md)
