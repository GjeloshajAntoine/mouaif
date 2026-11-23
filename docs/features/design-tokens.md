# Design tokens and shared UI styles

## Overview

Every screen in mouaif draws its colours, fonts, corner radii and motion from one set of design tokens declared in `frontend/src/base.css`, and reuses a few shared building blocks — buttons, icon buttons, modal sheets, overflow menus and spinners — instead of restyling them per screen. A menu or a spinner therefore looks and behaves the same everywhere in the app, and a theme change reaches every view at once.

## Usage

Nothing to configure. What you can expect:

- **One overflow menu.** The **⋯** menu on a project card, in **Settings → Projects**, on a Git commit row, and in the Inspector's tab actions and target rows share the same look: 44 px rows, rounded corners, and destructive items (**Unregister**, **Close tab**) in red with a red tint when you press them.
- **One spinner motion.** Tool cards, the Git refresh button and dictation all spin the same way.
- **One monospace font.** File paths, the file editor, hints, and the Inspector's rule and property names all use the same code font.
- **One system font.** The app's body text uses the platform's native font stack, and form fields inherit it so typing never falls back to a different face.
- **Two depth levels, not five.** Cards and panel rows sit one step above the page with `--shadow-sm`; popovers, menus, the console autocomplete and sheets lift with `--shadow-lg`. Nothing invents its own blur or spread.

## The token set

| Group | Tokens | Notes |
| --- | --- | --- |
| Surfaces | `--bg`, `--surface`, `--surface-2`, `--surface-3` | Four clearly separated steps (page, card, pressed row, popover). The gap between them is deliberately wide so a card never dissolves into the page. |
| Borders | `--border`, `--border-strong` | The hairline is an alpha tint so it recedes at mobile density; `--border-strong` is solid for container edges and focus rings. |
| Text | `--fg`, `--fg-soft`, `--muted`, `--muted-2`, `--tab-label` | `--muted-2` is tertiary meta only; captions that carry meaning use `--muted`. |
| Accent | `--accent`, `--accent-soft`, `--accent-press`, `--accent-hi`, `--accent-hi-2`, `--on-accent` | `--accent-soft` is an alpha tint, not a solid, so chips adapt to whatever surface they sit on. |
| Semantic | `--success`, `--warning`, `--danger` and their `-soft` tints | Destructive and warning text always pairs with its tint on a tinted row. |
| Elevation | `--shadow-sm`, `--shadow-md`, `--shadow-lg` | Layered (contact shadow + ambient glow). |
| Radius | `--r-sm`, `--r-md`, `--r-lg`, `--r-pill` | Chips and small buttons, cards and bubbles, sheets, and anything pill-shaped. |
| Motion | `--dur-fast`, `--dur`, `--ease`, `--ease-out` | Zeroed by the reduced-motion media query. |
| Sizing | `--tap`, `--tap-sm`, `--tap-xs`, `--tabbar-h` | `--tap` is the 44 px minimum; the smaller stops are for glyph-only accessories, not a licence to shrink a primary target. |

## Behavior

- **Colour, radius and motion are themeable from one place.** Every screen pulls from the same tokens, so a change to a token updates the whole app instead of one view. Built-in and custom themes override the tokens (see [Themes](./themes.md)) rather than restyling components.
- **Derived tints are mixed, not hard-coded.** A red border on a danger pill is `color-mix(in srgb, var(--danger) 40%, transparent)`, so it follows a custom theme instead of staying midnight blue.
- **Pill shape is a token.** Anything rounded to a full radius uses `--r-pill`; the only remaining literal is the chat composer's `1.4rem`, which sits deliberately between `--r-md` and `--r-lg` because a two-line composer styled as a full pill would round its toolbar row into a lozenge.
- **Elevation is tokenised.** Panels, profile cards, the pick banner, sheet surfaces and popovers all take a `--shadow-*` token instead of a one-off `rgba(0, 0, 0, …)` blur.
- **Reduced-motion is honoured.** Spinners stop animating when the operating system asks for less motion.
- **Nothing depends on hover.** The overflow menu and its destructive items work on tap first.

## Exceptions

Two surfaces intentionally keep literal colours because they are not part of the app chrome:

- **The chat's CLI terminal** (`frontend/src/chat-composer.css`) paints its own near-black `#0b0e14` bed and ANSI palette, the way a terminal emulator does.
- **Rendered Mermaid diagrams** (`frontend/src/mermaid.js`) build a standalone SVG data URI, and an `<img>` never inherits the page's custom properties. Its `PALETTE` mirrors the dark tokens and must be updated when `base.css` changes.

The file editor, hidden-content editor and Inspector JavaScript console paint their CodeMirror area from `--surface` / `--surface-2` / `--fg-soft`, so they follow the active theme.

## Related

- [Modal sheets](./modal-sheets.md)
- [Responsive layout](./responsive-layout.md)
- [Themes](./themes.md)
