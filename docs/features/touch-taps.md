# Touch taps

## Overview

Every control in mouaif responds to a **single tap**. Buttons, list rows, tabs, switches, and menu items all act the moment a finger lifts — there is no second tap to confirm, and no control is reachable only with a mouse. Hover styling exists for desktop, but it is scoped so touch devices never have to pay for it.

## Usage

Use the app with a finger as you would expect:

- **Tap a row** (a project card chat, a Settings row, a tool row) — it opens or toggles immediately.
- **Tap a tab** in the bottom bar — the view switches immediately.
- **Tap a switch or a segmented control** — the value is written immediately.
- **Press and hold** where a gesture is offered (dragging an Inspector slider, mark-dragging in Draft Craft) — the press is the gesture, not a tap.

On a phone, a tap never needs repeating. If a tap truly does nothing, the cause is a disabled control or a guard (for example a Save button while a request is in flight), not a hidden first-tap step.

## Why hover is scoped to mouse devices

Touch browsers — iOS Safari and an installed iOS PWA in particular — deliver a tap in two steps when the tapped element has a `:hover` style: the first tap applies the hover state, and only a second tap delivers the `click`. That is the classic "every button needs two taps" behaviour, and it is a property of the *page*, not of any one control: one element with an unguarded `:hover` is enough to make the whole surface feel like it needs double taps.

mouaif therefore keeps every `:hover` rule inside a `@media (hover: hover)` block:

```css
@media (hover: hover) {
  .group__row:hover { background: var(--surface-2); }
}
.group__row:active { background: var(--surface-3); }
```

`(hover: hover)` is false on a touch-only device, so the hover rule does not exist there and iOS has no state to spend the first tap on. The `:active` rule is left outside the guard: it is what a touch user *should* see, and it fires on the press itself.

This also keeps the project's mobile-first rule honest — "avoid hover-only affordances; everything must work on tap."

## What this does not change

`touch-action`, safe-area insets, and the 44 px tap-target minimum are separate
concerns and are unaffected. Controls keep the same size, position, and labels;
only the hover styling becomes conditional on a mouse being present.
