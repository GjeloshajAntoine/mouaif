# Built-in skill: mouaif config

## Overview

`mouaif-config` is a skill that ships with the app, so every project has at least one skill without the user writing one. It teaches the assistant to read and change a project's configuration through the normal settings tools — the same values the Settings tab edits — instead of guessing at `.mouaif.json` keys or hand-editing the file.

## Usage

Nothing to install. Open a chat and ask in a normal sentence:

```text
Set this project's prompt size to extensive.
Add a model for this project that uses my OpenRouter connection.
Turn the shell tool off for this project.
Which provider serves my default model here?
```

The assistant activates the skill, reads the current state with `get_settings`, and writes the change with `update_settings`.

The skill is an ordinary skill for every other purpose:

- It appears in the chat's **Skills** card and in the **Tools** popup, and can be switched off per chat like any other skill.
- **Settings → Project → Tools → Skills** switches skills off for the whole project, this skill included.
- A project that ships its own `.agents/skills/mouaif-config/SKILL.md` **replaces** the bundled one, so a team's own house rules win. Other project skills are unaffected.

## What it covers

| Area | Covered |
| --- | --- |
| Settings layers | defaults → app → project, and which key lives where |
| Prompt behavior | prompt-size profile, custom prompts, per-chat profile |
| Providers and models | provider ids, project models, which providers are key-based versus plan sign-ins |
| Agents | subagent personas in `agents` / `defaultAgent` |
| Tool authorization | the `shell`, `file`, `chats`, `mouaif` and `subagent` gates, `off` / `ask` / `allow`, per-tool overrides, and which keys always need approval |
| MCP | that servers are configured in the app, and how their tools are gated |

## Limits

Two boundaries the skill states explicitly, because both would otherwise lead to a confident wrong answer:

- **Credentials.** Writing or re-authenticating a provider — including the OAuth and plan-based sign-ins — is something you do in **Settings → Providers**. Ask the assistant to connect a provider and it will send you there instead of handling the secret.
- **Lists are replaced, not merged.** Changing the project's models, prompts, tags, custom actions or agents writes the whole list back, so entries are never lost by a partial update.

## Keeping the list honest

The skill repeats the settings keys, provider ids and tool gates that the app defines elsewhere, so it can go stale. When a new gate, tool or provider lands, that list needs the same update.

## Related

- [Skills](./skills.md) — the skill format, discovery, and per-chat opt-outs.
- [Native chat and app tools](./mouaif-tool.md) — `get_settings` and `update_settings` and the rest of the app tools.
- [App and project settings](./app-and-project-settings.md) — the settings layers and where each store lives.
