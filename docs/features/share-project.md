# Share a project with another mouaif

## Overview

Share a project from the mouaif that has its folder, and add it on another mouaif. A folder on your home computer can then be used from a public mouaif, and from a phone anywhere.

- **The project runs on the machine that has the folder.** Chats, the agent loop, tools, files, git, hooks, MCP servers and skills all stay there.
- **The mouaif you use supplies the models.** Through the mouaif it was added on, a shared project uses that mouaif's providers and subscriptions, so the sharing machine needs no provider at all. Opened directly on the sharing machine, the project uses that machine's own providers.
- The sharing machine always dials out, so nothing is opened on its network. The other mouaif must be reachable at the address you type.

Both mouaifs must run with [app access](authentication.md) (`--auth`) and an account set up.

## Usage

### Share a project (on the mouaif that has the folder)

1. On the project card, open the **⋯** menu and choose **Share project**.
2. Enter the address of the other mouaif, or tap one you used before. A bare host name means `https://`. A LAN address, `localhost` or a `.local` name means `http://`.
3. Choose what the share allows:
   - **Files only**: chats, files and git history. The shell, the terminal, project commands, MCP servers, hooks and scheduled or webhook turns are off.
   - **Files and shell**: also the shell, the terminal and project commands, within the project's own tool settings.
4. Tap **Share**. The first time with a new address, the sheet shows a short code, for example `K7QD-3XPA`. It expires after 15 minutes. **Show a new code** makes another one.

The same sheet lists the project's shares with their state (**Waiting to be added** or **Added**), lets you change what a share allows, and has **Stop sharing**.

### Add the shared project (on the other mouaif)

1. Tap **+** (Add project), then **Shared with me**.
2. The pending share is listed with the project name, its path and the machine name. The first time, type the code shown on the sharing machine.
3. Tap **Add**. The project appears in the project list with a **Shared from &lt;machine&gt;** label.

### After that

- Later shares between the same two mouaifs need no code. You still tap **Add**.
- **Stop sharing** on the sharing machine removes the project from the other mouaif at once. **Remove shared project** in the card's **⋯** menu, on the other mouaif, does the same from that side.
- When the sharing machine is off, the card shows **offline** and its chats cannot be read. It comes back on its own when the machine reconnects.
- The cost on a shared card is what the adding mouaif's providers were billed for that project.
- The project count at the top of the list includes shared projects.

There is no start flag and no separate machines page. The connection between two mouaifs is created by the first share, kept for later ones, and closed when the last share between them stops.

### What works through a share

| Works | Not through a share |
| --- | --- |
| Chats, streaming, subagents, re-entry into a running chat | App settings, providers, accounts, sign-in, restart |
| Files (editor, image preview), git history | Browsing folders, other projects |
| Project settings, prompts, agents, tool permissions | Inspector and its WebSocket, web preview of the sharing machine's `localhost` |
| Shell, terminal, git commit, project commands, MCP servers (**Files and shell** only) | MCP Apps, project tags |

## Borrowed providers

A chat of a shared project, used from the mouaif it was added on, never needs a provider on the sharing machine:

1. The sharing machine runs the turn as usual, up to the provider call.
2. It sends the provider-neutral inputs over the connection: the model id and provider, the messages, the tool list, the thinking level and the output cap.
3. The adding mouaif checks that it offers that model (one of its configured models, or one in its provider's live model list), builds the request with its own credentials (refreshing an OAuth token if needed), calls the provider, and pipes the raw answer back.
4. The sharing machine parses the stream with the same parser it uses for its own providers.

- Cancelling a run, or the 3-minute idle timeout, cancels the provider call on the adding side. If the connection drops, both sides stop.
- A model the adding mouaif does not offer is refused with `EMODEL_NOT_OFFERED`. So the connection cannot be used to sign arbitrary requests with its credentials.
- The adding mouaif records each call's tokens and cost. The sharing machine prices the chat with the same pricing the adding mouaif sent back, so both sides show the same cost.
- The model picker of a shared project lists the adding mouaif's models. Dictation also uses the adding mouaif's providers.

## Rules

- Sharing and adding both refuse to work unless app access (`--auth`) is on, with an account set up.
- First-time codes are single use, expire after 15 minutes, and are void after 5 wrong answers. Wrong codes also count against the sign-in attempt limit of the adding mouaif.
- After the first code, each side stores the other's public key (Ed25519). Every later connection proves both identities by signing fresh nonces. If the key at a known address changes, the sharing machine refuses to connect.
- A forwarded request passes an allowlist of project-scoped routes, then the share's access level, then the project filter. It must name the shared project, and every file path it names must stay inside the project, after resolving symlinks. Only then does a handler run.
- On the sharing machine, a forwarded request and everything it starts runs as a *share caller*:
  - Tools a **Files only** share does not allow are not offered to the model, and are refused if called anyway. The chat's Tools panel shows the same thing: those tools are not listed, read as off, and no MCP server is shown.
  - `restart_app`, `list_projects` and app-scoped settings are refused on every share.
  - `change_working_folder` must stay inside the project.
- The sharing machine shows a push notification when one of its shares is added.
- The connection never carries provider credentials.

## Limits

- The adding mouaif sees chat content, because it makes the provider calls.
- Chat history lives on the sharing machine. When that machine is off, the chats cannot be read from the other mouaif.
- Scheduled wake-ups and webhook turns of a shared chat run on the sharing machine later, outside the request. They use the sharing machine's own providers.
- The `search_models` tool lists the sharing machine's provider catalogs, not the adding mouaif's.
- If the same folder path is already a registered project on the adding mouaif, adding is refused (`ESHARE_DIR_CONFLICT`).
- Two home machines on different networks cannot share directly yet: the mouaif you add a project on must be reachable from the sharing machine. A live view of the sharing machine's browser is not available either.
