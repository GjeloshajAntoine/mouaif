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
- **Leaving a chat stops its live reader** — switching chats (or unmounting the view) aborts this client's `fetch` for the streaming turn and the read loop stops. The server keeps running the turn, so returning to the chat shows the completed result; what stops is the local reader, which would otherwise keep appending to the transcript of the chat you left and render its deltas into the chat you moved to. A deliberate abort is silent — no error card, no auto-retry, no reconnect poll — and the composer is released immediately. Returning to a running chat follows the active turn, blocks concurrent sends from Enter or the composer while watching, and syncs the completed transcript immediately when the turn ends.

### Conversation management
- **Model selection** — tap the model button in the header to search, switch, or bookmark models across your connected providers.
- **Prompt profiles** — pick between `Very small`, `Average`, and `Extensive` prompt profiles when starting a new chat.
- **Custom prompt presets** — attach custom system prompts from the chat options menu.
- **Draft preservation** — unsent text and image attachments are preserved per chat so you never lose your place.
- **Trace export** — export the full event trace of a chat session directly from the chat menu.

## Keyboard & Mobile considerations

- **Touch-friendly** — the back button is a full `--tap` (44 px) target that fills a row already that tall, so it costs no layout. The title (**Switch chat**) is a 260 × 32 target: dense-header sizing, like the gear and globe beside it, because the head's first row is already 66 px tall and a 44 px box around 16 px of text only inserted dead space between the title and the usage chips. The two controls whose box *is* their target stay at 26 px — the model picker (200 px wide) and the thinking level select (110 px) — because at 44 px they doubled the header height, and the composer keeps its 32 px buttons and 40 px pill for the same reason. See [Responsive layout](responsive-layout.md) for the measurements and the `.tap-target` helper. Scrolling stays smooth on mobile.
- **Virtual keyboard support** — the composer adjusts automatically as the on-screen keyboard opens and closes.
- **Auto-scroll & unpin** — the transcript follows new streaming messages automatically when at the bottom; scrolling up shows a jump-to-bottom button. While pinned, it also follows existing rows that expand after rendering, such as tool cards, decoded images, and asynchronously laid-out markdown. Only user input can unpin it: an upward wheel or scroll key, a touch drag (including its momentum), or a pointer press on the transcript. Scrolls the browser makes itself — off-screen rows collapsing to their placeholder height, scroll anchoring, or a streaming reply growing between two frames — keep following, so a long reply no longer runs on below the fold.
- **PWA resume refresh** — returning to an installed PWA reconciles the visible chat immediately, including messages, run state, and pending authorization or question cards received while the app was backgrounded.

## Related

- [Model picker](./model-picker.md) — browsing and switching AI models.
- [Tool authorization](./tool-authorization.md) — approving or gating tool execution.
- [Usage metrics](./usage-metrics.md) — token and cost tracking details.
- [Custom prompts](./custom-prompts.md) — managing system prompt presets.
