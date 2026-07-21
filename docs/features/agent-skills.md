# Agent skills

<!-- Static-page-ready. No SSG shortcodes. Update docs/README.md in the same commit that adds this file. -->

## Overview

Agent skills are named, project-scoped instruction files stored under `<projectDir>/.agents/skills/<name>/SKILL.md`. When a chat streams, every discovered skill is injected into the upstream system context as its own `system` message, so the model can apply domain-specific guidance without the user pasting it into every prompt. Skills live in the project directory so they can be committed to the repo and edited by hand alongside the code they describe.

## Usage

### Directory layout

Create a subdirectory for each skill and put a `SKILL.md` inside it:

```text
my-project/
  .agents/
    skills/
      code-review/
        SKILL.md
      refactor/
        SKILL.md
```

The directory name becomes the skill name. It must start with an alphanumeric character and may contain letters, digits, dots, underscores, and hyphens (max 64 chars). Hidden directories (starting with `.`) and directories without a `SKILL.md` are ignored.

### SKILL.md format

The file is plain Markdown. The first `# Heading` is used as the human-friendly title in the UI and in the injected system-message header. If there is no heading, the directory name is used as the title.

```markdown
# Code Review

Check for style, correctness, and test coverage. Prefer small, focused commits.
```

### In a chat

Skills are injected automatically when the chat streams. The server reads the current working-tree version of each `SKILL.md` at message-send time, so edits take effect immediately without restarting the server.

Open **Settings → Agents** to associate all skills or a selected subset with an agent. The chat **Skills** card can override that selection for one chat. `null` means all discovered skills and `[]` means none.

### Per-chat toggle

Each chat carries an optional `skills` boolean:

- `true` — inject skills even when the prompt-size profile is `very-small`.
- `false` — do not inject skills, even on `average` or `extensive`.
- `undefined` / `null` — use the profile default (`very-small` = off, `average`/`extensive` = on).

The project-level `.mouaif.json` can also set `skills: true|false` to override the profile default for every chat in the project.

## REST

| Method | Path | Query | Response |
|--------|------|-------|----------|
| `GET` | `/api/skills` | `?projectDir=<abs>` | `{ skills: [{ name, title, size }] }` |
| `GET` | `/api/skills/:name` | `?projectDir=<abs>` | `{ skill: { name, title, role, content } }` |

The API is read-only; the server never creates, modifies, or deletes skill files.

## Behavior

- **Storage:** on disk only, under `.agents/skills/`. No database, no `.mouaif.json` key.
- **Ordering:** skills are discovered and injected in alphabetical order by directory name.
- **Size cap:** a `SKILL.md` larger than 64 KiB is truncated with a trailing `[... truncated at 65536 bytes ...]` note.
- **Empty files:** a `SKILL.md` that is empty or only whitespace is skipped.
- **Trace:** when the chat's trace flag is on, a `skills` event is written to the trace file listing the injected skill names and titles.
- **System-prompt preview:** `GET /api/chats/:id/system-prompt` includes a `skills` array so the UI can show which skills will be injected before the first message is sent.

## Implementation notes

- Source: `src/skills.js` (new module) — `discover(projectDir)`, `load(projectDir)`, `resolveEnabled({chat, projectDir})`.
- Injection happens in `src/index.js` → `handleChatStream`, after agent files and before tagged files and the custom prompt.
- The per-chat toggle is persisted in `<projectDir>/.mouaif.json` under `chats[].skills` (see `src/chats.js`).
- Mobile-first: agent configuration uses 44 px touch rows in Settings, while the chat Skills card persists per-chat overrides.

## Related

- [docs/features/custom-prompts.md](./custom-prompts.md) — skills and custom prompts compose; skills sit deeper in the system context.
- [docs/features/file-tagging.md](./file-tagging.md) — another way to inject project context into a chat.
- [docs/features/prompt-profiles.md](./prompt-profiles.md) — the `very-small` profile disables skills by default.
- Source: `src/skills.js`, `src/index.js`, `src/chats.js`.
