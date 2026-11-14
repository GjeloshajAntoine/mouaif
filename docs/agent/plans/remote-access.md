# Remote access — implementation plan

## Overview

Two actions: **share a project** from the mouaif that has the folder, and **add that shared project** on another mouaif. A folder on a home computer can then be used from the public mouaif, and from a phone anywhere.

This is a proposed sequence, not permission to add dependencies, open ports, change deployment or restart the running app. Nothing here is built yet. Items marked **(verify)** are assumptions that have not been checked against the code.

## What the user does

### Share a project (on the mouaif that has the folder)

1. Project card `⋯` menu → **Share project**.
2. Enter the address of the other mouaif, or pick one used before.
3. Choose what the share allows: files only, or files and shell.
4. The first time with a new address, a short code is shown.

### Add the shared project (on the other mouaif)

1. **+ Add project** → **Shared with me**.
2. The pending share is listed with the project and machine name. The first time, type the code shown on the sharing side.
3. Tap **Add**. The project appears in the project list, marked as shared, with the machine name.

### After that

- Later shares between the same two mouaifs need no code.
- **Stop sharing** in the same `⋯` menu removes the project from the other mouaif at once.
- A shared project shows as offline when the sharing machine is off.

There is no start flag, no mode, and no separate "machines" page. The connection between the two mouaifs is created by the first share and kept for later ones.

## The model

**A shared project runs entirely on the machine that holds its folder. Only its AI calls go out through the mouaif where it was added.**

| | Mouaif where the project was added | Sharing machine |
| --- | --- | --- |
| Subscriptions, credentials, model list, cost | yes | none needed |
| Sends the request to the AI provider | yes | hands it over the connection |
| Agent loop, tools, shell, files, git, hooks, MCP, skills | no | yes, existing code |
| Chats and project settings | no | stored here |
| The screen the user works in | yes | also works directly |

The mouaif being used supplies the models. Through the adding mouaif, a shared project uses the adding mouaif's providers. Opened directly on the sharing machine, it uses that machine's own, so the sharing machine needs providers only if it is also used directly.

### Why the cut is at the AI call

- `projectDir` is treated as a local path in about 70 server modules (settings, skills, hooks, artifacts, attachments, git, MCP, chat working folder). Running the agent on the adding side and only the tools on the sharing machine would mean a remote version of each, and a round trip per file read.
- The chat request to a provider leaves from one `fetch` (`src/ai-stream.js`, the `fetch(req.url, …)` call), and model lists from `src/ai-endpoints.js`. That is a narrow seam.

### What this gives up

- Chat history lives on the sharing machine. When it is off, the chats cannot be read from the other mouaif.
- The mouaif where the project was added sees chat content, because it makes the AI calls.

## Who connects to whom

The sharing machine always dials out, so nothing is opened on its network. The other mouaif must be reachable at the address typed in the share sheet.

| Situation | Extra server | Path |
| --- | --- | --- |
| Local shares to a public mouaif | none | local dials out to the public one |
| Two locals, same network | none | direct, using the LAN address |
| Two locals, different networks | one public mouaif to introduce them | WebRTC direct path; the public mouaif forwards when that fails (phase 3) |
| Phone away from home | the public mouaif it loads the app from | through the public mouaif, then direct (phase 3) |

No third-party tunnel or VPN tool is wrapped. The public mouaif does signalling, address discovery and fallback forwarding itself, so no separate STUN or TURN server is required.

## Phases

| Phase | Work | Outcome |
| --- | --- | --- |
| 1 | Share, add, forwarding | A local project is shared to and used from the public mouaif, with the local's providers |
| 2 | Borrowed providers | The shared project uses the public mouaif's subscriptions; the local needs none |
| 3 | WebRTC direct path | Sharing between two locals on different networks; the phone talks straight to the local |
| 4 | Live view | Video of the host's debug Chrome on the same connection |

Phase 1 is usable on its own. Phase 2 is what makes the model above true. Phases 3 and 4 are independent of each other.

## Phase 1 — share and add

### 1.1 Connection

- New `src/share.js`: the sharing machine opens a WebSocket to `wss://<address>/api/share`; the other mouaif accepts it in the `server.on('upgrade')` router in `src/http-server.js`, next to the inspector route. Load `ws` lazily, as the inspector does.
- Framing: multiplexed streams over one socket (request, response head, body chunks, end, abort), so SSE and long downloads do not block each other. Carry a protocol version and refuse a mismatch with a clear message.
- One connection per pair of mouaifs, carrying all projects shared between them. Stored in the app SQLite store and reopened on start, with backoff.
- The connection closes when the last share between the two is stopped.

### 1.2 First-time code

- The sharing machine shows a short one-time code; the other side types it when accepting (reuse the 15-minute setup-code pattern from `src/access-auth.js`). Both then store a long-lived key pair.
- Later connections and later shares authenticate with the key.
- Rate-limit code attempts with the existing access-attempt tracking.

### 1.3 Forwarding

- Route `/s/<share>/…` on the adding side: strip the prefix, send the request over the connection, stream the answer back. Covers REST and SSE.
- On the sharing machine, forwarded requests enter the normal route table as an authenticated "share" caller, not as a browser session. They pass an **allowlist of project-scoped routes**: no access, provider, credential, restart or app-settings endpoints.
- Every forwarded request is checked to belong to the shared project before it reaches a handler. The other mouaif cannot browse folders or see unshared projects.
- "Files only" shares refuse shell, terminal and command-running routes and tools. **(verify)** that the tool authorization gate can enforce this per caller.

### 1.4 Frontend

- Share sheet from the project card menu (address, allowed access, code, stop sharing). Bottom sheet, mobile first, 360 px.
- **Shared with me** entry in the add-project flow, with pending shares and the code field.
- A shared project carries its share id. One helper in `frontend/src/api.js` prefixes its project-scoped calls with `/s/<share>`; the handful of call sites that build `/api/…` URLs outside `api.js` (raw `fetch`, `EventSource`, image `src`) move to it.
- Project card: a "shared from <machine>" label and an offline state.

### 1.5 Rules

- Sharing and adding both refuse to work unless app access (`--auth`) is enabled on that mouaif.
- A push notification on the sharing machine when a share is accepted.
- Stopping a share takes effect immediately on both sides.

### 1.6 Tests

- Unit: framing, first-time code, allowlist, project filter, files-only restriction.
- End to end: two servers (one sharing, one adding) in one Node test process, no extra container.

## Phase 2 — borrowed providers

1. The sharing machine sends the provider-neutral inputs; the adding side runs `buildRequest` with its own credentials. `parseEvent` keeps running unchanged on the sharing machine.
2. Endpoint on the adding side over the connection: take the request, resolve credentials (including token refresh in `src/auth.js`), call the provider, pipe the raw stream back. Abort and idle-timeout signals cross the connection in both directions.
3. Model picker and model list for a shared project come from the adding mouaif.
4. Usage and cost are recorded on the adding mouaif and shown on both sides.
5. Other provider calls that need the same hand-over **(verify each)**: the Codex path (`src/ai-codex.js`), transcription (`src/server-handlers-transcribe.js`), subagents and subagent image generation, the search engine tool.
6. Tests with a fake provider on the adding side and no provider on the sharing machine.

## Phase 3 — WebRTC direct path

- Sharing between two locals on different networks: the share sheet takes a public mouaif both already share with, which introduces them. Signalling rides the existing connections; the public mouaif answers address discovery on one UDP port and forwards when no direct path exists.
- The server side needs a WebRTC stack: `node-datachannel` (native, prebuilt) or `werift` (pure JS). Decide with a spike that measures install size and idle memory; load it only when a direct path is attempted. Adding the dependency needs approval.
- Mouaif to mouaif: the same framing as 1.1 over a data channel, end-to-end encrypted with the stored keys. A mouaif that only forwards cannot read it.
- Browser to sharing machine: the page opens a data channel in the background; each request uses it when up and the public mouaif when not. Start with the chat stream and the terminal.
- Reconnect on network change (phone moving between Wi-Fi and mobile data).

## Phase 4 — live view

- The debug Chrome on the sharing machine is the video source and WebRTC peer, so Node needs no encoder. Signalling goes through mouaif.
- Shown in the web preview and inspector as an alternative to screenshots.
- Later: microphone audio to the host for dictation.

## Security checklist

- Both sides require app access; first-time codes are single use and expire.
- Forwarded requests hit an allowlist and the project filter before any handler.
- The connection never carries provider credentials; in phase 2 they stay on the adding mouaif.
- Stop sharing works from either side.
- Browser end-to-end encryption through a forwarding mouaif protects against one that reads traffic, not one that serves altered app code. With a self-hosted one this is the trust already given to the reverse proxy.

## Commits and docs

One Conventional Commit per feature, each with its doc in the same commit:

- `feat(share): share a project with another mouaif` — `docs/features/share-project.md`
- `feat(share): add a shared project and forward its requests`
- `feat(share): files-only shares`
- `feat(ai): shared projects use the adding mouaif's providers`
- `feat(share): direct path over WebRTC`
- `feat(preview): live view of the host browser`

Add the `docs/README.md` entry with the first one.

## Open decisions

1. WebRTC library, and whether a native dependency is acceptable.
