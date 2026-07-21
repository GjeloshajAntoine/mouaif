# Agents

## Overview

Agents are named project personas stored as Markdown under `.agents/agents/<name>/AGENT.md`. A chat can select one agent to inject its instructions into the upstream system context, and the `subagent` tool can target an agent for focused delegated work.

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

Set `agentId` on a chat with the existing chat patch endpoint:

```http
PATCH /api/chats/<chatId>
Content-Type: application/json

{ "projectDir": "/path/to/project", "agentId": "reviewer" }
```

Use `null` or an empty string to clear the chat agent.

### List agents

```http
GET /api/agents?projectDir=/path/to/project
```

Response:

```json
{
  "agents": [
    { "name": "reviewer", "title": "Reviewer", "size": 119 }
  ]
}
```

Read one agent:

```http
GET /api/agents/reviewer?projectDir=/path/to/project
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
- The `list_features` tool reports `{ agents: { selected, discovered } }` so the model can inspect available agents.
- Source: `src/agents.js`, `src/index.js`, `src/ai.js`, `src/tools/subagent.js`.
