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


Run the narrowest relevant tests first, then the full suite.
```

Save it as `.agents/skills/testing/SKILL.md`. Optional `scripts/`, `references/`, and `assets/` directories may sit beside it.

Open **Settings → Project → Skills** to toggle skills on or off. In a chat, the transcript shows a **Skills** card below tools and agent files; every discovered skill appears with a checkbox. Open **Tools** to see the same always-expanded Skills group. Toggling any available skill checkbox changes the chat-level skills on/off state without changing the project default.

Project settings use this shape:

```json
{
  "skills": true
}
```
