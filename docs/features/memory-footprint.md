# Memory footprint and payload size

## Overview

mouaif runs as a long-lived server, often on a small box or next to other dev tools, and its UI is usually opened on a phone over a mobile link. The server loads optional subsystems only when they are first used, keeps its in-memory tables bounded, and prunes stale entries from them.

## Usage

Nothing to configure. The effects are:

- An idle `mouaif serve` starts with about 35% fewer loaded modules and a smaller resident set.

## Related

- [Chat load performance](./chat-load-performance.md) — how long chats open quickly.
