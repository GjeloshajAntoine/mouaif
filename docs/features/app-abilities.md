# App abilities

## Overview

mouaif organizes AI-assisted work by project. Each project can have its own models, instructions, tools, agents, and chats while provider connections remain available across the app.

## Projects and chats

- Add an existing folder or create a folder from the **Chats** tab.
- Create multiple chats for each project and switch between them from the chat header.
- Pick and bookmark a model for each chat.
- Attach text files and images to a message.
- Use **Draft Craft** to add selected file code or an annotated Inspector image to any chat draft.
- Read streamed responses with Markdown, token usage, speed, and estimated cost.
- Rename, trace, or delete chats from the chat menu.

Unregistering a project removes it from mouaif without deleting the folder on disk.

## Coding tools

Open a project’s settings, then configure each tool as **Off**, **Ask**, or **Allow**. Use **Ask** when you want to review calls before they run.

### Shell

The model can run non-interactive commands in the project folder, inspect the output, make changes, and run another command. Calls appear in the chat with their live output.

You can also run a command yourself from the composer:

```text
/shell npm test
```

Commands that wait for terminal input are not supported. Use one-shot commands such as `npm test` or `node -e "console.log('ok')"`.

### Files

File tools let the model list, search, read, create, and edit files in the project. The Files toolbar also lets you inspect or edit text files and preview common image formats yourself.

### Git

Open the Git view from the file toolbar to inspect staged changes, unstaged changes, and recent commits, and to stage, commit, stash, pull, or push yourself. When the model runs git commands, it does so through the shell tool, and those calls appear in the chat like any other shell command.

### Tasks and progress

The model can create a task list and update progress while it works. Long operations can show a live progress bar in the transcript.

### Ask user

When the model needs a product choice or approval, it can present a structured question with selectable answers and a free-form note.

## Agents and skills

- **Agents** are named project personas that can handle delegated work with their own model and instructions.
- **Skills** are reusable instruction sets discovered from the project and enabled for a chat.
- **Agent instruction files** such as `AGENTS.md`, `CLAUDE.md`, and configured alternatives can provide project guidance automatically.

Configure these under the project settings. Delegated runs appear as expandable cards in the parent chat.

## MCP integrations

MCP connects additional tools, such as browser automation or external services.

1. Open **Settings → MCP servers**.
2. Add a server manually or browse the registry.
3. Enable it globally or for a project.
4. Set its authorization mode before using it in chat.

The Chrome Debug MCP can give the model access to the same debug browser used by the Inspector.

## Inspector

Use the **Inspector** tab to work with pages open in the configured debug Chrome:

- discover and select browser tabs;
- preview a page;
- read console messages;
- run JavaScript in the console;
- inspect network requests;
- navigate, reload, open, and close tabs.

Closing a browser tab requires confirmation.

## Prompts and model controls

Per-chat and per-project controls include:

- custom system prompts;
- prompt-size profiles;
- model selection and bookmarks;
- reasoning or thinking level when supported;
- maximum output tokens;
- tool visibility and authorization.

Use a smaller prompt profile to reduce context use, or an extensive profile when the model needs fuller guidance.

## Traces, notifications, and installation

- Enable tracing for a chat when you want an event history that can be exported or saved with the project.
- Enable browser notifications to follow long-running chats and respond to approvals while the app is in the background.
- Install the web app from a supported browser for an app-like mobile experience.

## Safety tips

- Keep shell and write-capable tools on **Ask** until you trust the workflow.
- Review commands and file changes before approving them.
- Use access authentication and HTTPS before sharing mouaif on a network.
- Keep API keys out of project files and chat messages; add them through **Settings → Providers**.

## Next steps

- [Getting started](./getting-started.md) — install, run, and complete first setup.
- [Authentication](./authentication.md) — provider sign-in and access-auth CLI examples.
