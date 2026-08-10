# Skills

## Overview

Skills implement the [Agent Skills specification](https://agentskills.io/specification) using `.agents/skills/<skill>/SKILL.md`. The model receives a compact metadata catalog and activates full instructions only when relevant; skills can be disabled per project, per chat, or individually.

## Usage

Create a conformant skill:

```markdown
---
name: testing
description: Run and diagnose project tests. Use when changing code or investigating failures.
---

# Testing

Run the narrowest relevant tests first, then the full suite.
```

Save it as `.agents/skills/testing/SKILL.md`. Optional `scripts/`, `references/`, and `assets/` directories may sit beside it.

Open **Settings → Project → Agent files** to toggle all skills or enter disabled skill folder names, one per line. In a chat, the transcript shows a **Skills** card below tools and agent files; every discovered skill appears with a checkbox. Open **Tools** to see the same always-expanded Skills group. Toggling any available skill checkbox changes the chat-level skills on/off state without changing the project default.

Project settings use this shape:

```json
{
  "skills": true,
  "disabledSkills": ["legacy-skill"]
}
```

## Implementation notes

`src/agentSkills.js` parses required YAML frontmatter, rejects files without `name` or `description`, verifies safe project-contained paths, and exposes metadata through the system catalog. The dynamically registered `activate_skill` tool constrains names to available skills, returns body-only instructions with the skill root, and lists bundled resources without eagerly loading them.

Project `skills: false` is a master gate; chat `skills: false` disables skills for one chat. `disabledSkills` filters skills out of both the catalog and activation tool while regular agent files remain controlled by the file-name list and chat-level toggle. The UI currently exposes per-skill rows as checkboxes, but the persisted chat setting remains a family toggle; project-disabled skills render disabled with a reason.
