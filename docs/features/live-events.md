# Live events

## Overview

An open page learns that something changed from one event stream per tab, `GET /events`, instead of asking the server on a timer. The server sends a small notice when a store changes: a chat's rows, a run starting or ending, an approval being parked or answered, a hook or extension being trusted, a share being accepted. The page then fetches what changed with the endpoints it already uses, so a page that sits open sends no requests.

Changes made outside any stream reach the page this way:

- a tool call or result written while another tab or device runs the chat;
- a run started in another tab or on another device;
- a background subagent's events and result, written after its turn ended;
- an approval answered in another tab, whose card then goes away here.

The bars and panels around the chat follow the same notices instead of their own timers:

| What you see | Updates when |
|---|---|
| Hooks and extensions bar ("this project defines hooks") | a hook or extension is trusted, turned on or off, or a turn ends |
| Extension views in the chat, and the App context bar | an extension changes, a view gives context, a prompt carries it |
| The chat's Hooks, Webhook and Run bars | their hooks, webhook calls or run change, or a turn ends |
| The `@` list and the file chips under the composer | a turn ends, or an extension or hook changes (typing `@` always rescans) |
| Share sheet, **Shared with me**, shared project cards | a share is accepted, stopped or changed, or the other mouaif goes on or offline |
| MCP sign-in status in Settings | a sign-in finishes in another window |
| The "new version" banner | the server restarts (a new version only ships with a restart) |

Every view also refreshes when the tab is shown again. A file changed outside any chat while a view is on screen (in an editor, by `git pull`) shows the next time a turn ends or the page comes back.

A project added from another mouaif works the same way: its events come through the share, and only events about that project are sent.

Live chat output is not part of this stream: the text, tool output and approval cards of a running turn still arrive over the turn's own stream ([live tool preview](live-tool-preview.md)).

## Usage

Nothing to set up. Open the same chat in two tabs or on two devices: a row written by either one, or by a background subagent, appears in the other at once.

If the stream cannot be opened at all, for example behind a proxy that buffers `text/event-stream`, the chat shows **Live updates unavailable — showing saved state** under the composer and refreshes every 15 seconds while the page is visible. The note goes away when the stream connects again.
