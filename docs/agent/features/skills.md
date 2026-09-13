# Skills — implementation notes

> Agent-facing reference for [`docs/features/skills.md`](../../features/skills.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

`src/agentSkills.js` parses required YAML frontmatter, rejects files without `name` or `description`, verifies safe project-contained paths, and exposes metadata through the system catalog. The dynamically registered `activate_skill` tool constrains names to available skills, returns body-only instructions with the skill root, and lists bundled resources without eagerly loading them.

Project `skills: false` is a master gate; chat `skills: false` disables skills for one chat. Both project and chat carry a `disabledSkills` list of ids; `resolve` returns them separately (`projectDisabled`, `chatDisabled`) plus their union in `disabled`, which filters the catalog and `activate_skill` while normal agent files remain enabled. The two halves are separate so the chat view can render a project lock as a disabled row with a reason and a per-chat opt-out as a plain switch.

`chat_store.disabled_skills` is a JSON array column (`NULL` when empty, added by the migration in `chatdb.js`); `PATCH /api/chats/:id` takes `disabledSkills`, and an empty array or `null` clears it. The system-prompt response reports per skill `{ enabled, disabled, chatDisabled }` plus `skillsEnabled` — the family flag as the stream resolves it, which can differ from the persisted `chat.skills` when a prompt preset forces skills on. `features.skills` is still absent from `/api/features`, so the prompt editor's synthetic Skills group never appears.
