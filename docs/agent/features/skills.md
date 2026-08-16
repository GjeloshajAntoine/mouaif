# Skills — implementation notes

> Agent-facing reference for [`docs/features/skills.md`](../../features/skills.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

`src/agentSkills.js` parses required YAML frontmatter, rejects files without `name` or `description`, verifies safe project-contained paths, and exposes metadata through the system catalog. The dynamically registered `activate_skill` tool constrains names to available skills, returns body-only instructions with the skill root, and lists bundled resources without eagerly loading them.

Project `skills: false` is a master gate; chat `skills: false` disables skills for one chat. `disabledSkills` filters skills out of both the catalog and activation tool while normal agent files remain enabled. The UI currently exposes per-skill rows as checkboxes, but the persisted chat setting remains a family toggle; project-disabled skills render disabled with a reason.
