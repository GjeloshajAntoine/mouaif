# iOS touch scroll — chat transcript scrolls when the user drags it

## Overview

On iOS Safari, dragging a chat transcript with a finger used to do nothing: the page never moved, no momentum kicked in, and the jump-to-bottom FAB never appeared. The transcript was a `flex: 1 1 auto` item inside the chat-view section, and the section itself was a `flex: 1 1 auto` child of the `app__main--flush` flex column. iOS Safari sizes a flex item whose `flex-basis` is `auto` by the content's intrinsic height instead of the parent's free space, so the overflow was effectively unbounded and the touch-scroll gesture had nothing to scroll.

The fix pins the chat-view section to the parent flex column's free space with the standard "flex child owns the scroll" pattern (`flex: 1 1 0; min-height: 0; height: 0;`) and adds the iOS-specific hooks the transcript needs to claim the pan gesture and bring back momentum scrolling.

## Usage

No user-facing change. Drag the chat transcript up or down with a finger on an iPhone (Safari or a PWA installed via Add-to-Home-Screen) and it scrolls the same way it does on a desktop browser:

- Drag up to read older messages.
- Drag down to return to the bottom; once the bottom is visible, the auto-pin behaviour kicks back in and new tokens keep the view pinned.
- The floating "↓ N" jump button appears as soon as the user has scrolled up enough that auto-pin is suspended, and a single tap re-anchors the view to the bottom.

This applies to every chat, including the first message in a brand-new chat (the empty transcript, the system-prompt card, and the per-chat tool toggles all live inside the same scroll container).

## Implementation notes

### Why `flex: 1 1 auto` was wrong on iOS

The chat view was a `flex: 1 1 auto` child of `.app__main--flush`, and the transcript was a `flex: 1 1 auto` child of the chat view. The `auto` basis is the key: iOS Safari computes the item's main size from the content's intrinsic height rather than from the parent's free space, so the box grows to fit the transcript and the overflow scroll the CSS was promising was never installed at runtime. The result: a touch-drag inside the transcript bubbled up to the page, the page itself wasn't tall enough to scroll, and the gesture looked like a no-op.

The non-chat flush views (project settings, folder picker, …) already use the correct pattern: they get `flex: 1 1 0; min-height: 0; height: 0;` from the `.app__main--flush > section:not(.chat-view)` rule in `layout.css`. The chat view is excluded from that rule because it manages its own internal transcript scroll, so the fix had to live in the chat view's own rules.

### The change

`src/web/src/components.css`, `.chat-view` rule:

```css
.chat-view {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;   /* was: 1 1 auto */
  min-height: 0;
  height: 0;     /* new — forces the flex algorithm to use free space */
  overflow: hidden;
  touch-action: pan-y;  /* new — claim the vertical pan */
  position: relative;
}
```

The `height: 0` is the bit that makes iOS Safari cooperate: with the basis forced to 0, the flex algorithm hands the section exactly the parent's free space, and the transcript's `overflow-y: auto` finally has a finite box to clip and scroll.

`src/web/src/components.css`, `.chat-view__transcript` rule:

```css
.chat-view__transcript {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 8px 6px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;  /* iOS momentum scrolling */
  overscroll-behavior: contain;        /* no chain-bounce to the page */
  touch-action: pan-y;                 /* claim the vertical pan */
  scrollbar-width: thin;
}
```

Three new declarations on the transcript:

- `-webkit-overflow-scrolling: touch` — the iOS-specific opt-in for momentum scrolling inside a nested `overflow: auto` container. The property is still respected on iOS 13+ and is a no-op on other engines, so it ships unconditionally.
- `overscroll-behavior: contain` — stops the transcript from chain-bouncing the parent `.app__main` when the user hits the top or bottom of the transcript. Without it, dragging past the newest message scrolls the page instead.
- `touch-action: pan-y` — claims the vertical pan gesture for the transcript. The page-level `touch-action: manipulation` on `<html>` lets the browser pick pan vs. zoom; on iOS Safari a nested scroll container sometimes loses the gesture to an ancestor if it doesn't claim it explicitly.

### Why not just `overflow-scrolling: touch` alone

`-webkit-overflow-scrolling: touch` only matters once the box has a finite height to scroll inside. The actual root cause of the iOS bug was the unbounded flex basis; the momentum hook is the polish on top. Both are needed:

- Without the `flex: 1 1 0` / `height: 0` change, the transcript is unbounded and the momentum hook is moot.
- Without the momentum hook, the transcript scrolls in fixed steps on iOS 13+ instead of the smooth rubber-band feel users expect.

### What was *not* changed

- The `app__main` flex container, the head row, and the composer are unchanged. The composer was already a `flex: 0 0 auto` row sitting below the transcript, so it stays pinned to the bottom of the chat view the same way it did before.
- The transcript's auto-pin / jump-to-bottom logic in `src/web/src/components/chat/scroll.js` is unchanged. It only cares about `scrollTop` and `scrollHeight`, which behave identically once the box has a real height.
- The virtual list primitive in `src/web/src/virtual-list.js` is unaffected — it already assumes the caller's scroller has `overflow: auto` and a real height.

### Verifying the fix

In a Safari Web Inspector attached to an iPhone (or the iOS Simulator), inspect the chat view and confirm the section reports a non-zero `clientHeight` (the parent's free space, not the content's intrinsic height) and that the transcript has `scrollHeight > clientHeight` on a chat with more than a screen of messages. Touch-drag the transcript; the `scroll` event fires, the `scrollTop` value changes, and `-webkit-overflow-scrolling: touch` brings back the momentum on release.
