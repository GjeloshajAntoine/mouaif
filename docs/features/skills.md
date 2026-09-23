# Skills

## Overview

Skills implement the [Agent Skills specification](https://agentskills.io/specification) using `.agents/skills/<skill>/SKILL.md`. The model receives a compact metadata catalog and activates full instructions only when relevant; skills can be disabled per project, per chat, or one skill at a time inside a chat.

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

Open **Settings → Project → Tools** to toggle skills on or off. Off locks skills out of every chat; on lets each chat opt out.

In a chat, the transcript shows a **Skills** card below tools and agent files. Every discovered skill has its own checkbox:

- Unchecking one skill switches **only that skill** off for this chat. The other skills stay on, the project setting is untouched, and the choice is stored on the chat record, so it survives a reload.
- Checking a skill switches it back on for this chat, again without touching its siblings.
- A chat whose skills are off shows every row unchecked. Checking any row turns the chat's skills back on with that one skill selected.

The **Tools** popup (globe icon in the chat top bar) shows the same always-expanded **Skills** group. There the group checkbox is the explicit all-on / all-off shortcut for the chat, while each row is that one skill's switch.

Project settings use this shape:

```json
{
  "skills": true
}
```

An individual skill can also be switched off for the whole project from `.mouaif.json` (no UI yet). Such a skill renders disabled with a reason in every chat.

```json
{
  "skills": true,
  "disabledSkills": ["pdf-processing"]
}
```
