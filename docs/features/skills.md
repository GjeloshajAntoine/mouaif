# Skills

## Overview

Skills are reusable project instructions stored as `.agents/skills/<skill>/SKILL.md`. They are injected as separate system messages and can be disabled globally per project, per chat from the Tools popup, or individually in Agent files settings.

## Usage

Create a skill:

```text
.agents/skills/testing/SKILL.md
```

Open **Settings → Project → Agent files** to toggle all skills or enter disabled skill folder names, one per line. In a chat, open **Tools** and toggle the Skills group without changing the project default.

Project settings use this shape:

```json
{
  "skills": true,
  "disabledSkills": ["legacy-skill"]
}
```

## Implementation notes

`src/agentSkills.js` discovers and loads skill files with a 64 KiB limit per file. Project `skills: false` is a master gate; chat `skills: false` disables skills for one chat. `disabledSkills` is applied by folder ID while normal agent files remain enabled.
