# Prompt-size profiles

## Overview

`mouaif` provides three built-in system prompt profiles — `very-small`, `average`, and `extensive` — to tailor how much context, guidance, and tool schema information is provided to the AI model.

## Usage

### Picking a profile

- **In the chat (at creation time)** — open a fresh chat and pick from the dropdown at the top of the transcript (`Very small`, `Average`, or `Extensive`). Once the first message is sent, the choice is locked for that conversation to ensure consistent model behavior.
- **For the whole project** — configure `Default prompt style` in project settings. New chats inherit this default.
- **Global default** — set your preferred app-wide default in **Settings → Defaults**.

### Reading the active profile

The active system prompt (the profile instructions plus any attached custom prompt) is displayed in an expandable **System prompt** card at the top of the chat transcript. Tap it anytime to inspect the exact instructions given to the model.

### The three profiles

| ID | Label | When to use it |
|---|---|---|
| `very-small` | Very small | Minimizes prompt token overhead for fast, lightweight responses or simpler tasks. Tools are listed in compact form and schemas are retrieved on demand. |
| `average` | Average | The recommended default. Balances identity, response formatting, non-interactive execution guidance, and standard tool schemas. |
| `extensive` | Extensive | Comprehensive instructions with thorough trace rules and detailed problem-solving examples for complex workflows. |

## Behavior

- **Layered instructions** — system prompt profile instructions are placed first, followed by project custom prompts, and then the conversation turns.
- **Per-chat flexibility** — you can choose different profiles for different tasks within the same codebase.

## Related

- [Custom prompts](./custom-prompts.md) — managing custom prompt presets.
- [Chat UI](./chat-ui.md) — the conversation interface.
- [App and project settings](./app-and-project-settings.md) — defaults and configuration hierarchy.
