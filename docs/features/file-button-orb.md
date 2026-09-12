# File button: glass orb

## Overview

Settings → App defaults → Chat defaults has a **Glass orb file button** switch. With it off (the default) the button beside the message box is the flat circle the composer has always used. With it on, the same button is drawn as a shaded glass sphere: the up-chevron, the folder and the down-chevron sit inside it as 3D objects, the folder and its `+N` / `−N` counts ride a slab 7px in front of the chevrons, and the whole pictogram turns slowly on two axes while a highlight drifts across the ball.

The option changes **how the button is painted, never what it does**. Same 44 × 44 tap target, same `aria-label`, same menu.

## Usage

1. Open **Settings → Chat defaults**.
2. Turn on **Glass orb file button**. The choice saves immediately and applies app-wide, so every project's composer uses it.
3. Open any chat. The button beside the text box is now the orb.

Turn it back off to return to the flat circle. Nothing else about the composer moves: the orb occupies the same 44 × 44 box in the composer row, so the text area and the send button do not shift.

| Setting | Off (default) | On |
|---------|---------------|-----|
| Painted circle | Flat `--surface-2` with a 1px border | Shaded sphere: sheen, specular hotspot, cool bounce along the lower edge, outer bloom |
| Folder | One flat silhouette | Extruded solid: deep side, lit face, ambient occlusion, rim light, specular streak |
| Counts | Flat colored glyphs at a fixed `0.46rem` | Embossed, and sized per render from the longest count drawn (11.5px down to 8.5px) |
| Motion | None | Orbit on two axes, the slab breathing in Z, the sphere sheen drifting, the folder streak breathing |
| Tap target | `44 × 44` | `44 × 44` (unchanged) |
| `aria-label` | Exact counts in words | Exact counts in words (unchanged) |

### Reduced motion

With the operating system's *reduce motion* preference on, the orb still renders — it holds a single frame. That frame is not a front-on view: the rest pose carries the full 3/4 attitude (a `−9deg` pitch and a `6deg` yaw), so the 3D shape, the extrusion and the emboss all still read. Only the turning stops.

## Implementation notes

### Files

| File | Role |
|------|------|
| `frontend/src/components/chat/fileOrb.js` | The preference reader — `fileOrbFromApp()` / `FILE_ORB_DEFAULT` |
| `frontend/src/components/chat/FileToolbar.jsx` | Renders either the flat glyph or the orb stack |
| `frontend/src/components/chat/useChatState.js` | Seeds the preference from `/api/settings` on chat load |
| `frontend/src/components/SettingsDefaults.jsx` | The switch in Settings → Chat defaults |
| `frontend/src/chat-composer.css` | Every `.file-toolbar--orb` rule |
| `src/settings.js` | `fileOrbButton: false` in `DEFAULTS` |
| `src/server-shared.js` | `'fileOrbButton'` in `CLIENT_SETTINGS_KEYS` |
| `scripts/test-file-orb.mjs` | Preference, plumbing, render and CSS-invariant tests |

### The preference is app-level, not per-chat

`fileOrbButton` lives in the app SQLite store beside `enterForNewline` and `autoRetry`, and appears in Settings → App defaults → Chat defaults. A per-chat record would mean a new column, a migration and a second place to look for a switch that only changes how one button is painted. Being in `Settings.DEFAULTS` also puts it in `RESETTABLE_APP_KEYS`, so Settings → reset can clear it.

The key must be in **both** `DEFAULTS` and `CLIENT_SETTINGS_KEYS`. The allowlist is what strips server-only bookkeeping out of `/api/settings`, so a key that is stored but not allowlisted is accepted by `PUT /api/settings/app`, written to SQLite, and then silently removed from every response — which looks exactly like the toggle failing to save.

```js
// frontend/src/components/chat/fileOrb.js
export function fileOrbFromApp(snapshot) {
  const bag = snapshot && snapshot.app;
  if (!bag || typeof bag !== 'object') return FILE_ORB_DEFAULT;
  const raw = bag[FILE_ORB_KEY];
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return FILE_ORB_DEFAULT;
}
```

The string forms are accepted because the app store holds a TEXT blob: a hand-edited `store.sqlite` can legitimately hand back `'true'`.

### How the depth is built

Four techniques, in the order they contribute:

1. **The sphere** is one pseudo-element. `::before` is inherited from the flat trigger (`inset: 2px`, `--surface-2`, a 1px border, the inherited corner radius), and the variant re-declares only the paint: five stacked gradients back-to-front (dark lower-right, cool inner bounce, broad left sheen, tight hotspot, glass body), a bright upper-left inset edge with a dark counter-edge, and an outer rim-light plus bloom ring.
2. **The orbit** is a real 3D rotation, not a 2D wobble. The stack sits inside `perspective(520px)` and rotates on both axes, so the chevrons genuinely turn in depth. The rest pose is already a 3/4 view (`-9deg` / `6deg`) rather than front-on, because a slab seen straight from the front has no depth to read.
3. **The slab** (`__plate`) is a soft dark glass tile that floats `--orb-depth` in front of the chevrons. It is deliberately *not* white: a white folder on a white slab is one white blob, and the counts would lose the dark backing their contrast is tuned against. The slab only darkens and diffuses what is behind it, which is what makes the lighter folder read as a separate object in front.
4. **The folder** is an extruded solid built from stacked silhouettes of one shared path — a contact shadow on the slab, the deep side 2px lower, the mid-tone body 1px lower, ambient occlusion, the lit face, a diagonal specular streak, and a rim light along the top edges and the pocket fold. At 28 × 22 this stacking is what reads as thickness; a folder glyph has no volume of its own to push in Z.

The counts are embossed, and the emboss has **five** stacked shadows per glyph. Read top to bottom as light travels over a raised letter:

1. the **bevel** — a dark bite along the glyph's top-inner edge, where a raised solid turns away from an overhead light. This is the shadow that makes the digits look milled rather than printed;
2. the **lip** — a bright edge on the far side, where the solid's base meets the plate;
3. the **bloom**, in the glyph's own hue, kept modest on purpose;
4. a wide soft **halo**, so the glow reaches the plate rather than stopping at the glyph's edge;
5. the **echo** — a near-black copy of the whole count offset down-right, the letterpress shadow the raised glyph casts on the plate.

The bloom is a glow rather than a different ink, so the 6:1 contrast (`#006600` / `#b30000` on the light face) is unchanged. Pushing it harder is a mistake worth recording: at a higher opacity the fill lifts toward pastel and the saturated hues the colors are chosen for are lost — measured, the glyph core read `rgb(39,134,45)` instead of `#006600`'s `rgb(0,102,0)`. Trimmed back, the same glyph reads `rgb(34,100,40)`.

### The count size is adaptive, and it has to be

The formatter ([`gitCount.js`](../../frontend/src/components/chat/gitCount.js)) can emit anything from 2 glyphs (`+0`) to 5 (`+995k`), and one fixed size cannot serve both inside a 28 × 22 folder:

- sized for the 5-glyph worst case, the digits render at ~9px, where every emboss offset is sub-pixel and melts into mush — this is exactly the "no depth, no texture" the first fixed size produced. `+995k` also measured **26.9px against a 23.7px box**, so the worst case was being *clipped*, not merely drawn small;
- sized for `+0` / `−0` — by far the common case, and the state the reference render shows — there is room for genuinely chunky digits.

So `orbCountFont(maxLen)` picks the step from the longest count actually drawn, and `FileToolbar` passes it in as the `--orb-count` custom property. Each step has to clear **two** budgets:

| Budget | Constraint | Binds at |
|--------|-----------|----------|
| Width | the widest string of `maxLen` glyphs inside the 25.7px content box | 4–5 glyphs |
| Height | two stacked line boxes at `line-height: 0.85` inside the 20.6px content box | 2–3 glyphs |

Width is per-**string**, not per-glyph — `.` is far narrower than a digit, so `+9.9k` (2.63em) is wider than `+995k` (2.92em) would be at the same size. The measured em widths, at weight 800 with tabular figures:

```text
+0      1.19em      +9.9k   2.63em
+99     1.77em      +995k   2.92em
```

Which gives:

```js
const ORB_FONT_STEPS = Object.freeze({ 2: 11.5, 3: 11, 4: 9.5, 5: 8.5 });
```

The height budget is the one that is easy to miss, and missing it is invisible in a screenshot: two 12px lines need 24px but the content box is only 20.6px, and `overflow: hidden` then silently cuts ~4.3px off the descender side of both counts. That is what stripped the texture off the digits before the line-height was tightened. Each step is also checked to be *maximal* — the next 0.5px up has to bust its budget — so the sizer is not leaving chunkiness on the table.

Every emboss offset is in `em`, so it scales with the chosen size: a 1.5px extrusion on 11.5px digits becomes 1.1px on 8.5px ones. The echo was previously a fixed `0.6px`, which is a visible bevel at one end of the range and an invisible smear at the other — tuning that single rule could never have reached the chunky case.

### One animated number

Everything that turns reads a single animated custom property, registered so it interpolates:

```css
@property --orb-tilt { syntax: '<angle>';  inherits: true; initial-value: 0deg; }
@property --orb-depth { syntax: '<length>'; inherits: true; initial-value: 7px; }

@keyframes file-orb-tilt { 0% { --orb-tilt: -7deg; } 50% { --orb-tilt: 7deg; } 100% { --orb-tilt: -7deg; } }
```

The stack, the plate and the slab's depth all derive from it with their own factors:

```css
.file-toolbar--orb .file-toolbar__stack {
  transform: perspective(520px)
             rotateX(calc(-9deg + var(--orb-tilt) * 0.85))
             rotateY(calc(6deg + var(--orb-tilt) * -0.7));
}
.file-toolbar--orb .file-toolbar__plate {
  transform: translateZ(var(--orb-depth)) scale(1.06);
}
```

Because there is only one phase, the orbits can never drift out of step — and `--orb-depth`, being registered, tweens instead of snapping. Without the registration both properties flip between their endpoint values on every frame, so the orbit *jumps*; that was the first, wrong version.

Only `transform`, `opacity` and those two registered properties are animated. No layout property is touched, so the composer never reflows and the effect stays on the compositor — on a phone mid-stream that matters (see [Chat streaming performance](chat-streaming-performance.md)).

### The specificity trap

The flat look pins the folder fill with:

```css
.file-toolbar__folder > svg path { fill: var(--fg); }   /* (0,1,2) */
```

The orb's folder span carries **both** `file-toolbar__folder` and `file-toolbar__folder--3d`, so a rule like `.file-toolbar__folder-face path { fill: url(#…) }` is `(0,1,1)` — it loses on element count to the flat rule, and every gradient layer silently repaints flat white. The 3D then reads as a sticker, which is exactly what the orb exists to avoid.

Every gradient-fill rule therefore carries the variant class:

```css
.file-toolbar--orb .file-toolbar__folder-face path { fill: url(#fileToolbarFolderFace); }  /* (0,2,1) */
```

`scripts/test-file-orb.mjs` pins this: any `fill: url(#…)` rule without the `.file-toolbar--orb` prefix fails the suite.

### Testing

`node scripts/test-file-orb.mjs` covers:

- the preference reader — absent key, missing bag, failed fetch, string forms, junk values;
- the plumbing — the key is in `DEFAULTS`, in the client allowlist, and round-trips through the real `settings.js` + `settingsForClient()` against a throwaway store;
- the render — running the actual `FileToolbar` component through a hook-harness in both modes, asserting the orb layers exist only when asked, every referenced gradient is defined, the decorative echo copies are `aria-hidden`, and both modes emit an identical `aria-label` and `title`;
- the count sizer — monotonic steps, clamping for inputs the formatter cannot emit (`undefined` would drop the whole `font-size` declaration and silently fall back to the inherited size), every step clearing both the width and the height budget, and each width-bound step being maximal;
- the CSS invariants — no unprefixed gradient fill, the orb paint is variant-scoped, the animation lives inside `prefers-reduced-motion: no-preference`, no keyframe animates a layout property, the emboss is in `em` rather than fixed px, and the rest pose carries a perspective and a base tilt.

It is wired into `npm run lint` and `npm test`.

### Related

- [File toolbar](file-toolbar.md) — what the button opens (Files / Preview / Git / Cli) and the `+N` / `−N` counts.
- [Chat UI](chat-ui.md) — the composer row the button sits in.
- [App and project settings](app-and-project-settings.md) — app-level vs project-level settings.
