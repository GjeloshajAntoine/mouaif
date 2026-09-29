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

Descriptions may use YAML block scalars and comments:

```yaml
name: testing # matches the directory name
description: >-
  Run and diagnose project tests.
  Use when changing code or investigating failures.
```

The dependency-free reader supports plain and quoted strings, inline comments, literal (`|`) and folded (`>`) blocks (including chomping/indentation indicators), and a shallow string-valued `metadata` map. Unsupported constructs (such as flow collections, aliases, tags, or multiline plain/quoted strings), malformed quoting, duplicate keys, and invalid indentation cause the skill to be skipped rather than advertised with corrupted metadata.

Open **Settings → Project → Tools** to toggle skills on or off. Off locks skills out of every chat; on lets each chat opt out.

In a chat, the transcript shows a **Skills** card below tools and agent files. Every discovered skill has its own checkbox:

- Unchecking one skill switches **only that skill** off for this chat. The other skills stay on, the project setting is untouched, and the choice is stored on the chat record, so it survives a reload.
- Checking a skill switches it back on for this chat, again without touching its siblings.
- Changes appear immediately in both the transcript card and the popup. Quick successive taps save in order; a failed save restores the last saved selection. After saving, both surfaces reconcile with the server's effective state, including prompt presets.
- A chat whose skills are off shows every row unchecked. Checking any row turns the chat's skills back on with that one skill selected.

The **Tools** popup (globe icon in the chat top bar) shows the same always-expanded **Skills** group. There the group checkbox is the explicit all-on / all-off shortcut for the chat, while each row is that one skill's switch.

Custom prompt presets use the same effective skill setting for the metadata catalog, activation tool, and activation result. Delegated subagents inherit that setting and this chat's individual skill opt-outs; they cannot reactivate a skill unchecked in the parent chat. The project-level off switch always wins.

Skill activation is controlled by the **Skills** switches independently of the ordinary tool selection: unchecking Shell or File tools (even unchecking every ordinary tool) does not disable checked skills. An agent's explicit tool allowlist still restricts its delegated run; include `activate_skill` there if that agent should load skills.

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

## Implementation notes

`src/agentSkills.js` owns discovery and activation. The streaming handler passes the preset-resolved chat into the AI loop and delegated runs. The Skills UI shares response normalization and an ordered save queue in `frontend/src/components/chat/skillState.js`.

Run focused parser, streaming, and UI regression coverage with:

```bash
npm run test:skills
```
