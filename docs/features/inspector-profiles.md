# Inspector Chrome profiles

> **Status: hidden.** The setup screen's **Chrome profiles** button does not
> render today — it is gated by `PROFILES_ENTRY` in
> [frontend/src/components/Inspector.jsx](../../frontend/src/components/Inspector.jsx),
> which is `false`. Everything below still works if you flip that flag to
> `true` (or type a profile's port into the debugger URL field directly, which
> never needed the button). This page documents the feature itself.

## Overview

The **Inspector** attaches to one Chrome debug endpoint at a time. This feature lets you keep more than one Chrome *user profile* — "Work", "Personal", a clean test profile — and switch which one the Inspector attaches to, without remembering ports or retyping debugger URLs.

mouaif lists the profiles Chrome already has on disk, shows the endpoint each one points at, and switches the active one in a single tap.

## Usage

### Opening the profile list

1. Open the **Inspector** tab.
2. On the setup screen, tap **Chrome profiles**.
3. The sheet lists every Chrome profile it found, grouped by the user-data-dir they live in.

Each row shows:

- the profile's name, as Chrome itself displays it;
- the signed-in account, when the profile has one;
- the debug endpoint it points at (`127.0.0.1:9222`);
- **Active** on the profile currently in use.

### Switching profiles

Tap a profile row. mouaif records that profile as active, points the Inspector at its endpoint, and closes the sheet. Everything else in the Inspector — the targets list, open/close, navigation, the live panels — follows, because they all read the one debugger URL the switch just wrote.

A profile whose Chrome is **not running** is still listed and still selectable. Switching to it is not an error; the targets list simply comes back empty until you start that Chrome.

### Setting an endpoint per profile

Each row has an **Endpoint** action. Use it to give a profile its own debugger URL — typically a different port, because each Chrome instance needs its own `--remote-debugging-port`:

```bash
# work profile
chrome --user-data-dir="$HOME/.config/google-chrome" --remote-debugging-port=9222

# personal profile, a second instance on its own port
chrome --user-data-dir="/tmp/chrome-personal" --remote-debugging-port=9223
```

A saved endpoint is remembered for that profile only, and is used the next time you switch to it. This is separate from switching on purpose: you can pre-configure the second profile's port before that Chrome is ever started.

**Use URL** copies a profile's endpoint into the debugger URL field without saving or switching — the escape hatch for "this is the port I need, but not the profile I want active."

### Adding a profile folder

Profiles live in a Chrome *user-data-dir*. mouaif scans the standard locations for Chrome, Chromium, Brave, and Edge on macOS, Windows, and Linux.

For a portable Chrome or a profile tree somewhere else, tap **Add profile folder** and give the path. The folder must actually look like a Chrome user-data-dir (it contains a `Local State` file or a `Default` directory), so a typo is rejected at the door instead of silently showing an empty list. Added folders appear under **Profile folders** and can be removed again; folders mouaif found on its own are marked **found** and have no Remove action.

### When a manual URL wins

If you type a debugger URL into the field and tap **Save & discover**, the active profile marker is cleared. A hand-typed URL is no longer attributable to a profile, and leaving the badge on would name a profile that no longer describes the endpoint. Saved *per-profile* endpoints are untouched — only the active marker is dropped.

## Related

- [Inspector](./inspector.md) — the Inspector tab itself.
- [Chrome Debug MCP](./chrome-debug-mcp.md) — letting the AI assistant automate the browser.
