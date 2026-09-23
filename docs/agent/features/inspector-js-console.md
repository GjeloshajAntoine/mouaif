# Inspector JavaScript console — implementation notes

> Agent-facing reference for [`docs/features/inspector-js-console.md`](../../features/inspector-js-console.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- The component is [`frontend/src/components/inspector/JsConsole.jsx`](../../../frontend/src/components/inspector/JsConsole.jsx)
  and it is mounted by `ConsolePanel.jsx` under the log's virtual list. The
  panel passes `onEvaluate` (which pushes the result row) and `getEval` (a
  `Runtime.evaluate` sender) down to it.
- **The editor is created once**, in a mount effect, and never rebuilt: the
  CodeMirror view, its completion source, and its history live for the life of
  the panel. It renders no Preact state at all — the strip's button is rendered
  on every render but the editor is not, so the button reaches the current view
  through a ref (`indentRef`) rather than capturing a view from the first
  render. Evaluating is a keymap binding (`Mod-Enter`), which is why the
  component needs no re-render when the box fills or empties, either.
- **The height cap has to be on `.cm-scroller`.** CodeMirror styles that
  element with a definite `height: 100%`, so a `max-height` on the wrapper is
  simply overflowed and clipped — which is what the old fixed 108 px box did,
  hiding a long expression with no way to scroll to it. Constraining the
  scroller keeps CodeMirror's own geometry intact and makes it the element
  that scrolls. `.cm-editor` is `height: auto` for the same reason: a percentage
  height would re-introduce the dead space the wrapper just stopped reserving.
- **The Tab button copies the current line's leading whitespace** and prepends a
  newline, which is what a keyboard `Tab` inside an indented block does — a soft
  keyboard has no `Tab` key at all, and `Ctrl` + `Space` is not reachable on a
  phone either, so this button is the only way to indent on touch.
- **In full screen** (`inspector-fullscreen.css`) the console wrapper stops
  filling the surface (`flex: 0 1 auto`) and the editor strip is pushed to the
  end of the card with `margin-top: auto`. The card is the panel's last child on
  a fixed, full-height surface, so a filling wrapper left the editor at the very
  bottom edge, inside the home-indicator inset, with empty space stretched
  around it.
- **Tests:** `scripts/test-inspector-js-console-mobile.js` drives the component
  in a VM against a miniature CodeMirror — typing, firing the keymap bindings,
  tapping the strip button — and asserts the CSS invariants the mobile sizing
  depends on (content height, the scroller cap, the 44 px floor, the full-screen
  order). Run it with `node scripts/test-inspector-js-console-mobile.js`; it is
  also part of `npm run test:inspector`.
