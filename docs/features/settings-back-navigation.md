# Settings back navigation

## Overview

Every page under **Settings** has a Back arrow in its header, and every page that belongs to a project is part of a drill-down: the project card (or Settings → Projects) opens **Project settings**, which links to **File tool options**, **Web preview**, **Technical details**, **Hide file content**, **MCP servers**, **Custom prompts**, **Custom actions**, and **Agents** — and each of those links onward again. Back navigation is what makes that safe to explore: at any depth, one or two taps return you to where you started, without re-finding the project or the chat.

## Usage

The Back arrow points at whichever page you actually came from, most specific first:

| You opened the page from | Back goes to |
|---|---|
| A chat (its header gear, or any project page reached from a chat) | that chat |
| Project settings | project settings (keeping the project) |
| Settings → Projects | the registered-projects list |
| The Chats tab's project card | the Chats tab |
| Settings → App defaults (MCP servers, Custom prompts, Custom actions) | the Settings root |

Two examples, both from a phone:

1. **Chat → project settings → File tool options → back → back** returns to the chat. The header gear on a chat opens `#/settings/project?projectDir=…&chatId=…`; that `chatId` rides through every sub-page, so the second Back knows which chat to reopen.
2. **Settings → MCP servers (app defaults) → Add → Back** returns to the app-wide server list. The list is a project-less page, so its links stay project-less instead of silently adopting the active project.
