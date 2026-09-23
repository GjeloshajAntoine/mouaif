# Inspector full screen — implementation notes

> Agent-facing reference for [`docs/features/inspector-fullscreen.md`](../../features/inspector-fullscreen.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

### The header button

The button lives in `PanelCard` in [frontend/src/components/Inspector.jsx](../../../frontend/src/components/Inspector.jsx), in the slot the panel label used to fill. It is a glyph-only control with `aria-label` + `title`, sized to the shared `--tap` (44 px) minimum like every other control in that row, and it is disabled rather than hidden when its panel is off.

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

The panel bodies carry their stacked-layout heights as `dvh` values in the panel parts (`inspector-chrome.css` sets the console and network scrollers to `32dvh`, `inspector-styles.css` sizes the Styles scroller at `52dvh`, or `72dvh` when it is the only visible card). Those have to lose to the surface, and some of the selectors have the same specificity, so they are overridden by cascade order: [frontend/src/inspector-fullscreen.css](../../../frontend/src/inspector-fullscreen.css) is imported **last** by [frontend/src/inspector.css](../../../frontend/src/inspector.css), after every panel part.

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
