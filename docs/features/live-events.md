# Live events

## Overview

An open page learns that something changed from one event stream per tab, `GET /events`, instead of asking the server on a timer. The server sends a small notice when a store changes: a chat's rows, a run starting or ending, an approval being parked or answered. The page then fetches what changed with the endpoints it already uses.

Changes made outside any stream reach the page this way:

- a tool call or result written while another tab or device runs the chat;
- a run started in another tab or on another device;
- a background subagent's events and result, written after its turn ended;
- an approval answered in another tab, whose card then goes away here.

A project added from another mouaif works the same way: its events come through the share, and only events about that project are sent.

Live chat output is not part of this stream: the text, tool output and approval cards of a running turn still arrive over the turn's own stream ([live tool preview](live-tool-preview.md)).

## Usage

Nothing to set up. Open the same chat in two tabs or on two devices: a row written by either one, or by a background subagent, appears in the other at once.

If the stream cannot be opened at all, for example behind a proxy that buffers `text/event-stream`, the chat shows **Live updates unavailable — showing saved state** under the composer and refreshes every 15 seconds while the page is visible. The note goes away when the stream connects again.
