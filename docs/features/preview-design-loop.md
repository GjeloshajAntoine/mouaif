# Preview design loop

## Overview

The web preview viewer is where you iterate on a page's design: ask for a change without leaving the viewer, watch the preview refresh when the agent finishes, and compare the new capture with the earlier ones. It builds on the [Web preview tool](./webpreview.md) and is mobile first: everything works with one thumb on a 360–430 px phone.

## Usage

1. Get a preview into the dock: the agent calls `webpreview`, or you use **File tools → Preview**.
2. Tap the dock to open the viewer.
3. Type in the **prompt bar** at the bottom ("Make the Sign up button bigger") and tap the arrow or press Enter. The message is sent as a normal chat message, and the viewer stays open.
4. While the agent works, the bar shows **Working** and the dock thumbnail shows a pulsing dot.
5. When the turn ends, the preview refreshes: a **Live** frame reloads in place, and a **Screenshot** is captured again at the same size. The dock flashes once when the new version lands.
6. Tap **Compare** to see the new screenshot against an earlier one. Drag the slider to move the before/after divider, and tap a time chip to pick which earlier capture is "before".

### Controls (viewer footer)

- **Screenshot / Live**: unchanged; see [Web preview tool](./webpreview.md).
- **Compare**: shown in Screenshot mode once this URL has at least two captures.
- **Auto**: refreshes the preview after each agent reply. It is on by default and remembered on the device (`localStorage` key `mouaif.webpreview.autoRefresh`).
- **Open ↗**: opens the URL in a new tab.

If a prompt can't be sent (no model picked, a turn already running), the bar keeps your text and shows the reason above the input, because the viewer covers the chat's own status line.

## Related

- [Web preview tool](./webpreview.md)
- [Local preview proxy](./local-preview-proxy.md): a Live view of a dev server on the host
