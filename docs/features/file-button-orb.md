# File button: glass orb

## Overview

Settings → App defaults → Chat defaults has a **Glass orb file button** switch. With it off (the default) the button beside the message box is the flat circle the composer has always used. With it on, the same button is drawn as a glass ball: a window reflection sweeps its upper-left, refracted light runs along its lower-inner wall and its lower-right falls away to a dark limb ringed by a bright meniscus. Inside it, the up-chevron, the folder and the down-chevron sit as 3D objects — white bevelled bars above and below a pale extruded folder on a cool frosted pane, with the `+N` / `−N` counts embossed into the folder. The whole pictogram turns slowly on two axes while a highlight drifts across the ball.

The option changes **how the button is painted, never what it does**. Same 44 × 44 tap target, same `aria-label`, same menu.

## Usage

1. Open **Settings → Chat defaults**.
2. Turn on **Glass orb file button**. The choice saves immediately and applies app-wide, so every project's composer uses it.
3. Open any chat. The button beside the text box is now the orb.

Turn it back off to return to the flat circle. Nothing else about the composer moves: the orb occupies the same 44 × 44 box in the composer row, so the text area and the send button do not shift.

| Setting | Off (default) | On |
|---------|---------------|-----|
| Painted circle | Flat `--surface-2` with a 1px border | Glass ball: a window reflection sweeping the upper-left, a hard specular blob, refracted light along the lower-inner wall, a dark limb and a bright meniscus round the rim |
| Chevrons | One `currentColor` bar each | White bars with a dark under-edge, so they read over both the lit and the dark half of the ball |
| Folder | One flat silhouette | Extruded solid: a 1px dark side, a near-white face with a hairline silhouette outline, ambient occlusion, and a rim light along its top edges |
| Tile | — | A cool frosted pane *behind* the folder, so the pale solid separates from it on every edge |
| Counts | Flat colored glyphs at a fixed `0.46rem` | Embossed, and sized per render from the longest count drawn (7px down to 5px) |
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

### The depth is built
Five techniques, in the order they contribute:
1. **The sphere** is one pseudo-element. `::before` is inherited from the flat trigger (`inset: 2px`, `--surface-2`, a 1px border, the inherited corner radius), and the variant re-declares only the paint: five stacked gradients back-to-front (the dark limb at the lower-right, light refracted along the lower-inner wall, the broad window reflection sweeping the upper-left, the hard specular blob, and the cool steel body), a bright upper-left inset edge with a dark counter-edge, and an outer rim-light plus bloom ring. The three light layers are what make the ball read as *glass* rather than as a shaded disc: a solid sphere lit this way has one gradient, a transparent one has a second, sharper reflection of its surroundings on top of it. Because the top of the ball is genuinely light, everything drawn on it needed its own dark edge — see the chevrons below.
2. **The chevrons** are two-path solids rather than one `currentColor` bar. The flat button's grey (`--fg-soft`) sits within a couple of points of the ball's sheen and vanished into it (measured 1.36:1); the reference's bars are white, so each bar is drawn as a white face over a dark copy offset 1px down, plus a hairline outline (`drop-shadow(0 0 0.6px …)`) so its silhouette survives where it crosses the light. The dark copy is what gives the bar an edge against the *window reflection*, where a bare white bar still only measured 2.6:1.
3. **The orbit** is a real 3D rotation, not a 2D wobble. The stack sits inside `perspective(520px)` and rotates on both axes, so the chevrons genuinely turn in depth. The rest pose is already a 3/4 view (`-9deg` / `6deg`) rather than front-on, because a slab seen straight from the front has no depth to read.
4. **The tile** (`__plate`) is a cool, *translucent* pane that floats `--orb-depth` in front of the chevrons, with a `backdrop-filter` frost so the ball's own sheen shows through it. It is deliberately **darker than the folder**, which is the one thing that makes the folder silhouette visible at all: a white solid on a white tile is one white blob with two numbers on it, and the tab, the extrusion and the pocket all disappear into it (this was the first pass, and it read as "a card with two numbers"). An opaque dark tile fails the other way — the folder vanishes into it — so the pane is a mid-tone blue-grey between the near-white folder and the dark limb of the ball.
5. **The folder** is an extruded solid built from stacked silhouettes of one shared path: a contact shadow on the tile, the dark side 1px lower, the mid-tone body, shallow ambient occlusion, a near-white face with a hairline silhouette outline and a soft drop shadow, and a rim light along its top edges. At 20 × 17 this stacking is what reads as thickness; a folder glyph has no volume of its own to push in Z. The **fold line** that used to be stroked across the middle of the silhouette is gone on purpose: the counts are laid out top/bottom on this plate, so at 1x it landed across the red count's cap and read as a stray rule rather than as a fold. The face's gradient also holds near-white across the middle and only models at the very edge, so the counts keep the pale bed they are tuned against; the depth the old darker ramp was buying comes from the outline and the extrusion instead.

### The proportions are the effect, and they are pinned
The single biggest thing that made the first version read as "a white sticker on a disc" rather than as the reference render was **scale**. The first pass drew 14 × 7 chevrons over a 28 × 22 folder — a 38px pictogram inside a 40px painted sphere. There was no glass left around the artwork, the chevrons touched the rim, and the ball stopped reading as a ball. A sphere is recognizable mainly by the gradient around its edge; fill that edge with icon and the sphere is gone.
The sizes are therefore declared as ratios of the painted sphere rather than as taste, and they live in one place (`FileToolbar.jsx`) which `chat-composer.css` mirrors:
| Element | Size | Share of the 40px sphere |
|---------|------|--------------------------|
| Chevron | 11 × 6 | 28% wide |
| Folder / tile | 20 × 17 | 50% wide |
| Whole stack | 31 tall | 78% tall |
`scripts/test-file-orb.mjs` asserts both ceilings — the stack may not exceed 70% of the sphere's width or 85% of its height — so a future tweak that fattens the icon fails the suite instead of quietly eating the glass again.
Two consequences worth knowing:
- The **count text is HTML**, not SVG, and it is laid out against the tile box. So the plate's size in `FileToolbar.jsx` and in the CSS has to be the *same number*; the test asserts that equality, because otherwise the sizer's width/height budgets describe a rectangle that no longer exists.
- the whole pictogram is only ~31px tall, so the extrusion offsets (1px) are a meaningful fraction of the glyph. That is why the bevel is visible at all; scale the pictogram back up and those same offsets become invisible edges.

The counts are embossed, and the emboss has **four** stacked shadows per glyph. Read top to bottom as light travels over a raised letter:

1. the **bevel** — a dark bite along the glyph's top-inner edge, where a raised solid turns away from an overhead light. This is the shadow that makes the digits look milled rather than printed;
2. the **lip** — a bright edge on the far side, where the solid's base meets the tile;
3. the **bloom**, in the glyph's own hue, kept modest on purpose;
4. a soft **halo**, one radius out, so the glow reaches the tile rather than stopping at the glyph's edge.

The **echo** — a near-black copy of the whole count, offset down-right — is drawn *under* the glyph by `__count-echo`. It is the letterpress shadow the raised glyph casts on the tile, and the bloom radii are deliberately kept small enough (see below) that it stays visible.

The bloom is a glow rather than a different ink, so the contrast the colors are chosen for is unchanged. Pushing it harder is a mistake worth recording: at a higher opacity the fill lifts toward pastel and the saturated hues the colors are chosen for are lost — measured, the glyph core read `rgb(39,134,45)` instead of `#006600`'s `rgb(0,102,0)`. Trimmed back, the same glyph reads `rgb(34,100,40)`.

The **ink is per-variant**. `#006600` / `#b30000` were chosen for a flat glyph on `--fg`; embossed into a lit solid with a dark under-copy and a white lip they read as near-black, so the orb carries its own, measurably lighter pair (`#087a1c` / `#c11b1b`). Both still clear the 4.5:1 small-text budget on the pale bed they sit on — the rendered button measures 5.1:1 (green) and 5.5:1 (red) against the folder face — while the flat pair is asserted to be untouched, because the orb is a skin and the flat button's contrast notes are pinned to those two values.

### The count size is adaptive, and it has to be
The formatter ([`gitCount.js`](../../frontend/src/components/chat/gitCount.js)) can emit anything from 2 glyphs (`+0`) to 5 (`+995k`), and one fixed size cannot serve both inside the tile:
- sized for the 5-glyph worst case, the digits render small enough that every emboss offset is sub-pixel and melts into mush — this is exactly the "no depth, no texture" the first fixed size produced — and `+995k` overflowed its box rather than merely being small;
- sized for `+0` / `−0` — by far the common case, and the state the reference render shows — there is room for a genuinely chunky digit.
So `orbCountFont(maxLen)` picks the step from the longest count actually drawn, and `FileToolbar` passes it in as the `--orb-count` custom property. Each step has to clear **two** budgets, both derived from the plate rather than pinned as literals:
| Budget | Constraint | Binds at |
|--------|-----------|----------|
| Width | the widest string of `maxLen` glyphs inside the 16px content box | 4–5 glyphs |
| Height | two stacked line boxes at `line-height: 0.85` inside the 13px content box | 2–3 glyphs |
The budgets are the plate (`ORB_FOLDER_W/H` in `FileToolbar.jsx`, mirrored by `.file-toolbar__plate`) less the 2px inset `.file-toolbar--orb .file-toolbar__git-stats` applies on every side. `scripts/test-file-orb.mjs` reads both numbers out of the source and asserts the two files agree, so resizing the plate cannot leave the sizer silently overshooting it.
Width is per-**string**, not per-glyph — `.` is far narrower than a digit, so `+9.9k` (2.63em) is wider than `+995k` (2.92em) would be at the same size. The measured em widths, at weight 800 with tabular figures:
```text
+0      1.19em      +9.9k   2.63em
+99     1.77em      +995k   2.92em
```
Which gives:
```js
const ORB_FONT_STEPS = Object.freeze({ 2: 7, 3: 7, 4: 6, 5: 5 });
```
The height budget is the one that is easy to miss, and missing it is invisible in a screenshot: two 12px lines need 24px but the content box is only 13px, and `overflow: hidden` then silently cuts ~4.3px off the descender side of both counts. That is what stripped the texture off the digits before the line-height was tightened. Each step is also checked to be *maximal* — the next 0.5px up has to bust its budget — so the sizer is not leaving chunkiness on the table. The 2- and 3-glyph steps are 7px rather than the 7.6px the height budget alone would allow, because the two line boxes also have to leave a *visible* gap: at 7.5px they summed to 12.75 of the 13px available and `justify-content: space-between` had 0.25px left to separate them, which measured as only 1.4px of clear space between the green and red ink. At 7px it measures 2px.
Every emboss offset is in `em`, so it scales with the chosen size: a 1.5px extrusion on 7px digits becomes ~1px on 5px ones. The echo was previously a fixed `0.6px`, which is a visible bevel at one end of the range and an invisible smear at the other — tuning that single rule could never have reached the chunky case.
The **bloom** is capped for the same reason, and getting this wrong is what made the button look smeared rather than embossed. The two coloured halos used to reach `0.8em`, i.e. 19px across on a 20px tile: the green and red glows met in the middle and the whole tile turned into a coloured cloud. They are now two stops at `0.14em` and `0.3em`, which keeps the glow inside the glyph's own corner of the tile.

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
- the CSS invariants — no unprefixed gradient fill, the orb paint is variant-scoped, the animation lives inside `prefers-reduced-motion: no-preference`, no keyframe animates a layout property, the emboss is in `em` rather than fixed px, and the rest pose carries a perspective and a base tilt;
- the *material* invariants — the orb emits a white chevron face plus a dark side (and the flat button emits neither), the tile's composited tone stays well clear of the folder face, and the orb's count inks are lighter than the flat pair while both clear 4.5:1 on the pale bed.

The last group is what keeps the button reading like the reference rather than like a shaded disc again: each one is a relationship between declared tones rather than a pinned hex value, so the palette can still be tuned.

It is wired into `npm run lint` and `npm test`.

### Related

- [File toolbar](file-toolbar.md) — what the button opens (Files / Preview / Git / Cli) and the `+N` / `−N` counts.
- [Chat UI](chat-ui.md) — the composer row the button sits in.
- [App and project settings](app-and-project-settings.md) — app-level vs project-level settings.
