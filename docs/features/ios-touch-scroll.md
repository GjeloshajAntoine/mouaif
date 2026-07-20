# iOS touch scroll — chat transcript scrolls when the user drags it

## Overview

On iOS Safari, dragging the chat transcript with a finger used to do nothing: the page never moved, no momentum kicked in, and the jump-to-bottom FAB never appeared. The transcript is an `overflow-y: auto` element, and the real reason iOS Safari wouldn't scroll it is that **every** ancestor in the chain between the transcript and the document was also a scroll container. iOS Safari does not deliver a touch-pan gesture to a nested `overflow: auto` element when one of its ancestors already establishes a scroll context — the outer scroll container captures the gesture, the inner one never sees it, and a touch-drag is a no-op.

The fix removes every overflow layer between the transcript and the document so the transcript is the only scroll container in the tree. The flex sizing is left as the standard "flex child owns the scroll" pattern (`flex: 1 1 0; min-height: 0;` on the section, `flex: 1 1 auto; min-height: 0;` on the transcript), and the transcript keeps the iOS-specific hooks (`-webkit-overflow-scrolling: touch`, `overscroll-behavior: contain`, `touch-action: pan-y`) so momentum and gesture ownership are explicit.

## Usage

No user-facing change. Drag the chat transcript up or down with a finger on an iPhone (Safari or a PWA installed via Add-to-Home-Screen) and it scrolls the same way it does on a desktop browser:

- Drag up to read older messages.
- Drag down to return to the bottom; once the bottom is visible, the auto-pin behaviour kicks back in and new tokens keep the view pinned.
- The floating "↓ N" jump button appears as soon as the user has scrolled up enough that auto-pin is suspended, and a single tap re-anchors the view to the bottom.

This applies to every chat, including the first message in a brand-new chat (the empty transcript, the system-prompt card, and the per-chat tool toggles all live inside the same scroll container).

## Implementation notes

### Why the transcript would not scroll on iOS

The chat view's box tree on the chat route was:

```
.app__shell                  (height: 100dvh)
  .app__header
  .app__main                 (flex: 1; min-height: 0; overflow-y: auto)
    .app__main--flush        (display: flex; flex-direction: column;
                              min-height: 0; overflow: hidden)
      <section.chat-view>    (display: flex; flex-direction: column;
                              flex: 1 1 auto; min-height: 0;
                              overflow: hidden)
        .chat-view__head
        .chat-view__transcript  (flex: 1 1 auto; min-height: 0;
                                overflow-y: auto)
        .chat-view__composer
```

Three scroll layers between the transcript and the document: `app__main` (`overflow-y: auto` from the base rule), `app__main--flush` (`overflow: hidden`), and the chat-view section (`overflow: hidden`). On iOS Safari, the outer `overflow: auto` on `app__main` is the one that captures the pan gesture — iOS sees that the touch started on a scrollable element, claims the gesture for that element, and never hands it to the nested `overflow: auto` on the transcript. `overflow: hidden` on the intermediate layers also blocks the gesture from reaching the inner scroll container. Net result: a touch-drag inside the transcript is a no-op.

The same chain affected the other flush views (project settings, folder picker, provider edit) for a different reason: their `<section>` was `flex: 1 1 0; min-height: 0; height: 0; overflow-y: auto;`, and they sat inside the same `app__main` (`overflow-y: auto`) + `app__main--flush` (`overflow: hidden`) sandwich. Those views had a different bug (the section's own scroll worked but the outer overflow clipped unrelated content), and they also benefited from removing the outer overflow.

### The fix

Three changes, all in CSS:

1. **`src/web/src/layout.css`, `.app__main--flush`** — override the base `.app__main { overflow-y: auto; }` with `overflow: visible`. The base rule is correct for non-flush views (chats list, settings, inspector) where the main element itself is the page's scroll container; on flush views the inner section (or the chat-view's transcript) is the scroll container, so the outer overflow must go. The flex children are still bounded by `min-height: 0` and the parent's `height: 100dvh`, so removing the overflow doesn't let content escape the shell.

   ```css
   .app__main--flush {
     padding: 0;
     display: flex;
     flex-direction: column;
     min-height: 0;
     overflow: visible;   /* new — was: inherited overflow-y: auto from .app__main */
   }
   ```

2. **`src/web/src/components.css`, `.chat-view`** — drop the `overflow: hidden` and the `height: 0`. The chat view is a flex column with `flex: 1 1 0; min-height: 0;` so it's already bounded by the parent; the `overflow: hidden` was only there as defensive clipping for the absolutely-positioned jump-to-bottom FAB, and the FAB doesn't need it (it's positioned within the chat view's coordinate space via `position: relative` and the FAB's `bottom` is within the section's bounds). Without `overflow: hidden` on the chat view, the inner transcript's `overflow-y: auto` is the only scroll context inside the section, and iOS Safari delivers the pan gesture to it.

   ```css
   .chat-view {
     display: flex;
     flex-direction: column;
     gap: 0;
     flex: 1 1 0;
     min-height: 0;
     position: relative;   /* FAB anchor */
     /* no height: 0, no overflow: hidden */
   }
   ```

3. **`src/web/src/components.css`, `.chat-view__transcript`** — keep the iOS-specific hooks so the scroll is smooth and contained:

   ```css
   .chat-view__transcript {
     display: flex;
     flex-direction: column;
     gap: 4px;
     padding: 4px 8px 6px;
     flex: 1 1 auto;
     min-height: 0;
     overflow-y: auto;
     -webkit-overflow-scrolling: touch;  /* iOS momentum */
     overscroll-behavior: contain;        /* no chain-bounce */
     touch-action: pan-y;                 /* claim the vertical pan */
     scrollbar-width: thin;
   }
   ```

   - `-webkit-overflow-scrolling: touch` — the iOS-specific opt-in for momentum scrolling inside a nested `overflow: auto` container. The property is still respected on iOS 13+ and is a no-op on other engines, so it ships unconditionally.
   - `overscroll-behavior: contain` — stops the transcript from chain-bouncing the document when the user hits the top or bottom of the transcript. With the outer overflow layers gone, this is mostly belt-and-suspenders, but it's still the right default for a chat transcript.
   - `touch-action: pan-y` — claims the vertical pan gesture for the transcript. The page-level `touch-action: manipulation` on `<html>` lets the browser pick pan vs. zoom; on iOS Safari a nested scroll container sometimes loses the gesture to an ancestor if it doesn't claim it explicitly.

### Why the original `flex: 1 1 auto` theory was wrong

The first attempt at this fix diagnosed the issue as `flex: 1 1 auto` on the chat-view (and the `flex: 1 1 auto` on the transcript) — the iOS-Safari "flex basis auto" gotcha, where the box is sized by content's intrinsic height rather than the parent's free space. That diagnosis was plausible but incorrect: changing the flex basis to `flex: 1 1 0` and adding `height: 0` did not actually fix the iOS scroll, because the root cause was the outer `overflow: auto` / `overflow: hidden` chain, not the flex sizing. The current fix keeps `flex: 1 1 0; min-height: 0;` on the chat view (the standard bounded-flex pattern) but drops the `height: 0` and the `overflow: hidden`; the transcript stays `flex: 1 1 auto; min-height: 0;`. The whole point is that the chat view's box is bounded by the flex parent (no `height: 0` needed) and is not a scroll container (no `overflow: hidden` needed).

### What was *not* changed

- The non-flush `app__main` (chats list, settings, inspector) is unchanged. Its `overflow-y: auto` is the page's scroll container and works correctly on iOS for those views.
- The head row and the composer are unchanged. Both are `flex: 0 0 auto` rows, the composer is pinned to the bottom of the chat view the same way it was before, and the FAB (`position: absolute`) is still anchored to the chat view via `position: relative`.
- The transcript's auto-pin / jump-to-bottom logic in `src/web/src/components/chat/scroll.js` is unchanged. It only cares about `scrollTop` and `scrollHeight`, which behave identically once the box has a real height and the gesture actually reaches it.
- The virtual list primitive in `src/web/src/virtual-list.js` is unaffected — it already assumes the caller's scroller has `overflow: auto` and a real height.

### Verifying the fix

In a Safari Web Inspector attached to an iPhone (or the iOS Simulator), open a chat with more than a screen of messages and:

1. Inspect `.app__main` on the chat route. Confirm it has `app__main--flush` and that its computed `overflow` is `visible` (not `auto` and not `hidden`).
2. Inspect `.chat-view`. Confirm computed `overflow` is `visible` (not `hidden`).
3. Inspect `.chat-view__transcript`. Confirm computed `overflow-y` is `auto`, `clientHeight` is the bounded free space (not the content's intrinsic height), and `scrollHeight` is greater than `clientHeight` on a long chat.
4. Touch-drag the transcript. The `scroll` event fires, `scrollTop` changes, and `-webkit-overflow-scrolling: touch` brings back the momentum on release.
