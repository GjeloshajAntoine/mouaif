# iOS touch scroll — the chat transcript scrolls when the user drags it

## Overview

On iOS Safari, dragging the chat transcript with a finger used to do nothing: the page never moved, no momentum kicked in, and the jump-to-bottom FAB never appeared. Two separate layout bugs caused this, and both are fixed:

1. **Nested scroll layers** — the transcript is an `overflow-y: auto` element, and **every** ancestor in the chain between the transcript and the document was also a scroll container. iOS Safari does not deliver a touch-pan gesture to a nested `overflow: auto` element when one of its ancestors already establishes a scroll context — the outer scroll container captures the gesture, the inner one never sees it, and a touch-drag is a no-op. The fix removes every overflow layer between the transcript and the document so the transcript is the only scroll container in the tree.

2. **The document itself was scrollable** — the safe-area insets (`env(safe-area-inset-*)` for the iPhone notch / home indicator) lived on `<html>` as padding while the app shell was `height: 100dvh`. On a notched iPhone that pushed the document 47+34 px past the bottom of the screen, making the *page* scrollable alongside the transcript. The two fought for the touch gesture: iOS Safari would hand the pan to the page (or rubber-band it), the transcript's `scroll` events fired late or never, and the composer / status line ended up below the home indicator. The fix locks the document to the viewport (`html/body { height: 100%; overflow: hidden }`) and moves the safe-area padding onto the shell (border-box, so `100dvh` + insets still fills exactly the visible area).

The transcript keeps the iOS-specific hooks (`-webkit-overflow-scrolling: touch`, `overscroll-behavior: contain`, `touch-action: pan-y`) so momentum and gesture ownership are explicit, and the flex sizing is the standard "flex child owns the scroll" pattern (`flex: 1 1 0; min-height: 0;` on the section, `flex: 1 1 auto; min-height: 0;` on the transcript). The same momentum/containment hooks apply to the main list scroller and non-chat drill-in sections.

The shell uses `height: 100vh` followed by `height: 100dvh`: older iOS releases get a bounded fallback, while current Safari uses the dynamic viewport as its top and bottom browser chrome changes. The shell owns the top inset. On top-level routes, the tab bar owns the bottom inset so its background reaches the screen edge while its controls remain above the home indicator; on flush routes without a tab bar, the main region owns that inset. The tab bar is a normal flex sibling of the main region, so the main scroller does not reserve another tab-bar height as bottom padding. Its content row is the 44 px minimum touch target and the icon/label stack is shifted 4 px toward the screen edge, keeping the bar compact without entering the home-indicator inset.

## Usage

No user-facing change. Drag the chat transcript up or down with a finger on an iPhone (Safari or a PWA installed via Add-to-Home-Screen) and it scrolls the same way it does on a desktop browser:

- Drag up to read older messages.
- Drag down to return to the bottom; once the bottom is visible, the auto-pin behaviour kicks back in and new tokens keep the view pinned.
- The floating "↓ N" jump button appears as soon as the user has scrolled up enough that auto-pin is suspended, and a single tap re-anchors the view to the bottom.

This applies to every chat, including the first message in a brand-new chat (the empty transcript, the system-prompt card, and the per-chat tool toggles all live inside the same scroll container).
