# Inspector full screen

Expand one Inspector panel over the whole viewport, from the button in its own card header.

## Overview

The Inspector stacks its panels as cards inside the tab: Preview, Styles, Console, Network and Info, each with its own scroll area. On a phone that leaves every panel body between 32 and 54 `dvh` tall — under half the screen — which is workable for a glance and cramped for the tasks the panels exist for: reading a computed-styles list of ~470 rows, scanning a request log, or scrolling a console back through a noisy page.

Every card header therefore carries a **full-screen button**. Tapping it expands that panel over the whole viewport; tapping it again returns to the stacked layout exactly as you left it.

The header used to print the panel's name in that slot. It no longer does: the name is what the chip in the switcher above the cards already says, and the row's one wide slot is worth more as an action. The button carries the panel's name in its accessible label, so nothing becomes unnameable for assistive technology.

## Usage

1. Open the **Inspector** tab and connect to a page.
2. Find the panel you want to enlarge (its chip in the switcher row shows which are visible).
3. Tap the **expand** glyph at the left of that panel's header.
4. Work as normal — the panel is the same live surface, just larger. Everything the panel does inline still works: selecting elements, editing values, evaluating in the console, tapping the preview.
5. Tap the glyph again, or press **Escape**, to return to the stacked layout.

### Which panel you get

| Card | What its full-screen button opens |
| --- | --- |
| Preview | The panel's own **viewport-spanning live preview**, unchanged: a second screenshot surface with the live page's title + host, Refresh, Capture size, zoom and its own close button. |
| Styles | The card expanded over the viewport, with its style controls, property lists and matched rules. |
| Console | The card expanded over the viewport: the log list plus the JavaScript console below it. |
| Network | The card expanded over the viewport. |
| Info | The card expanded over the viewport. |

Preview keeps its own overlay because it already had a fuller full screen — a second surface with its own header, viewport presets and "type into page" bar — and replacing it with the generic one would lose controls rather than gain space.

### Leaving full screen

Any of these returns you to the stacked layout:

- **Escape.**
- Tapping the same header button again (the glyph now points inward).
- Switching the expanded panel off with its eye toggle. Opening a different panel card is never blocked by the mode; the mode is simply left.
- Detaching from the inspected tab.

## Implementation notes

### The header button

The button lives in `PanelCard` in [frontend/src/components/Inspector.jsx](../../frontend/src/components/Inspector.jsx), in the slot the panel label used to fill. It is a glyph-only control with `aria-label` + `title`, sized to the shared `--tap` (44 px) minimum like every other control in that row, and it is disabled rather than hidden when its panel is off.

`onFullscreen` is what differs per card:

```js
onFullscreen: id === 'preview'
  ? () => { if (previewFullscreenRef.current) previewFullscreenRef.current(); }
  : () => togglePanelFullscreen(id),
```

### The surface

Expanding a card *in place* would not deliver the space. The card is sized in the flow, inside `.app__main`, and the region is the box that has the dead space in it — a list stretched to the bottom of the region is the same list it already was. The full-screen surface is therefore a separate node portalled to the document root:

```js
focusPanelId
  ? createPortal(
      h('div', { class: 'inspector__fs', role: 'dialog', 'aria-modal': 'true' }, ...),
      document.body
    )
  : null,
```

Two consequences are deliberate:

- **The stacked layout stays mounted underneath**, with its own scroll offsets and panel bodies untouched. Leaving full screen is therefore exactly the state you left, with no restore path to get wrong.
- **The focused panel is mounted a second time** inside the surface (`key: 'fs-' + focusPanelId`). A panel body cannot be in two places at once — the console and network panel bodies build their virtual lists against the DOM node they own, and the Styles panel publishes its pinned-stack height and re-adopts its selected element on mount — so the state that has to survive both mounts lives above them: the Inspector owns the selection and its retained copy, the session receipt, the attached target and the CDP handlers.

### Filling the height

The panel bodies carry their stacked-layout heights as `dvh` values in the panel parts (`inspector-chrome.css` sets the console and network scrollers to `32dvh`, `inspector-styles.css` sizes the Styles scroller at `52dvh`, or `72dvh` when it is the only visible card). Those have to lose to the surface, and some of the selectors have the same specificity, so they are overridden by cascade order: [frontend/src/inspector-fullscreen.css](../../frontend/src/inspector-fullscreen.css) is imported **last** by [frontend/src/inspector.css](../../frontend/src/inspector.css), after every panel part.

That last part re-declares the three body shapes as `flex: 1 1 auto; height: auto`, lifts the Styles scroller's `78dvh` ceiling and raises the element-preview cap, so the list is what scrolls inside the surface rather than the surface around it.

### Escape

The surface is a dialog, not a sheet: it is the only thing on screen but it is not layered over another surface, and it takes no slot on the modal stack. Its key handler is registered on `document` in the **bubble** phase, so a sheet opened from inside the expanded panel — the Styles edit sheet, the Add-property confirm, a detail sheet — handles the key first through `useModal`'s capture-phase listener and stops it there. One press closes the sheet; it does not also close the panel underneath it.

### The Preview interaction

`PreviewPanel` publishes whether its own overlay is open through a ref:

```js
if (props.fullscreenOpenRef) props.fullscreenOpenRef.current.open = fullscreen;
```

The card mode stands down when that ref reports the overlay is open, so the two full-screen states can never both be in force — the overlay covers the viewport, and a card left expanded underneath would be revealed in that state the moment the overlay closed.

### What is not persisted

The mode is a momentary reading surface, so it is not written to storage: a reload or a reconnect comes back to the stacked layout rather than greeting the next session with a screen you cannot account for. It is dropped on detach for the same reason.
