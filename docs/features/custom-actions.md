# Custom actions

## Overview

Custom actions are project-scoped shortcuts that run a saved CLI command or MCP tool without a model round-trip. They are stored in the project’s `customActions` setting and remain protected by the underlying Shell or MCP authorization mode.

## Usage

Open **Project settings → More settings → Custom actions**, then add an action.

### CLI action

Choose **CLI**, give the action an ID, and enter a non-interactive command. The command runs with the project folder as its working directory.

```json
{
  "customActions": [
    {
      "id": "test",
      "label": "Run tests",
      "description": "Run the project test suite",
      "kind": "cli",
      "command": "npm test",
      "timeoutMs": 120000
    }
  ]
}
```

### MCP action

Choose **MCP**, select a configured server and tool, then edit the prefilled JSON arguments. The editor builds the initial object from the tool’s input schema, using declared defaults, examples, or enum values when available and type-appropriate placeholders otherwise.

```json
{
  "customActions": [
    {
      "id": "open-issues",
      "label": "List open issues",
      "kind": "mcp",
      "serverId": "github",
      "toolName": "list_issues",
      "args": {
        "state": "open"
      }
    }
  ]
}
```

### Run an action

From a chat in that project:
- Tap the **file-toolbar** button (the stacked arrow/folder icon) left of the textarea and pick the action by name. Compact action rows appear first and show only the action name, without an icon, section heading, or type metadata.
- Type `@test` as the complete composer message. Pressing Enter runs the exact action even when a similarly named file is the first autocomplete result or the composer setting normally uses Enter for a newline; Shift+Enter still inserts a newline. The autocomplete refresh keeps this direct-dispatch list current, so newly created actions work without reopening the chat.
An action uses its saved command or arguments. Ad-hoc arguments after the `@action-id` are not accepted. MCP action failures surface the server's returned text in the composer status instead of a generic error.
