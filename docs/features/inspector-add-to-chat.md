# Add Inspector entries to a chat

## Overview

The Inspector's detail sheet — the panel that opens when you tap a console log, an uncaught exception, or a network request — has an **Add to chat** button. It copies that entry into a chat draft as plain text, so you can ask the assistant about a specific failure without retyping the message or the stack trace. Nothing is sent: the text lands in the draft and waits for you.

## Usage

1. Open **Inspector** and attach to a browser tab.
2. Tap a row in the **Console** or **Network** panel. The detail sheet opens.
3. Tap **Add to chat** in the sheet's header, next to **Close**.
4. Choose the **project** and **chat**, then tap **Add to draft**.

The entry is appended to that chat's draft. Open the chat to review and send it.

## Behavior

- **Add to chat** only appears when the app has a chat surface to hand the entry to. Otherwise the button is rendered but disabled, so the feature is never invisible — just unavailable.
- The button is also disabled when the entry produces no text (a request row captured before its response still produces a header).
- The button lives in the sheet **header**, not the scrolling body, so a long stack trace or response body cannot push it off screen.
- The draft is **appended**, never replaced: existing draft text and attachments are preserved.
- The chat is not opened and no model run is started. Draft Craft never sends.

### What the text looks like

Console log and exception entries:

```text
Inspector console error — My Page
18:42:11 ERROR Error: nope
Source: http://x/app.js:12
Stack:
  at f (app.js:12:4)
```

An uncaught exception is titled `Inspector exception` rather than `Inspector console error`.

Network requests:

```text
Inspector request POST 404 — My Page
http://x/api
XHR · application/json · 2.0 KB · 120 ms
```

A request that failed to complete adds its cause:

```text
Inspector request GET FAIL — My Page
http://x/api
Error: net::ERR_FAILED
```

The page name is the inspected page's `document.title`, falling back to its URL, then to `the inspected page`. An HTTP status's own text (`Not Found`) is not labelled an error — the status is already in the header — while a transport failure's `errorText` is.

## Related

- [Draft Craft](draft-craft.md) — the shared project/chat picker and the annotator.
- [Inspector](inspector.md) — the panel set and the detail sheet.
- Source: [entryText.js](../../frontend/src/components/inspector/entryText.js), [DetailSheet.jsx](../../frontend/src/components/inspector/DetailSheet.jsx), [Inspector.jsx](../../frontend/src/components/Inspector.jsx).
