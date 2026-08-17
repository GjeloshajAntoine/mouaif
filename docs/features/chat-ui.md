# Chat UI — mobile shell and conversation view

## Overview

The chat view provides a mobile-first AI conversation interface with real-time streaming, interactive tool execution, markdown formatting, model selection, and token usage tracking.

## Interface structure

- **Header bar** — includes the chat switcher to jump between conversations in the same project, the active model picker button, a quick model refresh action, and options to rename, export trace, or delete the chat. The header is a compact two-line bar: the back button, chat title, and usage chips sit on the top line, while the model picker (a text-sized dropdown showing the model id only) and thinking-level select drop to a second line. The two header icons (project-settings gear and tool-popup globe) stack one per line on the right, matching the top line's height. The head has no vertical padding — vertical rhythm comes only from the flex `gap` and the bottom border — so there is no visible gap between the app header and the title, and no gap between the usage chips and the model row below.
- **Transcript area** — displays conversational messages with markdown support, expandable system prompt details, inline tool run cards with live execution status, and per-message usage metrics.
- **Floating composer** — includes actions to attach files or images, an auto-expanding input box, keyboard shortcuts (`Enter` to send, `Shift+Enter` for newlines), and a responsive send button.

## Features

### Real-time streaming & tools
- **Live streaming** — responses stream in real-time with smooth progressive rendering.
- **Inline tool execution** — tool runs (terminal commands, file changes, agent delegations) show up directly in the transcript with interactive previews and status indicators.
- **Collapsible system prompts** — view the active system prompt, prompt profile, and tool rules at the top of the chat without crowding the conversation.
- **Token & cost visibility** — see context tokens in the header and token speed / per-turn cost under each completed assistant turn.

### Conversation management
- **Model selection** — tap the model button in the header to search, switch, or bookmark models across your connected providers.
- **Prompt profiles** — pick between `Very small`, `Average`, and `Extensive` prompt profiles when starting a new chat.
- **Custom prompt presets** — attach custom system prompts from the chat options menu.
- **Draft preservation** — unsent text and image attachments are preserved per chat so you never lose your place.
- **Trace export** — export the full event trace of a chat session directly from the chat menu.

## Keyboard & Mobile considerations

- **Touch-friendly** — comfortable tap targets (≥ 44 × 44 px) and smooth mobile scrolling.
- **Virtual keyboard support** — the composer adjusts automatically as the on-screen keyboard opens and closes.
- **Auto-scroll & unpin** — the transcript follows new streaming messages automatically when at the bottom; scrolling up shows a jump-to-bottom button.

## Related

- [Model picker](./model-picker.md) — browsing and switching AI models.
- [Tool authorization](./tool-authorization.md) — approving or gating tool execution.
- [Usage metrics](./usage-metrics.md) — token and cost tracking details.
- [Custom prompts](./custom-prompts.md) — managing system prompt presets.
