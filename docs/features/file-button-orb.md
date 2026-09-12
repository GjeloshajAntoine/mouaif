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
| Counts | Flat colored glyphs at `0.46rem` | Embossed at `0.56rem`, with a dark under-copy, a white lip and a two-stop bloom |
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

The counts are embossed with four layers per count: a near-black copy offset 0.6px down-right, the colored face, a white lip directly *under* the face, and a two-stop bloom in the glyph's own hue. The bloom widens the shape at 9px without changing its color, so the 6:1 contrast (`#006600` / `#b30000` on the light face) is unchanged.

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
- the CSS invariants — no unprefixed gradient fill, the orb paint is variant-scoped, the animation lives inside `prefers-reduced-motion: no-preference`, no keyframe animates a layout property, and the rest pose carries a perspective and a base tilt.

It is wired into `npm run lint` and `npm test`.

### Related

- [File toolbar](file-toolbar.md) — what the button opens (Files / Preview / Git / Cli) and the `+N` / `−N` counts.
- [Chat UI](chat-ui.md) — the composer row the button sits in.
- [App and project settings](app-and-project-settings.md) — app-level vs project-level settings.
