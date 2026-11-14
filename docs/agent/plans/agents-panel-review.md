# Agents panel review

Review of the Agents row above the composer (`frontend/src/components/chat/AgentNetworkDock.jsx`, `agentNetwork.js`, `agentNetworkState.js`, `frontend/src/agent-network.css`), covering animations, relevance, message display and what a tap shows. Date: 2026-11-13.

**Status: implemented 2026-11-13** — the four bugs, all of "Suggested order", and from the other sections: background answers from `subagent_status`, numbered same-named agents, a one-line head, message times, no "→ all" arrow, non-button "Main agent", node glide and fade-in, no reopen animation, the graph as `role="group"`, and "Show in chat" loading older pages. Not done: scoping the count, graph and feed to the current turn (only the status dot follows the latest turn). See `docs/features/agent-network.md`.

## How it was checked

- The dock was bundled into a single HTML file and opened in the debug Chrome at 390 × 780, then driven with the same events the chat sends.
- Model behaviour (feed order, polling, background answers) was run directly in Node against `agentNetwork.js`.
- Items marked *(from the code)* were read, not observed.
- Fullscreen mode was not exercised.

## Bugs

| # | Problem | Evidence | Where |
| --- | --- | --- | --- |
| 1 | Wrong graph after switching chats. With the panel expanded, going to another chat with the same shape (e.g. one delegation each) keeps the previous chat's layout; the new agent is drawn as a box labelled "agent". | Chat X showed `Main agent, alpha`; chat Y showed `Main agent, agent` while the head read "beta → Main agent". | The layout cache keys on version and count, not on the chat: `AgentNetworkDock.jsx:206` |
| 2 | Message animations stop after 80 messages. The head line and the newest feed row are keyed on the feed length, which is capped at 80. New messages then replace the text without sliding in, and the "Messages" count stays at 80. | After 86 messages, both elements were reused for the next one; count read 80. | `AgentNetworkDock.jsx` (keys `latest-<length>` and `<length> - i`), `FEED_LIMIT` in `agentNetwork.js` |
| 3 | Reopened chats show messages in the wrong order. A sub-agent's nested exchanges are added after its final answer, so the head's "latest message" is a grandchild's message. | Feed order on reopen: `delegate root>c1, result c1>root, delegate c1>g1, result g1>c1`. | `agentNetwork.js:233` (result is added before `ingestNestedChat`) |
| 4 | Repeated polls duplicate messages. Each `subagent_messages` call re-adds the same lines as new "reported" rows. | Two polls of two lines produced four rows. | The feed key uses the poll's call id, not the line cursor (`noteToolResult`, `subagent_messages` branch) |

## Animations

- **"Writing" dots mislead.** While a child streams, a dot travels to its parent every 1.4 s and lights the parent as "receiving". With three children streaming, the main agent was lit 85% of the time and 2–3 edges stayed thick. Nothing was sent; the feature doc says a travelling dot is a message. The spinning ring already says "working".
- **Running edges add noise.** The marching dashes on every running agent's edge repeat what the ring shows. In the outline layout they overlap the shared trunk, so solid edges to finished agents look dashed too.
- **Nodes jump.** A new agent re-positions every box instantly; there is no enter or move transition. *(from the code)*
- **Reopen animates a little.** The head line and the first feed row slide in on every mount or expand, though the doc says reopening is without animation. *(from the code)*

## Relevance

- **The status dot stays red forever.** One failed agent anywhere in the chat's history keeps the head dot red, even after later agents succeed.
- **Nothing is scoped to the current turn.** The count, graph and feed accumulate every delegation the chat ever made. Live agents get buried among finished ones in a long chat, and the row stays above the composer permanently with a stale last message.
- **Background agents' answers never reach the feed** when they come back through `subagent_status`: the node turns green with no message.
- **Same-named agents are indistinguishable.** Two "tester" boxes look identical in the graph and the feed.

## Message display

- **Text is cut at 140 characters with no way to read the rest.** This applies to answers too, so the feed is a teaser, not a record. Tasks are cut at 400.
- **The head row is cramped on a phone.** "4 agents · 2 active" wraps to two lines, and the latest message gets about 166 px in 10 px mono type.- **No time on messages**, and broadcast rows read "→ all". *(from the code)*

## On click

- **Tapping an agent shows almost nothing.** The detail renders below the graph inside a 359 px scrolling body; after a tap, only 53 px of it was visible.
- **Tapping a name in the feed shows nothing at all.** The detail opens above, fully scrolled out of view (0 px visible).
- **The detail lacks the answer.** It shows task, status and model, but not the agent's result or its messages, and the feed is not filtered to the selected agent.
- **Dead taps.** "Main agent" and "all" are styled as buttons but do nothing, and a message row itself is not tappable. "Show in chat" silently does nothing when the card is not in the loaded transcript; the run dock's jump helper (`jumpToRun.js`) already loads older pages for this case. *(from the code)*
- **Screen readers cannot reach the agents.** The graph is `role="img"`, which hides the node buttons inside it. *(from the code)*

## Suggested order

1. Fix the four bugs (small, local changes).
2. Scroll the detail into view on select, and add the answer plus that agent's messages to it.
3. Drop the stream dots and marching edges (keep the ring), and make the head dot reflect the current turn.
4. Let a message row expand to its full text.
