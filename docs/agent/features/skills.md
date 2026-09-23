# Skills — implementation notes

> Agent-facing reference for [`docs/features/skills.md`](../../features/skills.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

`src/agentSkills.js` parses required YAML frontmatter, rejects files without `name` or `description`, verifies safe project-contained paths, and exposes metadata through the system catalog. The dynamically registered `activate_skill` tool constrains names to available skills, returns body-only instructions with the skill root, and lists bundled resources without eagerly loading them.

Project `skills: false` is a master gate; chat `skills: false` disables skills for one chat. Both project and chat carry a `disabledSkills` list of ids; `resolve` returns them separately (`projectDisabled`, `chatDisabled`) plus their union in `disabled`, which filters the catalog and `activate_skill` while normal agent files remain enabled. The two halves are separate so the chat view can render a project lock as a disabled row with a reason and a per-chat opt-out as a plain switch.

`chat_store.disabled_skills` is a JSON array column (`NULL` when empty, added by the migration in `chatdb.js`); `PATCH /api/chats/:id` takes `disabledSkills`, and an empty array or `null` clears it. The system-prompt response reports per skill `{ enabled, disabled, chatDisabled }` plus `skillsEnabled` — the family flag as the stream resolves it, which can differ from the persisted `chat.skills` when a prompt preset forces skills on. `features.skills` is still absent from `/api/features`, so the prompt editor's synthetic Skills group never appears.

- Discovery and resolution live in `src/agentSkills.js`. `resolve({ chat, projectDir })` returns the family flag, the project-level lock, and two separate opt-out sets: `projectDisabled` (from `project.disabledSkills`) and `chatDisabled` (from `chat.disabledSkills`). `disabled` is their union and is what filters the catalog and the `activate_skill` tool.
- The chat record carries `disabledSkills` (a string array of skill ids, stored as JSON in `chat_store.disabled_skills`, `NULL` when empty). `PATCH /api/chats/:id` accepts it; an empty array or `null` clears it.
- `GET /api/chats/:id/system-prompt` reports each skill as `{ id, name, description, enabled, disabled, chatDisabled }` plus `skillsEnabled`, so the chat view can tell a project lock (row disabled, with a reason) from this chat's own opt-out (a plain checkbox), and can show what the stream will actually inject.
- Enabling a single skill in a chat that had skills off writes both `skills: true` and the remaining skill ids into `disabledSkills`, and switching the last skill off writes `skills: false` together with every selectable id. A prompt preset may force the family flag back on for a turn, and the per-skill list is what keeps that from resurrecting a catalog the user switched off row by row.
