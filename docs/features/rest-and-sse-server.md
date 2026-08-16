# Assistant server & CLI

## Overview

mouaif runs as a local background process and CLI that hosts the mobile web interface, orchestrates AI provider requests, and manages real-time conversational streaming.

## Usage

Start the server using the default port (`5732`):

```bash
mouaif serve
```

### Options

```bash
mouaif serve --port 9000       # use a custom port
mouaif serve --watch           # restart automatically on local source changes
mouaif info                    # show package version and default port
```

Once running, open `http://127.0.0.1:5732/` in any browser on your machine or phone.

## Related

- [Chat UI](./chat-ui.md) — the web interface.
- [App and project settings](./app-and-project-settings.md) — configuration hierarchy and defaults.
