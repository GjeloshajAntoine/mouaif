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
| `very-small` | Very small | Shared core rules for concise answers, safe changes, progress, and verification. The smallest prompt; tools are listed in compact form and schemas are retrieved on demand. |
| `average` | Average | The recommended default. Adds an explicit inspect/edit/verify workflow, precise file-editing guidance, and full tool schemas. |
| `extensive` | Extensive | All Average guidance plus planning, regression testing, mobile UI checks, and concrete workflow examples. Uses the same full tool schemas. |

## Shared behavior

Changing the profile adds detail, not a different set of permissions or safety rules. All three profiles instruct the assistant to:

- Answer concisely with project-relative paths and language-tagged code blocks.
- Follow applicable project and custom instructions while respecting instruction priority.
- Make reasonable, reversible decisions autonomously; ask when ambiguity affects scope, safety, or correctness.
- Obtain explicit authorization for destructive actions, full-file rewrites, dependency installs, and pushes; preserve unrelated user work.
- Use only enabled tools, respect authorization gates, and discover missing tool schemas before calling them.
- Inspect before editing, keep changes focused, run relevant checks, and use non-interactive shell commands.
- Report task start and completion when `report_progress` is enabled. Completed work uses `status: "completed"` with `current` equal to `total`; blocked work uses `status: "failed"`, not a false completion.
- Report actual results, unrun checks, and limitations without inventing project facts or exposing secrets.

Average and Extensive also distinguish implementation requests from questions/reviews: apply authorized changes for implementation, but do not edit files merely to answer a question. Their progress guidance uses real milestones and falls back to brief text when the progress tool is unavailable.

## Implementation notes

`src/promptProfiles.js` composes each profile from shared text: Very small is the compact core, Average appends workflow guidance, and Extensive appends planning and examples to Average. This keeps common instructions identical and prevents larger profiles from drifting into contradictory behavior.

Profile IDs, the `average` default, settings resolution, and tool-schema reduction are unchanged. `GET /api/prompt-profiles` exposes the same metadata and composed `systemMessage` used by the chat pipeline and the custom-prompt editor's **Start from a default** / **Copy from default** actions. Saved custom prompts are independent copies and are not overwritten by built-in prompt updates.

Regression coverage in `scripts/test-prompt-profiles.js` checks shared rules, additive composition, size ordering, settings fallback, tool schemas, and HTTP responses using an isolated server on an ephemeral loopback port.

## Chat integration

- **Layered instructions** — system prompt profile instructions are placed first, followed by project custom prompts, and then the conversation turns.
- **Per-chat flexibility** — you can choose different profiles for different tasks within the same codebase.

## Related

- [Custom prompts](./custom-prompts.md) — managing custom prompt presets.
- [Chat UI](./chat-ui.md) — the conversation interface.
- [App and project settings](./app-and-project-settings.md) — defaults and configuration hierarchy.
