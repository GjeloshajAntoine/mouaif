# Prompt-size profiles

## Overview

`mouaif` provides four built-in system prompt profiles — `very-small`, `average`, `extensive`, and `chat` — to tailor how much context, guidance, and tool schema information is provided to the AI model.

## Usage

### Picking a profile

- **In the chat (at creation time)** — open a fresh chat and pick from the dropdown at the top of the transcript (`Very small`, `Average`, `Extensive`, or `Chat`). Once the first message is sent, the choice is locked for that conversation to ensure consistent model behavior.
- **For the whole project** — configure `Default prompt style` in project settings. New chats inherit this default.
- **Global default** — set your preferred app-wide default in **Settings → Defaults**.

### Reading the active profile

The active system prompt (the profile instructions plus any attached custom prompt) is displayed in an expandable **System prompt** card at the top of the chat transcript. Tap it anytime to inspect the exact instructions given to the model.

The expanded prompt wraps to the card's width — long lines fold rather than running off the card inside a horizontally scrolling box, so the instructions are readable on a phone. The same wrapping applies to the nested prompt card inside an expanded subagent card. Fenced code blocks in a reply are unaffected: they keep their own no-wrap, horizontally scrolling rendering.

### The four profiles

| ID | Label | When to use it |
|---|---|---|
| `very-small` | Very small | Shared core rules for concise answers, safe changes, progress, and verification. The smallest prompt; tools are listed in compact form and schemas are retrieved on demand. |
| `average` | Average | The recommended default. Adds an explicit inspect/edit/verify workflow, precise file-editing guidance, and full tool schemas. |
| `extensive` | Extensive | All Average guidance plus planning, regression testing, mobile UI checks, and concrete workflow examples. Uses the same full tool schemas. |
| `chat` | Chat | A plain conversation: an empty system prompt. Agent files are off by default, as with Very small. |

### The Chat profile

`chat` sends no profile system message. It is purely a prompt-style value, like the other three: creating a chat with it (or switching a chat to it) does **not** change the chat's tool list or any other per-chat setting. Every tool stays exactly as it was — check or uncheck them in the chat's **Tools** card as usual.

## Shared behavior

Changing the profile adds detail, not a different set of permissions or safety rules. The three non-empty profiles (`very-small`, `average`, `extensive`) instruct the assistant to:

- Answer concisely with project-relative paths and language-tagged code blocks.
- Follow applicable project and custom instructions while respecting instruction priority.
- Make reasonable, reversible decisions autonomously; ask when ambiguity affects scope, safety, or correctness.
- Obtain explicit authorization for destructive actions, full-file rewrites, dependency installs, and pushes; preserve unrelated user work.
- Use only enabled tools, respect authorization gates, and discover missing tool schemas before calling them.
- Inspect before editing, keep changes focused, run relevant checks, and use non-interactive shell commands.
- Report task start and completion when `report_progress` is enabled. Completed work uses `status: "completed"` with `current` equal to `total`; blocked work uses `status: "failed"`, not a false completion.
- Report actual results, unrun checks, and limitations without inventing project facts or exposing secrets.

Average and Extensive also distinguish implementation requests from questions/reviews: apply authorized changes for implementation, but do not edit files merely to answer a question. Their progress guidance uses real milestones and falls back to brief text when the progress tool is unavailable.

## Chat integration

- **Layered instructions** — system prompt profile instructions are placed first, followed by project custom prompts, and then the conversation turns.
- **Per-chat flexibility** — you can choose different profiles for different tasks within the same codebase.

## Related

- [Custom prompts](./custom-prompts.md) — managing custom prompt presets.
- [Chat UI](./chat-ui.md) — the conversation interface.
- [App and project settings](./app-and-project-settings.md) — defaults and configuration hierarchy.
