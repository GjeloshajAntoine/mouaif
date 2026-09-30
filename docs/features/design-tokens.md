# Design tokens and shared UI styles

## Overview

Every screen in mouaif draws its colours, fonts, corner radii and motion from one set of design tokens, and reuses a few shared building blocks — buttons, icon buttons, modal sheets, overflow menus and spinners — instead of restyling them per screen. A menu or a spinner therefore looks and behaves the same everywhere in the app.

## Usage

Nothing to configure. What you can expect:

- **One overflow menu.** The **⋯** menu on a project card, in **Settings → Projects**, on a Git commit row, and in the Inspector's tab actions and target rows share the same look: 44 px rows, rounded corners, and destructive items (**Unregister**, **Close tab**) in red with a red tint when you press them.
- **One spinner motion.** Tool cards, the Git refresh button and dictation all spin the same way.
- **One monospace font.** File paths, the file editor, hints, and the Inspector's rule and property names all use the same code font.
- **One system font.** The app's body text uses the platform's native font stack, and form fields inherit it so typing never falls back to a different face.

## Behavior

- **Colour, radius and motion are themeable from one place.** Every screen pulls from the same tokens, so a change to a token updates the whole app instead of one view.
- **Reduced-motion is honoured.** Spinners stop animating when the operating system asks for less motion.
- **Nothing depends on hover.** The overflow menu and its destructive items work on tap first.

## Related

- [Modal sheets](./modal-sheets.md)
- [Responsive layout](./responsive-layout.md)
