# Hooks and extensions: remaining issues

## Overview

These issues are left over from the hooks and extensions performance work of 1 November 2026. The measured results are on the [Hooks and Extensions Cost](https://claude.ai/artifact/GfDUE1FYPJUxwdoUdNPSPg) page (private until shared).

Issues are in priority order. Each status says how far it has been checked:

- **Reproduced:** seen happening in a running app.
- **Measured:** the cost was measured, and a fix is a judgement call.
- **Code reading only:** not yet tested.

## Issues

### 1. Project extensions may run a changed script for up to 2 seconds

**Status:** fixed. A test reproduced it: the changed script ran. `runtimeHooks` now reads project files and their trust on every lookup, and `scripts/test-extensions.js` fires a hook straight after the edit. App extensions keep the cache.

### 2. Extension views fail when only the app port is published

**Status:** fixed. Every view now uses the same-port sandbox route, and the separate listener is gone, so a Docker install only publishes the app port. Checked in Chrome on `127.0.0.1:5732` and on the plain-HTTP container IP. See decision 40 in `docs/decisions.md`.

### 3. `test-chat-working-folder.js` stops early

**Status:** reproduced, with and without the performance fixes.

`scripts/test-chat-working-folder.js:61` expects the `change_working_folder` tool description to contain "never creates a folder", and it doesn't. The test stops there, so the rest of the file's checks don't run.

**Next steps:**

1. Decide whether the description or the test is wrong, and fix that one.
2. Run the whole file, since later checks may also fail.

### 4. An open extension view costs about 9.5 MB of JS heap

**Status:** measured.

A one-line dock adds about 1.1 MB to the page heap and 8.38 MB in its own frame. Most of that is probably the inlined 418 KB MCP Apps SDK (`src/instant-mcp-apps.js:43`), but this hasn't been confirmed with a heap snapshot. The frame's total process memory wasn't measured.

**Next steps:**

1. Take a heap snapshot of the frame to see what holds the memory.
2. Measure the frame's process memory, since that matters most on a phone or small host.

### 5. API responses aren't compressed

**Status:** measured for size; the gain from compressing isn't measured.

`sendJSON` (`src/server-shared.js:115`) never compresses. Opening a 2,000-row chat transfers about 1.9 MB across 20 `/api/chats/:id/messages` requests. Only MCP App mount responses are compressed so far.

**Next step:** measure compressing large responses. Check the CPU and memory cost on a small host, as `src/server-web-static.js` warns that each compressor allocates several MB.

### 6. An idle chat makes 72 requests a minute

**Status:** measured.

| Requests per minute | Routes |
| --- | --- |
| 20 | `/api/chats/:id/revision` |
| 12 each | `/api/agents`, `/api/actions`, `/api/projects/registered` |
| 4 each | `/api/chats/:id/hooks`, `/api/chats/:id/webhook` |
| 2 each | `/api/extensions/surfaces`, `/api/extensions`, `/api/hooks/project`, `/api/chats/:id/run` |

About 63 of these existed before hooks. The server's `broadcast` could replace some of the polling.

**Next step:** start with `/api/agents`, `/api/actions` and `/api/projects/registered`, which change rarely and account for half the requests.

### 7. Remaining hook cost on each tool call

**Status:** measured; estimated from a CPU profile.

Hooks still add about 365 µs to each tool call, even with none configured. About 180 µs of that is `fingerprint` (`src/projectHooks.js:125`), which must not be replaced with a time-based cache (see issue 1). `getConfig` takes about 70 µs and chat hook lookups about 50 µs.

**Next step:** make `fingerprint` cheaper without skipping its checks. This is low priority, because real tool work is usually far slower.

### 8. Hooks and extensions added 42 KB to the JS on every page

**Status:** measured.

The JS loaded on every page grew from 721.4 KB to 763.5 KB uncompressed, or 10.4 KB more as transferred. Most users pay this whether or not they use either feature.

**Next step:** see whether the dock, sheet and project hook bar code can load only when needed. The dock and context bar always mount in a chat, so this may save little.

## Before committing the performance fixes

- `src/ai-stream.js`, `frontend/src/components/chat/ExtensionDocks.jsx` and `scripts/test-extensions.js` hold both the fixes and other uncommitted work. Separate them for a clean commit.
- The full `npm test` hasn't been run, only the suites around the changed code.
- Prod keeps its old server code until it's restarted.
- The test app doesn't have the fixes until `mouaif-app:latest` is rebuilt.
