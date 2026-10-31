# Themes

## Overview

Themes change how the whole app looks: colours, corners, type, and anything CSS can reach. A custom theme can also run its own JavaScript for animations and effects such as a pointer glow, a starfield, or page transitions.

mouaif ships seven built-in themes:

| Theme | Base | Look |
| --- | --- | --- |
| Midnight | dark | the default cool blue |
| OLED | dark | true black surfaces |
| Aurora | dark | teal and violet, with a slow drifting glow behind the app |
| Paper | light | warm paper with a terracotta accent |
| Parchment | light | yellowed paper: grain and fibres over the page, cards that sit like separate sheets, serif type, fountain-pen blue ink |
| Mono | dark | terminal green, monospace type, sharp corners, scanlines |
| CRT | dark | a phosphor tube: glowing text, heavy scanlines, an RGB sub-pixel mask, a dark vignette, a faint flicker and a bright band rolling down the screen |

With reduced motion turned on, Aurora's drift and CRT's flicker and rolling band stop.

The active theme is an app-wide setting, so every device signed in to the same mouaif uses it. Other open tabs in the same browser switch at once. Other devices pick it up on their next load.

## Usage

Open **Settings → App defaults → Themes** (`#/settings/themes`).

- Tap a card to use that theme. The change applies and saves immediately.
- **Customize** on a built-in theme opens the editor on a copy of it.
- **New theme** starts from the default palette.
- **Import file** reads a `.mouaif-theme.json` file and opens it in the editor. It is not switched on, so you can read its script first.

### The editor

The editor (`#/settings/themes/<id>`) has five parts:

- **Theme**: the name; the base (Dark or Light, which sets the browser's `color-scheme` for scrollbars and form controls); corners (Sharp, Default, Round); and type (System, Serif, Mono).
- **Colours**: the main design tokens, each with a colour picker and a text field that accepts any CSS colour. Leave a field empty to keep the default. Soft tints, press shades and hairlines follow the main colours automatically through `color-mix()`, unless you set them yourself.
- **More tokens**: any other token from `frontend/src/base.css`, one `--name: value;` per line. Examples are `--shadow-md`, `--accent-soft` and `--font-mono`.
- **CSS**: a stylesheet loaded after the app's own. Use it for backgrounds, keyframes and per-component tweaks.
- **JavaScript**: an optional ES module (see below). **Start from** inserts a template or one of the examples: Pointer glow, Starfield, Page transitions, and Time-of-day accent.

While you edit, the app around the editor previews the theme's colours and CSS live. The script does not run in the preview. It runs once the theme is saved and in use. **Save & use** does both. **Export** downloads the theme as a file, and **Delete** removes it. If you delete the theme in use, the app returns to Midnight.

### Theme scripts

A theme script is an ES module whose default export receives a `ctx` object. It may return a cleanup function:

```js
export default function setup(ctx) {
  ctx.addStyle('body::after { content: ""; position: fixed; inset: 0; pointer-events: none; }');
  window.addEventListener('pointermove', (e) => {
    ctx.setVar('--glow-x', e.clientX + 'px');
  }, { signal: ctx.signal });
  return () => { /* undo anything ctx does not track */ };
}
```

| `ctx` member | What it does |
| --- | --- |
| `theme` | `{ id, name, base, vars }` of the running theme |
| `root`, `app` | `document.documentElement` and the `#app` mount |
| `signal` | an `AbortSignal` aborted when the theme stops; pass it to `addEventListener` |
| `reducedMotion` | `true` while the user prefers reduced motion |
| `route` | the current route object (`{ name, ... }`) |
| `addStyle(css)` | adds a stylesheet that lives as long as the theme |
| `setVar(name, value)` | sets a CSS custom property on `<html>`; removed when the theme stops |
| `onRoute(fn)` | calls `fn(route)` now and on every navigation |
| `onFrame(fn)` | a `requestAnimationFrame` loop, `fn(timeMs, deltaMs)`; pauses while the tab is hidden; return `false` to stop |
| `onMotionChange(fn)` | called with `true`/`false` when reduced motion is toggled |

Everything registered through `ctx` is undone when you switch themes, edit the theme, or the theme is deleted. No reload is needed. To draw behind the app, make `body`, `.app__shell` and `.app__main--flush` transparent, as the Starfield example does, and place the element at `z-index: -1`.

A script runs inside mouaif with the same access as the app itself, including your chats, settings and the API. Only use code you wrote or have read.

### When a script breaks something

- An error thrown by `setup()`, by the module itself, or later from the theme's code (timers, listeners) shows a **Theme script failed** notice on the Themes page, with a link to the script. Anything the failed `setup()` registered through `ctx` is removed.
- If a script makes the app unusable, open the app with `?safe` before the `#`, for example `http://127.0.0.1:5732/?safe#/settings/themes`. Safe mode loads with the default look and runs no theme CSS or script, so you can fix or delete the theme. Remove `?safe` to leave it.

### Theme files

A theme file is JSON:

```json
{
  "mouaifTheme": 1,
  "name": "Neon",
  "base": "dark",
  "vars": { "--accent": "#ff4fa3" },
  "css": "",
  "js": "export default function setup(ctx) {}"
}
```

## Related

- [Settings](settings-ui.md) — the Settings tab and what each section controls.
- [Install as an app](pwa.md) — the theme sets the installed app's status-bar colour.
