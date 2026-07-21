# Agents

## Overview

Agents are named project personas stored as Markdown under `.agents/agents/<name>/AGENT.md`. Settings can choose a project default and associate each agent with a custom prompt and a skill selection. Every chat can keep that default or select a different agent; its effective instructions are applied on the next turn.

## Usage

### Create an agent

Create a directory below `.agents/agents/` and add an `AGENT.md` file:

```text
.agents/
  agents/
    reviewer/
      AGENT.md
```

Example:

```markdown
# Reviewer

You are a careful code reviewer. Look for correctness, security, and maintainability issues. Prefer concise bullet lists and cite file paths.
```

Agent names must match this pattern:

```text
[A-Za-z0-9][A-Za-z0-9._-]{0,63}
```

### Select an agent for a chat

Open **Settings → Agents** to choose the project default. In a chat, use the **Agent** card to keep the project default or select a chat-specific agent. The card summarizes the effective prompt and skill count.

The same selection is available through REST:

Set `agentId` on a chat with the existing chat patch endpoint:

```http
PATCH /api/chats/<chatId>
Content-Type: application/json

{ "projectDir": "/path/to/project", "agentId": "reviewer" }
```

Use `null` or an empty string to clear the chat agent.

### Configure an agent

Open **Settings → Agents**. For each discovered agent you can choose:

- A custom prompt from project prompts.
- All skills or an explicit selection from `.agents/skills/*/SKILL.md`.

Configuration is stored in `.mouaif.json` under `agentConfigs` keyed by agent name.

### List agents

```http
GET /api/agents?projectDir=/path/to/project
```

Response:

```json
{
  "defaultAgentId": "reviewer",
  "agents": [
    { "name": "reviewer", "title": "Reviewer", "size": 119, "config": { "promptId": null, "tools": null, "selectedSkills": null } }
  ]
}
```

Update the project default:

```http
PUT /api/agents/default?projectDir=/path/to/project
Content-Type: application/json

{ "agentId": "reviewer" }
```

Read one agent:

```http
GET /api/agents/reviewer?projectDir=/path/to/project
```

Update an agent config:

```http
PUT /api/agents/reviewer/config?projectDir=/path/to/project
Content-Type: application/json

{ "promptId": "prompt-1", "selectedSkills": ["testing"] }
```

### Use an agent with `subagent`

The native `subagent` tool accepts an optional `agent` argument:

```json
{
  "task": "Review the staged changes for regressions.",
  "agent": "reviewer"
}
```

When present, mouaif injects that agent's `AGENT.md` into the nested model call before the delegated task.

## Implementation notes

- Agent discovery is read-only. mouaif does not create, edit, or delete agent files.
- Each `AGENT.md` is capped at 64 KiB before injection and gets a truncation note when capped.
- The first Markdown H1 becomes the display title; otherwise the directory name is used.
- Selected agents are injected after root agent files (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`) and before agent skills.
- Resolution order is `chat.agentId` → project default → no agent. Unknown or removed agent names are ignored.
- For prompt and skills, explicit chat values win, followed by the selected agent configuration, then an optional preset.
- Agent config is project-scoped in `.mouaif.json` under `agentConfigs`; it never edits the agent Markdown file.
- The `list_features` tool reports `{ agents: { selected, discovered } }` so the model can inspect available agents.
- Source: `src/agents.js`, `src/index.js`, `src/ai.js`, `src/tools/subagent.js`.
