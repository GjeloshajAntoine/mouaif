# Chat UI — mobile shell and conversation view

## Overview

The chat view provides a mobile-first AI conversation interface with real-time streaming, interactive tool execution, markdown formatting, model selection, and token usage tracking.

## Interface structure

- **Header bar** — includes the chat switcher to jump between conversations in the same project, the active model picker button, a quick model refresh action, and options to rename, export trace, or delete the chat. The header is a compact two-line bar: the back button, chat title, and usage chips sit on the top line, while the model picker (a text-sized dropdown showing the model id only) and thinking-level select drop to a second line. The two header icons (project-settings gear and tool-popup globe) stack one per line on the right, matching the top line's height. The head has no vertical padding — vertical rhythm comes only from the flex `gap` and the bottom border — so there is no visible gap between the app header and the title, and no gap between the usage chips and the model row below.
- **Transcript area** — displays conversational messages with markdown support, expandable system prompt details, inline tool run cards with live execution status, and per-message usage metrics. Every row spans the full width of the transcript's inner box, so short rows (a one-line `Read …` card) line up with long ones instead of shrinking and floating; the message bubble inside still hugs its text from that shared left edge, and user bubbles stay right-aligned.
- **Floating composer** — includes actions to attach files or images, an auto-expanding input box, keyboard shortcuts (`Enter` to send, `Shift+Enter` for newlines), and a responsive send button.

## Features

### Real-time streaming & tools
- **Live streaming** — responses stream in real-time with smooth progressive rendering.
- **Inline tool execution** — tool runs (terminal commands, file changes, agent delegations) show up directly in the transcript with interactive previews and status indicators.
- **Collapsible system prompts** — view the active system prompt, prompt profile, and tool rules at the top of the chat without crowding the conversation.
- **Token & cost visibility** — see context tokens in the header and token speed / per-turn cost under each completed assistant turn.
- **Leaving a chat stops its live reader** — switching chats (or unmounting the view) aborts this client's `fetch` for the streaming turn and the read loop stops. The server keeps running the turn, so returning to the chat shows the completed result; what stops is the local reader, which would otherwise keep appending to the transcript of the chat you left and render its deltas into the chat you moved to. A deliberate abort is silent — no error card, no auto-retry, no reconnect poll — and the composer is released immediately.

### Conversation management
- **Model selection** — tap the model button in the header to search, switch, or bookmark models across your connected providers.
- **Prompt profiles** — pick between `Very small`, `Average`, and `Extensive` prompt profiles when starting a new chat.
- **Custom prompt presets** — attach custom system prompts from the chat options menu.
- **Draft preservation** — unsent text and image attachments are preserved per chat so you never lose your place.
- **Trace export** — export the full event trace of a chat session directly from the chat menu.

## Keyboard & Mobile considerations

- **Touch-friendly** — every non-accessory control in the chat header and composer is a full `--tap` (44 px) target: the title (**Switch chat**), the model picker, the thinking level select, the back button, the textarea, send, image and tools. The two stacked header glyph buttons (project settings, tools) stay at 32 px of paint, because a 44 px pair would add ~24 px to the header row; see [Responsive layout](responsive-layout.md) for the helper and the remaining density trade-offs. Scrolling stays smooth on mobile.
- **Virtual keyboard support** — the composer adjusts automatically as the on-screen keyboard opens and closes.
- **Auto-scroll & unpin** — the transcript follows new streaming messages automatically when at the bottom; scrolling up shows a jump-to-bottom button. While pinned, it also follows existing rows that expand after rendering, such as tool cards, decoded images, and asynchronously laid-out markdown.
- **PWA resume refresh** — returning to an installed PWA reconciles the visible chat immediately, including messages, run state, and pending authorization or question cards received while the app was backgrounded.

## Implementation notes

Detaching a turn is detected from the abort signal itself, not only from a thrown `AbortError`. The read loop also re-checks the mounted `projectDir`/`chatId` before every read, so a switch that lands between two reads unwinds the loop without throwing; both paths converge on the same silent detach and skip the finalize step that would otherwise append the abandoned chat's partial assistant turn to `state.messages` and reconcile the new chat against the old chat's cursor.

Per-chat state that is normally seeded by the chat load — the backward-pagination cursor, the transcript append cursor, and the live replay cursor — is reset by a dedicated effect on every `projectDir`/`chatId` change, so a failed or superseded load cannot leave the previous chat's cursor driving the next chat's fetches. The chat load re-checks its `cancelled` flag after its last `await` (the tool-authorization fetch), so a load that is still in flight when the user switches away cannot overwrite the incoming chat's composer, thinking level, meta line, provider credit, or model picker.

The composer is also reset per chat. `ChatView` is reused across navigation rather than remounted, so the outgoing chat's text and image attachments are flushed to that chat (an explicit chat-scoped `PATCH`, because `state.props` already points at the new chat by then) and the field is cleared before the incoming chat's saved draft is applied. This keeps a typed message from being saved as another chat's draft, and lets the new chat show its own draft.

The chat switcher preloads its first page per `projectDir`/`chatId` and resets its pager only when that identity changes. A `runningVisible` flip — which happens at both ends of every turn — re-fetches the newest page and merges it over the rows already on screen, instead of replacing the list, so pages the user scrolled in are never discarded. A page callback that finds its pager has been replaced still clears the loading flag, so "Loading more…" cannot stay on screen after a project switch.

Composer autosaves remain debounced. Draft-only PATCH responses update only saved text/attachment metadata: they do not rebuild the model picker, repaint the header, or fetch provider credit. A late draft acknowledgement cannot replace an in-progress model selection with an older server snapshot. Mixed metadata updates and explicit model changes retain their normal refresh behavior.

The transcript observes DOM mutations and geometry changes for both its viewport and direct message rows. Geometry changes re-pin only when the reader is already at the bottom; scrolling up disables automatic movement so reading history is not interrupted.

The chat listens for `visibilitychange`, `pageshow`, and window `focus`. Resume signals are coalesced into one incremental revision sync, covering ordinary tabs, page-cache restores, and standalone mobile PWA foregrounding without reloading the full page.

### Regression checks

Run the focused reliability/performance checks with:

```bash
npm run test:chat-view
```

This suite covers send preparation failures, cursor-aligned total costs, batched transcript scrolling, and draft-only saves. It also runs as part of `npm test`.

## Related

- [Model picker](./model-picker.md) — browsing and switching AI models.
- [Tool authorization](./tool-authorization.md) — approving or gating tool execution.
- [Usage metrics](./usage-metrics.md) — token and cost tracking details.
- [Custom prompts](./custom-prompts.md) — managing system prompt presets.
