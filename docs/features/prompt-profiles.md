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
| `very-small` | Very small | The shared core rules alone: short answers, safe and reversible action, inspect-then-edit, non-interactive commands, and honest reporting. The smallest prompt; tools are listed in compact form and schemas are retrieved on demand. |
| `average` | Average | The recommended default. Adds the project workflow — read first, change when asked, run and read the checks, report at milestones — on top of the shared core. |
| `extensive` | Extensive | All Average guidance plus planning, root-cause tracing, regression tests, mobile-first UI checks, and three worked examples. Uses the same full tool schemas. |
| `chat` | Chat | A plain conversation: an empty system prompt. Behaves like Average everywhere else — same tools, same agent files. |

### The Chat profile

`chat` sends no profile system message. It is purely a prompt-style value, like the other three: creating a chat with it (or switching a chat to it) does **not** change the chat's tool list or any other per-chat setting. Every tool stays exactly as it was — check or uncheck them in the chat's **Tools** card as usual.

## Shared behavior

Changing the profile adds detail, not a different set of permissions or safety rules. The three non-empty profiles (`very-small`, `average`, `extensive`) share one byte-identical core — Average appends the workflow section to it and Extensive appends planning and examples to that — so the common rules can never drift apart. The core groups its rules under four headings, and states each rule with the condition that triggers it and the tool or command form it depends on:

**Answering** — keep replies short and lead with the result; short Markdown, fenced code blocks, project-relative paths; the project's own instructions and conventions outrank these defaults.

**Acting** — prefer a reasonable, reversible action over a question, stating the assumption; ask only when it changes what you do (destructive work, scope, or ambiguity that changes the code); get approval first for destructive actions, full-file rewrites, dependency installs, and pushes; use only enabled tools and respect authorization. If an operation is denied, stop it rather than retrying or performing it through another tool (for example, using shell after a denied file edit); ask for clarification or continue only with permitted work. Call `discover_tool` when a tool declaration omits its parameters.

**Editing** — read the code, its callers, and its tests first, and match the naming and error handling used nearby; fix the cause, not the symptom, with the smallest change that works; patch with `edit_file` using an exact, unique `oldText`/`newText` block, and re-read when an edit does not match; shell stdin is closed, so use the one-shot form and feed input with a heredoc or pipe; read the failure before editing again.

**Reporting** — call `report_progress` when available at the start (`status "running"`), at milestones, and at the end; finish with `status: "completed"` and `current` equal to `total`, or `status: "failed"` when blocked, never marking unfinished work complete; close with what changed, what was run, and what is still open, without claiming unverified results or exposing secrets.

Average and Extensive add the project workflow: read the project instructions before acting, apply authorized changes for implementation requests but answer questions and reviews without editing, keep the change scoped, run the targeted tests/lint/build and say which checks did not run, report progress at real milestones rather than narrating, and close by citing the paths touched.

Extensive adds planning and verification (plan first, trace the root cause, add a regression test, check the narrow mobile width first for UI work, parallelize independent reads) and three worked examples: a bug fix, the harmless-versus-material ambiguity split, and blocked verification.

## Chat integration

- **Layered instructions** — system prompt profile instructions are placed first, followed by project custom prompts, and then the conversation turns.
- **Per-chat flexibility** — you can choose different profiles for different tasks within the same codebase.

## Related

- [Custom prompts](./custom-prompts.md) — managing custom prompt presets.
- [Chat UI](./chat-ui.md) — the conversation interface.
- [App and project settings](./app-and-project-settings.md) — defaults and configuration hierarchy.
